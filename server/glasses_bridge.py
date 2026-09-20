"""
glasses_bridge.py

Runs on your laptop. Connects to the OpenGlass firmware over Bluetooth LE,
reassembles the chunked JPEG photos it sends, and forwards each photo to
your existing detector_server.py (/detect) and face_service.py (/verify).

Shutter mode: about every 5 seconds, take a short burst of single-shot
photos (-1), score them (face match / face present / hazards / sharpness),
and publish only the best frame to /latest_result. Firmware cannot do true
sub-5s periodic intervals, so the cycle is software-timed.

The phone app polls /latest_result over HTTP (Expo Go friendly).

Run with:
    python -m venv .venv
    .venv/Scripts/activate
    pip install -r requirements.txt
    uvicorn glasses_bridge:app --host 0.0.0.0 --port 8002
"""

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, List, Optional

import httpx
from bleak import BleakClient, BleakScanner
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from frame_selection import (
    MIN_SHARPNESS,
    STATUS_NO_FACE,
    STATUS_OK,
    STATUS_RETAKE,
    get_best_frame_for_recognition,
    jpeg_sharpness,
    rotate_jpeg,
)
from snowflake_client import (
    add_safe_space,
    apply_gps,
    enrich_scene,
    get_place,
    inside_safe_zone,
    maybe_routine_reminder,
    place_state,
    remove_safe_space,
    wake_warehouse,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("glasses_bridge")
# Bleak scanner DEBUG floods the console with every nearby BLE device.
logging.getLogger("bleak").setLevel(logging.WARNING)
logging.getLogger("asyncio").setLevel(logging.WARNING)

try:
    import cv2

    # Hide libjpeg "premature end of data segment" spam from truncated BLE frames.
    if hasattr(cv2, "setLogLevel"):
        cv2.setLogLevel(0)
except Exception:  # noqa: BLE001
    pass

# --- Config ----------------------------------------------------------------
DETECTOR_URL = "http://127.0.0.1:8000"
FACE_URL = "http://127.0.0.1:8001"

# Every ~5s: take BURST_SIZE quick shots, keep the best one.
# Set BURST_SIZE to 5 for a denser burst (heavier on BLE).
CYCLE_TARGET_SECONDS = 5.0
BURST_SIZE = 3
# Leave enough time for the previous JPEG to finish transferring over BLE.
SHOT_GAP_SECONDS = 1.25
PHOTO_TIMEOUT_SECONDS = 15.0
MAX_SHOT_RETRIES = 2

# Firmware photo-control (handlePhotoControl in firmware.ino):
#   -1      -> take exactly one photo
#    0      -> stop periodic capture
#   5..300  -> periodic every N seconds (min 5, rounded to 5)
PHOTO_CONTROL_STOP = 0
PHOTO_CONTROL_SINGLE = -1

SERVICE_UUID = "19b10000-e8f2-537e-4f6c-d104768a1214"
PHOTO_DATA_UUID = "19b10005-e8f2-537e-4f6c-d104768a1214"
PHOTO_CONTROL_UUID = "19b10006-e8f2-537e-4f6c-d104768a1214"
DEVICE_NAME = "OpenGlass"

latest_result = {
    "matched": False,
    "name": None,
    "relationship": None,
    "score": 0.0,
    "detections": [],
    "status": None,
    "sharpness": None,
    "spoken_text": None,
    "place": "away",
    "routine_reminder": None,
    "inside_safe_zone": False,
    "timestamp": None,
}
_photo_chunks = {}  # frame_index -> payload bytes
_photo_queue: asyncio.Queue | None = None
_ble_task = None


def _reset_photo_buffer():
    global _photo_chunks
    _photo_chunks = {}


def _control_byte(signed_value: int) -> bytes:
    return (signed_value & 0xFF).to_bytes(1, "little")


def _is_valid_jpeg(data: bytes) -> bool:
    """Require markers + a successful OpenCV decode (rejects truncated BLE frames)."""
    from frame_selection import decode_jpeg_gray

    return decode_jpeg_gray(data) is not None


def _assemble_photo() -> bytes:
    if not _photo_chunks:
        return b""
    return b"".join(_photo_chunks[index] for index in sorted(_photo_chunks))


def _jpeg_sharpness(jpeg_bytes: bytes) -> float:
    return jpeg_sharpness(jpeg_bytes)


# ---------------------------------------------------------------------------
# Orientation: calibrate ONCE (first face), then hardcode forever.
# After you see "Orientation LOCKED at X°", that value is written to
# glasses_orientation.py and used on every later start — no re-scan.
# ---------------------------------------------------------------------------
try:
    from glasses_orientation import FIXED_ORIENTATION_DEG
except ImportError:
    FIXED_ORIENTATION_DEG = None  # None => auto-calibrate on first face

_ORIENTATION_CONFIG_PATH = Path(__file__).with_name("glasses_orientation.py")

_orientation_deg = 0
_orientation_locked = False


def _load_fixed_orientation() -> None:
    global _orientation_deg, _orientation_locked
    if FIXED_ORIENTATION_DEG is None:
        return
    _orientation_deg = int(FIXED_ORIENTATION_DEG) % 360
    _orientation_locked = True
    print(
        f"Using hardcoded FIXED_ORIENTATION_DEG={_orientation_deg}° "
        "(skipping auto-calibrate)"
    )


def _write_fixed_orientation(degrees: int) -> None:
    """Persist the calibrated angle so the next process start hardcodes it."""
    degrees = int(degrees) % 360
    contents = (
        "# Auto-written by glasses_bridge after one-time orientation calibrate.\n"
        "# Delete this file to re-calibrate, or edit the number if you remount the camera.\n"
        f"FIXED_ORIENTATION_DEG = {degrees}\n"
    )
    _ORIENTATION_CONFIG_PATH.write_text(contents, encoding="utf-8")
    print("=" * 60)
    print(f"HARDCODED orientation -> glasses_orientation.py")
    print(f"FIXED_ORIENTATION_DEG = {degrees}")
    print("=" * 60)


async def _score_faces(client: httpx.AsyncClient, jpeg_bytes: bytes) -> tuple:
    """Return (face_count, max_det_score, max_face_area) from face_service."""
    files = {"file": ("frame.jpg", jpeg_bytes, "image/jpeg")}
    try:
        response = await client.post(f"{FACE_URL}/face_score", files=files)
    except Exception as exc:  # noqa: BLE001
        print("face_score request failed:", exc)
        return (0, 0.0, 0.0)

    if response.status_code == 404:
        print(
            "ERROR: /face_score returned 404 — face_service is an OLD process. "
            "Stop it and restart: uvicorn face_service:app --host 0.0.0.0 --port 8001"
        )
        return (0, 0.0, 0.0)

    if response.status_code != 200:
        print(f"face_score HTTP {response.status_code}: {response.text[:200]}")
        return (0, 0.0, 0.0)

    payload = response.json()
    return (
        int(payload.get("face_count") or 0),
        float(payload.get("max_det_score") or 0.0),
        float(payload.get("max_face_area") or 0.0),
    )


async def _calibrate_orientation(jpeg_bytes: bytes) -> int:
    """One-time: try 0/90/180/270, lock + hardcode the strongest face angle."""
    global _orientation_deg, _orientation_locked

    best_deg = 0
    best_key = (-1, -1.0, -1.0)

    async with httpx.AsyncClient(timeout=30.0) as client:
        for degrees in (0, 90, 180, 270):
            rotated = rotate_jpeg(jpeg_bytes, degrees)
            if rotated is None:
                continue
            face_count, det_score, face_area = await _score_faces(client, rotated)
            key = (face_count, det_score, face_area)
            print(
                f"Calibrate orientation {degrees}°: faces={face_count} "
                f"det={det_score:.3f} area={face_area:.0f}"
            )
            if key > best_key:
                best_key = key
                best_deg = degrees

    if best_key[0] > 0:
        _orientation_deg = best_deg
        _orientation_locked = True
        _write_fixed_orientation(best_deg)
        print(f"Orientation LOCKED at {_orientation_deg}° clockwise for all future frames")
    else:
        print("Orientation calibrate: no faces yet; will retry on next sharp frame")

    return _orientation_deg


def _apply_locked_orientation(jpeg_bytes: bytes) -> tuple[bytes, int]:
    """Apply the locked/hardcoded rotation (or 0° if not calibrated yet)."""
    if _orientation_deg == 0:
        return jpeg_bytes, 0
    rotated = rotate_jpeg(jpeg_bytes, _orientation_deg)
    if rotated is None:
        return jpeg_bytes, _orientation_deg
    return rotated, _orientation_deg


async def _orient_jpeg(jpeg_bytes: bytes) -> tuple[bytes, int]:
    """
    If FIXED_ORIENTATION_DEG / glasses_orientation.py is set, only rotate.
    Otherwise calibrate once on the first frame with a face, then hardcode.
    """
    if not _orientation_locked:
        await _calibrate_orientation(jpeg_bytes)
    return _apply_locked_orientation(jpeg_bytes)


_DEBUG_FRAME_DIR = Path(__file__).with_name("debug_frames")


def _save_debug_frame(jpeg_bytes: bytes, label: str = "last_oriented") -> None:
    try:
        _DEBUG_FRAME_DIR.mkdir(exist_ok=True)
        path = _DEBUG_FRAME_DIR / f"{label}.jpg"
        path.write_bytes(jpeg_bytes)
        print(f"Saved debug frame -> {path}")
    except Exception as exc:  # noqa: BLE001
        print("Could not save debug frame:", exc)


async def _analyze_photo(jpeg_bytes: bytes) -> dict:
    """Stage B: fixed orientation, then InsightFace verify + YOLO detect."""
    global _orientation_deg

    oriented, orientation_deg = await _orient_jpeg(jpeg_bytes)
    _save_debug_frame(oriented, "last_oriented")

    # If locked angle finds no face, probe other angles once and re-lock if needed.
    async with httpx.AsyncClient(timeout=20.0) as client:
        face_count, det_score, _area = await _score_faces(client, oriented)
        if face_count == 0 and _orientation_locked:
            print(
                f"No face at locked {orientation_deg}° — probing other angles once..."
            )
            best_deg = orientation_deg
            best_key = (0, 0.0, 0.0)
            best_jpeg = oriented
            for degrees in (0, 90, 180, 270):
                if degrees == orientation_deg:
                    continue
                rotated = rotate_jpeg(jpeg_bytes, degrees)
                if rotated is None:
                    continue
                key = await _score_faces(client, rotated)
                print(
                    f"  probe {degrees}°: faces={key[0]} det={key[1]:.3f}"
                )
                if key > best_key:
                    best_key = key
                    best_deg = degrees
                    best_jpeg = rotated
            if best_key[0] > 0:
                _orientation_deg = best_deg
                _write_fixed_orientation(best_deg)
                oriented = best_jpeg
                orientation_deg = best_deg
                _save_debug_frame(oriented, "last_oriented")
                print(f"Re-LOCKED orientation to {best_deg}°")

    files_verify = {"file": ("frame.jpg", oriented, "image/jpeg")}
    files_detect = {"file": ("frame.jpg", oriented, "image/jpeg")}

    async with httpx.AsyncClient(timeout=15.0) as client:
        verify_response, detect_response = await asyncio.gather(
            client.post(f"{FACE_URL}/verify", files=files_verify),
            client.post(f"{DETECTOR_URL}/detect", files=files_detect),
            return_exceptions=True,
        )

    detections = []
    if isinstance(detect_response, httpx.Response) and detect_response.status_code == 200:
        detections = detect_response.json().get("detections", [])
    else:
        print("Detector request failed:", detect_response)

    matched = False
    name = None
    relationship = None
    score = 0.0
    face_present = False

    if isinstance(verify_response, httpx.Response) and verify_response.status_code == 200:
        verify_json = verify_response.json()
        matched = bool(verify_json.get("matched", False))
        name = verify_json.get("name")
        relationship = verify_json.get("relationship")
        score = float(verify_json.get("score") or 0.0)
        face_present = True
    elif isinstance(verify_response, httpx.Response) and verify_response.status_code == 400:
        face_present = False
        print("Face verify 400:", verify_response.text)
    else:
        print("Face verify request failed:", verify_response)

    return {
        "matched": matched,
        "name": name,
        "relationship": relationship,
        "score": score,
        "detections": detections,
        "face_present": face_present,
        "sharpness": _jpeg_sharpness(oriented),
        "orientation_deg": orientation_deg,
        "status": STATUS_OK,
    }


async def _apply_snowflake(frame: dict) -> dict:
    """Add Cortex spoken_text and log the scene. Never send the JPEG."""
    if frame.get("status") == STATUS_RETAKE:
        return frame
    scene = {
        "matched": frame.get("matched", False),
        "name": frame.get("name"),
        "relationship": frame.get("relationship"),
        "score": frame.get("score", 0.0),
        "detections": frame.get("detections") or [],
    }
    try:
        enriched = await enrich_scene(scene, force=False)
    except Exception as exc:  # noqa: BLE001
        print("Snowflake enrich failed:", exc)
        return frame
    frame["spoken_text"] = enriched.get("spoken_text")
    frame["place"] = enriched.get("place")
    frame["routine_reminder"] = enriched.get("routine_reminder")
    frame["inside_safe_zone"] = enriched.get("inside_safe_zone")
    frame["skip_publish"] = enriched.get("skip_publish")
    return frame


def _publish_result(frame: dict) -> None:
    global latest_result
    latest_result = {
        "matched": frame.get("matched", False),
        "name": frame.get("name"),
        "relationship": frame.get("relationship"),
        "score": frame.get("score", 0.0),
        "detections": frame.get("detections") or [],
        "status": frame.get("status"),
        "sharpness": frame.get("sharpness"),
        "orientation_deg": frame.get("orientation_deg"),
        "spoken_text": frame.get("spoken_text"),
        "place": frame.get("place") or get_place(),
        "routine_reminder": frame.get("routine_reminder"),
        "inside_safe_zone": frame.get("inside_safe_zone", inside_safe_zone()),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    print(
        "Updated latest_result:",
        latest_result,
        f"(sharpness={frame.get('sharpness')})",
    )


def _publish_gate_status(status: str, sharpness: float | None = None) -> None:
    """Publish retake / no-face without calling InsightFace."""
    _publish_result(
        {
            "matched": False,
            "name": None,
            "relationship": None,
            "score": 0.0,
            "detections": [],
            "face_present": False,
            "sharpness": sharpness,
            "status": status,
        }
    )


def _make_notification_handler(loop: asyncio.AbstractEventLoop):
    def handler(_sender, data: bytearray):
        if len(data) < 2:
            return

        is_end_marker = len(data) == 2 and data[0] == 0xFF and data[1] == 0xFF
        if is_end_marker:
            full = _assemble_photo()
            _reset_photo_buffer()
            if len(full) == 0 or _photo_queue is None:
                return
            loop.call_soon_threadsafe(_photo_queue.put_nowait, full)
            return

        # Little-endian frame index; index 0 starts a new photo.
        frame_index = data[0] | (data[1] << 8)
        if frame_index == 0:
            _reset_photo_buffer()
        _photo_chunks[frame_index] = bytes(data[2:])

    return handler


async def _write_photo_control(
    client: BleakClient, signed_value: int, *, with_response: bool = False
) -> None:
    await asyncio.wait_for(
        client.write_gatt_char(
            PHOTO_CONTROL_UUID,
            _control_byte(signed_value),
            response=with_response,
        ),
        timeout=10.0,
    )


async def _drain_photo_queue() -> None:
    if _photo_queue is None:
        return
    while not _photo_queue.empty():
        try:
            _photo_queue.get_nowait()
        except asyncio.QueueEmpty:
            break


async def _capture_one_photo(client: BleakClient) -> bytes | None:
    """Single-shot shutter (-1); wait for a complete, decodable JPEG."""
    for attempt in range(1, MAX_SHOT_RETRIES + 1):
        if not client.is_connected:
            return None

        await _drain_photo_queue()
        _reset_photo_buffer()
        # Brief settle so the previous transfer is fully idle.
        await asyncio.sleep(0.15)

        try:
            await _write_photo_control(client, PHOTO_CONTROL_SINGLE)
        except asyncio.TimeoutError:
            print("Timed out writing single-shot photo-control.")
            return None

        try:
            jpeg = await asyncio.wait_for(
                _photo_queue.get(), timeout=PHOTO_TIMEOUT_SECONDS
            )
        except asyncio.TimeoutError:
            print("Timed out waiting for JPEG after single-shot trigger.")
            return None

        if _is_valid_jpeg(jpeg):
            return jpeg

        head = jpeg[:8].hex() if jpeg else ""
        tail = jpeg[-4:].hex() if jpeg and len(jpeg) >= 4 else ""
        print(
            f"Incomplete/corrupt JPEG attempt {attempt}/{MAX_SHOT_RETRIES}: "
            f"{len(jpeg)} bytes head={head} tail={tail}"
        )
        await asyncio.sleep(SHOT_GAP_SECONDS)

    return None


async def _run_burst_cycle(client: BleakClient) -> None:
    """
    Capture a burst, pick the sharpest frame via get_best_frame_for_recognition,
    and only then run InsightFace (Stage B) if status is ok.
    """
    jpegs = []
    for index in range(BURST_SIZE):
        if not client.is_connected:
            break
        jpeg = await _capture_one_photo(client)
        if jpeg is None:
            print(f"Burst shot {index + 1}/{BURST_SIZE} failed.")
        else:
            sharpness = _jpeg_sharpness(jpeg)
            print(
                f"Burst shot {index + 1}/{BURST_SIZE}: {len(jpeg)} bytes, "
                f"sharpness={sharpness:.1f}"
            )
            jpegs.append(jpeg)
        if index + 1 < BURST_SIZE and client.is_connected:
            await asyncio.sleep(SHOT_GAP_SECONDS)

    if not jpegs:
        print("Burst produced no usable frames.")
        _publish_gate_status(STATUS_RETAKE, sharpness=0.0)
        return

    best_frame, status = get_best_frame_for_recognition(
        jpegs,
        num_frames=BURST_SIZE,
        min_sharpness=MIN_SHARPNESS,
        # Haar Stage A rejects most OpenGlass frames (wide-angle / small faces).
        # InsightFace is the real face gate on Stage B.
        run_stage_a=False,
    )
    print(f"Frame selection status={status} min_sharpness={MIN_SHARPNESS}")

    if status == STATUS_RETAKE:
        best_score = max((_jpeg_sharpness(frame) for frame in jpegs), default=0.0)
        _publish_gate_status(STATUS_RETAKE, sharpness=best_score)
        return

    if status == STATUS_NO_FACE or best_frame is None:
        best_score = max((_jpeg_sharpness(frame) for frame in jpegs), default=0.0)
        _publish_gate_status(STATUS_NO_FACE, sharpness=best_score)
        return

    # Stage B — InsightFace + YOLO on the single gated frame only.
    analyzed = await _analyze_photo(best_frame)
    if not analyzed.get("face_present"):
        analyzed["status"] = STATUS_NO_FACE
    analyzed = await _apply_snowflake(analyzed)
    if analyzed.get("skip_publish"):
        print("Skipping duplicate scene publish")
        return
    _publish_result(analyzed)


async def _run_shutter_cycles(client: BleakClient) -> None:
    """
    Software-timed shutter: burst every CYCLE_TARGET_SECONDS when possible.
    If the burst runs long (BLE), the next cycle starts right after.
    """
    while client.is_connected:
        cycle_started = asyncio.get_running_loop().time()
        try:
            await _run_burst_cycle(client)
        except Exception as exc:  # noqa: BLE001
            print(f"Burst cycle error: {type(exc).__name__}: {exc!r}")

        if not client.is_connected:
            break

        elapsed = asyncio.get_running_loop().time() - cycle_started
        wait_for = CYCLE_TARGET_SECONDS - elapsed
        if wait_for > 0:
            await asyncio.sleep(wait_for)


async def _run_ble_loop():
    global _photo_queue
    loop = asyncio.get_running_loop()
    _photo_queue = asyncio.Queue()

    def _on_disconnect(client_instance):
        print(f"BLE disconnect callback fired for {client_instance.address}")

    while True:
        try:
            print(f"Scanning for '{DEVICE_NAME}'...")
            device = await BleakScanner.find_device_by_filter(
                lambda d, ad: d.name == DEVICE_NAME, timeout=20.0
            )
            if device is None:
                print("Glasses not found, retrying in 5s...")
                await asyncio.sleep(5)
                continue

            print(f"Found glasses at {device.address}, connecting...")
            async with BleakClient(device, disconnected_callback=_on_disconnect) as client:
                _reset_photo_buffer()
                await _drain_photo_queue()
                await client.start_notify(
                    PHOTO_DATA_UUID, _make_notification_handler(loop)
                )

                # Stop any leftover periodic mode from a previous session.
                try:
                    await _write_photo_control(
                        client, PHOTO_CONTROL_STOP, with_response=True
                    )
                    await asyncio.sleep(0.5)
                except asyncio.TimeoutError:
                    print("Timed out stopping periodic capture.")
                    continue

                print(
                    f"Connected. Shutter: burst of {BURST_SIZE} every "
                    f"~{CYCLE_TARGET_SECONDS}s (pick best frame)."
                )
                await _run_shutter_cycles(client)

            print("Disconnected from glasses. Reconnecting...")
        except Exception as exc:  # noqa: BLE001
            print(f"BLE loop error: {type(exc).__name__}: {exc!r}")
            await asyncio.sleep(5)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _ble_task
    _load_fixed_orientation()
    asyncio.create_task(wake_warehouse())
    _ble_task = asyncio.create_task(_run_ble_loop())
    yield
    if _ble_task:
        _ble_task.cancel()


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class SceneEventBody(BaseModel):
    matched: bool = False
    name: Optional[str] = None
    relationship: Optional[str] = None
    score: float = 0.0
    detections: List[Any] = Field(default_factory=list)
    force: bool = False


class LocationBody(BaseModel):
    lat: float
    lng: float
    accuracy: Optional[float] = None


class SafeSpaceBody(BaseModel):
    name: str = ""
    address: str = ""
    lat: Optional[float] = None
    lng: Optional[float] = None
    radius_m: Optional[float] = None


@app.get("/latest_result")
async def get_latest_result():
    return latest_result


@app.post("/scene_event")
async def post_scene_event(body: SceneEventBody):
    scene = {
        "matched": body.matched,
        "name": body.name,
        "relationship": body.relationship,
        "score": body.score,
        "detections": body.detections,
    }
    return await enrich_scene(scene, force=body.force)


@app.get("/place")
async def get_place_state():
    return place_state()


@app.post("/location")
async def post_location(body: LocationBody):
    state = apply_gps(body.lat, body.lng, body.accuracy)
    if not state.get("inside_safe_zone"):
        state["alert"] = await maybe_routine_reminder()
    else:
        state["alert"] = None
    return state


@app.get("/safe_spaces")
async def get_safe_spaces():
    return place_state()


@app.post("/safe_spaces")
async def post_safe_space(body: SafeSpaceBody):
    try:
        add_safe_space(
            body.name,
            body.address,
            lat=body.lat,
            lng=body.lng,
            radius_m=body.radius_m,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return place_state()


@app.delete("/safe_spaces/{space_id}")
async def delete_safe_space(space_id: str):
    try:
        remove_safe_space(space_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return place_state()


@app.get("/health")
async def health():
    return {"status": "ok"}
