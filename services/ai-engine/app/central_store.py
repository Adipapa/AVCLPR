from __future__ import annotations

import os
import uuid
from typing import Any

try:
    import psycopg
except ImportError:  # pragma: no cover
    psycopg = None


class CentralStore:
    """PostgreSQL adapter for the central event, alert, evidence and watchlist store."""

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

    @staticmethod
    def _db_alert_id(alert_id: str) -> str:
        return str(uuid.uuid5(uuid.NAMESPACE_URL, f"avclpr:alert:{alert_id}"))

    def insert_event(self, event: dict[str, Any]) -> str:
        if not self.enabled:
            raise RuntimeError("Central PostgreSQL store is not enabled")
        if not event.get("site_uuid") or not event.get("camera_uuid"):
            raise ValueError("site_uuid and camera_uuid are required for central persistence")
        db_id = self._db_event_id(str(event["event_id"]))
        with psycopg.connect(self.database_url) as conn:
            conn.execute(
                """INSERT INTO vehicle_events
                (id,site_id,camera_id,event_timestamp,tracking_id,vehicle_type,direction,
                 detection_confidence,plate_number,normalized_plate,plate_confidence,
                 watchlist_status,watchlist_category,snapshot_path,evidence_hash,
                 processing_time_ms,model_version,ai_node_id)
                VALUES (%s,%s,%s,to_timestamp(%s),%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (id) DO NOTHING""",
                (
                    db_id, event["site_uuid"], event["camera_uuid"], event["timestamp"],
                    event.get("tracking_id"), event.get("vehicle_type") or "unknown",
                    event.get("direction") if event.get("direction") in {"IN", "OUT", "UNKNOWN"} else "UNKNOWN",
                    event.get("detection_confidence"), event.get("plate_number"),
                    event.get("plate_number"), event.get("plate_confidence"),
                    "match" if event.get("watchlist") else "none", event.get("watchlist_category"),
                    (event.get("evidence") or {}).get("path"), (event.get("evidence") or {}).get("sha256"),
                    None, os.getenv("AI_MODEL_VERSION", "unknown"), os.getenv("EDGE_SITE_ID", "unknown"),
                ),
            )
            alert = event.get("alert")
            if alert:
                severity = str(alert.get("severity", "medium")).lower()
                if severity not in {"low", "medium", "high", "critical"}:
                    severity = "medium"
                conn.execute(
                    """INSERT INTO alerts
                    (id,event_id,site_id,camera_id,type,severity,title,description,status)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'active')
                    ON CONFLICT (id) DO NOTHING""",
                    (self._db_alert_id(alert["id"]), db_id, event["site_uuid"], event["camera_uuid"],
                     "WATCHLIST_MATCH", severity, "Watchlist vehicle detected", alert.get("message")),
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
                    (evidence_id, db_id, "vehicle_frame", evidence["path"], evidence["sha256"], evidence.get("size_bytes"),
                     event["timestamp"], event["timestamp"] + retention_days * 86400),
                )
            conn.commit()
        return db_id

    def list_watchlists(self) -> list[dict[str, Any]] | None:
        if not self.enabled:
            return None
        with psycopg.connect(self.database_url) as conn:
            rows = conn.execute(
                """SELECT plate_number,normalized_plate,category,description
                   FROM watchlists WHERE active=true AND alert_enabled=true
                   ORDER BY updated_at DESC"""
            ).fetchall()
        return [{"plate_number": r[0], "normalized_plate": r[1], "category": r[2], "description": r[3]} for r in rows]

    def list_events(self, limit: int = 100, site_id: str | None = None) -> list[dict[str, Any]]:
        if not self.enabled:
            return []
        limit = max(1, min(int(limit), 500))
        sql = """SELECT e.id,e.event_timestamp,e.tracking_id,e.vehicle_type,e.direction,
                         e.detection_confidence,e.plate_number,e.plate_confidence,
                         e.watchlist_status,e.watchlist_category,e.snapshot_path,
                         s.site_code,s.name,c.camera_code,c.name
                  FROM vehicle_events e
                  JOIN sites s ON s.id=e.site_id
                  JOIN cameras c ON c.id=e.camera_id"""
        params: list[Any] = []
        if site_id:
            sql += " WHERE e.site_id=%s"
            params.append(site_id)
        sql += " ORDER BY e.event_timestamp DESC LIMIT %s"
        params.append(limit)
        with psycopg.connect(self.database_url) as conn:
            rows = conn.execute(sql, params).fetchall()
        return [
            {"id": str(r[0]), "timestamp": r[1].isoformat(), "tracking_id": r[2], "vehicle_type": r[3],
             "direction": r[4], "detection_confidence": float(r[5]) if r[5] is not None else None,
             "plate_number": r[6], "plate_confidence": float(r[7]) if r[7] is not None else None,
             "watchlist": r[8] == "match", "watchlist_category": r[9], "snapshot_path": r[10],
             "site_code": r[11], "site_name": r[12], "camera_code": r[13], "camera_name": r[14]}
            for r in rows
        ]

    def list_alerts(self, limit: int = 100, status: str | None = "active") -> list[dict[str, Any]]:
        if not self.enabled:
            return []
        limit = max(1, min(int(limit), 500))
        sql = """SELECT a.id,a.event_id,a.severity,a.type,a.title,a.description,a.status,a.created_at,
                         s.site_code,s.name,c.camera_code,c.name
                  FROM alerts a
                  LEFT JOIN sites s ON s.id=a.site_id
                  LEFT JOIN cameras c ON c.id=a.camera_id"""
        params: list[Any] = []
        if status:
            sql += " WHERE a.status=%s"
            params.append(status)
        sql += " ORDER BY a.created_at DESC LIMIT %s"
        params.append(limit)
        with psycopg.connect(self.database_url) as conn:
            rows = conn.execute(sql, params).fetchall()
        return [
            {"id": str(r[0]), "event_id": str(r[1]) if r[1] else None, "severity": r[2], "type": r[3],
             "title": r[4], "description": r[5], "status": r[6], "created_at": r[7].isoformat(),
             "site_code": r[8], "site_name": r[9], "camera_code": r[10], "camera_name": r[11]}
            for r in rows
        ]

    def acknowledge_alert(self, alert_id: str, user_id: str) -> bool:
        if not self.enabled:
            return False
        with psycopg.connect(self.database_url) as conn:
            result = conn.execute(
                """UPDATE alerts SET status='acknowledged',acknowledged_by=%s,acknowledged_at=now()
                   WHERE id=%s AND status='active'""", (user_id, alert_id)
            )
            conn.commit()
            return result.rowcount == 1
