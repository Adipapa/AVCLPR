import os
from io import BytesIO

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from PIL import Image

from .event_pipeline import EventBuilder, WatchlistMatcher
from .inference import infer, load_model, model_status
from .plate_ocr import detect_and_read, load_plate_model, plate_model_status
from .tracker import VehicleTracker

app = FastAPI(title="AVCLPR AI Engine", version="0.5.0")
AI_SERVICE_TOKEN = os.getenv("AI_SERVICE_TOKEN", "")
tracker = VehicleTracker()
watchlists = WatchlistMatcher()
events = EventBuilder(watchlists)


@app.on_event("startup")
def startup() -> None:
    load_model()
    load_plate_model()


@app.get("/health")
def health():
    vehicle = model_status()
    plate = plate_model_status()
    ready = bool(vehicle["loaded"] and plate["loaded"] and plate["ocr_available"])
    return {
        "status": "ok" if ready else "degraded",
        "service": "ai-engine",
        "vehicle_model": vehicle,
        "plate_model": plate,
        "tracker": {"active_tracks": len(tracker._tracks)},
        "event_pipeline": {"recent_dedup_keys": events.recent_keys()},
    }


def require_service_token(x_ai_service_token: str | None) -> None:
    if AI_SERVICE_TOKEN and x_ai_service_token != AI_SERVICE_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid AI service token")


async def read_image(image: UploadFile) -> tuple[Image.Image, bytes]:
    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(status_code=415, detail="An image upload is required")
    payload = await image.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Empty image payload")
    try:
        return Image.open(BytesIO(payload)).convert("RGB"), payload
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Unable to decode image: {exc}") from exc


@app.post("/v1/inference/validate")
def validate_inference(x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token)
    vehicle = model_status()
    plate = plate_model_status()
    return {"accepted": True, "vehicle_inference_ready": bool(vehicle["loaded"]), "plate_detection_ready": bool(plate["loaded"]), "ocr_ready": bool(plate["ocr_available"])}


@app.post("/v1/inference/vehicles")
async def vehicle_inference(image: UploadFile = File(...), x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token)
    frame, _ = await read_image(image)
    try:
        detections = infer(frame)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"success": True, "model": model_status()["model_path"], "count": len(detections), "detections": detections}


@app.post("/v1/inference/plates")
async def plate_inference(image: UploadFile = File(...), x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token)
    frame, _ = await read_image(image)
    try:
        detections = detect_and_read(frame)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"success": True, "plate_model": plate_model_status()["model_path"], "count": len(detections), "detections": detections}


@app.post("/v1/inference/vehicle-with-plate")
async def vehicle_with_plate_inference(image: UploadFile = File(...), x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token)
    frame, _ = await read_image(image)
    try:
        vehicles = infer(frame)
        plates = detect_and_read(frame)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"success": True, "vehicle_model": model_status()["model_path"], "plate_model": plate_model_status()["model_path"], "vehicles": vehicles, "vehicle_count": len(vehicles), "plates": plates, "plate_count": len(plates)}


@app.post("/v1/inference/tracked-frame")
async def tracked_frame_inference(image: UploadFile = File(...), x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token)
    frame, _ = await read_image(image)
    try:
        vehicles = infer(frame)
        plates = detect_and_read(frame)
        tracker.update(vehicles)
        tracked = tracker.associate_plates(plates)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"success": True, "vehicle_model": model_status()["model_path"], "plate_model": plate_model_status()["model_path"], "vehicle_count": len(vehicles), "plate_count": len(plates), "tracked_vehicle_count": len(tracked), "tracks": tracked}


@app.post("/v1/events/process-frame")
async def process_event_frame(
    image: UploadFile = File(...),
    site_id: str = "SITE-01",
    camera_id: str = "CAM-01-01",
    x_ai_service_token: str | None = Header(default=None),
):
    """Complete edge pipeline: detection -> tracking -> ANPR -> watchlist -> alert -> evidence."""
    require_service_token(x_ai_service_token)
    frame, payload = await read_image(image)
    try:
        vehicles = infer(frame)
        plates = detect_and_read(frame)
        tracker.update(vehicles)
        tracks = tracker.associate_plates(plates)
        built_events = events.build(tracks, site_id=site_id, camera_id=camera_id, frame_payload=payload)
    except (RuntimeError, OSError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"success": True, "site_id": site_id, "camera_id": camera_id, "vehicle_detections": len(vehicles), "plate_detections": len(plates), "active_tracks": len(tracks), "events_created": len(built_events), "events": built_events}


@app.get("/v1/watchlists")
def list_watchlists(x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token)
    return {"count": len(watchlists.list()), "items": watchlists.list()}


@app.post("/v1/watchlists")
def add_watchlist(plate: str, category: str = "GENERAL", description: str | None = None, x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token)
    try:
        return {"success": True, "item": watchlists.upsert(plate, category, description)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/v1/watchlists/{plate}")
def delete_watchlist(plate: str, x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token)
    if not watchlists.remove(plate):
        raise HTTPException(status_code=404, detail="Watchlist plate not found")
    return {"success": True}


@app.post("/v1/tracker/reset")
def reset_tracker(x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token)
    tracker.reset()
    return {"success": True, "message": "Tracker state reset"}
