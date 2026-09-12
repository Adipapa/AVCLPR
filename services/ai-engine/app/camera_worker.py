from __future__ import annotations

import os
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Any

import cv2

from .central_store import CentralStore
from .event_pipeline import EventBuilder, WatchlistMatcher
from .inference import infer
from .plate_ocr import detect_and_read
from .sync_queue import SyncQueue
from .tracker import VehicleTracker


AI_FRAME_INTERVAL = max(1, int(os.getenv("AI_FRAME_INTERVAL", "5")))
JPEG_QUALITY = max(50, min(95, int(os.getenv("AI_JPEG_QUALITY", "80"))))
MAX_FRAME_QUEUE = max(1, int(os.getenv("AI_FRAME_QUEUE_SIZE", "2")))
RECONNECT_SECONDS = max(1, float(os.getenv("RTSP_RECONNECT_SECONDS", "3")))
FRAME_TIMEOUT_SECONDS = max(5, float(os.getenv("RTSP_FRAME_TIMEOUT_SECONDS", "15")))

# Ultralytics/Tesseract model objects are process-global. Serialize inference
# across camera workers until a dedicated GPU scheduler is introduced.
AI_INFERENCE_LOCK = threading.Lock()


@dataclass(frozen=True)
class CameraWorkerConfig:
    site_id: str
    camera_id: str
    rtsp_url: str
    site_uuid: str | None = None
    camera_uuid: str | None = None
    sample_every_n_frames: int = AI_FRAME_INTERVAL


class CameraWorker:
    """Continuous RTSP ingestion with bounded buffering and local AI processing.

    Capture and AI processing are separated so a slow GPU/OCR cycle cannot cause
    unbounded memory growth. When the processor falls behind, the oldest frame
    is discarded and the newest frame is retained.
    """

    def __init__(self, config: CameraWorkerConfig, outbox: SyncQueue, central: CentralStore, watchlists: WatchlistMatcher) -> None:
        self.config = config
        self.outbox = outbox
        self.central = central
        self.watchlists = watchlists
        self.events = EventBuilder(watchlists)
        self.tracker = VehicleTracker()
        self._capture_thread: threading.Thread | None = None
        self._process_thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._queue_lock = threading.Lock()
        self._frames: deque[tuple[int, Any, float]] = deque(maxlen=MAX_FRAME_QUEUE)
        self._capture: cv2.VideoCapture | None = None
        self._connected = False
        self._last_frame_at: float | None = None
        self._last_processed_at: float | None = None
        self._started_at: float | None = None
        self._frames_received = 0
        self._frames_processed = 0
        self._frames_dropped = 0
        self._reconnects = 0
        self._events_created = 0
        self._last_error: str | None = None
        self._frame_counter = 0

    def start(self) -> None:
        if self.running:
            return
        self._stop.clear()
        self._started_at = time.time()
        self._capture_thread = threading.Thread(target=self._capture_loop, name=f"rtsp-{self.config.camera_id}", daemon=True)
        self._process_thread = threading.Thread(target=self._process_loop, name=f"ai-{self.config.camera_id}", daemon=True)
        self._capture_thread.start()
        self._process_thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._release_capture()
        for thread in (self._capture_thread, self._process_thread):
            if thread and thread.is_alive():
                thread.join(timeout=3)
        self._capture_thread = None
        self._process_thread = None
        self._connected = False

    @property
    def running(self) -> bool:
        return not self._stop.is_set() and (self._capture_thread is not None or self._process_thread is not None)

    def status(self) -> dict[str, Any]:
        now = time.time()
        stale = self._last_frame_at is None or now - self._last_frame_at > FRAME_TIMEOUT_SECONDS
        if self._stop.is_set():
            state = "stopped"
        elif self._connected and not stale:
            state = "streaming"
        elif self._connected:
            state = "stale"
        else:
            state = "connecting"
        return {
            "site_id": self.config.site_id,
            "camera_id": self.config.camera_id,
            "running": self.running,
            "state": state,
            "connected": self._connected,
            "last_frame_at": self._last_frame_at,
            "last_processed_at": self._last_processed_at,
            "frames_received": self._frames_received,
            "frames_processed": self._frames_processed,
            "frames_dropped": self._frames_dropped,
            "reconnects": self._reconnects,
            "events_created": self._events_created,
            "queue_depth": len(self._frames),
            "active_tracks": len(self.tracker._tracks),
            "started_at": self._started_at,
            "last_error": self._last_error,
            "sample_every_n_frames": self.config.sample_every_n_frames,
        }

    def _release_capture(self) -> None:
        capture = self._capture
        self._capture = None
        if capture is not None:
            try:
                capture.release()
            except Exception:
                pass

    def _open_capture(self) -> cv2.VideoCapture | None:
        capture = cv2.VideoCapture(self.config.rtsp_url, cv2.CAP_FFMPEG)
        capture.set(cv2.CAP_PROP_BUFFERSIZE, 2)
        if not capture.isOpened():
            capture.release()
            return None
        return capture

    def _capture_loop(self) -> None:
        while not self._stop.is_set():
            capture = self._open_capture()
            if capture is None:
                self._connected = False
                self._reconnects += 1
                self._last_error = "Unable to open RTSP stream"
                self._stop.wait(RECONNECT_SECONDS)
                continue
            self._capture = capture
            self._connected = True
            self._last_error = None
            try:
                while not self._stop.is_set():
                    ok, frame = capture.read()
                    if not ok or frame is None:
                        self._connected = False
                        self._last_error = "RTSP frame read failed"
                        break
                    self._frame_counter += 1
                    self._frames_received += 1
                    self._last_frame_at = time.time()
                    if self._frame_counter % max(1, self.config.sample_every_n_frames) != 0:
                        continue
                    with self._queue_lock:
                        if len(self._frames) >= MAX_FRAME_QUEUE:
                            self._frames.popleft()
                            self._frames_dropped += 1
                        self._frames.append((self._frame_counter, frame, self._last_frame_at))
            finally:
                self._release_capture()
            if not self._stop.is_set():
                self._reconnects += 1
                self._stop.wait(RECONNECT_SECONDS)

    def _get_frame(self) -> tuple[int, Any, float] | None:
        with self._queue_lock:
            if not self._frames:
                return None
            return self._frames.pop()

    def _process_loop(self) -> None:
        while not self._stop.is_set():
            item = self._get_frame()
            if item is None:
                self._stop.wait(0.01)
                continue
            _, frame, timestamp = item
            try:
                ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
                if not ok:
                    self._last_error = "JPEG evidence encoding failed"
                    continue
                payload = encoded.tobytes()
                with AI_INFERENCE_LOCK:
                    vehicles = infer(frame)
                    plates = detect_and_read(frame)
                self.tracker.update(vehicles)
                tracks = self.tracker.associate_plates(plates)
                built = self.events.build(tracks, site_id=self.config.site_id, camera_id=self.config.camera_id, frame_payload=payload, timestamp=timestamp)
                for event in built:
                    event["site_uuid"] = self.config.site_uuid
                    event["camera_uuid"] = self.config.camera_uuid
                    self.outbox.enqueue(event)
                self._events_created += len(built)
                self._frames_processed += 1
                self._last_processed_at = time.time()
                self._last_error = None
            except (RuntimeError, OSError, cv2.error) as exc:
                self._last_error = str(exc)
                time.sleep(0.05)
