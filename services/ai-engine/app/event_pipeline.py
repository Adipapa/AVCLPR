from __future__ import annotations

import hashlib
import os
import re
import threading
import time
import uuid
from collections import OrderedDict
from pathlib import Path
from typing import Any

EVIDENCE_ROOT = Path(os.getenv("EVIDENCE_ROOT", "./data/evidence"))
DEDUP_SECONDS = float(os.getenv("EVENT_DEDUP_SECONDS", "30"))
MIN_EVENT_FRAMES = int(os.getenv("EVENT_MIN_FRAMES", "3"))
MAX_RECENT_EVENTS = int(os.getenv("EVENT_MAX_RECENT_EVENTS", "5000"))


_PLATE_RE = re.compile(r"[^A-Z0-9]")


def normalize_plate(value: str | None) -> str | None:
    if not value:
        return None
    value = _PLATE_RE.sub("", value.upper())
    return value or None


class WatchlistMatcher:
    """Thread-safe in-memory edge watchlist.

    PostgreSQL is the authoritative production store. This edge copy allows
    matching to continue while a site is offline and can later be synchronized.
    """

    def __init__(self) -> None:
        self._items: dict[str, dict[str, Any]] = {}
        self._lock = threading.RLock()

    def upsert(self, plate: str, category: str = "GENERAL", description: str | None = None) -> dict[str, Any]:
        normalized = normalize_plate(plate)
        if not normalized:
            raise ValueError("A valid plate is required")
        item = {
            "plate_number": plate.upper().strip(),
            "normalized_plate": normalized,
            "category": category.upper().strip() or "GENERAL",
            "description": description,
            "updated_at": time.time(),
        }
        with self._lock:
            self._items[normalized] = item
        return dict(item)

    def remove(self, plate: str) -> bool:
        normalized = normalize_plate(plate)
        if not normalized:
            return False
        with self._lock:
            return self._items.pop(normalized, None) is not None

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(item) for item in self._items.values()]

    def match(self, plate: str | None) -> dict[str, Any] | None:
        normalized = normalize_plate(plate)
        if not normalized:
            return None
        with self._lock:
            item = self._items.get(normalized)
            return dict(item) if item else None


class AlertEngine:
    SEVERITY = {
        "STOLEN": "CRITICAL",
        "WANTED": "CRITICAL",
        "INTELLIGENCE": "HIGH",
        "SUSPICIOUS": "HIGH",
    }

    def create_alert(self, event: dict[str, Any], match: dict[str, Any]) -> dict[str, Any]:
        category = str(match.get("category", "GENERAL")).upper()
        severity = self.SEVERITY.get(category, "MEDIUM")
        return {
            "id": f"ALT-{uuid.uuid4().hex[:12].upper()}",
            "event_id": event["event_id"],
            "site_id": event["site_id"],
            "camera_id": event["camera_id"],
            "plate_number": event.get("plate_number"),
            "category": category,
            "severity": severity,
            "status": "OPEN",
            "created_at": event["timestamp"],
            "message": f"Watchlist match: {event.get('plate_number') or 'unreadable plate'}",
        }


class EvidenceStore:
    """Writes immutable-by-convention evidence and returns a SHA-256 digest."""

    def save_frame(self, payload: bytes, event_id: str, timestamp: float) -> dict[str, Any]:
        day = time.strftime("%Y/%m/%d", time.gmtime(timestamp))
        directory = EVIDENCE_ROOT / day
        directory.mkdir(parents=True, exist_ok=True)
        filename = f"{event_id}.jpg"
        path = directory / filename
        path.write_bytes(payload)
        digest = hashlib.sha256(payload).hexdigest()
        return {
            "path": str(path),
            "sha256": digest,
            "size_bytes": len(payload),
            "content_type": "image/jpeg",
        }


class EventBuilder:
    """Converts stable tracks into deduplicated vehicle events."""

    def __init__(self, watchlists: WatchlistMatcher) -> None:
        self.watchlists = watchlists
        self.alerts = AlertEngine()
        self.evidence = EvidenceStore()
        self._recent: OrderedDict[str, float] = OrderedDict()
        self._lock = threading.RLock()

    def _dedup_key(self, site_id: str, camera_id: str, track: dict[str, Any]) -> str:
        plate = normalize_plate(track.get("plate_number"))
        if plate:
            return f"{site_id}:{camera_id}:plate:{plate}"
        return f"{site_id}:{camera_id}:track:{track.get('tracking_id')}"

    def build(
        self,
        tracks: list[dict[str, Any]],
        site_id: str,
        camera_id: str,
        frame_payload: bytes | None = None,
        timestamp: float | None = None,
    ) -> list[dict[str, Any]]:
        now = timestamp if timestamp is not None else time.time()
        events: list[dict[str, Any]] = []
        with self._lock:
            for track in tracks:
                if int(track.get("frame_count", 0)) < MIN_EVENT_FRAMES:
                    continue
                key = self._dedup_key(site_id, camera_id, track)
                previous = self._recent.get(key)
                if previous is not None and now - previous < DEDUP_SECONDS:
                    continue

                event_id = f"EVT-{uuid.uuid4().hex[:16].upper()}"
                plate = normalize_plate(track.get("plate_number"))
                event = {
                    "event_id": event_id,
                    "timestamp": now,
                    "site_id": site_id,
                    "camera_id": camera_id,
                    "tracking_id": track.get("tracking_id"),
                    "vehicle_type": track.get("vehicle_type"),
                    "direction": track.get("direction"),
                    "plate_number": plate,
                    "plate_confidence": track.get("plate_confidence", 0),
                    "detection_confidence": track.get("confidence", 0),
                    "frame_count": track.get("frame_count", 0),
                    "watchlist": False,
                    "watchlist_category": None,
                    "alert": None,
                    "evidence": None,
                }

                match = self.watchlists.match(plate)
                if match:
                    event["watchlist"] = True
                    event["watchlist_category"] = match["category"]
                    event["alert"] = self.alerts.create_alert(event, match)

                if frame_payload:
                    evidence = self.evidence.save_frame(frame_payload, event_id, now)
                    event["evidence"] = {
                        "sha256": evidence["sha256"],
                        "path": evidence["path"],
                        "size_bytes": evidence["size_bytes"],
                    }

                self._recent[key] = now
                self._recent.move_to_end(key)
                while len(self._recent) > MAX_RECENT_EVENTS:
                    self._recent.popitem(last=False)
                events.append(event)
        return events

    def recent_keys(self) -> int:
        with self._lock:
            return len(self._recent)
