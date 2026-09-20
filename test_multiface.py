import json
from pathlib import Path

import cv2
import numpy as np
from insightface.app import FaceAnalysis

ROOT = Path(__file__).resolve().parent
FILES = ["IMG_5456.jpeg", "IMG_6917.jpeg", "IMG_7020.jpeg", "IMG_8422.jpeg", "DSC00015.JPG"]
REFERENCE = "IMG_8422.jpeg"


def cosine(left: np.ndarray, right: np.ndarray) -> float:
    left = left.astype(np.float32)
    right = right.astype(np.float32)
    return float(np.dot(left, right) / (np.linalg.norm(left) * np.linalg.norm(right)))


model = FaceAnalysis(name="buffalo_l")
model.prepare(ctx_id=0, det_size=(640, 640))
faces_by_file = {}

for filename in FILES:
    image = cv2.imread(str(ROOT / filename))
    faces = model.get(image)
    faces_by_file[filename] = faces
    print(f"{filename}: {len(faces)} detected face(s)")
    for index, face in enumerate(faces):
        bbox = [round(float(value), 1) for value in face.bbox]
        print(f"  face {index}: bbox={bbox}, detection={float(face.det_score):.3f}")

reference_face = max(faces_by_file[REFERENCE], key=lambda face: float(face.det_score))
selected = {}
for filename, faces in faces_by_file.items():
    selected[filename] = max(faces, key=lambda face: cosine(reference_face.embedding, face.embedding))

print("\nSelected target-face scores against reference:")
for filename, face in selected.items():
    print(f"  {filename}: {cosine(reference_face.embedding, face.embedding):.4f}")

profile = np.mean(
    np.asarray([selected[filename].embedding for filename in FILES], dtype=np.float32),
    axis=0,
)
print("\nVerification against target-face profile:")
for filename in FILES:
    score = cosine(selected[filename].embedding, profile)
    print(f"  {filename}: {score:.4f} {'MATCH' if score >= 0.75 else 'below 0.75'}")

print("\nPrevious enrollment profile from known_faces.db:")
with __import__("sqlite3").connect(ROOT / "known_faces.db") as connection:
    row = connection.execute("SELECT embedding FROM people ORDER BY id DESC LIMIT 1").fetchone()
if row:
    stored = np.asarray(json.loads(row[0]), dtype=np.float32)
    for filename in FILES:
        print(f"  {filename}: {cosine(selected[filename].embedding, stored):.4f}")
