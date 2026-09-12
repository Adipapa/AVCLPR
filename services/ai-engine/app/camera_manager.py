from __future__ import annotations

import threading
from typing import Any

from .camera_worker import CameraWorker, CameraWorkerConfig
from .central_store import CentralStore
from .event_pipeline import WatchlistMatcher
from .sync_queue import SyncQueue


class CameraManager:
    """Owns the continuous RTSP workers for an edge node/site."""

    def __init__(self, outbox: SyncQueue, central: CentralStore, watchlists: WatchlistMatcher) -> None:
        self.outbox = outbox
        self.central = central
        self.watchlists = watchlists
        self._workers: dict[str, CameraWorker] = {}
        self._lock = threading.RLock()

    def start(self, config: CameraWorkerConfig) -> dict[str, Any]:
        with self._lock:
            existing = self._workers.get(config.camera_id)
            if existing and existing.running:
                return existing.status()
            if existing:
                existing.stop()
            worker = CameraWorker(config, self.outbox, self.central, self.watchlists)
            self._workers[config.camera_id] = worker
            worker.start()
            return worker.status()

    def stop(self, camera_id: str) -> bool:
        with self._lock:
            worker = self._workers.pop(camera_id, None)
            if not worker:
                return False
            worker.stop()
            return True

    def stop_all(self) -> None:
        with self._lock:
            workers = list(self._workers.values())
            self._workers.clear()
        for worker in workers:
            worker.stop()

    def get(self, camera_id: str) -> CameraWorker | None:
        with self._lock:
            return self._workers.get(camera_id)

    def status(self, camera_id: str | None = None) -> dict[str, Any] | None:
        with self._lock:
            if camera_id:
                worker = self._workers.get(camera_id)
                return worker.status() if worker else None
            return {camera: worker.status() for camera, worker in self._workers.items()}

    def count(self) -> int:
        with self._lock:
            return len(self._workers)
