"""
Snowflake Cortex client for spoken cues, event logging, and personal reminders.

Never sends photos. Only structured scene JSON (names, distances, place).
If SNOWFLAKE_PAT is unset, every public function no-ops so glasses stay live.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import time
import uuid
from pathlib import Path
from typing import Any, Optional

import httpx

NARRATE_TIMEOUT_S = 6.0
DAY_TIMEOUT_S = 10.0
WARM_TIMEOUT_S = 30.0
DEDUP_SECONDS = 20.0
IMPORTANT_HAZARDS = {"person", "car", "stop sign"}
DEFAULT_USUAL_START = 7
DEFAULT_USUAL_END = 19
MIN_EVENTS_FOR_USUAL_HOURS = 6
MIN_HOUR_SPAN_FOR_USUAL = 3
DEFAULT_RADIUS_M = 120.0
LEAVE_RADIUS_M = 180.0
MAX_GPS_ACCURACY_M = 250.0
_PLACE_PATH = Path(__file__).with_name(".place.json")
_SPACES_PATH = Path(__file__).with_name(".safe_spaces.json")

_ENV_LOADED = False
_use_sql_complete: Optional[bool] = None
_last_signature: Optional[str] = None
_last_signature_at = 0.0
_last_spoken: Optional[str] = None
_last_known_person: Optional[str] = None
_last_known_person_at = 0.0
_safe_spaces: list[dict] = []
_current_space_id: Optional[str] = None
_routine_reminder: Optional[str] = None
_alert_decision: Optional[str] = None
_last_gps: Optional[dict] = None
_usual_hours_cache: Optional[dict] = None
_usual_hours_at = 0.0


def _load_env() -> None:
    global _ENV_LOADED
    if _ENV_LOADED:
        return
    path = Path(__file__).with_name(".env")
    if path.exists():
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    _ENV_LOADED = True
    _load_saved_place()


def _configured() -> bool:
    _load_env()
    return bool(os.environ.get("SNOWFLAKE_ACCOUNT_URL") and os.environ.get("SNOWFLAKE_PAT"))


def _account_url() -> str:
    return os.environ["SNOWFLAKE_ACCOUNT_URL"].rstrip("/")


def _pat() -> str:
    return os.environ["SNOWFLAKE_PAT"]


def _model() -> str:
    return os.environ.get("SNOWFLAKE_MODEL") or "llama3.1-8b"


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {_pat()}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-Snowflake-Authorization-Token-Type": "PROGRAMMATIC_ACCESS_TOKEN",
    }


def get_place() -> str:
    space = get_current_space()
    return space["name"] if space else "away"


def get_place_address() -> Optional[str]:
    space = get_current_space()
    return space["address"] if space else None


def inside_safe_zone() -> bool:
    return get_current_space() is not None


def get_routine_reminder() -> Optional[str]:
    return _routine_reminder


def list_safe_spaces() -> list[dict]:
    _load_env()
    return [dict(space) for space in _safe_spaces]


def get_current_space() -> Optional[dict]:
    _load_env()
    if not _current_space_id:
        return None
    for space in _safe_spaces:
        if space["id"] == _current_space_id:
            return dict(space)
    return None


def place_state() -> dict:
    space = get_current_space()
    return {
        "place": get_place(),
        "address": space["address"] if space else None,
        "space_id": space["id"] if space else None,
        "inside_safe_zone": inside_safe_zone(),
        "spaces": list_safe_spaces(),
        "alert": get_routine_reminder(),
        "gps": dict(_last_gps) if _last_gps else None,
        "suspicious": bool(_routine_reminder),
    }


def _parse_coord(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    radius = 6371000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lng2 - lng1)
    a = (
        math.sin(d_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    )
    return 2 * radius * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _normalize_space(raw: Any) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    name = " ".join(str(raw.get("name") or "").split())
    address = " ".join(str(raw.get("address") or "").split())
    if not name or not address:
        return None
    lat = _parse_coord(raw.get("lat") if raw.get("lat") is not None else raw.get("latitude"))
    lng = _parse_coord(raw.get("lng") if raw.get("lng") is not None else raw.get("longitude"))
    radius = _parse_coord(raw.get("radius_m")) or DEFAULT_RADIUS_M
    return {
        "id": str(raw.get("id") or uuid.uuid4()),
        "name": name,
        "address": address,
        "lat": lat,
        "lng": lng,
        "radius_m": radius,
    }


def _load_saved_place() -> None:
    global _safe_spaces, _current_space_id
    _safe_spaces = []
    _current_space_id = None
    data = None
    try:
        data = json.loads(_SPACES_PATH.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        data = None
    if isinstance(data, dict):
        spaces = []
        for raw in data.get("spaces") or []:
            space = _normalize_space(raw)
            if space:
                spaces.append(space)
        _safe_spaces = spaces
        current = data.get("current_id")
        if current and any(space["id"] == current for space in _safe_spaces):
            _current_space_id = str(current)
        return
    try:
        old = json.loads(_PLACE_PATH.read_text(encoding="utf-8"))
        if str(old.get("place") or "").lower() == "away":
            _current_space_id = None
    except Exception:  # noqa: BLE001
        pass


def _save_spaces() -> None:
    try:
        _SPACES_PATH.write_text(
            json.dumps(
                {"spaces": list_safe_spaces(), "current_id": _current_space_id},
                indent=2,
            ),
            encoding="utf-8",
        )
    except Exception as exc:  # noqa: BLE001
        print("Could not persist safe spaces:", exc)


def add_safe_space(
    name: str,
    address: str,
    lat: Any = None,
    lng: Any = None,
    radius_m: Any = None,
) -> dict:
    global _current_space_id, _routine_reminder
    space = _normalize_space(
        {"name": name, "address": address, "lat": lat, "lng": lng, "radius_m": radius_m}
    )
    if not space:
        raise ValueError("Name and address are required.")
    _load_env()
    _safe_spaces.append(space)
    _routine_reminder = None
    _save_spaces()
    return dict(space)


def remove_safe_space(space_id: str) -> None:
    global _safe_spaces, _current_space_id, _routine_reminder, _alert_decision
    _load_env()
    remaining = [space for space in _safe_spaces if space["id"] != space_id]
    if len(remaining) == len(_safe_spaces):
        raise ValueError("Safe space not found.")
    _safe_spaces = remaining
    if _current_space_id == space_id:
        _current_space_id = None
        _routine_reminder = None
        _alert_decision = None
    _save_spaces()


def set_current_space(space_id: Optional[str]) -> str:
    global _current_space_id, _routine_reminder, _alert_decision
    _load_env()
    if not space_id or str(space_id).strip().lower() in {"away", "none"}:
        leaving = _current_space_id is not None
        _current_space_id = None
        if leaving:
            _routine_reminder = None
            _alert_decision = None
        _save_spaces()
        return get_place()
    wanted = str(space_id).strip()
    for space in _safe_spaces:
        if space["id"] == wanted:
            _current_space_id = space["id"]
            _routine_reminder = None
            _alert_decision = None
            _save_spaces()
            return get_place()
    raise ValueError("Unknown safe space.")


def set_place(place: str) -> str:
    """Set current location: 'away', a space id, or a space name."""
    normalized = str(place or "").strip()
    if not normalized or normalized.lower() == "away":
        return set_current_space(None)
    if normalized.lower() == "home":
        for space in list_safe_spaces():
            if space["name"].lower() == "home":
                return set_current_space(space["id"])
        if _safe_spaces:
            return set_current_space(_safe_spaces[0]["id"])
        return set_current_space(None)
    for space in list_safe_spaces():
        if space["id"] == normalized or space["name"].lower() == normalized.lower():
            return set_current_space(space["id"])
    return set_current_space(None)


def apply_gps(lat: Any, lng: Any, accuracy: Any = None) -> dict:
    """Match live phone GPS against geocoded safe-space addresses."""
    global _last_gps
    _load_env()
    parsed_lat = _parse_coord(lat)
    parsed_lng = _parse_coord(lng)
    parsed_accuracy = _parse_coord(accuracy)
    _last_gps = {
        "lat": parsed_lat,
        "lng": parsed_lng,
        "accuracy": parsed_accuracy,
        "distance_m": None,
        "nearest_name": None,
        "space_id": None,
        "skipped": None,
    }
    if parsed_lat is None or parsed_lng is None:
        _last_gps["skipped"] = "invalid"
        return place_state()
    geocoded = [
        space
        for space in _safe_spaces
        if space.get("lat") is not None and space.get("lng") is not None
    ]
    if not geocoded:
        _last_gps["skipped"] = "no_geocoded_spaces"
        return place_state()
    if parsed_accuracy is not None and parsed_accuracy > MAX_GPS_ACCURACY_M:
        _last_gps["skipped"] = "accuracy"
        return place_state()

    current = get_current_space()
    nearest = None
    nearest_dist = None
    matched = None
    matched_dist = None
    for space in geocoded:
        dist = _haversine_m(parsed_lat, parsed_lng, space["lat"], space["lng"])
        if nearest_dist is None or dist < nearest_dist:
            nearest = space
            nearest_dist = dist
        radius = float(space.get("radius_m") or DEFAULT_RADIUS_M)
        if current and current["id"] == space["id"]:
            radius = max(radius, LEAVE_RADIUS_M)
        if dist <= radius and (matched_dist is None or dist < matched_dist):
            matched = space
            matched_dist = dist

    _last_gps["nearest_name"] = nearest["name"] if nearest else None
    _last_gps["distance_m"] = round(nearest_dist, 1) if nearest_dist is not None else None
    _last_gps["space_id"] = matched["id"] if matched else None
    matched_id = matched["id"] if matched else None
    current_id = current["id"] if current else None
    if matched_id != current_id:
        set_current_space(matched_id)
    return place_state()


def _sql_str(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def _bearing_side(bearing: Any) -> Optional[str]:
    try:
        degrees = float(bearing)
    except (TypeError, ValueError):
        return None
    if degrees <= -12:
        return "left"
    if degrees >= 12:
        return "right"
    return "ahead"


def _hazard_confidence(label: str, confidence: Any) -> bool:
    try:
        score = float(confidence)
    except (TypeError, ValueError):
        score = 0.0
    if label == "stop sign":
        return True
    if label == "person":
        return score >= 0.5
    return score >= 0.6


def compact_obstacles(detections: Optional[list] = None, *, matched: bool = False) -> list[dict]:
    compact = []
    for detection in detections or []:
        label = str(detection.get("label") or "").lower().strip().replace("  ", " ")
        if label not in IMPORTANT_HAZARDS or not _hazard_confidence(label, detection.get("confidence")):
            continue
        if matched and label == "person":
            continue
        distance = detection.get("distance_m_estimate")
        try:
            distance_m = round(float(distance), 1) if distance is not None else None
        except (TypeError, ValueError):
            distance_m = None
        compact.append(
            {
                "label": label,
                "side": _bearing_side(detection.get("bearing_deg")),
                "distance_m": distance_m,
            }
        )
    compact.sort(
        key=lambda item: item["distance_m"] if item["distance_m"] is not None else 999
    )
    return compact[:4]


def scene_signature(scene: dict) -> str:
    matched_name = (scene.get("name") or "") if scene.get("matched") else ""
    obstacles = compact_obstacles(scene.get("detections"), matched=bool(scene.get("matched")))
    parts = [matched_name]
    for item in obstacles:
        parts.append(f"{item['label']}:{item['side']}:{item['distance_m']}")
    parts.append(get_place())
    return "|".join(parts)


def should_announce(scene: dict) -> bool:
    if scene.get("matched") and scene.get("name"):
        return True
    return len(compact_obstacles(scene.get("detections"), matched=False)) > 0


def _is_duplicate(signature: str) -> bool:
    if not signature or signature == "|home" or signature == "|away":
        return False
    if _last_signature != signature:
        return False
    return (time.monotonic() - _last_signature_at) < DEDUP_SECONDS


def _remember_signature(signature: str) -> None:
    global _last_signature, _last_signature_at
    _last_signature = signature
    _last_signature_at = time.monotonic()


def compact_scene(scene: dict) -> dict:
    matched = bool(scene.get("matched"))
    payload = {
        "matched": matched,
        "name": scene.get("name") if matched else None,
        "relationship": scene.get("relationship") if matched else None,
        "obstacles": compact_obstacles(scene.get("detections"), matched=matched),
        "place": get_place(),
        "address": get_place_address(),
        "inside_safe_zone": inside_safe_zone(),
        "safe_spaces": [space["name"] for space in list_safe_spaces()],
    }
    person_distance = None
    for detection in scene.get("detections") or []:
        label = str(detection.get("label") or "").lower().strip()
        if label != "person":
            continue
        try:
            person_distance = round(float(detection.get("distance_m_estimate")), 1)
            payload["person_side"] = _bearing_side(detection.get("bearing_deg"))
            payload["person_distance_m"] = person_distance
            break
        except (TypeError, ValueError):
            continue
    return payload


def summary_text(scene: dict) -> str:
    compact = compact_scene(scene)
    parts = []
    if compact["matched"] and compact["name"]:
        relation = f" ({compact['relationship']})" if compact["relationship"] else ""
        distance = compact.get("person_distance_m")
        side = compact.get("person_side")
        extra = []
        if side:
            extra.append(side)
        if distance is not None:
            extra.append(f"{distance}m")
        where = f" {' '.join(extra)}" if extra else ""
        parts.append(f"{compact['name']}{relation}{where}")
    for item in compact["obstacles"]:
        where = []
        if item["side"]:
            where.append(item["side"])
        if item["distance_m"] is not None:
            where.append(f"{item['distance_m']}m")
        suffix = f" {' '.join(where)}" if where else ""
        parts.append(f"{item['label']}{suffix}")
    parts.append(f"place={compact['place']}")
    if compact.get("address"):
        parts.append(f"address={compact['address']}")
    parts.append("inside_safe_zone=" + ("true" if compact["inside_safe_zone"] else "false"))
    return "; ".join(parts)


def _clip_spoken(text: str) -> str:
    cleaned = " ".join((text or "").strip().strip('"').split())
    for separator in (". ", "! ", "? "):
        if separator in cleaned:
            cleaned = cleaned.split(separator)[0].rstrip(".!?") + "."
            break
    words = cleaned.split()
    if len(words) > 24:
        cleaned = " ".join(words[:24]).rstrip(".,;:") + "."
    return cleaned


def _extract_choice_text(payload: Any) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    choices = payload.get("choices") or []
    if choices:
        message = choices[0].get("message") or {}
        content = message.get("content")
        if isinstance(content, str) and content.strip():
            return content.strip()
        if isinstance(content, list):
            bits = [
                part.get("text")
                for part in content
                if isinstance(part, dict) and part.get("text")
            ]
            joined = " ".join(bits).strip()
            if joined:
                return joined
    content = payload.get("content")
    if isinstance(content, str) and content.strip():
        return content.strip()
    return None


def _sql_result_text(payload: Any) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    data = payload.get("data")
    if isinstance(data, list) and data:
        row = data[0]
        if isinstance(row, list) and row:
            value = row[0]
            return str(value).strip() if value is not None else None
        if isinstance(row, dict):
            for value in row.values():
                if value is not None:
                    return str(value).strip()
    return None


def _sql_rows(payload: Any) -> list[dict]:
    if not isinstance(payload, dict):
        return []
    metadata = payload.get("resultSetMetaData") or {}
    names = [
        (col.get("name") or "").lower()
        for col in metadata.get("rowType") or []
    ]
    rows = []
    for raw in payload.get("data") or []:
        if isinstance(raw, dict):
            rows.append({str(key).lower(): value for key, value in raw.items()})
            continue
        if isinstance(raw, list):
            rows.append({names[i]: raw[i] for i in range(min(len(names), len(raw)))})
    return rows


async def _run_sql(statement: str, timeout: float) -> Optional[dict]:
    if not _configured():
        return None
    url = f"{_account_url()}/api/v2/statements"
    body = {
        "statement": statement,
        "warehouse": os.environ.get("SNOWFLAKE_WAREHOUSE") or "SEE_THROUGH_WH",
        "database": os.environ.get("SNOWFLAKE_DATABASE") or "SEE_THROUGH",
        "schema": os.environ.get("SNOWFLAKE_SCHEMA") or "APP",
        "timeout": max(10, int(timeout)),
    }
    async with httpx.AsyncClient(timeout=timeout + 5) as client:
        response = await client.post(url, headers=_headers(), json=body)
        payload = _safe_json(response)
        if response.status_code == 200:
            return payload
        handle = (payload or {}).get("statementHandle")
        status_url = (payload or {}).get("statementStatusUrl")
        if response.status_code not in {202, 408} or not handle:
            print(f"Snowflake SQL {response.status_code}: {response.text[:300]}")
            return None
        poll_url = (
            status_url
            if status_url and status_url.startswith("http")
            else f"{_account_url()}/api/v2/statements/{handle}"
        )
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            await asyncio.sleep(0.5)
            polled = await client.get(poll_url, headers=_headers())
            if polled.status_code == 200:
                return _safe_json(polled)
            if polled.status_code not in {202, 408}:
                print(f"Snowflake SQL poll {polled.status_code}: {polled.text[:300]}")
                return None
    return None


def _safe_json(response: httpx.Response) -> Optional[dict]:
    try:
        payload = response.json()
    except Exception:  # noqa: BLE001
        return None
    return payload if isinstance(payload, dict) else None


async def _complete_rest(prompt: str, timeout: float) -> tuple[Optional[str], Optional[str]]:
    url = f"{_account_url()}/api/v2/cortex/v1/chat/completions"
    body = {
        "model": _model(),
        "messages": [
            {"role": "system", "content": "You write short, calm assistive-tech speech. No emoji."},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": 80,
        "temperature": 0.2,
    }
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(url, headers=_headers(), json=body)
    if response.status_code >= 400:
        return None, f"{response.status_code} {response.text[:400]}"
    return _extract_choice_text(_safe_json(response)), None


async def _complete_sql(prompt: str, timeout: float) -> Optional[str]:
    escaped = prompt.replace("$$", " ")
    statement = (
        f"SELECT SNOWFLAKE.CORTEX.COMPLETE({_sql_str(_model())}, $${escaped}$$)"
    )
    payload = await _run_sql(statement, timeout)
    return _sql_result_text(payload)


async def complete(prompt: str, timeout: float) -> Optional[str]:
    global _use_sql_complete
    if not _configured():
        return None
    if _use_sql_complete is None:
        _use_sql_complete = os.environ.get("SNOWFLAKE_COMPLETE_VIA_SQL", "").lower() in {
            "1",
            "true",
            "yes",
        }
    if not _use_sql_complete:
        text, error = await _complete_rest(prompt, timeout)
        if text:
            return text
        if error and ("trial" in error.lower() or error.startswith("403")):
            print("Cortex REST blocked; falling back to SQL COMPLETE")
            _use_sql_complete = True
        elif error:
            print("Cortex REST failed:", error)
            return await _complete_sql(prompt, timeout)
    return await _complete_sql(prompt, timeout)


async def wake_warehouse() -> None:
    """Resume the warehouse so the first spoken cue is not a timeout."""
    if not _configured():
        print("Snowflake unset; skipping warehouse warm-up")
        return
    warehouse = os.environ.get("SNOWFLAKE_WAREHOUSE") or "SEE_THROUGH_WH"
    print(f"Warming Snowflake warehouse {warehouse}...")
    try:
        resumed = await _run_sql(
            f"ALTER WAREHOUSE {warehouse} RESUME",
            WARM_TIMEOUT_S,
        )
        ping = await _run_sql("SELECT 1", WARM_TIMEOUT_S)
        if ping or resumed:
            print("Snowflake warehouse is awake")
        else:
            print("Snowflake warehouse warm-up did not return a result")
    except Exception as exc:  # noqa: BLE001
        print("Snowflake warehouse warm-up failed:", exc)


def _default_usual_hours(event_count: int = 0) -> dict:
    return {
        "start_hour": DEFAULT_USUAL_START,
        "end_hour": DEFAULT_USUAL_END,
        "learned": False,
        "event_count": event_count,
    }


def _is_unusual_hour(hour: int, usual: dict) -> bool:
    start = int(usual.get("start_hour", DEFAULT_USUAL_START))
    end = int(usual.get("end_hour", DEFAULT_USUAL_END))
    if start <= end:
        return hour < start or hour >= end
    return end <= hour < start


async def fetch_usual_hours() -> dict:
    """Learn the walk window from glasses history; fall back to 7-19 until enough data."""
    global _usual_hours_cache, _usual_hours_at
    if _usual_hours_cache and (time.monotonic() - _usual_hours_at) < 60:
        return _usual_hours_cache
    fallback = _default_usual_hours()
    if not _configured():
        return fallback
    statement = (
        "SELECT HOUR(TS) AS HR, COUNT(*) AS N FROM SCENE_EVENTS GROUP BY 1 ORDER BY 1"
    )
    payload = await _run_sql(statement, DAY_TIMEOUT_S)
    counts = []
    for row in _sql_rows(payload):
        try:
            hour = int(row.get("hr"))
            count = int(row.get("n") or 0)
        except (TypeError, ValueError):
            continue
        if 0 <= hour <= 23 and count > 0:
            counts.append((hour, count))
    total = sum(count for _, count in counts)
    if total < MIN_EVENTS_FOR_USUAL_HOURS:
        fallback["event_count"] = total
        _usual_hours_cache = fallback
        _usual_hours_at = time.monotonic()
        return fallback
    span = counts[-1][0] - counts[0][0]
    if span < MIN_HOUR_SPAN_FOR_USUAL:
        fallback["event_count"] = total
        _usual_hours_cache = fallback
        _usual_hours_at = time.monotonic()
        return fallback
    cumulative = 0
    start = counts[0][0]
    end = min(24, counts[-1][0] + 1)
    low = total * 0.1
    high = total * 0.9
    started = False
    for hour, count in counts:
        nxt = cumulative + count
        if not started and nxt >= low:
            start = hour
            started = True
        if cumulative < high:
            end = min(24, hour + 1)
        cumulative = nxt
    if end <= start:
        end = min(24, start + 1)
    learned = {
        "start_hour": start,
        "end_hour": end,
        "learned": True,
        "event_count": total,
    }
    _usual_hours_cache = learned
    _usual_hours_at = time.monotonic()
    return learned


async def narrate(scene: dict, *, force: bool = False) -> Optional[str]:
    global _last_spoken, _last_known_person, _last_known_person_at
    global _last_spoken, _last_known_person
    if not should_announce(scene):
        return None
    signature = scene_signature(scene)
    if not force and _is_duplicate(signature):
        return None
    compact = compact_scene(scene)
    prompt = (
        "Write one spoken cue for a blind walker. Rules: one sentence, at most "
        "20 words; use left/right/ahead; nearest first; name a person only if "
        "matched is true; never say someone is unknown; unmatched people are "
        "just a person obstacle; calm; no preface.\n"
        f"Scene: {json.dumps(compact)}"
    )
    try:
        text = await asyncio.wait_for(complete(prompt, NARRATE_TIMEOUT_S), NARRATE_TIMEOUT_S)
    except Exception as exc:  # noqa: BLE001
        print("Snowflake narrate failed:", exc)
        text = None
    spoken = _clip_spoken(text) if text else None
    _remember_signature(signature)
    if spoken:
        _last_spoken = spoken
    if compact.get("matched") and compact.get("name"):
        relation = f", {compact['relationship']}" if compact.get("relationship") else ""
        _last_known_person = f"{compact['name']}{relation}"
        _last_known_person_at = time.time()
    return spoken


async def log_event(scene: dict) -> None:
    if not _configured() or not should_announce(scene):
        return
    obstacles = compact_obstacles(scene.get("detections"), matched=bool(scene.get("matched")))
    statement = (
        "INSERT INTO SCENE_EVENTS "
        "(MATCHED, PERSON_NAME, RELATIONSHIP, SCORE, OBSTACLES, PLACE, SUMMARY_TEXT) "
        "SELECT "
        f"{_sql_str(bool(scene.get('matched')))}, "
        f"{_sql_str(scene.get('name') if scene.get('matched') else None)}, "
        f"{_sql_str(scene.get('relationship') if scene.get('matched') else None)}, "
        f"{_sql_str(float(scene.get('score') or 0))}, "
        f"PARSE_JSON({_sql_str(json.dumps(obstacles))}), "
        f"{_sql_str(get_place())}, "
        f"{_sql_str(summary_text(scene))}"
    )
    try:
        await _run_sql(statement, DAY_TIMEOUT_S)
    except Exception as exc:  # noqa: BLE001
        print("Snowflake log_event failed:", exc)


async def fetch_recent_events(limit: int = 20) -> list[dict]:
    if not _configured():
        return []
    statement = (
        "SELECT TO_VARCHAR(TS) AS TS, MATCHED, PERSON_NAME, RELATIONSHIP, "
        "PLACE, SUMMARY_TEXT FROM SCENE_EVENTS "
        f"ORDER BY TS DESC LIMIT {int(limit)}"
    )
    payload = await _run_sql(statement, DAY_TIMEOUT_S)
    return _sql_rows(payload)


async def _search_events(question: str, limit: int = 8) -> list[dict]:
    service = os.environ.get("SNOWFLAKE_SEARCH_SERVICE") or "SCENE_SEARCH"
    database = os.environ.get("SNOWFLAKE_DATABASE") or "SEE_THROUGH"
    schema = os.environ.get("SNOWFLAKE_SCHEMA") or "APP"
    url = (
        f"{_account_url()}/api/v2/databases/{database}/schemas/{schema}/"
        f"cortex-search-services/{service}:query"
    )
    body = {
        "query": question,
        "columns": ["SUMMARY_TEXT", "TS", "PERSON_NAME", "PLACE", "MATCHED"],
        "limit": limit,
    }
    try:
        async with httpx.AsyncClient(timeout=DAY_TIMEOUT_S) as client:
            response = await client.post(url, headers=_headers(), json=body)
        if response.status_code >= 400:
            print(f"Cortex Search {response.status_code}: {response.text[:200]}")
            return []
        payload = _safe_json(response) or {}
        results = payload.get("results") or payload.get("data") or []
        rows = []
        for item in results:
            if isinstance(item, dict):
                rows.append({str(key).lower(): value for key, value in item.items()})
        return rows
    except Exception as exc:  # noqa: BLE001
        print("Cortex Search failed:", exc)
        return []


def _spaces_for_llm() -> list[dict]:
    return [
        {"name": space["name"], "address": space["address"]}
        for space in list_safe_spaces()
    ]


def _hours_since_familiar() -> Optional[float]:
    if not _last_known_person or not _last_known_person_at:
        return None
    return round(max(0.0, time.time() - _last_known_person_at) / 3600, 1)


def _parse_classification(text: Optional[str]) -> Optional[dict]:
    if not text or not str(text).strip():
        return None
    cleaned = str(text).strip()
    if "```" in cleaned:
        cleaned = cleaned.replace("```json", "```")
        chunks = cleaned.split("```")
        if len(chunks) >= 2:
            cleaned = chunks[1]
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        payload = json.loads(cleaned[start : end + 1])
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def _fallback_suspicious_alert(unusual: bool, usual: dict) -> Optional[str]:
    if not unusual:
        return None
    start = usual.get("start_hour", DEFAULT_USUAL_START)
    end = usual.get("end_hour", DEFAULT_USUAL_END)
    return (
        "You are outside your saved places later than your usual routine "
        f"of {start}:00–{end}:00. Consider checking your surroundings."
    )


async def maybe_routine_reminder(events: Optional[list] = None) -> Optional[str]:
    """Create one wearer-facing reminder for clearly unusual activity."""
    global _routine_reminder, _alert_decision
    if inside_safe_zone() or not list_safe_spaces():
        _routine_reminder = None
        _alert_decision = None
        return None
    if _alert_decision == "normal":
        return None
    if _alert_decision == "suspicious" and _routine_reminder:
        return _routine_reminder

    rows = events if events is not None else await fetch_recent_events(12)
    hour = time.localtime().tm_hour
    usual = await fetch_usual_hours()
    unusual = _is_unusual_hour(hour, usual)
    hours_since = _hours_since_familiar()
    context = {
        "hour": hour,
        "unusual_hour": unusual,
        "usual_hours": usual,
        "inside_safe_zone": False,
        "safe_spaces": _spaces_for_llm(),
        "last_known_person": _last_known_person,
        "hours_since_familiar_face": hours_since,
        "recent": rows[:6],
    }
    prompt = (
        "You decide whether the wearer needs a calm personal routine reminder. "
        "Create one only if the situation is clearly unusual. Unusual: being "
        "outside every saved place "
        "outside usual hours; away late at night or before dawn; no familiar "
        "face for many hours while away at an odd time; clearly unlike recent "
        "daily pattern. Not suspicious: a daytime walk during usual hours, "
        "errands, or being away with little history in daytime. "
        "Reply with JSON only: {\"suspicious\": true or false, \"alert\": "
        "\"one calm sentence addressed directly to the wearer, or empty\"}. "
        "Do not mention family, caregivers, tracking, or monitoring. No markdown.\n"
        f"Context: {json.dumps(context)}"
    )
    classification = _parse_classification(await complete(prompt, DAY_TIMEOUT_S))
    suspicious = unusual
    alert_text = None
    if isinstance(classification, dict):
        flag = classification.get("suspicious")
        if isinstance(flag, bool):
            suspicious = bool(flag) or unusual
        elif isinstance(flag, str):
            suspicious = flag.strip().lower() in {"true", "yes", "1"} or unusual
        raw_alert = classification.get("alert")
        if isinstance(raw_alert, str) and raw_alert.strip():
            alert_text = raw_alert.strip()

    if not suspicious:
        _alert_decision = "normal"
        _routine_reminder = None
        print("Routine reminder skipped: ordinary activity")
        return None

    _alert_decision = "suspicious"
    _routine_reminder = alert_text or _fallback_suspicious_alert(unusual, usual) or (
        "This trip is different from your usual routine. Consider checking your surroundings."
    )
    return _routine_reminder


async def enrich_scene(scene: dict, *, force: bool = False) -> dict:
    """Narrate, log, and optionally alert. Safe to call when Snowflake is unset."""
    result = {
        "spoken_text": None,
        "skip_publish": False,
        "routine_reminder": None,
        "place": get_place(),
        "inside_safe_zone": inside_safe_zone(),
        "logged": False,
    }
    if not should_announce(scene):
        return result
    signature = scene_signature(scene)
    if not force and _is_duplicate(signature):
        result["skip_publish"] = True
        result["spoken_text"] = _last_spoken
        return result
    spoken = await narrate(scene, force=force)
    result["spoken_text"] = spoken
    if _configured():
        if force:
            await log_event(scene)
        else:
            asyncio.create_task(log_event(scene))
        result["logged"] = True
        if not inside_safe_zone():
            result["routine_reminder"] = await maybe_routine_reminder()
    return result
