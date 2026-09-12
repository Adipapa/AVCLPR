from __future__ import annotations

import os
from io import BytesIO

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from PIL import Image
from pydantic import BaseModel, Field

from .camera_manager import CameraManager
from .camera_worker import CameraWorkerConfig
from .central_store import CentralStore
from .event_pipeline import EventBuilder, WatchlistMatcher
from .inference import infer, load_model, model_status
from .plate_ocr import detect_and_read, load_plate_model, plate_model_status
from .sync_queue import SyncQueue
from .sync_service import CentralSyncService
from .tracker import VehicleTracker

app = FastAPI(title="AVCLPR AI Engine", version="0.9.0")
AI_SERVICE_TOKEN = os.getenv("AI_SERVICE_TOKEN", "")
tracker = VehicleTracker()
watchlists = WatchlistMatcher()
events = EventBuilder(watchlists)
central = CentralStore()
outbox = SyncQueue()
cameras = CameraManager(outbox, central, watchlists)
sync_service = CentralSyncService(
    outbox, central, watchlists,
    interval_seconds=float(os.getenv("EDGE_SYNC_INTERVAL_SECONDS", "10")),
    batch_size=int(os.getenv("EDGE_SYNC_BATCH_SIZE", "100")),
)


class CameraStartRequest(BaseModel):
    site_id: str = Field(min_length=1, max_length=100)
    camera_id: str = Field(min_length=1, max_length=100)
    rtsp_url: str = Field(min_length=1, max_length=2048)
    site_uuid: str | None = None
    camera_uuid: str | None = None
    sample_every_n_frames: int = Field(default=5, ge=1, le=60)


@app.on_event("startup")
def startup() -> None:
    load_model()
    load_plate_model()
    sync_service.start()


@app.on_event("shutdown")
def shutdown() -> None:
    sync_service.stop()
    cameras.stop_all()


def require_service_token(x_ai_service_token: str | None) -> None:
    if AI_SERVICE_TOKEN and x_ai_service_token != AI_SERVICE_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid AI service token")


@app.get("/health")
def health():
    vehicle = model_status()
    plate = plate_model_status()
    ready = bool(vehicle["loaded"] and plate["loaded"] and plate["ocr_available"])
    return {
        "status": "ok" if ready else "degraded", "service": "ai-engine", "version": "0.9.0",
        "vehicle_model": vehicle, "plate_model": plate,
        "tracker": {"active_tracks": len(tracker._tracks)},
        "event_pipeline": {"recent_dedup_keys": events.recent_keys()},
        "camera_workers": {"count": cameras.count(), "items": cameras.status()},
        "central_store": central.health(), "sync": sync_service.status(),
    }


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


@app.post("/v1/cameras/start")
def start_camera(request: CameraStartRequest, x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token)
    if not request.rtsp_url.lower().startswith(("rtsp://", "rtsps://")):
        raise HTTPException(status_code=400, detail="rtsp_url must use rtsp:// or rtsps://")
    config = CameraWorkerConfig(site_id=request.site_id, camera_id=request.camera_id, rtsp_url=request.rtsp_url,
                                site_uuid=request.site_uuid, camera_uuid=request.camera_uuid,
                                sample_every_n_frames=request.sample_every_n_frames)
    return {"success": True, "camera": cameras.start(config)}


@app.post("/v1/cameras/stop/{camera_id}")
def stop_camera(camera_id: str, x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token)
    if not cameras.stop(camera_id):
        raise HTTPException(status_code=404, detail="Camera worker not found")
    return {"success": True, "camera_id": camera_id}


@app.get("/v1/cameras/status")
def camera_status(camera_id: str | None = None, x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token)
    result = cameras.status(camera_id)
    if camera_id and result is None:
        raise HTTPException(status_code=404, detail="Camera worker not found")
    return {"success": True, "cameras": result}


@app.get("/v1/sync/status")
def sync_status(x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token)
    return sync_service.status()


@app.post("/v1/sync/run")
def run_sync(x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token)
    return sync_service.run_once()


@app.get("/v1/events")
def list_events(limit: int = 100, site_id: str | None = None, x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token)
    return {"success": True, "events": central.list_events(limit, site_id)}


@app.get("/v1/alerts")
def list_alerts(limit: int = 100, status: str | None = "active", x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token)
    return {"success": True, "alerts": central.list_alerts(limit, status)}


@app.post("/v1/alerts/{alert_id}/acknowledge")
def acknowledge_alert(alert_id: str, user_id: str, x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token)
    if not central.acknowledge_alert(alert_id, user_id):
        raise HTTPException(status_code=404, detail="Active alert not found")
    return {"success": True, "alert_id": alert_id, "status": "acknowledged"}


@app.get("/v1/watchlists")
def list_watchlists(x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token)
    items = central.list_watchlists()
    return {"count": len(items or []), "items": items if items is not None else watchlists.list()}


@app.post("/v1/watchlists")
def add_watchlist(plate: str, category: str = "GENERAL", description: str | None = None, x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token)
    try:
        return {"success": True, "item": watchlists.upsert(plate, category, description)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/v1/events/process-frame")
async def process_event_frame(image: UploadFile = File(...), site_id: str = "SITE-01", camera_id: str = "CAM-01-01",
                              site_uuid: str | None = None, camera_uuid: str | None = None,
                              sync: bool = False, x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token)
    if (site_uuid is None) != (camera_uuid is None):
        raise HTTPException(status_code=400, detail="site_uuid and camera_uuid must be supplied together")
    frame, payload = await read_image(image)
    try:
        vehicles = infer(frame); plates = detect_and_read(frame); tracker.update(vehicles)
        tracks = tracker.associate_plates(plates)
        built_events = events.build(tracks, site_id=site_id, camera_id=camera_id, frame_payload=payload)
        for event in built_events:
            event["site_uuid"] = site_uuid; event["camera_uuid"] = camera_uuid; outbox.enqueue(event)
        if sync:
            sync_service.run_once()
    except (RuntimeError, OSError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"success": True, "site_id": site_id, "camera_id": camera_id, "vehicle_detections": len(vehicles),
            "plate_detections": len(plates), "active_tracks": len(tracks), "events_created": len(built_events),
            "sync_requested": sync, "sync": sync_service.status(), "events": built_events}


@app.post("/v1/inference/validate")
def validate_inference(x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token)
    vehicle = model_status(); plate = plate_model_status()
    return {"accepted": True, "vehicle_inference_ready": bool(vehicle["loaded"]),
            "plate_detection_ready": bool(plate["loaded"]), "ocr_ready": bool(plate["ocr_available"])}


@app.post("/v1/inference/vehicles")
async def vehicle_inference(image: UploadFile = File(...), x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token); frame, _ = await read_image(image)
    try: detections = infer(frame)
    except RuntimeError as exc: raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"success": True, "model": model_status()["model_path"], "count": len(detections), "detections": detections}


@app.post("/v1/inference/plates")
async def plate_inference(image: UploadFile = File(...), x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token); frame, _ = await read_image(image)
    try: detections = detect_and_read(frame)
    except RuntimeError as exc: raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"success": True, "plate_model": plate_model_status()["model_path"], "count": len(detections), "detections": detections}


@app.post("/v1/inference/vehicle-with-plate")
async def vehicle_with_plate_inference(image: UploadFile = File(...), x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token); frame, _ = await read_image(image)
    try: vehicles = infer(frame); plates = detect_and_read(frame)
    except RuntimeError as exc: raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"success": True, "vehicle_model": model_status()["model_path"], "plate_model": plate_model_status()["model_path"],
            "vehicles": vehicles, "vehicle_count": len(vehicles), "plates": plates, "plate_count": len(plates)}


@app.post("/v1/inference/tracked-frame")
async def tracked_frame_inference(image: UploadFile = File(...), x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token); frame, _ = await read_image(image)
    try:
        vehicles = infer(frame); plates = detect_and_read(frame); tracker.update(vehicles); tracked = tracker.associate_plates(plates)
    except RuntimeError as exc: raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"success": True, "vehicle_model": model_status()["model_path"], "plate_model": plate_model_status()["model_path"],
            "vehicle_count": len(vehicles), "plate_count": len(plates), "tracked_vehicle_count": len(tracked), "tracks": tracked}


@app.get("/v1/central/health")
def central_health(x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token); return central.health()


@app.post("/v1/tracker/reset")
def reset_tracker(x_ai_service_token: str | None = Header(default=None)):
    require_service_token(x_ai_service_token); tracker.reset(); return {"success": True, "message": "Tracker state reset"}
