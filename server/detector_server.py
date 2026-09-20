"""
Simple FastAPI server that loads YOLO26n via Ultralytics and exposes /detect
Endpoint accepts multipart file upload (form field 'file') and returns JSON detections.

Run:
python -m venv .venv
.venv\Scripts\activate
pip install ultralytics fastapi uvicorn opencv-python-headless numpy
uvicorn detector_server:app --host 0.0.0.0 --port 8000
"""
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse
import numpy as np
import cv2
from ultralytics import YOLO
from spatial import CalibrationConfig, bbox_geometry, bearing_degrees, estimate_distance_m

app = FastAPI()

# Load YOLO26n model (uses ultralytics package)
# You may need to download weights on first run; ultralytics will handle it.
MODEL = YOLO('yolov8n.pt')  # use yolov8n as a lightweight stand-in; replace with YOLO26n if available
CALIBRATION = CalibrationConfig()


def read_image_from_bytes(data: bytes):
    arr = np.frombuffer(data, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    return img


@app.post('/detect')
async def detect(file: UploadFile = File(...)):
    try:
        data = await file.read()
        img = read_image_from_bytes(data)
        if img is None:
            return JSONResponse(status_code=400, content={'error': 'unable to decode image'})

        results = MODEL(img)
        image_height, image_width = img.shape[:2]
        detections = []
        # results is a list (one per image)
        for r in results:
            boxes = r.boxes
            for b in boxes:
                xyxy = b.xyxy[0].tolist()  # [x1,y1,x2,y2]
                x1, y1, x2, y2 = xyxy
                w = x2 - x1
                h = y2 - y1
                conf = float(b.conf[0])
                cls = int(b.cls[0])
                label = r.names.get(cls, str(cls))
                geometry = bbox_geometry([x1, y1, w, h], image_width, image_height)
                detection = {
                    'label': label,
                    'confidence': conf,
                    'box': [float(x1), float(y1), float(w), float(h)],
                }
                if geometry is not None:
                    center_x = geometry['center']['x']
                    detection.update(geometry)
                    detection.update({
                        'bearing_deg': bearing_degrees(
                            center_x, image_width, CALIBRATION.hfov_deg
                        ),
                        'distance_m_estimate': estimate_distance_m(
                            geometry['height_px'], label, image_width, CALIBRATION
                        ),
                        'distance_quality': 'provisional',
                    })
                detections.append(detection)

        return {
            'image': {'width': image_width, 'height': image_height},
            'detections': detections,
        }
    except Exception as e:
        return JSONResponse(status_code=500, content={'error': str(e)})
