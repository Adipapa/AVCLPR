from __future__ import annotations

import logging
import threading
import time
from typing import Any

from .central_store import CentralStore
from .event_pipeline import WatchlistMatcher
from .sync_queue import SyncQueue

logger = logging.getLogger(__name__)


class CentralSyncService:
    """Continuously drains the edge outbox and refreshes the edge watchlist cache."""

    def __init__(self, outbox: SyncQueue, central: CentralStore, watchlists: WatchlistMatcher, interval_seconds: float = 10, batch_size: int = 100) -> None:
        self.outbox = outbox
        self.central = central
        self.watchlists = watchlists
        self.interval_seconds = max(2.0, float(interval_seconds))
        self.batch_size = max(1, min(int(batch_size), 1000))
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.RLock()
        self._last_run_at: float | None = None
        self._last_success_at: float | None = None
        self._last_error: str | None = None
        self._synced_total = 0
        self._failed_total = 0
        self._watchlists_synced = 0

    def start(self) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, name="central-sync", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread and thread.is_alive():
            thread.join(timeout=5)
        self._thread = None

    def status(self) -> dict[str, Any]:
        return {
            "running": bool(self._thread and self._thread.is_alive()),
            "interval_seconds": self.interval_seconds,
            "batch_size": self.batch_size,
            "last_run_at": self._last_run_at,
            "last_success_at": self._last_success_at,
            "last_error": self._last_error,
            "synced_total": self._synced_total,
            "failed_total": self._failed_total,
            "watchlists_synced": self._watchlists_synced,
            "queue": self.outbox.stats(),
            "central": self.central.health(),
        }

    def run_once(self) -> dict[str, Any]:
        self._last_run_at = time.time()
        if not self.central.health().get("connected"):
            self._last_error = "Central database unavailable"
            return {"synced": 0, "failed": 0, "watchlists": 0, "connected": False, "queue": self.outbox.stats()}
        synced = 0
        failed = 0
        try:
            self._refresh_watchlists()
            for item in self.outbox.pending(limit=self.batch_size):
                try:
                    self.central.insert_event(item["event"])
                    self.outbox.acknowledge(item["row_id"])
                    synced += 1
                except Exception as exc:
                    self.outbox.fail(item["row_id"], str(exc))
                    failed += 1
                    logger.warning("Central event sync failed for %s: %s", item["event_id"], exc)
            self._synced_total += synced
            self._failed_total += failed
            self._last_success_at = time.time()
            self._last_error = None if failed == 0 else "One or more events failed to synchronize"
        except Exception as exc:
            self._last_error = str(exc)
            logger.exception("Central synchronization cycle failed")
        return {"synced": synced, "failed": failed, "watchlists": self._watchlists_synced, "connected": True, "queue": self.outbox.stats()}

    def _refresh_watchlists(self) -> None:
        items = self.central.list_watchlists()
        if items is None:
            return
        for item in items:
            self.watchlists.upsert(item["plate_number"], item["category"], item.get("description"))
        self._watchlists_synced = len(items)

    def _run(self) -> None:
        while not self._stop.is_set():
            self.run_once()
            self._stop.wait(self.interval_seconds)
