# AVCLPR v2 Production Architecture

## Objective

Transform AVCLPR from a prototype dashboard/RTSP platform into a government-grade, multi-site AI vehicle intelligence and ANPR platform for the QTS 10-location pilot.

## Core principles

- Edge-first processing: cameras and AI nodes continue operating during WAN outages.
- Secure by default: no hard-coded credentials, authenticated APIs, encrypted transport, RBAC and audit trails.
- Evidence integrity: every enforcement-relevant event carries evidence metadata and a cryptographic hash.
- Model traceability: every AI event records the detector/OCR model versions and inference node.
- Separation of concerns: React dashboard, Node API/control plane, Python AI inference service and databases are separate components.
- Government data governance: retention, access, export and deletion are explicit policies.

## Target topology

```text
10 highway sites
  -> RTSP cameras
  -> Edge AI node
      -> frame acquisition
      -> vehicle detection
      -> tracking
      -> plate detection
      -> OCR
      -> event/evidence creation
      -> local durable queue
  -> VPN/TLS
  -> Central API
      -> authentication/RBAC
      -> event processing
      -> watchlists/alerts
      -> PostgreSQL/PostGIS
      -> evidence storage
  -> Government dashboard
```

## Service boundaries

### Dashboard
React/Vite application for national overview, live monitoring, ANPR search, alerts, watchlists, reports, evidence, users, audit and system health.

### API/control plane
Node.js/Express service. Owns authentication, authorization, sites, cameras, events, watchlists, alerts, reporting and audit APIs. It must not run GPU inference.

### AI service
Python service. Owns frame sampling, YOLO inference, tracking, plate detection, OCR, confidence scoring and event generation. It posts validated events to the API.

### Edge persistence
SQLite is retained for edge buffering/offline operation. It is not the authoritative national database.

### Central persistence
PostgreSQL is the authoritative relational store. PostGIS should be enabled if geographic querying is required.

### Evidence storage
Use controlled filesystem/object storage, separate from relational event records. Evidence must have retention rules, access control and integrity hashes.

## Minimum production entities

- sites
- cameras
- users
- roles
- permissions
- vehicle_events
- evidence
- watchlists
- watchlist_entries
- alerts
- audit_logs
- ai_models
- ai_nodes
- system_health

## 10-site requirements

The data model must support multiple regions, sites and cameras. No production UI or API should assume `cameras[0]` or a single camera.

## Security baseline

- TLS for all remote traffic.
- VPN/private networking between edge and central systems.
- RBAC with site-level authorization.
- MFA-ready authentication.
- Secret references instead of plaintext camera passwords.
- Strict CORS allow-list.
- API request validation and rate limiting.
- Immutable/append-only audit records where practical.
- Evidence export authorization and logging.
- Removal of all default credentials before deployment.

## Reliability baseline

- Local event queue at every edge site.
- Automatic synchronization after WAN recovery.
- Camera/RTSP health checks.
- AI process watchdog.
- Disk, GPU, CPU, RAM and network monitoring.
- Automated database backups.
- Documented RPO/RTO.

## AI event contract

Each AI event should contain at least:

- event ID
- timestamp
- site ID
- camera ID
- tracking ID
- vehicle type
- direction
- lane where available
- detection confidence
- plate number where recognized
- plate confidence
- vehicle/plate/snapshot evidence references
- model version
- AI node ID
- processing latency
- evidence hash

Speed must be treated as an estimated/calibrated value unless validated with an enforcement-grade measurement method.
