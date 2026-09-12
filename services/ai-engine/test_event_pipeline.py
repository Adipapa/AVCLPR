import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.event_pipeline import EventBuilder, WatchlistMatcher


class EventPipelineTests(unittest.TestCase):
    def setUp(self):
        self.watchlists = WatchlistMatcher()
        self.builder = EventBuilder(self.watchlists)
        self.temp_dir = tempfile.TemporaryDirectory()
        self.patch_root = patch("app.event_pipeline.EVIDENCE_ROOT", Path(self.temp_dir.name))
        self.patch_root.start()

    def tearDown(self):
        self.patch_root.stop()
        self.temp_dir.cleanup()

    def track(self, plate="BJL4821", tracking_id=1, frames=3):
        return {
            "tracking_id": tracking_id,
            "vehicle_type": "car",
            "confidence": 0.92,
            "frame_count": frames,
            "direction": "right",
            "plate_number": plate,
            "plate_confidence": 88.0,
        }

    def test_event_requires_minimum_frames(self):
        events = self.builder.build([self.track(frames=2)], "SITE-01", "CAM-01")
        self.assertEqual(events, [])

    def test_watchlist_match_generates_alert(self):
        self.watchlists.upsert("BJL 4821", "STOLEN", "test")
        events = self.builder.build([self.track()], "SITE-01", "CAM-01")
        self.assertEqual(len(events), 1)
        self.assertTrue(events[0]["watchlist"])
        self.assertEqual(events[0]["watchlist_category"], "STOLEN")
        self.assertEqual(events[0]["alert"]["severity"], "CRITICAL")

    def test_duplicate_event_is_suppressed(self):
        first = self.builder.build([self.track()], "SITE-01", "CAM-01")
        second = self.builder.build([self.track()], "SITE-01", "CAM-01")
        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])

    def test_evidence_hash_is_created(self):
        events = self.builder.build([self.track()], "SITE-01", "CAM-01", b"test-frame")
        evidence = events[0]["evidence"]
        self.assertEqual(len(evidence["sha256"]), 64)
        self.assertTrue(Path(evidence["path"]).exists())


if __name__ == "__main__":
    unittest.main()
