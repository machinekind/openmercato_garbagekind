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
                "bypassable": "false",
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
        self.assertFalse(report["checks"]["emergencyStop"]["bypassable"])
        self.assertEqual(report["checks"]["emergencyStop"]["missingScenarios"], ["grasp"])
        self.assertEqual(
            report["checks"]["deterministicLimits"]["missingLimits"],
            ["command_timeout"],
        )

    def test_policy_artifacts_have_roles_uri_digest_and_training_provenance(self):
        report = validator.blank_report()
        with tempfile.TemporaryDirectory() as directory:
            policy_dir = Path(directory)
            (policy_dir / "config.json").write_text("{}\n", encoding="utf-8")
            (policy_dir / "model.safetensors").write_bytes(b"weights")
            (policy_dir / "policy_preprocessor.json").write_text("{}\n", encoding="utf-8")
            args = type(
                "Args",
                (),
                {
                    "policy_dir": policy_dir,
                    "artifact_base_uri": "s3://physical-ai/policies/run-1/",
                    "task_key": "sort-plastic",
                    "training_run_ref": "train-2026-09-19-001",
                    "framework": "LeRobot 0.6.1",
                    "dataset_version": "dataset-7",
                    "declared_spec_digest": "A" * 64,
                },
            )()
            self.assertEqual(validator.command_artifacts(args, report), 0)
            by_name = {item["name"]: item for item in report["artifacts"]}
            self.assertEqual(by_name["model.safetensors"]["role"], "weights")
            self.assertEqual(by_name["config.json"]["role"], "config")
            self.assertEqual(
                by_name["policy_preprocessor.json"]["uri"],
                "s3://physical-ai/policies/run-1/policy_preprocessor.json",
            )
            self.assertRegex(by_name["model.safetensors"]["sha256"], r"^[0-9a-f]{64}$")
            self.assertEqual(report["policyProvenance"]["declaredSpecDigest"], "a" * 64)
            self.assertEqual(report["policyProvenance"]["trainingRunRef"], "train-2026-09-19-001")

    def test_policy_artifacts_reject_local_uri_and_invalid_declared_digest(self):
        report = validator.blank_report()
        with tempfile.TemporaryDirectory() as directory:
            common = {
                "policy_dir": Path(directory),
                "task_key": "sort-plastic",
                "training_run_ref": "train-1",
                "framework": "LeRobot",
                "dataset_version": "dataset-1",
            }
            invalid_digest = type(
                "Args",
                (),
                {**common, "artifact_base_uri": "s3://policies", "declared_spec_digest": "abc"},
            )()
            with self.assertRaisesRegex(ValueError, "64-character SHA-256"):
                validator.command_artifacts(invalid_digest, report)
            local_uri = type(
                "Args",
                (),
                {**common, "artifact_base_uri": "file:///policy", "declared_spec_digest": "a" * 64},
            )()
            with self.assertRaisesRegex(ValueError, "non-local object storage"):
                validator.command_artifacts(local_uri, report)

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
                "bypassable": False,
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
            self.assertFalse(created["safetyLayer"]["bypassable"])
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


class BusContractTest(unittest.TestCase):
    def joints(self, **overrides):
        rows = [
            {"name": name, "id": motor_id, "firmwareVersion": "3.10"}
            for name, motor_id in validator.JOINTS
        ]
        for index, patch in overrides.items():
            rows[int(index)].update(patch)
        return rows

    def test_six_servos_with_readable_firmware_pass(self):
        status, problems = validator.bus_contract_status(self.joints())

        self.assertEqual(status, "passed")
        self.assertEqual(problems, [])

    def test_duplicate_motor_id_fails(self):
        rows = self.joints()
        rows[1]["id"] = rows[0]["id"]

        status, problems = validator.bus_contract_status(rows)

        self.assertEqual(status, "failed")
        self.assertTrue(any("duplicate" in problem for problem in problems))

    def test_missing_servo_fails(self):
        status, problems = validator.bus_contract_status(self.joints()[:5])

        self.assertEqual(status, "failed")
        self.assertTrue(any("found 5" in problem for problem in problems))

    def test_unreadable_firmware_fails_the_bus_contract(self):
        rows = self.joints()
        rows[3]["firmwareVersion"] = {"error": {"major": {"error": "TimeoutError"}, "minor": 10}}

        status, problems = validator.bus_contract_status(rows)

        self.assertEqual(status, "failed")
        self.assertTrue(any("firmware" in problem for problem in problems))


class PlaceholderTest(unittest.TestCase):
    def measure_args(self, **overrides):
        base = {
            "placeholder": True,
            "confirm": validator.PLACEHOLDER_CONFIRM,
            "reach_mm": None,
            "payload_kg": None,
            "reach_uncertainty_mm": None,
            "payload_uncertainty_kg": None,
            "payload_hold_seconds": 30,
            "instrument": None,
            "operator": None,
            "method": None,
            "notes": "",
        }
        base.update(overrides)
        return type("Args", (), base)()

    def power_args(self, **overrides):
        base = {
            "placeholder": True,
            "confirm": validator.PLACEHOLDER_CONFIRM,
            "expected_min_v": None,
            "expected_max_v": None,
            "measured_idle_v": None,
            "measured_loaded_v": None,
            "instrument": None,
            "operator": None,
            "method": None,
            "evidence_uri": None,
        }
        base.update(overrides)
        return type("Args", (), base)()

    def test_placeholder_measurements_never_get_passed_status(self):
        report = validator.blank_report()

        validator.command_measure(self.measure_args(), report)

        for check in ("reach", "payload"):
            self.assertEqual(report["checks"][check]["status"], validator.PLACEHOLDER_STATUS)
            self.assertEqual(report["checks"][check]["provenance"], "synthetic")
            self.assertIn("nie pochodzi z pomiaru", report["checks"][check]["note"])

    def test_placeholder_power_never_gets_passed_status(self):
        report = validator.blank_report()

        validator.command_power(self.power_args(), report)

        self.assertEqual(report["checks"]["power"]["status"], validator.PLACEHOLDER_STATUS)
        self.assertEqual(report["checks"]["power"]["provenance"], "synthetic")

    def test_placeholder_requires_its_own_confirmation_token(self):
        report = validator.blank_report()

        with self.assertRaisesRegex(ValueError, validator.PLACEHOLDER_CONFIRM):
            validator.command_measure(self.measure_args(confirm="VALUES-MEASURED"), report)

    def test_placeholder_evidence_cannot_be_sealed(self):
        report = validator.blank_report()
        for name in validator.REQUIRED_CHECKS:
            report["checks"][name] = {"status": "passed"}
        validator.command_measure(self.measure_args(), report)
        validator.command_power(self.power_args(), report)

        self.assertEqual(validator.overall_status(report), "partial")
        with tempfile.TemporaryDirectory() as directory:
            args = type(
                "Args",
                (),
                {"confirm": "SEAL-PHYSICAL-EVIDENCE", "output": Path(directory) / "sealed.json"},
            )()
            with self.assertRaisesRegex(ValueError, "incomplete"):
                validator.command_seal(args, report)

    def test_measured_mode_still_demands_every_value(self):
        report = validator.blank_report()
        args = self.measure_args(placeholder=False, confirm="VALUES-MEASURED")

        with self.assertRaisesRegex(ValueError, "Missing measured values"):
            validator.command_measure(args, report)


class AdapterIdentityTest(unittest.TestCase):
    def ports(self):
        return [
            {"device": "/dev/ttyACM0", "serialNumber": "5AAF219965", "vid": "1A86", "pid": "55D3"},
            {"device": "/dev/ttyS0", "serialNumber": None, "vid": None, "pid": None},
        ]

    def test_identity_is_taken_from_the_matching_port(self):
        identity = validator.adapter_identity("/dev/ttyACM0", self.ports())

        self.assertEqual(identity["serialNumber"], "5AAF219965")
        self.assertEqual(identity["vid"], "1A86")

    def test_unknown_port_yields_empty_identity_instead_of_raising(self):
        identity = validator.adapter_identity("/dev/ttyACM9", self.ports())

        self.assertIsNone(identity["serialNumber"])
        self.assertEqual(identity["device"], "/dev/ttyACM9")

    def test_swapped_unit_on_the_same_path_is_a_conflict(self):
        previous = {"device": "/dev/ttyACM0", "serialNumber": "5AAF219965"}
        current = {"device": "/dev/ttyACM0", "serialNumber": "5AAF220303"}

        conflict = validator.adapter_conflict(previous, current)

        self.assertIsNotNone(conflict)
        self.assertIn("5AAF220303", conflict)

    def test_same_unit_replugged_is_not_a_conflict(self):
        identity = {"device": "/dev/ttyACM0", "serialNumber": "5AAF219965"}

        self.assertIsNone(validator.adapter_conflict(identity, identity))

    def test_first_run_has_nothing_to_compare_against(self):
        self.assertIsNone(
            validator.adapter_conflict(None, {"device": "/dev/ttyACM0", "serialNumber": "X"})
        )


if __name__ == "__main__":
    unittest.main()
