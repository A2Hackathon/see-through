"""
Sharpness-based frame selection before InsightFace recognition.

Selection picks the sharpest JPEG from a burst. If it is below MIN_SHARPNESS,
callers must NOT run InsightFace and should surface status="retake_needed".

Two-stage gating:
  Stage A (cheap): OpenCV Haar face detect on the top 1–2 sharpest frames.
  Stage B (expensive): InsightFace verify/embeddings — only on a frame that
  passed Stage A. FaceAnalysis.get() always extracts embeddings when called,
  so we cannot run InsightFace "detection-only"; Stage A stays on OpenCV.

For OpenGlass BLE bursts, pass already-captured JPEG bytes via `frames=`.
`stream_url` is reserved for a future live HTTP/MJPEG source.
"""

from __future__ import annotations

import logging
from typing import Iterable, List, Optional, Sequence, Tuple

import cv2
import numpy as np

logger = logging.getLogger(__name__)
if not logging.getLogger().handlers:
    logging.basicConfig(level=logging.INFO)

# Tunable from real glasses data (Laplacian variance).
# OpenGlass walking bursts typically land ~5–40; 100 was far too high and
# rejected every frame. ~15 keeps soft/blurry shots out while allowing usable ones.
MIN_SHARPNESS = 15.0
# Minimum face box area (pixels^2) for Stage A to count as a usable face.
MIN_FACE_AREA_PX = 40 * 40
STAGE_A_CANDIDATES = 2

STATUS_OK = "ok"
STATUS_RETAKE = "retake_needed"
STATUS_NO_FACE = "no_face_detected"

_haar_cascade = None
_haar_unavailable = False


def _get_haar_cascade():
    """
    Load Haar if this OpenCV build supports it.
    Some headless/minimal installs expose cv2 without CascadeClassifier.
    """
    global _haar_cascade, _haar_unavailable
    if _haar_unavailable:
        return None
    if _haar_cascade is not None:
        return _haar_cascade
    if not hasattr(cv2, "CascadeClassifier"):
        logger.warning(
            "cv2.CascadeClassifier missing — Stage A face gate disabled "
            "(sharpness gate still applies)"
        )
        _haar_unavailable = True
        return None
    path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    cascade = cv2.CascadeClassifier(path)
    if cascade.empty():
        logger.warning("Haar cascade failed to load; Stage A face gate disabled")
        _haar_unavailable = True
        return None
    _haar_cascade = cascade
    return _haar_cascade


def decode_jpeg_gray(jpeg_bytes: bytes, min_side: int = 32):
    """
    Decode JPEG to grayscale. Returns None if truncated/corrupt or too small.
    OpenGlass BLE often yields FFD8…FFD9 blobs that still trigger
    'premature end of data segment' and bad sharpness — reject those.
    """
    if not jpeg_bytes or len(jpeg_bytes) < 100:
        return None
    if jpeg_bytes[:2] != b"\xff\xd8" or jpeg_bytes[-2:] != b"\xff\xd9":
        return None
    try:
        arr = np.frombuffer(jpeg_bytes, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
        if img is None or img.size == 0:
            return None
        height, width = img.shape[:2]
        if height < min_side or width < min_side:
            return None
        return img
    except Exception:  # noqa: BLE001
        return None


def jpeg_sharpness(jpeg_bytes: bytes) -> float:
    """Laplacian variance on grayscale — higher is sharper. 0 if undecodable."""
    img = decode_jpeg_gray(jpeg_bytes)
    if img is None:
        return 0.0
    try:
        return float(cv2.Laplacian(img, cv2.CV_64F).var())
    except Exception:  # noqa: BLE001
        return 0.0


def stage_a_face_ok(jpeg_bytes: bytes, min_face_area: float = MIN_FACE_AREA_PX) -> bool:
    """
    Cheap face gate (OpenCV Haar) when available.
    OpenGlass wide-angle frames often fail Haar even with a person present;
    prefer run_stage_a=False and let InsightFace decide.
    """
    cascade = _get_haar_cascade()
    if cascade is None:
        return True

    gray = decode_jpeg_gray(jpeg_bytes)
    if gray is None:
        return False

    faces = cascade.detectMultiScale(
        gray, scaleFactor=1.05, minNeighbors=3, minSize=(24, 24)
    )
    if len(faces) == 0:
        return False
    return any(float(w) * float(h) >= min_face_area for (_x, _y, w, h) in faces)


def score_frames(frames: Sequence[bytes]) -> List[Tuple[int, float, bytes]]:
    """Return (index, sharpness, bytes) sorted sharpest-first; skip undecodable."""
    scored = []
    for index, frame in enumerate(frames):
        score = jpeg_sharpness(frame)
        if score <= 0:
            logger.debug("frame[%s] skipped (undecodable/corrupt JPEG)", index)
            continue
        scored.append((index, score, frame))
        logger.debug("frame[%s] sharpness=%.2f bytes=%s", index, score, len(frame))
    scored.sort(key=lambda item: item[1], reverse=True)
    return scored


def get_best_frame_for_recognition(
    frames: Optional[Sequence[bytes]] = None,
    *,
    stream_url: Optional[str] = None,
    num_frames: int = 8,
    min_sharpness: float = MIN_SHARPNESS,
    run_stage_a: bool = True,
) -> Tuple[Optional[bytes], str]:
    """
    Pick one frame safe to send to InsightFace.

    Returns:
      (frame_bytes_or_None, status)
      status: "ok" | "retake_needed" | "no_face_detected"

    Notes:
      - Pass `frames` for OpenGlass burst JPEGs.
      - `stream_url` / `num_frames` are for a future live stream grabber;
        calling with only stream_url currently returns retake_needed until
        a stream capture helper is added.
    """
    if frames is None:
        if stream_url:
            logger.warning(
                "stream_url=%s is not implemented yet; pass frames= for BLE bursts",
                stream_url,
            )
        return None, STATUS_RETAKE

    valid = [frame for frame in frames if frame]
    if not valid:
        return None, STATUS_RETAKE

    # Respect num_frames as a max when callers pass a long buffer.
    if len(valid) > num_frames:
        valid = list(valid)[:num_frames]

    scored = score_frames(valid)
    if not scored:
        logger.info("retake_needed: no decodable frames in burst")
        return None, STATUS_RETAKE

    for index, score, _frame in scored:
        logger.debug("ranked frame[%s] sharpness=%.2f", index, score)

    best_index, best_score, best_frame = scored[0]
    logger.info(
        "best frame[%s] sharpness=%.2f (min_sharpness=%.2f)",
        best_index,
        best_score,
        min_sharpness,
    )

    if best_score < min_sharpness:
        logger.info("retake_needed: best sharpness %.2f < %.2f", best_score, min_sharpness)
        return None, STATUS_RETAKE

    if not run_stage_a:
        return best_frame, STATUS_OK

    # Stage A on the top 1–2 sharpest frames that cleared the sharpness floor.
    candidates = [
        (index, score, frame)
        for index, score, frame in scored[:STAGE_A_CANDIDATES]
        if score >= min_sharpness
    ]
    for index, score, frame in candidates:
        if stage_a_face_ok(frame):
            logger.info(
                "Stage A passed frame[%s] sharpness=%.2f — safe for InsightFace (Stage B)",
                index,
                score,
            )
            return frame, STATUS_OK
        logger.debug("Stage A no usable face on frame[%s] sharpness=%.2f", index, score)

    logger.info("no_face_detected: sharp frames failed Stage A face gate")
    return None, STATUS_NO_FACE


def rotate_jpeg(jpeg_bytes: bytes, degrees_clockwise: int) -> bytes | None:
    """Rotate JPEG by 0/90/180/270 degrees clockwise. Returns None if undecodable."""
    degrees = degrees_clockwise % 360
    arr = np.frombuffer(jpeg_bytes, dtype=np.uint8)
    image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if image is None:
        return None

    if degrees == 90:
        image = cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE)
    elif degrees == 180:
        image = cv2.rotate(image, cv2.ROTATE_180)
    elif degrees == 270:
        image = cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE)
    elif degrees != 0:
        return None

    ok, encoded = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
    if not ok:
        return None
    return encoded.tobytes()


def sharpness_summary(frames: Iterable[bytes]) -> List[float]:
    """Helper for tests / logging."""
    return [jpeg_sharpness(frame) for frame in frames]
