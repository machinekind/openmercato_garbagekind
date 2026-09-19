import base64
import importlib.util
import json
import os
import stat
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path


AGENT_DIR = Path(__file__).parents[1] / "mercato" / "hardware" / "edge_agent"
sys.path.insert(0, str(AGENT_DIR))


def load(name: str):
    spec = importlib.util.spec_from_file_location(f"edge_agent_{name}", AGENT_DIR / f"{name}.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


protocol = load("protocol")
identity = load("identity")
journal = load("journal")


class CanonicalJsonTest(unittest.TestCase):
    def test_keys_are_sorted_at_every_level(self):
        value = {"b": {"d": 1, "c": 2}, "a": 3}

        self.assertEqual(protocol.canonical_json(value), '{"a":3,"b":{"c":2,"d":1}}')

    def test_array_order_is_preserved(self):
        self.assertEqual(protocol.canonical_json([3, 1, 2]), "[3,1,2]")

    def test_integral_floats_are_written_the_javascript_way(self):
        # JSON.stringify(1.0) daje "1"; json.dumps dalby "1.0" i inny skrot.
        self.assertEqual(protocol.canonical_json({"x": 1.0}), '{"x":1}')

    def test_negative_zero_collapses_like_in_javascript(self):
        self.assertEqual(protocol.canonical_json(-0.0), "0")

    def test_exponent_notation_drops_the_leading_zero(self):
        self.assertEqual(protocol.canonical_json(1e-7), "1e-7")
        self.assertEqual(protocol.canonical_json(1e21), "1e+21")

    def test_non_finite_numbers_are_refused(self):
        with self.assertRaises(ValueError):
            protocol.canonical_json(float("nan"))
        with self.assertRaises(ValueError):
            protocol.canonical_json(float("inf"))

    def test_unicode_is_not_escaped(self):
        self.assertEqual(protocol.canonical_json("łódź"), '"łódź"')

    def test_booleans_are_not_treated_as_numbers(self):
        self.assertEqual(protocol.canonical_json({"a": True, "b": False}), '{"a":true,"b":false}')


class PayloadPrefixTest(unittest.TestCase):
    def test_each_message_carries_its_own_prefix(self):
        stamp = "2026-09-20T01:00:00.000Z"
        built = {
            protocol.enroll_payload("t", "f"),
            protocol.connect_payload("a", stamp),
            protocol.heartbeat_payload("s", 1, stamp),
            protocol.rotate_payload("a", "f2"),
            protocol.lease_payload("s", 1, stamp),
            protocol.report_payload("s", "running", stamp),
        }

        self.assertEqual(len(built), 6)
        prefixes = sorted(text.split(":", 1)[0] for text in built)
        self.assertEqual(
            prefixes,
            ["deployment.lease", "deployment.report", "edge.connect", "edge.enroll",
             "edge.heartbeat", "edge.rotate"],
        )

    def test_lease_and_report_signatures_cannot_be_swapped(self):
        stamp = "2026-09-20T01:00:00.000Z"

        self.assertNotEqual(
            protocol.lease_payload("s", 1, stamp), protocol.report_payload("s", "running", stamp)
        )

    def test_telemetry_binds_the_payload_digest(self):
        stamp = "2026-09-20T01:00:00.000Z"
        first = protocol.telemetry_payload("s", 1, stamp, "episode", {"a": 1})
        second = protocol.telemetry_payload("s", 1, stamp, "episode", {"a": 2})

        self.assertNotEqual(first, second)
        self.assertTrue(first.startswith("edge.telemetry:s:1:"))

    def test_unknown_telemetry_kind_is_refused(self):
        with self.assertRaises(ValueError):
            protocol.telemetry_payload("s", 1, "2026-09-20T01:00:00.000Z", "guess", {})

    def test_unknown_reported_state_is_refused(self):
        with self.assertRaises(ValueError):
            protocol.report_payload("s", "maybe", "2026-09-20T01:00:00.000Z")

    def test_timestamp_carries_milliseconds_and_zulu_suffix(self):
        stamp = protocol.iso_timestamp(datetime(2026, 9, 20, 1, 2, 3, 456789, tzinfo=timezone.utc))

        self.assertEqual(stamp, "2026-09-20T01:02:03.456Z")


class IdentityTest(unittest.TestCase):
    def test_fingerprint_is_taken_from_der_not_from_pem_text(self):
        private_key = identity.generate_private_key_pem()
        public_key = identity.public_key_pem(private_key)
        rewrapped = public_key.replace("\n", "\r\n")

        self.assertEqual(identity.fingerprint(public_key), identity.fingerprint(rewrapped))

    def test_signature_is_base64_and_verifies_against_the_public_key(self):
        from cryptography.hazmat.primitives import serialization

        private_key = identity.generate_private_key_pem()
        signature = identity.sign(private_key, "edge.connect:a:2026-09-20T01:00:00.000Z")
        public_key = serialization.load_pem_public_key(
            identity.public_key_pem(private_key).encode("ascii")
        )

        public_key.verify(
            base64.b64decode(signature), b"edge.connect:a:2026-09-20T01:00:00.000Z"
        )

    def test_stored_identity_is_not_world_readable(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "identity.json"
            identity.save_identity(
                path, identity.Identity(base_url="http://x", private_key_pem=identity.generate_private_key_pem())
            )

            mode = stat.S_IMODE(os.stat(path).st_mode)

        self.assertEqual(mode, identity.IDENTITY_FILE_MODE)

    def test_redacted_view_never_carries_the_private_key(self):
        record = identity.Identity(base_url="http://x", private_key_pem="SECRET-KEY-MATERIAL")

        self.assertNotIn("SECRET", json.dumps(record.redacted()))

    def test_new_session_resets_both_counters(self):
        record = identity.Identity(base_url="http://x", private_key_pem="k", sequence=17, lease_sequence=4)

        record.start_session("session-2")

        self.assertEqual((record.sequence, record.lease_sequence), (0, 0))

    def test_heartbeat_and_lease_counters_advance_independently(self):
        record = identity.Identity(base_url="http://x", private_key_pem="k")

        self.assertEqual(record.next_sequence(), 1)
        self.assertEqual(record.next_sequence(), 2)
        self.assertEqual(record.next_lease_sequence(), 1)
        self.assertEqual(record.sequence, 2)

    def test_identity_round_trips_through_disk(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "identity.json"
            original = identity.Identity(
                base_url="http://x",
                private_key_pem=identity.generate_private_key_pem(),
                agent_id="a",
                session_id="s",
                sequence=5,
            )
            identity.save_identity(path, original)

            restored = identity.load_identity(path)

        self.assertEqual(restored.agent_id, "a")
        self.assertEqual(restored.sequence, 5)
        self.assertEqual(restored.private_key_pem, original.private_key_pem)


class JournalMappingTest(unittest.TestCase):
    def entry(self, **overrides):
        base = {
            "action": "random_pose",
            "status": "reached",
            "observedAt": "2026-09-20T01:00:10.000000Z",
            "durationS": 0.73,
            "maxErrorDeg": 2.37,
            "deltaBudgetDeg": 30.0,
            "targetPositionRaw": {"shoulder_pan": 2053, "shoulder_lift": 1341},
            "haltedJoints": [],
        }
        base.update(overrides)
        return base

    def test_reached_move_becomes_a_successful_episode(self):
        episode = journal.episode_from_entry(self.entry())

        self.assertEqual(episode["outcome"], "success")
        self.assertEqual(episode["taskKey"], journal.TASK_KEY)
        self.assertEqual(episode["startedAt"], "2026-09-20T01:00:09.270Z")
        self.assertEqual(episode["endedAt"], "2026-09-20T01:00:10.000Z")
        self.assertEqual(episode["metrics"]["jointsMoved"], 2)

    def test_timeout_keeps_its_own_outcome(self):
        self.assertEqual(journal.episode_from_entry(self.entry(status="timeout"))["outcome"], "timeout")

    def test_overload_halt_is_an_aborted_episode_with_an_intervention(self):
        entry = self.entry(status="halted_on_load", haltedJoints=["shoulder_lift"])

        episode = journal.episode_from_entry(entry)
        intervention = journal.intervention_from_entry(entry)

        self.assertEqual(episode["outcome"], "aborted")
        self.assertIn("shoulder_lift", episode["outcomeDetail"])
        self.assertEqual(intervention["kind"], "abort")
        self.assertEqual(intervention["reasonCategory"], "unsafe_motion")
        self.assertIn(intervention["reasonCategory"], protocol.INTERVENTION_REASON_CATEGORIES)
        self.assertIn(intervention["kind"], protocol.INTERVENTION_KINDS)

    def test_successful_move_produces_no_intervention(self):
        self.assertIsNone(journal.intervention_from_entry(self.entry()))

    def test_non_motion_entries_are_skipped(self):
        self.assertIsNone(journal.episode_from_entry(self.entry(action="enable", status="enabled")))
        self.assertIsNone(journal.episode_from_entry(self.entry(action="release", status="released")))

    def test_external_ref_is_stable_for_the_same_move(self):
        entry = self.entry()

        self.assertEqual(journal.external_ref(entry), journal.external_ref(dict(entry)))

    def test_external_ref_differs_between_moves(self):
        first = journal.external_ref(self.entry())
        second = journal.external_ref(self.entry(observedAt="2026-09-20T01:00:20.000000Z"))

        self.assertNotEqual(first, second)

    def test_outcome_values_stay_inside_the_contract(self):
        for status in journal.OUTCOME_BY_STATUS.values():
            self.assertIn(status, protocol.EPISODE_OUTCOMES)

    def test_damaged_lines_do_not_abort_the_export(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "journal.ndjson"
            path.write_text(
                json.dumps(self.entry()) + "\nnie-json\n" + json.dumps(self.entry()) + "\n",
                encoding="utf-8",
            )

            entries = list(journal.read_journal(path))

        self.assertEqual(len(entries), 2)

    def test_missing_journal_yields_nothing_instead_of_raising(self):
        self.assertEqual(list(journal.read_journal(Path("/nonexistent/journal.ndjson"))), [])


if __name__ == "__main__":
    unittest.main()
