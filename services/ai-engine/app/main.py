import os
from io import BytesIO

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from PIL import Image

from .central_store import CentralStore
from .event_pipeline import EventBuilder, WatchlistMatcher
from .inference import infer, load_model, model_status
from .plate_ocr import detect_and_read, load_plate_model, plate_model_status
from .sync_queue import SyncQueue
from .tracker import VehicleTracker

app = FastAPI(title="AVCLPR AI Engine", version="0.7.0")
AI_SERVICE_TOKEN = os.getenv("AI_SERVICE_TOKEN", "")
tracker = VehicleTracker()
watchlists = WatchlistMatcher()
events = EventBuilder(watchlists)
central = CentralStore()
outbox = SyncQueue()


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
        "central_store": central.health(),
        "sync_queue": outbox.stats(),
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


def sync_one(event: dict) -> bool:
    try:
        central.insert_event(event)
        return True
    except Exception:
        return False


@app.post("/v1/events/process-frame")
async def process_event_frame(
    image: UploadFile = File(...),
    site_id: str = "SITE-01",
    camera_id: str = "CAM-01-01",
    site_uuid: str | None = None,
    camera_uuid: str | None = None,
    sync: bool = False,
    x_ai_service_token: str | None = Header(default=None),
):
    """Offline-first edge pipeline. Events are persisted locally before optional central sync."""
    require_service_token(x_ai_service_token)
    if (site_uuid is None) != (camera_uuid is None):
        raise HTTPException(status_code=400, detail="site_uuid and camera_uuid must be supplied together")
    frame, payload = await read_image(image)
    try:
        vehicles = infer(frame)
        plates = detect_and_read(frame)
        tracker.update(vehicles)
        tracks = tracker.associate_plates(plates)
        built_events = events.build(tracks, site_id=site_id, camera_id=camera_id, frame_payload=payload)
        for event in built_events:
            event["site_uuid"] = site_uuid
            event["camera_uuid"] = camera_uuid
            outbox.enqueue(event)
        if sync:
            for item in outbox.pending(limit=max(1, len(built_events))):
                if sync_one(item["event"]):
                    outbox.acknowledge(item["row_id"])
                else:
                    outbox.fail(item["row_id"], "Central store unavailable")
    except (RuntimeError, OSError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"success": True, "site_id": site_id, "camera_id": camera_id, "vehicle_detections": len(vehicles), "plate_detections": len(plates), "active_tracks": len(tracks), "events_created": len(built_events), "central_sync_requested": sync, "sync_queue": outbox.stats(), "events": built_events}


@app.post("/v1/sync/run")
def run_sync(limit: int = 100, x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token)
    if not central.health().get("connected"):
        return {"success": False, "message": "Central database unavailable", "sync_queue": outbox.stats()}
    synced = 0
    failed = 0
    for item in outbox.pending(limit=max(1, min(limit, 1000))):
        if sync_one(item["event"]):
            outbox.acknowledge(item["row_id"])
            synced += 1
        else:
            outbox.fail(item["row_id"], "Central persistence failed")
            failed += 1
    return {"success": failed == 0, "synced": synced, "failed": failed, "sync_queue": outbox.stats()}


@app.get("/v1/sync/status")
def sync_status(x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token)
    return {"central_store": central.health(), "sync_queue": outbox.stats()}


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


@app.get("/v1/central/health")
def central_health(x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token)
    return central.health()


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
