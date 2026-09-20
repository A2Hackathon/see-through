"""
Real face-recognition service for familiar-face enrollment and matching.

This module is intentionally separated from detector_server.py so that:
- detector_server.py handles object/person detection and hazard awareness
- face_service.py handles face enrollment, embedding extraction, and recognition

Run with:
    python -m venv .venv
    .venv\Scripts\activate
    pip install fastapi uvicorn insightface opencv-python-headless numpy sqlite-utils
    uvicorn face_service:app --host 0.0.0.0 --port 8001

Required packages:
    
"""

import json
import sqlite3
from typing import List

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

try:
    from insightface.app import FaceAnalysis
except ImportError as exc:  # pragma: no cover - runtime dependency check
    raise RuntimeError(
        "insightface is required for face embedding extraction. "
        "Install it with: pip install insightface"
    ) from exc

app = FastAPI(title="Familiar Face Recognition Service")
DB_PATH = "known_faces.db"

try:
    face_app = FaceAnalysis(name="buffalo_l")
    face_app.prepare(ctx_id=0, det_size=(640, 640))
except Exception:  # pragma: no cover - fails only if the model cannot initialize
    face_app = None


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS people (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            relationship TEXT NOT NULL,
            embedding TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.commit()
    conn.close()


def read_image_from_bytes(data: bytes) -> np.ndarray:
    arr = np.frombuffer(data, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Unable to decode uploaded image")
    return img


def extract_embeddings(image: np.ndarray):
    if face_app is None:
        raise RuntimeError("FaceAnalysis model failed to initialize")

    faces = face_app.get(image)
    if len(faces) == 0:
        raise ValueError("No face detected in the image")

    return [face.embedding.astype(np.float32) for face in faces]


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    a = np.asarray(a, dtype=np.float32)
    b = np.asarray(b, dtype=np.float32)
    denom = np.linalg.norm(a) * np.linalg.norm(b)
    if denom == 0:
        return 0.0
    return float(np.dot(a, b) / denom)


def select_identity_embeddings(face_embeddings):
    """Choose the recurring face across enrollment photos."""
    clusters = []
    for source_name, embedding in face_embeddings:
        best_cluster = None
        best_score = 0.0
        for cluster in clusters:
            centroid = np.mean(cluster["embeddings"], axis=0)
            score = cosine_similarity(embedding, centroid)
            if score >= 0.55 and score > best_score:
                best_cluster = cluster
                best_score = score

        if best_cluster is None:
            clusters.append({"embeddings": [embedding], "sources": [source_name]})
        else:
            best_cluster["embeddings"].append(embedding)
            best_cluster["sources"].append(source_name)

    clusters.sort(key=lambda cluster: len(set(cluster["sources"])), reverse=True)
    selected_cluster = clusters[0]
    selected = []
    centroid = np.mean(selected_cluster["embeddings"], axis=0)
    for source_name in set(selected_cluster["sources"]):
        candidates = [
            embedding
            for embedding, current_source in zip(
                selected_cluster["embeddings"], selected_cluster["sources"]
            )
            if current_source == source_name
        ]
        selected.append(
            max(candidates, key=lambda embedding: cosine_similarity(embedding, centroid))
        )
    return selected


def read_stored_embeddings(raw_embedding: str):
    stored = json.loads(raw_embedding)
    if stored and isinstance(stored[0], list):
        return [np.asarray(embedding, dtype=np.float32) for embedding in stored]
    return [np.asarray(stored, dtype=np.float32)]


async def build_embedding_json(files: List[UploadFile]) -> str:
    if not files:
        raise HTTPException(status_code=400, detail="At least one image is required")

    face_embeddings = []
    for file in files:
        data = await file.read()
        try:
            image = read_image_from_bytes(data)
            embeddings = extract_embeddings(image)
            face_embeddings.extend(
                (file.filename or "", embedding) for embedding in embeddings
            )
        except Exception as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Could not embed image '{file.filename}': {str(exc)}",
            ) from exc

    if not face_embeddings:
        raise HTTPException(status_code=400, detail="No valid face embeddings were created")

    selected_embeddings = select_identity_embeddings(face_embeddings)
    return json.dumps([embedding.tolist() for embedding in selected_embeddings])


@app.on_event("startup")
def startup() -> None:
    init_db()


@app.post("/enroll")
async def enroll(
    name: str = Form(...),
    relationship: str = Form(...),
    files: List[UploadFile] = File(...),
):
    emb_json = await build_embedding_json(files)

    conn = get_db()
    cursor = conn.execute(
        "INSERT INTO people (name, relationship, embedding) VALUES (?, ?, ?)",
        (name.strip(), relationship.strip(), emb_json),
    )
    conn.commit()
    person_id = cursor.lastrowid
    conn.close()

    return {
        "success": True,
        "person_id": person_id,
        "name": name.strip(),
        "relationship": relationship.strip(),
    }


@app.put("/people/{person_id}")
async def update_person(
    person_id: int,
    name: str = Form(...),
    relationship: str = Form(...),
    files: List[UploadFile] = File(...),
):
    conn = get_db()
    exists = conn.execute(
        "SELECT 1 FROM people WHERE id = ?", (person_id,)
    ).fetchone()
    conn.close()
    if exists is None:
        raise HTTPException(status_code=404, detail="Person not found")

    emb_json = await build_embedding_json(files)

    conn = get_db()
    cursor = conn.execute(
        """
        UPDATE people
        SET name = ?, relationship = ?, embedding = ?
        WHERE id = ?
        """,
        (name.strip(), relationship.strip(), emb_json, person_id),
    )
    conn.commit()
    rows_affected = cursor.rowcount
    conn.close()

    if rows_affected == 0:
        raise HTTPException(status_code=404, detail="Person not found")

    return {
        "success": True,
        "person_id": person_id,
        "name": name.strip(),
        "relationship": relationship.strip(),
    }


@app.post("/face_score")
async def face_score(file: UploadFile = File(...)):
    """
    Cheap orientation helper: detect faces only (no DB match).
    Used to pick which 0/90/180/270 rotation looks upright.
    """
    try:
        payload = await file.read()
        image = read_image_from_bytes(payload)
    except Exception as exc:
        return JSONResponse(
            status_code=400,
            content={"error": f"Could not read image: {str(exc)}"},
        )

    if face_app is None:
        return {"face_count": 0, "max_det_score": 0.0, "max_face_area": 0.0}

    faces = face_app.get(image)
    if not faces:
        return {"face_count": 0, "max_det_score": 0.0, "max_face_area": 0.0}

    det_scores = [float(face.det_score) for face in faces]
    areas = []
    for face in faces:
        x1, y1, x2, y2 = face.bbox.astype(float)
        areas.append(max(0.0, x2 - x1) * max(0.0, y2 - y1))

    return {
        "face_count": len(faces),
        "max_det_score": max(det_scores),
        "max_face_area": max(areas) if areas else 0.0,
    }


@app.post("/verify")
async def verify(file: UploadFile = File(...)):
    try:
        payload = await file.read()
        image = read_image_from_bytes(payload)
        query_embeddings = extract_embeddings(image)
    except Exception as exc:
        return JSONResponse(
            status_code=400,
            content={"error": f"Could not verify uploaded image: {str(exc)}"},
        )

    conn = get_db()
    rows = conn.execute(
        "SELECT id, name, relationship, embedding FROM people"
    ).fetchall()
    conn.close()

    best_id = None
    best_name = None
    best_relationship = None
    best_score = -1.0

    for row in rows:
        known_embeddings = read_stored_embeddings(row["embedding"])
        score = max(
            cosine_similarity(query_embedding, known_embedding)
            for query_embedding in query_embeddings
            for known_embedding in known_embeddings
        )
        if score > best_score:
            best_id = row["id"]
            best_name = row["name"]
            best_relationship = row["relationship"]
            best_score = score

    threshold = 0.55
    if best_name is None or best_score < threshold:
        return {
            "matched": False,
            "name": None,
            "relationship": None,
            "score": float(best_score if best_score >= 0 else 0.0),
            "threshold": threshold,
        }

    return {
        "matched": True,
        "id": best_id,
        "name": best_name,
        "relationship": best_relationship,
        "score": float(best_score),
        "threshold": threshold,
    }


@app.delete("/people/{person_id}")
async def delete_person(person_id: int):
    conn = get_db()
    cursor = conn.execute("DELETE FROM people WHERE id = ?", (person_id,))
    conn.commit()
    rows_affected = cursor.rowcount
    conn.close()
    if rows_affected == 0:
        raise HTTPException(status_code=404, detail="Person not found")
    return {"success": True, "message": f"Person {person_id} deleted successfully"}


@app.get("/health")
def health():
    return {"status": "ok"}
