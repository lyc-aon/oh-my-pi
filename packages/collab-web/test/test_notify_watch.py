import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE_PATH = Path(__file__).parents[1] / "scripts/notify-watch.py"
SPEC = importlib.util.spec_from_file_location("notify_watch", MODULE_PATH)
watch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(watch)


class Result:
    def __init__(self, code=0):
        self.returncode = code


class NotifyWatchTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        watch.STATE = root / "state.json"
        watch.SESSION_LINKS = root / "sessions"
        watch.DEFAULT_LINK = root / "collab-room.link"
        self.link = watch.DEFAULT_LINK
        self.link.touch()
        self.registry = [{"id": "collab"}]

    def tearDown(self):
        self.temporary.cleanup()

    def run_watch(self, *, lane=True, relay=True, web=True, sender=None):
        with patch.object(watch, "read_registry", return_value=self.registry), patch.object(
            watch, "lane_health", side_effect=lambda _lane: lane if self.link.exists() else None
        ), patch.object(
            watch, "port_up", side_effect=lambda port: relay if port == 7466 else web
        ), patch.object(watch, "send", side_effect=sender or (lambda *_args, **_kwargs: True)):
            return watch.main()

    def test_first_run_baselines_silently(self):
        sent = []
        self.assertEqual(self.run_watch(sender=lambda *args, **kwargs: sent.append((args, kwargs)) or True), 0)
        self.assertEqual(sent, [])

    def test_lane_death_alerts_once_then_recovery_alerts(self):
        self.run_watch(lane=True)
        sent = []
        self.run_watch(lane=False, sender=lambda label, recovery=False: sent.append((label, recovery)) or True)
        self.run_watch(lane=False, sender=lambda label, recovery=False: sent.append((label, recovery)) or True)
        self.run_watch(lane=True, sender=lambda label, recovery=False: sent.append((label, recovery)) or True)
        self.assertEqual(sent, [("lane collab", False), ("lane collab", True)])

    def test_user_stop_removes_expectation_without_alert(self):
        self.run_watch(lane=True)
        self.link.unlink()
        sent = []
        self.run_watch(lane=False, sender=lambda *args, **kwargs: sent.append((args, kwargs)) or True)
        self.assertEqual(sent, [])
        self.assertEqual(watch.load_state()["lanes"], {})

    def test_relay_failure_and_recovery(self):
        self.run_watch()
        sent = []
        self.run_watch(relay=False, sender=lambda label, recovery=False: sent.append((label, recovery)) or True)
        self.run_watch(relay=True, sender=lambda label, recovery=False: sent.append((label, recovery)) or True)
        self.assertEqual(sent, [("relay", False), ("relay", True)])

    def test_failed_send_keeps_old_state_for_retry(self):
        self.run_watch(lane=True)
        self.assertEqual(self.run_watch(lane=False, sender=lambda *_args, **_kwargs: False), 1)
        self.assertTrue(watch.load_state()["lanes"]["collab"])
        sent = []
        self.assertEqual(
            self.run_watch(lane=False, sender=lambda label, recovery=False: sent.append((label, recovery)) or True),
            0,
        )
        self.assertEqual(sent, [("lane collab", False)])

    def test_lane_mapping_matches_sentry_collab_conventions(self):
        targets = []

        def runner(arguments, **_kwargs):
            targets.append(arguments[-1])
            return Result(0)

        self.assertTrue(watch.lane_health({"id": "collab"}, exists=lambda path: path == watch.DEFAULT_LINK, runner=runner))
        self.assertTrue(
            watch.lane_health(
                {"id": "work"},
                exists=lambda path: path == watch.SESSION_LINKS / "work" / "room.link",
                runner=runner,
            )
        )
        self.assertEqual(targets, ["collab", "collab-work"])

    def test_state_mode_and_static_sender_contract(self):
        watch.save_state({"ok": True})
        self.assertEqual(os.stat(watch.STATE).st_mode & 0o777, 0o600)
        observed = {}

        def runner(arguments, **kwargs):
            observed["arguments"] = arguments
            observed["input"] = kwargs["input"]
            return Result(0)

        self.assertTrue(watch.send("relay", runner=runner))
        self.assertEqual(
            observed["arguments"],
            [watch.NOTIFY, "sentry-collab", "Sentry service needs attention", "warning"],
        )
        self.assertEqual(observed["input"], b"component: relay\n")

    def test_source_has_no_hermes_or_private_link_reads(self):
        source = MODULE_PATH.read_text()
        self.assertNotIn("Hermes", source)
        self.assertNotIn("8644", source)
        self.assertNotIn("room.link').read", source)


if __name__ == "__main__":
    unittest.main()
