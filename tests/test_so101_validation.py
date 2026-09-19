import importlib.util
import json
import tempfile
import unittest
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

    def test_finalize_creates_new_revision_without_overwriting_source(self):
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
            spec.write_text(json.dumps(source), encoding="utf-8")
            args = type(
                "Args",
                (),
                {
                    "confirm": "CREATE-HARDWARE-REVISION",
                    "spec": spec,
                    "output": output,
                    "evidence_uri": "sha256:abc",
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
            self.assertEqual(untouched["kinematics"]["reachMm"], "unknown")


if __name__ == "__main__":
    unittest.main()
