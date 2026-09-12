import os
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI(title="AVCLPR AI Engine", version="0.1.0")

AI_SERVICE_TOKEN = os.getenv("AI_SERVICE_TOKEN", "")

class HealthResponse(BaseModel):
    status: str
    service: str
    model_loaded: bool

@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        service="ai-engine",
        model_loaded=False,
    )

@app.post("/v1/inference/validate")
def validate_inference(x_ai_service_token: str | None = Header(default=None)):
    """Temporary contract endpoint.

    Real inference is intentionally not implemented here yet. The endpoint
    establishes the authenticated service boundary before detector/tracker/OCR
    modules are added.
    """
    if AI_SERVICE_TOKEN and x_ai_service_token != AI_SERVICE_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid AI service token")
    return {"accepted": True, "inference_ready": False}
