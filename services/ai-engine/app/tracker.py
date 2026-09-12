from __future__ import annotations

import math
import os
import time
from dataclasses import dataclass, field
from typing import Any

IOU_THRESHOLD = float(os.getenv("TRACKER_IOU_THRESHOLD", "0.20"))
MAX_MISSED_FRAMES = int(os.getenv("TRACKER_MAX_MISSED_FRAMES", "30"))
PLATE_ASSOC_IOU = float(os.getenv("PLATE_ASSOC_IOU_THRESHOLD", "0.01"))
PLATE_ASSOC_CENTER_DISTANCE = float(os.getenv("PLATE_ASSOC_CENTER_DISTANCE", "0.35"))


def _center(box: list[float]) -> tuple[float, float]:
    return ((box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0)


def _area(box: list[float]) -> float:
    return max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1])


def _iou(a: list[float], b: list[float]) -> float:
    x1 = max(a[0], b[0])
    y1 = max(a[1], b[1])
    x2 = min(a[2], b[2])
    y2 = min(a[3], b[3])
    intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = _area(a) + _area(b) - intersection
    return intersection / union if union > 0 else 0.0


def _contains(container: list[float], inner: list[float]) -> bool:
    return (
        inner[0] >= container[0]
        and inner[1] >= container[1]
        and inner[2] <= container[2]
        and inner[3] <= container[3]
    )


def _center_distance_ratio(vehicle: list[float], plate: list[float]) -> float:
    vx, vy = _center(vehicle)
    px, py = _center(plate)
    vw = max(1.0, vehicle[2] - vehicle[0])
    vh = max(1.0, vehicle[3] - vehicle[1])
    return math.sqrt(((px - vx) / vw) ** 2 + ((py - vy) / vh) ** 2)


@dataclass
class Track:
    tracking_id: int
    bbox: list[float]
    vehicle_type: str
    confidence: float
    first_seen: float
    last_seen: float
    frame_count: int = 1
    missed_frames: int = 0
    last_plate: str | None = None
    last_plate_confidence: float = 0.0
    plate_seen_at: float | None = None
    history: list[tuple[float, float, float]] = field(default_factory=list)

    def update(self, detection: dict[str, Any], timestamp: float) -> None:
        self.bbox = [float(v) for v in detection["bbox"]]
        self.vehicle_type = str(detection.get("vehicle_type", self.vehicle_type))
        self.confidence = max(self.confidence, float(detection.get("confidence", 0.0)))
        self.last_seen = timestamp
        self.frame_count += 1
        self.missed_frames = 0
        cx, cy = _center(self.bbox)
        self.history.append((timestamp, cx, cy))
        if len(self.history) > 30:
            self.history.pop(0)


class VehicleTracker:
    """Lightweight persistent tracker for edge inference.

    Matching is class-aware and IoU-based. It intentionally avoids inventing
    speed or direction; those are derived later from the trajectory history.
    """

    def __init__(self) -> None:
        self._next_id = 1
        self._tracks: dict[int, Track] = {}

    def reset(self) -> None:
        self._tracks.clear()
        self._next_id = 1

    def update(self, detections: list[dict[str, Any]], timestamp: float | None = None) -> list[dict[str, Any]]:
        now = timestamp if timestamp is not None else time.time()
        unmatched = set(range(len(detections)))
        assignments: dict[int, int] = {}

        candidates: list[tuple[float, int, int]] = []
        for track_id, track in self._tracks.items():
            for index, detection in enumerate(detections):
                if detection.get("vehicle_type") != track.vehicle_type:
                    continue
                score = _iou(track.bbox, [float(v) for v in detection["bbox"]])
                if score >= IOU_THRESHOLD:
                    candidates.append((score, track_id, index))

        for _score, track_id, index in sorted(candidates, reverse=True):
            if track_id in assignments or index not in unmatched:
                continue
            assignments[track_id] = index
            unmatched.remove(index)

        for track_id, index in assignments.items():
            self._tracks[track_id].update(detections[index], now)

        for track in self._tracks.values():
            if track.tracking_id not in assignments:
                track.missed_frames += 1

        for index in sorted(unmatched):
            detection = detections[index]
            bbox = [float(v) for v in detection["bbox"]]
            cx, cy = _center(bbox)
            track = Track(
                tracking_id=self._next_id,
                bbox=bbox,
                vehicle_type=str(detection["vehicle_type"]),
                confidence=float(detection.get("confidence", 0.0)),
                first_seen=now,
                last_seen=now,
                history=[(now, cx, cy)],
            )
            self._tracks[self._next_id] = track
            self._next_id += 1

        stale = [track_id for track_id, track in self._tracks.items() if track.missed_frames > MAX_MISSED_FRAMES]
        for track_id in stale:
            del self._tracks[track_id]

        return [self._serialize(track) for track in sorted(self._tracks.values(), key=lambda item: item.tracking_id) if track.missed_frames == 0]

    def associate_plates(self, plates: list[dict[str, Any]]) -> list[dict[str, Any]]:
        active = [track for track in self._tracks.values() if track.missed_frames == 0]
        for plate in plates:
            plate_box = [float(v) for v in plate["bbox"]]
            best: tuple[float, Track] | None = None
            for track in active:
                if _contains(track.bbox, plate_box):
                    score = 1.0
                else:
                    score = _iou(track.bbox, plate_box)
                    if score < PLATE_ASSOC_IOU and _center_distance_ratio(track.bbox, plate_box) > PLATE_ASSOC_CENTER_DISTANCE:
                        continue
                if best is None or score > best[0]:
                    best = (score, track)

            if best is None:
                continue

            ocr = plate.get("ocr") or {}
            normalized = ocr.get("normalized_plate")
            confidence = float(ocr.get("confidence") or 0.0)
            if normalized and confidence >= track_ocr_threshold():
                best[1].last_plate = str(normalized)
                best[1].last_plate_confidence = confidence
                best[1].plate_seen_at = time.time()

        return [self._serialize(track) for track in active]

    def _serialize(self, track: Track) -> dict[str, Any]:
        direction = None
        if len(track.history) >= 2:
            _, x1, y1 = track.history[0]
            _, x2, y2 = track.history[-1]
            dx, dy = x2 - x1, y2 - y1
            if abs(dx) + abs(dy) > 5:
                direction = "right" if abs(dx) >= abs(dy) and dx > 0 else "left" if abs(dx) >= abs(dy) else "down" if dy > 0 else "up"

        return {
            "tracking_id": track.tracking_id,
            "bbox": [round(v, 2) for v in track.bbox],
            "vehicle_type": track.vehicle_type,
            "confidence": round(track.confidence, 4),
            "first_seen": track.first_seen,
            "last_seen": track.last_seen,
            "frame_count": track.frame_count,
            "missed_frames": track.missed_frames,
            "plate_number": track.last_plate,
            "plate_confidence": round(track.last_plate_confidence, 2),
            "direction": direction,
        }


def track_ocr_threshold() -> float:
    return float(os.getenv("OCR_CONFIDENCE_THRESHOLD", "35"))
