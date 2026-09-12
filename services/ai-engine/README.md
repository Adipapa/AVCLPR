# AVCLPR AI Engine

Python inference service for edge AI processing.

## Planned pipeline

RTSP frame -> frame sampler -> vehicle detector -> tracker -> plate detector -> OCR -> event builder -> API/event queue.

## Production requirements

- GPU acceleration where available.
- Explicit model versioning.
- Configurable confidence thresholds.
- Bounded frame queues and backpressure.
- Health endpoint.
- Graceful shutdown.
- No direct database writes to the central database from the inference process.
- AI events are submitted through the authenticated API/event contract.

This service intentionally starts as a foundation. It must not claim ANPR capability until real detector and OCR models are installed and validated against representative road footage.
