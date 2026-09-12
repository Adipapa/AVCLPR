from __future__ import annotations

import os
import uuid
from typing import Any

try:
    import psycopg
except ImportError:  # pragma: no cover
    psycopg = None


class CentralStore:
    """PostgreSQL adapter for the central event, alert and evidence store."""

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

    @staticmethod
    def _db_event_id(event_id: str) -> str:
        return str(uuid.uuid5(uuid.NAMESPACE_URL, f"avclpr:event:{event_id}"))

    def insert_event(self, event: dict[str, Any]) -> str:
        if not self.enabled:
            raise RuntimeError("Central PostgreSQL store is not enabled")
        db_id = self._db_event_id(str(event["event_id"]))
        event_sql = """
        INSERT INTO vehicle_events (
            id, site_id, camera_id, event_timestamp, tracking_id,
            vehicle_type, direction, detection_confidence, plate_number,
            normalized_plate, plate_confidence, watchlist_status,
            watchlist_category, snapshot_path, evidence_hash,
            processing_time_ms, model_version, ai_node_id
        ) VALUES (
            %s, %s, %s, to_timestamp(%s), %s, %s, %s, %s, %s, %s,
            %s, %s, %s, %s, %s, %s, %s, %s
        ) ON CONFLICT (id) DO NOTHING
        """
        with psycopg.connect(self.database_url) as conn:
            conn.execute(event_sql, (
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
            ))

            alert = event.get("alert")
            if alert:
                alert_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"avclpr:alert:{alert['id']}"))
                severity = str(alert.get("severity", "medium")).lower()
                if severity not in {"low", "medium", "high", "critical"}:
                    severity = "medium"
                conn.execute(
                    """INSERT INTO alerts
                    (id,event_id,site_id,camera_id,type,severity,title,description,status)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'active')
                    ON CONFLICT (id) DO NOTHING""",
                    (
                        alert_id, db_id, event["site_uuid"], event["camera_uuid"],
                        "WATCHLIST_MATCH", severity, "Watchlist vehicle detected",
                        alert.get("message"),
                    ),
                )

            evidence = event.get("evidence")
            if evidence:
                evidence_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"avclpr:evidence:{event['event_id']}"))
                retention_days = int(os.getenv("EVIDENCE_RETENTION_DAYS", "90"))
                conn.execute(
                    """INSERT INTO evidence
                    (id,event_id,evidence_type,object_path,sha256_hash,size_bytes,captured_at,retention_until)
                    VALUES (%s,%s,%s,%s,%s,%s,to_timestamp(%s),to_timestamp(%s))
                    ON CONFLICT (id) DO NOTHING""",
                    (
                        evidence_id, db_id, "vehicle_frame", evidence["path"],
                        evidence["sha256"], evidence.get("size_bytes"),
                        event["timestamp"], event["timestamp"] + retention_days * 86400,
                    ),
                )
            conn.commit()
        return db_id
