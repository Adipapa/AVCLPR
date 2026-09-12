import os
from io import BytesIO

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from pydantic import BaseModel
from PIL import Image

from .inference import infer, load_model, model_status
from .plate_ocr import detect_and_read, load_plate_model, plate_model_status

app = FastAPI(title="AVCLPR AI Engine", version="0.3.0")
AI_SERVICE_TOKEN = os.getenv("AI_SERVICE_TOKEN", "")


class HealthResponse(BaseModel):
    status: str
    service: str
    model_loaded: bool
    model_path: str
    model_error: str | None = None
    plate_model_loaded: bool
    plate_model_path: str
    plate_model_error: str | None = None
    ocr_available: bool


@app.on_event("startup")
def startup() -> None:
    load_model()
    load_plate_model()


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    vehicle = model_status()
    plate = plate_model_status()
    ready = bool(vehicle["loaded"] and plate["loaded"] and plate["ocr_available"])
    return HealthResponse(
        status="ok" if ready else "degraded",
        service="ai-engine",
        model_loaded=bool(vehicle["loaded"]),
        model_path=str(vehicle["model_path"]),
        model_error=vehicle["error"],
        plate_model_loaded=bool(plate["loaded"]),
        plate_model_path=str(plate["model_path"]),
        plate_model_error=plate["error"],
        ocr_available=bool(plate["ocr_available"]),
    )


def require_service_token(x_ai_service_token: str | None) -> None:
    if AI_SERVICE_TOKEN and x_ai_service_token != AI_SERVICE_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid AI service token")


async def read_image(image: UploadFile) -> Image.Image:
    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(status_code=415, detail="An image upload is required")
    payload = await image.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Empty image payload")
    try:
        return Image.open(BytesIO(payload)).convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Unable to decode image: {exc}") from exc


@app.post("/v1/inference/validate")
def validate_inference(x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token)
    vehicle = model_status()
    plate = plate_model_status()
    return {
        "accepted": True,
        "vehicle_inference_ready": bool(vehicle["loaded"]),
        "plate_detection_ready": bool(plate["loaded"]),
        "ocr_ready": bool(plate["ocr_available"]),
    }


@app.post("/v1/inference/vehicles")
async def vehicle_inference(
    image: UploadFile = File(...),
    x_ai_service_token: str | None = Header(default=None),
):
    require_service_token(x_ai_service_token)
    frame = await read_image(image)
    try:
        detections = infer(frame)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {
        "success": True,
        "model": model_status()["model_path"],
        "count": len(detections),
        "detections": detections,
    }


@app.post("/v1/inference/plates")
async def plate_inference(
    image: UploadFile = File(...),
    x_ai_service_token: str | None = Header(default=None),
):
    """Detect number plates and run OCR on each detected plate crop."""
    require_service_token(x_ai_service_token)
    frame = await read_image(image)
    try:
        detections = detect_and_read(frame)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {
        "success": True,
        "plate_model": plate_model_status()["model_path"],
        "count": len(detections),
        "detections": detections,
    }


@app.post("/v1/inference/vehicle-with-plate")
async def vehicle_with_plate_inference(
    image: UploadFile = File(...),
    x_ai_service_token: str | None = Header(default=None),
):
    """Run vehicle detection followed by plate detection/OCR on the frame."""
    require_service_token(x_ai_service_token)
    frame = await read_image(image)
    try:
        vehicles = infer(frame)
        plates = detect_and_read(frame)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return {
        "success": True,
        "vehicle_model": model_status()["model_path"],
        "plate_model": plate_model_status()["model_path"],
        "vehicles": vehicles,
        "vehicle_count": len(vehicles),
        "plates": plates,
        "plate_count": len(plates),
    }
