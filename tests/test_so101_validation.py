import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "mercato" / "hardware" / "so101" / "validate.py"
SPEC = importlib.util.spec_from_file_location("so101_validate", MODULE_PATH)
assert SPEC and SPEC.loader
validator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validator)


class SO101ValidationTest(unittest.TestCase):
    def test_report_cannot_pass_without_every_physical_check(self):
        report = validator.blank_report()
        for name in validator.REQUIRED_CHECKS[:-1]:
            report["checks"][name] = {"status": "passed"}
        self.assertEqual(validator.overall_status(report), "partial")
        report["checks"][validator.REQUIRED_CHECKS[-1]] = {"status": "passed"}
        self.assertEqual(validator.overall_status(report), "passed")

    def test_calibration_rejects_missing_joint_and_invalid_range(self):
        calibration = {
            name: {"id": motor_id, "drive_mode": 0, "homing_offset": 0, "range_min": 1, "range_max": 2}
            for name, motor_id in validator.JOINTS
        }
        calibration.pop("gripper")
        calibration["shoulder_pan"]["range_min"] = 10
        calibration["shoulder_pan"]["range_max"] = 10
        valid, problems = validator.calibration_is_plausible(calibration)
        self.assertFalse(valid)
        self.assertTrue(any("gripper" in problem for problem in problems))
        self.assertTrue(any("shoulder_pan" in problem for problem in problems))

    def test_calibration_metadata_has_expiry_format_and_uncertainty(self):
        measured = datetime(2026, 9, 19, 10, 0, tzinfo=timezone.utc)
        metadata = validator.calibration_metadata(measured, 30, 0.5)
        self.assertEqual(metadata["format"], "lerobot-motors-bus-v1")
        self.assertEqual(metadata["measuredAt"], "2026-09-19T10:00:00Z")
        self.assertEqual(metadata["validUntil"], "2026-10-19T10:00:00Z")
        self.assertEqual(metadata["uncertainty"]["value"], 0.5)
        self.assertEqual(metadata["uncertainty"]["unit"], "degree")

    def test_calibration_metadata_rejects_missing_validity_and_uncertainty(self):
        measured = datetime(2026, 9, 19, 10, 0, tzinfo=timezone.utc)
        with self.assertRaisesRegex(ValueError, "positive number of days"):
            validator.calibration_metadata(measured, 0, 0.5)
        with self.assertRaisesRegex(ValueError, "non-negative number"):
            validator.calibration_metadata(measured, 30, -0.1)

    def test_power_fails_outside_declared_supply_range(self):
        report = validator.blank_report()
        args = type(
            "Args",
            (),
            {
                "confirm": "POWER-MEASURED",
                "expected_min_v": 7.0,
                "expected_max_v": 8.4,
                "measured_idle_v": 7.5,
                "measured_loaded_v": 4.8,
                "instrument": "meter-1",
                "operator": "tester",
                "method": "measured at motor bus",
                "evidence_uri": "sha256:power",
            },
        )()
        self.assertEqual(validator.command_power(args, report), 1)
        self.assertEqual(report["checks"]["power"]["status"], "failed")

    def test_safety_requires_all_scenarios_and_limit_kinds(self):
        report = validator.blank_report()
        args = type(
            "Args",
            (),
            {
                "confirm": "PHYSICAL-SAFETY-TESTED",
                "mechanism": "hardware_estop",
                "stop_time_ms": 75.0,
                "estop_scenarios": "idle,motion",
                "limit_tests": "position,speed",
                "implemented_in": "safety controller",
                "reset_procedure": "manual reset",
                "operator": "tester",
                "method": "measured with synchronized logger",
                "evidence_uri": "sha256:safety",
            },
        )()
        self.assertEqual(validator.command_safety(args, report), 1)
        self.assertEqual(report["checks"]["emergencyStop"]["missingScenarios"], ["grasp"])
        self.assertEqual(
            report["checks"]["deterministicLimits"]["missingLimits"],
            ["command_timeout"],
        )

    def test_seal_and_finalize_create_digest_bound_revision_without_overwriting_source(self):
        report = validator.blank_report()
        for name in validator.REQUIRED_CHECKS:
            report["checks"][name] = {"status": "passed"}
        report["checks"]["reach"]["valueMm"] = 420.0
        report["checks"]["payload"]["valueKg"] = 0.25
        report["checks"]["reach"]["uncertaintyMm"] = 2.0
        report["checks"]["payload"]["uncertaintyKg"] = 0.01
        report["checks"]["emergencyStop"].update(
            {
                "mechanism": "hardware_estop",
                "stopTimeMs": 75.0,
                "testedScenarios": ["grasp", "idle", "motion"],
                "evidenceUri": "sha256:safety",
            }
        )
        report["checks"]["deterministicLimits"].update(
            {
                "implementedIn": "safety controller",
                "testedLimits": ["command_timeout", "position", "speed"],
            }
        )
        report["port"] = "COM5"

        source = {
            "embodimentKey": "so101_follower",
            "revision": 1,
            "provenance": {"sourcedFrom": "documentation", "verifiedAgainstHardware": False, "sources": []},
            "kinematics": {"payloadKg": "unknown", "reachMm": "unknown"},
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = root / "r1.json"
            output = root / "r2.json"
            sealed = root / "evidence.sealed.json"
            spec.write_text(json.dumps(source), encoding="utf-8")
            seal_args = type(
                "Args",
                (),
                {
                    "confirm": "SEAL-PHYSICAL-EVIDENCE",
                    "output": sealed,
                },
            )()
            self.assertEqual(validator.command_seal(seal_args, report), 0)
            expected_digest = validator.sha256_file(sealed)
            args = type(
                "Args",
                (),
                {
                    "confirm": "CREATE-HARDWARE-REVISION",
                    "spec": spec,
                    "output": output,
                    "sealed_report": sealed,
                },
            )()
            self.assertEqual(validator.command_finalize(args, report), 0)
            created = json.loads(output.read_text(encoding="utf-8"))
            untouched = json.loads(spec.read_text(encoding="utf-8"))
            self.assertEqual(created["revision"], 2)
            self.assertEqual(created["kinematics"]["reachMm"], 420.0)
            self.assertEqual(created["kinematics"]["measurementUncertainty"]["payloadKg"], 0.01)
            self.assertEqual(created["safetyLayer"]["mechanism"], "hardware_estop")
            self.assertTrue(created["safetyLayer"]["verifiedAgainstHardware"])
            self.assertTrue(created["provenance"]["verifiedAgainstHardware"])
            self.assertEqual(created["provenance"]["evidenceDigest"], expected_digest)
            self.assertIn(f"sha256:{expected_digest}", created["provenance"]["sources"])
            self.assertEqual(untouched["kinematics"]["reachMm"], "unknown")

    def test_finalize_rejects_sealed_evidence_from_another_run(self):
        current = validator.blank_report()
        sealed_report = validator.blank_report()
        for name in validator.REQUIRED_CHECKS:
            sealed_report["checks"][name] = {"status": "passed"}
        sealed_report["overallStatus"] = "passed"
        sealed_report["seal"] = {"sealedAt": validator.now_iso(), "algorithm": "sha256"}

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sealed = root / "evidence.sealed.json"
            spec = root / "r1.json"
            sealed.write_text(json.dumps(sealed_report), encoding="utf-8")
            spec.write_text(json.dumps({"embodimentKey": "so101_follower"}), encoding="utf-8")
            args = type(
                "Args",
                (),
                {
                    "confirm": "CREATE-HARDWARE-REVISION",
                    "spec": spec,
                    "output": root / "r2.json",
                    "sealed_report": sealed,
                },
            )()
            with self.assertRaisesRegex(ValueError, "different validation run"):
                validator.command_finalize(args, current)


if __name__ == "__main__":
    unittest.main()
