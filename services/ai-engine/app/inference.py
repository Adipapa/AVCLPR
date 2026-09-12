import os
from typing import Any

import numpy as np
from PIL import Image

try:
    from ultralytics import YOLO
except ImportError:  # pragma: no cover
    YOLO = None

MODEL_PATH = os.getenv("VEHICLE_MODEL_PATH", "models/yolo11n.pt")
CONFIDENCE_THRESHOLD = float(os.getenv("AI_CONFIDENCE_THRESHOLD", "0.35"))
IMAGE_SIZE = int(os.getenv("AI_IMAGE_SIZE", "640"))

# COCO vehicle classes used by the first-stage detector.
VEHICLE_CLASSES = {
    2: "car",
    3: "motorcycle",
    5: "bus",
    7: "truck",
}

_model = None
_model_error: str | None = None


def load_model() -> None:
    global _model, _model_error
    if YOLO is None:
        _model_error = "ultralytics is not installed"
        return
    if not os.path.exists(MODEL_PATH):
        _model_error = f"Model file not found: {MODEL_PATH}"
        return
    try:
        _model = YOLO(MODEL_PATH)
        _model_error = None
    except Exception as exc:  # pragma: no cover
        _model = None
        _model_error = str(exc)


def model_status() -> dict[str, Any]:
    return {
        "loaded": _model is not None,
        "model_path": MODEL_PATH,
        "error": _model_error,
    }


def infer(image: Image.Image) -> list[dict[str, Any]]:
    if _model is None:
        raise RuntimeError(_model_error or "Vehicle model is not loaded")

    frame = np.asarray(image.convert("RGB"))
    results = _model.predict(
        source=frame,
        conf=CONFIDENCE_THRESHOLD,
        imgsz=IMAGE_SIZE,
        verbose=False,
    )

    detections: list[dict[str, Any]] = []
    for result in results:
        boxes = result.boxes
        if boxes is None:
            continue
        for box in boxes:
            class_id = int(box.cls[0].item())
            vehicle_type = VEHICLE_CLASSES.get(class_id)
            if vehicle_type is None:
                continue
            xyxy = [round(float(v), 2) for v in box.xyxy[0].tolist()]
            detections.append({
                "class_id": class_id,
                "vehicle_type": vehicle_type,
                "confidence": round(float(box.conf[0].item()), 4),
                "bbox": xyxy,
            })
    return detections
