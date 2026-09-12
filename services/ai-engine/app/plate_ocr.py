import os
import re
from typing import Any

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter, ImageOps

try:
    from ultralytics import YOLO
except ImportError:  # pragma: no cover
    YOLO = None

try:
    import pytesseract
except ImportError:  # pragma: no cover
    pytesseract = None

PLATE_MODEL_PATH = os.getenv("PLATE_MODEL_PATH", "models/plate_detector.pt")
PLATE_CONFIDENCE_THRESHOLD = float(os.getenv("PLATE_CONFIDENCE_THRESHOLD", "0.30"))
OCR_CONFIDENCE_THRESHOLD = float(os.getenv("OCR_CONFIDENCE_THRESHOLD", "35"))
PLATE_IMAGE_SIZE = int(os.getenv("PLATE_IMAGE_SIZE", "640"))
OCR_PSM = int(os.getenv("OCR_PSM", "7"))

_plate_model = None
_plate_model_error: str | None = None


def load_plate_model() -> None:
    global _plate_model, _plate_model_error
    if YOLO is None:
        _plate_model_error = "ultralytics is not installed"
        return
    if not os.path.exists(PLATE_MODEL_PATH):
        _plate_model_error = f"Plate model file not found: {PLATE_MODEL_PATH}"
        return
    try:
        _plate_model = YOLO(PLATE_MODEL_PATH)
        _plate_model_error = None
    except Exception as exc:  # pragma: no cover
        _plate_model = None
        _plate_model_error = str(exc)


def plate_model_status() -> dict[str, Any]:
    return {
        "loaded": _plate_model is not None,
        "model_path": PLATE_MODEL_PATH,
        "error": _plate_model_error,
        "ocr_available": pytesseract is not None,
    }


def _normalise_plate(text: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", text.upper())


def _preprocess(crop: Image.Image) -> list[Image.Image]:
    gray = ImageOps.grayscale(crop)
    gray = ImageOps.autocontrast(gray)
    scale = max(2, min(4, 1200 // max(1, gray.width)))
    if scale > 1:
        gray = gray.resize((gray.width * scale, gray.height * scale))
    sharp = gray.filter(ImageFilter.SHARPEN)
    contrast = ImageEnhance.Contrast(sharp).enhance(1.8)
    return [gray, sharp, contrast]


def _ocr(crop: Image.Image) -> dict[str, Any]:
    if pytesseract is None:
        return {"text": None, "normalized_plate": None, "confidence": 0.0, "engine": "unavailable"}

    candidates: list[dict[str, Any]] = []
    for image in _preprocess(crop):
        data = pytesseract.image_to_data(
            image,
            config=f"--psm {OCR_PSM} -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
            output_type=pytesseract.Output.DICT,
        )
        parts: list[str] = []
        confidences: list[float] = []
        for text, conf in zip(data.get("text", []), data.get("conf", [])):
            clean = _normalise_plate(text)
            try:
                score = float(conf)
            except (TypeError, ValueError):
                score = -1
            if clean and score >= 0:
                parts.append(clean)
                confidences.append(score)
        candidate = _normalise_plate("".join(parts))
        if candidate:
            candidates.append({
                "text": candidate,
                "confidence": round(sum(confidences) / len(confidences), 2) if confidences else 0.0,
            })

    if not candidates:
        return {"text": None, "normalized_plate": None, "confidence": 0.0, "engine": "tesseract"}
    best = max(candidates, key=lambda item: item["confidence"])
    return {
        "text": best["text"],
        "normalized_plate": best["text"],
        "confidence": best["confidence"],
        "engine": "tesseract",
    }


def detect_and_read(image: Image.Image) -> list[dict[str, Any]]:
    if _plate_model is None:
        raise RuntimeError(_plate_model_error or "Plate detection model is not loaded")

    frame = np.asarray(image.convert("RGB"))
    results = _plate_model.predict(
        source=frame,
        conf=PLATE_CONFIDENCE_THRESHOLD,
        imgsz=PLATE_IMAGE_SIZE,
        verbose=False,
    )

    height, width = frame.shape[:2]
    detections: list[dict[str, Any]] = []
    for result in results:
        boxes = result.boxes
        if boxes is None:
            continue
        for box in boxes:
            xyxy = [float(v) for v in box.xyxy[0].tolist()]
            x1, y1, x2, y2 = [max(0, int(round(v))) for v in xyxy]
            x1, x2 = min(x1, width), min(x2, width)
            y1, y2 = min(y1, height), min(y2, height)
            if x2 <= x1 or y2 <= y1:
                continue

            crop = Image.fromarray(frame[y1:y2, x1:x2])
            ocr = _ocr(crop)
            detections.append({
                "bbox": [round(v, 2) for v in xyxy],
                "confidence": round(float(box.conf[0].item()), 4),
                "ocr": ocr,
            })
    return detections
