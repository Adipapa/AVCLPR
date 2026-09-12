from __future__ import annotations

import os
from typing import Any

try:
    import psycopg
except ImportError:  # pragma: no cover
    psycopg = None


class CentralStore:
    """Small PostgreSQL adapter used by the authenticated edge sync layer.

    The AI process can run without PostgreSQL. When DATABASE_URL is absent or
    psycopg is unavailable, the store remains disabled rather than breaking
    local edge inference.
    """

    def __init__(self) -> None:
        self.database_url = os.getenv("DATABASE_URL", "")
        self.enabled = bool(self.database_url and psycopg)

    def health(self) -> dict[str, Any]:
        if not self.database_url:
            return {"enabled": False, "connected": False, "reason": "DATABASE_URL not configured"}
        if psycopg is None:
            return {"enabled": False, "connected": False, "reason": "psycopg not installed"}
        try:
            with psycopg.connect(self.database_url, connect_timeout=3) as conn:
                conn.execute("SELECT 1")
            return {"enabled": True, "connected": True}
        except Exception as exc:
            return {"enabled": True, "connected": False, "reason": str(exc)}

    def insert_event(self, event: dict[str, Any]) -> str:
        if not self.enabled:
            raise RuntimeError("Central PostgreSQL store is not enabled")
        query = """
        INSERT INTO vehicle_events (
            id, site_id, camera_id, event_timestamp, tracking_id,
            vehicle_type, direction, detection_confidence, plate_number,
            normalized_plate, plate_confidence, watchlist_status,
            watchlist_category, snapshot_path, evidence_hash,
            processing_time_ms, model_version, ai_node_id
        )
        VALUES (
            %s, %s, %s, to_timestamp(%s), %s,
            %s, %s, %s, %s, %s, %s, %s, %s,
            %s, %s, %s, %s, %s
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING id::text
        """
        event_id = event.get("event_id")
        # Application event IDs are not UUIDs, so use a deterministic UUID5
        # derived from the event ID for the PostgreSQL primary key.
        import uuid
        db_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"avclpr:event:{event_id}"))
        with psycopg.connect(self.database_url) as conn:
            row = conn.execute(query, (
                db_id,
                event["site_uuid"],
                event["camera_uuid"],
                event["timestamp"],
                event.get("tracking_id"),
                event.get("vehicle_type") or "unknown",
                event.get("direction") if event.get("direction") in {"IN", "OUT", "UNKNOWN"} else "UNKNOWN",
                event.get("detection_confidence"),
                event.get("plate_number"),
                event.get("plate_number"),
                event.get("plate_confidence"),
                "match" if event.get("watchlist") else "none",
                event.get("watchlist_category"),
                (event.get("evidence") or {}).get("path"),
                (event.get("evidence") or {}).get("sha256"),
                None,
                os.getenv("AI_MODEL_VERSION", "unknown"),
                os.getenv("EDGE_SITE_ID", "unknown"),
            ).fetchone()
            conn.commit()
        return row[0] if row else db_id
