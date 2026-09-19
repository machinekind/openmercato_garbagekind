import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "mercato" / "hardware" / "evidence_bundle.py"
SPEC = importlib.util.spec_from_file_location("evidence_bundle", MODULE_PATH)
assert SPEC and SPEC.loader
validator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validator)


RUN_REF = "11111111-1111-4111-8111-111111111111"
ROBOT_KEY = "SO101-0001"
SHA = "a" * 64
NOW = "2026-09-19T10:00:00Z"
LATER = "2026-10-19T10:00:00Z"


def write_json(path: Path, value):
    path.write_text(json.dumps(value, ensure_ascii=False) + "\n", encoding="utf-8")


def build_bundle(root: Path, failed_trial=None):
    write_json(
        root / "run.json",
        {
            "schemaVersion": 1,
            "runRef": RUN_REF,
            "robotKey": ROBOT_KEY,
            "operatorRef": "operator:pseudonym-01",
            "startedAt": NOW,
            "endedAt": "2026-09-19T10:05:00Z",
            "embodiment": {"key": "so101_follower", "revision": 2, "specDigest": SHA},
            "clockSync": {"source": "ptp:dgx-spark", "measuredAt": NOW, "maxOffsetMs": 1.5},
        },
    )
    write_json(
        root / "hardware.json",
        {
            "runRef": RUN_REF,
            "robotKey": ROBOT_KEY,
            "devices": [
                {
                    "role": "motor_bus",
                    "model": "Feetech STS3215 x6",
                    "serialHash": SHA,
                    "firmware": "observed:1",
                    "connection": "COM5",
                }
            ],
        },
    )
    write_json(
        root / "calibration.json",
        {
            "runRef": RUN_REF,
            "robotKey": ROBOT_KEY,
            "calibrations": [
                {
                    "key": "joint_offsets",
                    "producedBy": "LeRobot SOFollower.calibrate",
                    "artifactUri": "s3://evidence/calibration.json",
                    "sha256": SHA,
                    "measuredAt": NOW,
                    "validUntil": LATER,
                    "uncertainty": {"value": 0.5, "unit": "degree"},
                }
            ],
        },
    )
    trials = []
    for kind, scenario in sorted(validator.REQUIRED_P0_TRIALS):
        trials.append(
            {
                "kind": kind,
                "scenario": scenario,
                "result": "failed" if (kind, scenario) == failed_trial else "passed",
                "occurredAt": NOW,
                "method": "controlled physical trial",
                "evidenceUri": f"s3://evidence/{kind}-{scenario}.json",
            }
        )
    write_json(
        root / "safety.json",
        {
            "runRef": RUN_REF,
            "robotKey": ROBOT_KEY,
            "deterministicLayer": {
                "kind": "hardware_estop",
                "implementedIn": "dual-channel controller",
                "bypassable": False,
            },
            "trials": trials,
        },
    )
    (root / "telemetry.ndjson").write_text(
        json.dumps(
            {
                "runRef": RUN_REF,
                "externalRef": "telemetry:1",
                "timestamp": NOW,
                "sequence": 1,
                "stream": "joint_state",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    (root / "interventions.ndjson").write_text(
        json.dumps(
            {
                "runRef": RUN_REF,
                "externalRef": "intervention:1",
                "occurredAt": NOW,
                "kind": "estop",
                "reasonCategory": "person_in_safety_zone",
                "reason": "controlled P0 trial",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    write_json(
        root / "media-index.json",
        {
            "runRef": RUN_REF,
            "entries": [
                {
                    "uri": "s3://evidence/camera-1/clip.mp4",
                    "sha256": SHA,
                    "recordedAt": NOW,
                    "cameraKey": "camera-1",
                    "retentionUntil": LATER,
                    "anonymized": True,
                }
            ],
        },
    )
    lines = []
    for path in sorted(root.iterdir()):
        if path.name == "checksums.sha256":
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        lines.append(f"{digest}  {path.name}")
    (root / "checksums.sha256").write_text("\n".join(lines) + "\n", encoding="utf-8")


class EvidenceBundleTest(unittest.TestCase):
    def test_complete_bundle_passes_integrity_and_p0_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build_bundle(root)
            result = validator.verify_bundle(root, require_p0_pass=True)
            self.assertEqual(result["integrity"], "verified")
            self.assertEqual(result["p0SafetyGate"], "passed")
            self.assertEqual(result["counts"]["checksums"], 7)

    def test_tampered_file_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build_bundle(root)
            (root / "telemetry.ndjson").write_text("{}\n", encoding="utf-8")
            with self.assertRaisesRegex(validator.EvidenceError, "runRef does not match"):
                validator.verify_bundle(root)

    def test_semantically_unchanged_tamper_is_rejected_by_checksum(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build_bundle(root)
            telemetry = root / "telemetry.ndjson"
            telemetry.write_text(telemetry.read_text(encoding="utf-8") + "\n", encoding="utf-8")
            with self.assertRaisesRegex(validator.EvidenceError, "SHA-256 mismatch"):
                validator.verify_bundle(root)

    def test_unlisted_extra_file_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build_bundle(root)
            (root / "unlisted.log").write_text("not in manifest\n", encoding="utf-8")
            with self.assertRaisesRegex(validator.EvidenceError, "omits files: unlisted.log"):
                validator.verify_bundle(root)

    def test_missing_p0_trial_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build_bundle(root)
            safety = json.loads((root / "safety.json").read_text(encoding="utf-8"))
            safety["trials"] = safety["trials"][:-1]
            write_json(root / "safety.json", safety)
            with self.assertRaisesRegex(validator.EvidenceError, "missing P0 trials"):
                validator.verify_bundle(root)

    def test_failed_trial_is_valid_evidence_but_fails_acceptance_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build_bundle(root, failed_trial=("estop", "motion"))
            result = validator.verify_bundle(root)
            self.assertEqual(result["p0SafetyGate"], "failed")
            with self.assertRaisesRegex(validator.EvidenceError, "P0 safety gate failed"):
                validator.verify_bundle(root, require_p0_pass=True)

    def test_local_media_uri_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build_bundle(root)
            media = json.loads((root / "media-index.json").read_text(encoding="utf-8"))
            media["entries"][0]["uri"] = "file:///operator/video.mp4"
            write_json(root / "media-index.json", media)
            with self.assertRaisesRegex(validator.EvidenceError, "non-local object storage"):
                validator.verify_bundle(root)


if __name__ == "__main__":
    unittest.main()
