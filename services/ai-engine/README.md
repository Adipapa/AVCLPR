# AVCLPR AI Engine

Python inference service for edge AI processing.

## Current pipeline

RTSP frame -> frame sampler -> vehicle detector -> plate detector -> OCR -> event builder -> API/event queue.

## Models

Place the model weights under `services/ai-engine/models/` or configure absolute paths:

- `yolo11n.pt` — vehicle detector
- `plate_detector.pt` — number-plate detector

The repository does not include model weights.

## Current endpoints

- `GET /health`
- `POST /v1/inference/validate`
- `POST /v1/inference/vehicles`
- `POST /v1/inference/plates`
- `POST /v1/inference/vehicle-with-plate`

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

## OCR requirement

`pytesseract` is the Python wrapper. The deployment host/container must also have the **Tesseract OCR executable** installed. The Python package alone is not sufficient.

## Production requirements

- GPU acceleration where available.
- Explicit model versioning.
- Configurable confidence thresholds.
- Bounded frame queues and backpressure.
- Health endpoint.
- Graceful shutdown.
- No direct database writes to the central database from the inference process.
- AI events submitted through the authenticated API/event contract.
- Validation using representative Gambian road footage, including day/night, blur, rain and oblique plate angles.

OCR output must not automatically be treated as a legally valid plate reading. Plate-format validation, confidence handling and human-review rules must be established before operational use.
