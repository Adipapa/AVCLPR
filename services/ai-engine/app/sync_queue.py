from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

QUEUE_DB = Path(os.getenv("EDGE_QUEUE_DB", "./data/edge-sync.sqlite3"))


class SyncQueue:
    """Durable SQLite outbox for offline-first edge deployments."""

    def __init__(self) -> None:
        QUEUE_DB.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(QUEUE_DB, check_same_thread=False)
        self._conn.execute(
            """CREATE TABLE IF NOT EXISTS event_outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL UNIQUE,
                payload TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                next_attempt_at REAL NOT NULL DEFAULT 0,
                last_error TEXT,
                created_at REAL NOT NULL
            )"""
        )
        self._conn.commit()

    def enqueue(self, event: dict[str, Any]) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR IGNORE INTO event_outbox(event_id,payload,created_at) VALUES(?,?,?)",
                (event["event_id"], json.dumps(event), time.time()),
            )
            self._conn.commit()

    def pending(self, limit: int = 100) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT id,event_id,payload,attempts FROM event_outbox WHERE next_attempt_at<=? ORDER BY id LIMIT ?",
                (time.time(), limit),
            ).fetchall()
        return [{"row_id": r[0], "event_id": r[1], "event": json.loads(r[2]), "attempts": r[3]} for r in rows]

    def acknowledge(self, row_id: int) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM event_outbox WHERE id=?", (row_id,))
            self._conn.commit()

    def fail(self, row_id: int, error: str) -> None:
        with self._lock:
            row = self._conn.execute("SELECT attempts FROM event_outbox WHERE id=?", (row_id,)).fetchone()
            attempts = int(row[0]) + 1 if row else 1
            delay = min(300, 2 ** min(attempts, 8))
            self._conn.execute(
                "UPDATE event_outbox SET attempts=?,next_attempt_at=?,last_error=? WHERE id=?",
                (attempts, time.time() + delay, error[:1000], row_id),
            )
            self._conn.commit()

    def stats(self) -> dict[str, int]:
        with self._lock:
            count = self._conn.execute("SELECT COUNT(*) FROM event_outbox").fetchone()[0]
        return {"pending": int(count)}
