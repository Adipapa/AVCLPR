# AVCLPR AI Engine

Python inference service for edge AI processing.

## Current pipeline

RTSP frame -> frame sampler -> vehicle detector -> persistent tracker -> plate detector -> OCR -> plate/vehicle association -> deduplicated vehicle event -> watchlist matching -> alert generation -> evidence hashing/storage -> durable edge outbox -> central PostgreSQL synchronization.

## Models

Place the model weights under `services/ai-engine/models/` or configure absolute paths:

- `yolo11n.pt` — vehicle detector
- `plate_detector.pt` — number-plate detector

The repository does not include model weights.

## Endpoints

- `GET /health`
- `POST /v1/inference/validate`
- `POST /v1/inference/vehicles`
- `POST /v1/inference/plates`
- `POST /v1/inference/vehicle-with-plate`
- `POST /v1/inference/tracked-frame`
- `POST /v1/events/process-frame` — complete offline-first edge pipeline
- `POST /v1/sync/run` — drain the local event outbox to PostgreSQL
- `GET /v1/sync/status`
- `GET /v1/central/health`
- `GET /v1/watchlists`
- `POST /v1/watchlists`
- `DELETE /v1/watchlists/{plate}`
- `POST /v1/tracker/reset`

## Event pipeline behavior

- Vehicle tracks receive persistent IDs and are retained through short detection gaps.
- Plate reads are associated with the best active vehicle using bounding-box geometry.
- OCR readings below `OCR_CONFIDENCE_THRESHOLD` are not attached to a track.
- Events require a minimum number of observed frames before creation.
- Repeated observations are deduplicated for `EVENT_DEDUP_SECONDS`.
- Watchlist matches are exact normalized-plate matches.
- Watchlist categories generate alert severity; this is an operational alert signal, not an automatic enforcement decision.
- Evidence is written to `EVIDENCE_ROOT` and SHA-256 hashed.
- Events are first placed in a durable SQLite outbox, allowing a site to continue operating during WAN/database outages.
- `/v1/sync/run` retries pending events with exponential backoff and removes them only after successful PostgreSQL persistence.

## Central database

The PostgreSQL schema in `database/postgresql/001_initial_schema.sql` is the central authoritative target. Central event persistence requires valid `site_uuid` and `camera_uuid` values that correspond to the central `sites` and `cameras` tables.

The AI service does not require PostgreSQL to perform local inference. If the central database is unavailable, events remain in the local outbox.

## 10-site deployment model

Each highway location can run an independent edge AI node and local outbox. All ten nodes synchronize vehicle events to the central PostgreSQL platform when connectivity is available. This prevents a temporary network outage at one site from stopping local detection.

## Configuration

- `VEHICLE_MODEL_PATH`
- `PLATE_MODEL_PATH`
- `AI_CONFIDENCE_THRESHOLD`
- `AI_IMAGE_SIZE`
- `PLATE_CONFIDENCE_THRESHOLD`
- `OCR_CONFIDENCE_THRESHOLD`
- `PLATE_IMAGE_SIZE`
- `OCR_PSM`
- `AI_SERVICE_TOKEN`
- `AI_MODEL_VERSION`
- `TRACKER_IOU_THRESHOLD`
- `TRACKER_MAX_MISSED_FRAMES`
- `PLATE_ASSOC_IOU_THRESHOLD`
- `PLATE_ASSOC_CENTER_DISTANCE`
- `EVENT_MIN_FRAMES`
- `EVENT_DEDUP_SECONDS`
- `EVENT_MAX_RECENT_EVENTS`
- `EVIDENCE_ROOT`
- `DATABASE_URL`
- `EDGE_QUEUE_DB`

## OCR requirement

`pytesseract` is the Python wrapper. The deployment host/container must also have the **Tesseract OCR executable** installed. The Python package alone is not sufficient.

## Production requirements / limitations

- GPU acceleration where available.
- Explicit model versioning.
- Bounded frame queues and backpressure.
- Durable PostgreSQL watchlists and alert records still need to be wired into the edge cache synchronization service.
- Camera/site-specific direction calibration or virtual-line logic.
- Validated speed estimation before exposing speed as an enforcement measurement.
- Evidence retention/deletion jobs and controlled evidence access.
- RTSP camera worker/service and multi-camera scheduling still need integration with this API.
- Validation using representative Gambian road footage, including day/night, blur, rain and oblique plate angles.

OCR output must not automatically be treated as a legally valid plate reading. Plate-format validation, confidence handling and human-review rules must be established before operational use.
