import os
from io import BytesIO

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from pydantic import BaseModel
from PIL import Image

from .inference import infer, load_model, model_status

app = FastAPI(title="AVCLPR AI Engine", version="0.2.0")
AI_SERVICE_TOKEN = os.getenv("AI_SERVICE_TOKEN", "")


class HealthResponse(BaseModel):
    status: str
    service: str
    model_loaded: bool
    model_path: str
    model_error: str | None = None


@app.on_event("startup")
def startup() -> None:
    load_model()


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    status = model_status()
    return HealthResponse(
        status="ok" if status["loaded"] else "degraded",
        service="ai-engine",
        model_loaded=bool(status["loaded"]),
        model_path=str(status["model_path"]),
        model_error=status["error"],
    )


def require_service_token(x_ai_service_token: str | None) -> None:
    if AI_SERVICE_TOKEN and x_ai_service_token != AI_SERVICE_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid AI service token")


@app.post("/v1/inference/validate")
def validate_inference(x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token)
    return {"accepted": True, "inference_ready": bool(model_status()["loaded"])}


@app.post("/v1/inference/vehicles")
async def vehicle_inference(
    image: UploadFile = File(...),
    x_ai_service_token: str | None = Header(default=None),
):
    """Run first-stage YOLO vehicle detection on one image frame.

    Tracking, plate detection/OCR, watchlists and event persistence are
    separate stages and will consume these detections next.
    """
    require_service_token(x_ai_service_token)

    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(status_code=415, detail="An image upload is required")

    payload = await image.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Empty image payload")

    try:
        frame = Image.open(BytesIO(payload))
        detections = infer(frame)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Unable to process image: {exc}") from exc

    return {
        "success": True,
        "model": model_status()["model_path"],
        "count": len(detections),
        "detections": detections,
    }
