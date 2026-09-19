#!/usr/bin/env python3
"""Physical acceptance harness for a LeRobot SO-101 follower arm.

The default commands are read-only. Commands that write to the motor bus require
an explicit confirmation token so a CI job or an accidental invocation cannot
move or release the arm.
"""

from __future__ import annotations

import argparse
import copy
import dataclasses
import hashlib
import json
import platform
import re
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


TOOL_VERSION = "1.4.0"
JOINTS = (
    ("shoulder_pan", 1),
    ("shoulder_lift", 2),
    ("elbow_flex", 3),
    ("wrist_flex", 4),
    ("wrist_roll", 5),
    ("gripper", 6),
)
REQUIRED_CHECKS = (
    "busContract",
    "jointOffsets",
    "power",
    "reach",
    "payload",
    "torqueOff",
    "emergencyStop",
    "deterministicLimits",
)
SAFETY_MECHANISMS = (
    "hardware_estop",
    "safety_plc",
    "safety_rated_torque_limit",
    "safety_rated_speed_limit",
    "light_curtain",
    "fence_interlock",
    "dual_channel_relay",
)
POLICY_ARTIFACTS = (
    ("config.json", "config", True),
    ("model.safetensors", "weights", True),
    ("train_config.json", "metadata", False),
    ("policy_preprocessor.json", "preprocessor", False),
    ("normalizer.json", "normalizer", False),
)
REQUIRED_ESTOP_SCENARIOS = {"idle", "motion", "grasp"}
REQUIRED_LIMIT_TESTS = {"position", "speed", "command_timeout"}
SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def json_value(value: Any) -> Any:
    if dataclasses.is_dataclass(value):
        return {key: json_value(item) for key, item in dataclasses.asdict(value).items()}
    if isinstance(value, dict):
        return {str(key): json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_value(item) for item in value]
    if isinstance(value, Path):
        return str(value)
    if hasattr(value, "value"):
        return json_value(value.value)
    return value


def blank_report() -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "toolVersion": TOOL_VERSION,
        "embodimentKey": "so101_follower",
        "embodimentRevision": 1,
        "runRef": str(uuid.uuid4()),
        "createdAt": now_iso(),
        "generatedAt": now_iso(),
        "host": {
            "node": platform.node(),
            "platform": platform.platform(),
            "python": platform.python_version(),
        },
        "port": None,
        "checks": {},
        "artifacts": [],
        "overallStatus": "blocked",
    }


def load_report(path: Path) -> dict[str, Any]:
    if not path.exists():
        return blank_report()
    report = json.loads(path.read_text(encoding="utf-8"))
    if report.get("schemaVersion") != 1 or report.get("embodimentKey") != "so101_follower":
        raise ValueError(f"Unsupported SO-101 evidence report: {path}")
    return report


def overall_status(report: dict[str, Any]) -> str:
    checks = report.get("checks", {})
    statuses = [checks.get(name, {}).get("status") for name in REQUIRED_CHECKS]
    if any(status == "failed" for status in statuses):
        return "failed"
    if all(status == "passed" for status in statuses):
        return "passed"
    if not any(status in {"passed", "failed"} for status in statuses):
        return "blocked"
    return "partial"


def save_report(path: Path, report: dict[str, Any]) -> None:
    report["generatedAt"] = now_iso()
    report["overallStatus"] = overall_status(report)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def discover_ports() -> list[dict[str, str | None]]:
    try:
        from serial.tools import list_ports
    except ImportError as exc:
        raise RuntimeError("Missing pyserial; install requirements-hardware.txt") from exc
    return [
        {
            "device": port.device,
            "description": port.description,
            "hwid": port.hwid,
            "vid": f"{port.vid:04X}" if port.vid is not None else None,
            "pid": f"{port.pid:04X}" if port.pid is not None else None,
            "serialNumber": port.serial_number,
        }
        for port in list_ports.comports()
    ]


def lerobot_runtime() -> tuple[Any, Any, Any, Any]:
    try:
        from lerobot.motors import Motor, MotorNormMode
        from lerobot.motors.feetech import FeetechMotorsBus
        from lerobot.robots.so_follower import SOFollower, SOFollowerRobotConfig
    except ImportError as exc:
        raise RuntimeError(
            "Missing LeRobot Feetech runtime; install requirements-hardware.txt"
        ) from exc
    return Motor, MotorNormMode, FeetechMotorsBus, (SOFollower, SOFollowerRobotConfig)


def make_bus(port: str) -> Any:
    Motor, MotorNormMode, FeetechMotorsBus, _ = lerobot_runtime()
    motors = {
        name: Motor(
            motor_id,
            "sts3215",
            MotorNormMode.RANGE_0_100 if name == "gripper" else MotorNormMode.DEGREES,
        )
        for name, motor_id in JOINTS
    }
    return FeetechMotorsBus(port=port, motors=motors, calibration=None)


def read_register(bus: Any, name: str, motor: str) -> Any:
    try:
        return json_value(bus.read(name, motor, normalize=False, num_retry=2))
    except Exception as exc:  # Evidence should retain a per-register failure.
        return {"error": f"{type(exc).__name__}: {exc}"}


def calibration_payload(calibration: dict[str, Any]) -> dict[str, Any]:
    return {name: json_value(calibration[name]) for name, _ in JOINTS if name in calibration}


def calibration_is_plausible(calibration: dict[str, Any]) -> tuple[bool, list[str]]:
    problems: list[str] = []
    for name, motor_id in JOINTS:
        entry = calibration.get(name)
        if not isinstance(entry, dict):
            problems.append(f"{name}: missing calibration")
            continue
        if entry.get("id") != motor_id:
            problems.append(f"{name}: expected id {motor_id}, got {entry.get('id')}")
        minimum = entry.get("range_min")
        maximum = entry.get("range_max")
        if not isinstance(minimum, int) or not isinstance(maximum, int) or minimum >= maximum:
            problems.append(f"{name}: invalid range {minimum}..{maximum}")
        offset = entry.get("homing_offset")
        if not isinstance(offset, int) or not -2047 <= offset <= 2047:
            problems.append(f"{name}: invalid homing offset {offset}")
    return not problems, problems


def calibration_metadata(
    measured_at: datetime, valid_days: int, uncertainty_deg: float
) -> dict[str, Any]:
    if measured_at.tzinfo is None or measured_at.utcoffset() is None:
        raise ValueError("Calibration timestamp must be timezone-aware")
    if not isinstance(valid_days, int) or isinstance(valid_days, bool) or valid_days <= 0:
        raise ValueError("Calibration validity must be a positive number of days")
    if (
        not isinstance(uncertainty_deg, (int, float))
        or isinstance(uncertainty_deg, bool)
        or uncertainty_deg < 0
    ):
        raise ValueError("Calibration uncertainty must be a non-negative number")
    measured_utc = measured_at.astimezone(timezone.utc)
    valid_until = measured_utc + timedelta(days=valid_days)
    return {
        "format": "lerobot-motors-bus-v1",
        "measuredAt": measured_utc.isoformat().replace("+00:00", "Z"),
        "validUntil": valid_until.isoformat().replace("+00:00", "Z"),
        "validityDays": valid_days,
        "uncertainty": {
            "value": float(uncertainty_deg),
            "unit": "degree",
            "appliesTo": "joint_homing_offset",
        },
    }


def command_scan(args: argparse.Namespace, report: dict[str, Any]) -> int:
    ports = discover_ports()
    report["checks"]["discovery"] = {
        "status": "passed" if ports else "blocked",
        "observedAt": now_iso(),
        "ports": ports,
        "reason": None if ports else "Operating system exposes no serial ports",
    }
    print(json.dumps(ports, indent=2, ensure_ascii=False) if ports else "No serial ports detected.")
    return 0 if ports else 2


def command_inspect(args: argparse.Namespace, report: dict[str, Any]) -> int:
    bus = make_bus(args.port)
    report["port"] = args.port
    joints: list[dict[str, Any]] = []
    try:
        bus.connect()
        for name, motor_id in JOINTS:
            model_number = bus.ping(name, num_retry=2, raise_on_error=True)
            joints.append(
                {
                    "name": name,
                    "id": motor_id,
                    "expectedModel": "STS3215",
                    "modelNumber": model_number,
                    "torqueEnabled": read_register(bus, "Torque_Enable", name),
                    "operatingMode": read_register(bus, "Operating_Mode", name),
                    "presentPositionRaw": read_register(bus, "Present_Position", name),
                }
            )
        observed_calibration = calibration_payload(bus.read_calibration())
    finally:
        if getattr(bus, "is_connected", False):
            # Inspection is read-only: preserve the torque state found on entry.
            bus.disconnect(disable_torque=False)

    correct_ids = [joint["id"] for joint in joints] == [motor_id for _, motor_id in JOINTS]
    report["checks"]["busContract"] = {
        "status": "passed" if len(joints) == 6 and correct_ids else "failed",
        "observedAt": now_iso(),
        "readOnly": True,
        "joints": joints,
    }
    report["checks"]["jointOffsetsObserved"] = {
        "status": "observed",
        "observedAt": now_iso(),
        "calibration": observed_calibration,
        "sha256": sha256_bytes(
            json.dumps(observed_calibration, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ),
        "note": "Registers alone do not prove that the full LeRobot calibration procedure was completed.",
    }
    print(f"Read six motors on {args.port}; no motor configuration was changed.")
    return 0


def command_calibrate(args: argparse.Namespace, report: dict[str, Any]) -> int:
    if args.confirm != "CALIBRATE-SO101":
        raise ValueError("Calibration requires --confirm CALIBRATE-SO101")
    # Reject incomplete evidence metadata before opening the motor bus or
    # starting the interactive calibration procedure.
    calibration_metadata(datetime.now(timezone.utc), args.valid_days, args.uncertainty_deg)
    _, _, _, robot_types = lerobot_runtime()
    SOFollower, SOFollowerRobotConfig = robot_types
    calibration_dir = args.calibration_dir.resolve()
    calibration_dir.mkdir(parents=True, exist_ok=True)
    config = SOFollowerRobotConfig(
        port=args.port,
        id=args.robot_id,
        calibration_dir=calibration_dir,
        disable_torque_on_disconnect=True,
        max_relative_target=5.0,
    )
    robot = SOFollower(config)
    try:
        robot.bus.connect()
        robot.calibrate()
        calibration = calibration_payload(robot.bus.read_calibration())
    finally:
        if getattr(robot.bus, "is_connected", False):
            robot.bus.disconnect(disable_torque=True)

    plausible, problems = calibration_is_plausible(calibration)
    calibration_file = Path(robot.calibration_fpath)
    metadata = calibration_metadata(
        datetime.now(timezone.utc), args.valid_days, args.uncertainty_deg
    )
    report["port"] = args.port
    report["checks"]["jointOffsets"] = {
        "status": "passed" if plausible and calibration_file.exists() else "failed",
        "observedAt": now_iso(),
        "producer": "LeRobot SOFollower.calibrate",
        "lerobotRobotId": args.robot_id,
        "calibrationFile": str(calibration_file),
        "calibrationFileSha256": sha256_file(calibration_file) if calibration_file.exists() else None,
        "calibration": calibration,
        **metadata,
        "invalidatedBy": [
            "servo replacement",
            "horn remount or loosening",
            "collision moving a joint outside its recorded range",
            "motor id or drive mode change",
        ],
        "problems": problems,
    }
    print(f"Calibration saved and read back: {calibration_file}")
    return 0 if plausible and calibration_file.exists() else 1


def command_measure(args: argparse.Namespace, report: dict[str, Any]) -> int:
    if args.confirm != "VALUES-MEASURED":
        raise ValueError("Measurements require --confirm VALUES-MEASURED")
    if args.reach_mm <= 0 or args.payload_kg <= 0:
        raise ValueError("Reach and payload must be positive measured values")
    if args.reach_uncertainty_mm < 0 or args.payload_uncertainty_kg < 0:
        raise ValueError("Measurement uncertainty cannot be negative")
    if args.payload_hold_seconds <= 0:
        raise ValueError("Payload hold time must be positive")
    common = {
        "status": "passed",
        "observedAt": now_iso(),
        "instrument": args.instrument,
        "operator": args.operator,
        "method": args.method,
        "notes": args.notes,
    }
    report["checks"]["reach"] = {
        **common,
        "valueMm": args.reach_mm,
        "uncertaintyMm": args.reach_uncertainty_mm,
    }
    report["checks"]["payload"] = {
        **common,
        "valueKg": args.payload_kg,
        "uncertaintyKg": args.payload_uncertainty_kg,
        "holdSeconds": args.payload_hold_seconds,
    }
    print(f"Recorded measured reach {args.reach_mm} mm and payload {args.payload_kg} kg.")
    return 0


def command_power(args: argparse.Namespace, report: dict[str, Any]) -> int:
    if args.confirm != "POWER-MEASURED":
        raise ValueError("Power validation requires --confirm POWER-MEASURED")
    if not 0 < args.expected_min_v < args.expected_max_v:
        raise ValueError("Expected voltage range must be positive and increasing")
    values = (args.measured_idle_v, args.measured_loaded_v)
    passed = all(args.expected_min_v <= value <= args.expected_max_v for value in values)
    report["checks"]["power"] = {
        "status": "passed" if passed else "failed",
        "observedAt": now_iso(),
        "expectedMinV": args.expected_min_v,
        "expectedMaxV": args.expected_max_v,
        "measuredIdleV": args.measured_idle_v,
        "measuredLoadedV": args.measured_loaded_v,
        "instrument": args.instrument,
        "operator": args.operator,
        "method": args.method,
        "evidenceUri": args.evidence_uri,
    }
    print(
        "Power rail is within the declared range."
        if passed
        else "Power rail is outside the declared range; physical validation failed."
    )
    return 0 if passed else 1


def csv_set(value: str) -> set[str]:
    return {item.strip() for item in value.split(",") if item.strip()}


def command_safety(args: argparse.Namespace, report: dict[str, Any]) -> int:
    if args.confirm != "PHYSICAL-SAFETY-TESTED":
        raise ValueError(
            "Safety validation requires --confirm PHYSICAL-SAFETY-TESTED"
        )
    scenarios = csv_set(args.estop_scenarios)
    limit_tests = csv_set(args.limit_tests)
    missing_scenarios = sorted(REQUIRED_ESTOP_SCENARIOS - scenarios)
    missing_limits = sorted(REQUIRED_LIMIT_TESTS - limit_tests)
    if args.stop_time_ms <= 0:
        raise ValueError("Measured stop time must be positive")

    common = {
        "observedAt": now_iso(),
        "mechanism": args.mechanism,
        "operator": args.operator,
        "method": args.method,
        "evidenceUri": args.evidence_uri,
    }
    estop_passed = not missing_scenarios
    limits_passed = not missing_limits
    report["checks"]["emergencyStop"] = {
        **common,
        "status": "passed" if estop_passed else "failed",
        "stopTimeMs": args.stop_time_ms,
        "testedScenarios": sorted(scenarios),
        "missingScenarios": missing_scenarios,
        "resetProcedure": args.reset_procedure,
    }
    report["checks"]["deterministicLimits"] = {
        **common,
        "status": "passed" if limits_passed else "failed",
        "testedLimits": sorted(limit_tests),
        "missingLimits": missing_limits,
        "implementedIn": args.implemented_in,
    }
    if estop_passed and limits_passed:
        print("Recorded physical E-stop and deterministic-limit evidence.")
        return 0
    print(
        f"Safety evidence incomplete; missing scenarios={missing_scenarios}, "
        f"limits={missing_limits}."
    )
    return 1


def command_torque_off(args: argparse.Namespace, report: dict[str, Any]) -> int:
    if args.confirm != "ARM-SUPPORTED-DISABLE-TORQUE":
        raise ValueError(
            "Torque-off test requires --confirm ARM-SUPPORTED-DISABLE-TORQUE"
        )
    bus = make_bus(args.port)
    before: dict[str, Any] = {}
    after: dict[str, Any] = {}
    try:
        bus.connect()
        before = {name: read_register(bus, "Torque_Enable", name) for name, _ in JOINTS}
        bus.disable_torque(num_retry=5)
        after = {name: read_register(bus, "Torque_Enable", name) for name, _ in JOINTS}
    finally:
        if getattr(bus, "is_connected", False):
            bus.disconnect(disable_torque=False)
    passed = all(value == 0 for value in after.values())
    report["port"] = args.port
    report["checks"]["torqueOff"] = {
        "status": "passed" if passed else "failed",
        "observedAt": now_iso(),
        "command": "FeetechMotorsBus.disable_torque",
        "before": before,
        "after": after,
        "armLeftTorqueDisabled": True,
    }
    print("Torque is disabled on all six motors." if passed else "Torque-off verification failed.")
    return 0 if passed else 1


def command_artifacts(args: argparse.Namespace, report: dict[str, Any]) -> int:
    if not SHA256_RE.fullmatch(args.declared_spec_digest):
        raise ValueError("Declared spec digest must be a 64-character SHA-256")
    for label, value in (
        ("task key", args.task_key),
        ("training run reference", args.training_run_ref),
        ("framework", args.framework),
        ("dataset version", args.dataset_version),
    ):
        if not value.strip():
            raise ValueError(f"Policy {label} must be non-empty")
    artifact_base_uri = args.artifact_base_uri.rstrip("/")
    if "://" not in artifact_base_uri or artifact_base_uri.lower().startswith("file://"):
        raise ValueError("Artifact base URI must point to non-local object storage")

    artifacts = []
    missing = []
    for name, role, required in POLICY_ARTIFACTS:
        path = args.policy_dir / name
        if path.is_file():
            artifacts.append(
                {
                    "name": name,
                    "role": role,
                    "path": str(path.resolve()),
                    "uri": f"{artifact_base_uri}/{name}",
                    "sha256": sha256_file(path),
                }
            )
        elif required:
            missing.append(name)
    report["artifacts"] = artifacts
    report["policyProvenance"] = {
        "taskKey": args.task_key,
        "trainingRunRef": args.training_run_ref,
        "framework": args.framework,
        "datasetVersion": args.dataset_version,
        # This value is supplied by the training side and deliberately is not
        # derived from the local embodiment file during upload.
        "declaredSpecDigest": args.declared_spec_digest.lower(),
        "artifactBaseUri": artifact_base_uri,
    }
    report["checks"]["policyArtifacts"] = {
        "status": "passed" if not missing else "blocked",
        "observedAt": now_iso(),
        "missing": missing,
    }
    print(f"Hashed {len(artifacts)} policy artifacts; missing required: {missing or 'none'}.")
    return 0 if not missing else 2


def command_seal(args: argparse.Namespace, report: dict[str, Any]) -> int:
    if args.confirm != "SEAL-PHYSICAL-EVIDENCE":
        raise ValueError("Sealing requires --confirm SEAL-PHYSICAL-EVIDENCE")
    if overall_status(report) != "passed":
        missing = [
            name
            for name in REQUIRED_CHECKS
            if report.get("checks", {}).get(name, {}).get("status") != "passed"
        ]
        raise ValueError(f"Physical evidence is incomplete: {', '.join(missing)}")
    if args.output.exists():
        raise FileExistsError(f"Refusing to overwrite sealed evidence: {args.output}")

    snapshot = copy.deepcopy(report)
    snapshot["generatedAt"] = now_iso()
    snapshot["overallStatus"] = overall_status(snapshot)
    snapshot["seal"] = {
        "sealedAt": now_iso(),
        "algorithm": "sha256",
        "toolVersion": TOOL_VERSION,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n")
    digest = sha256_file(args.output)
    report["sealedEvidence"] = {
        "path": str(args.output.resolve()),
        "sha256": digest,
        "sealedAt": snapshot["seal"]["sealedAt"],
    }
    print(f"Sealed evidence: {args.output.resolve()}")
    print(f"Evidence digest: sha256:{digest}")
    return 0


def command_finalize(args: argparse.Namespace, report: dict[str, Any]) -> int:
    if args.confirm != "CREATE-HARDWARE-REVISION":
        raise ValueError("Finalization requires --confirm CREATE-HARDWARE-REVISION")
    sealed_report = json.loads(args.sealed_report.read_text(encoding="utf-8"))
    if sealed_report.get("schemaVersion") != 1 or sealed_report.get("embodimentKey") != "so101_follower":
        raise ValueError("Sealed evidence is not an SO-101 evidence report")
    if not isinstance(sealed_report.get("seal"), dict):
        raise ValueError("Evidence report was not created by the seal command")
    if sealed_report.get("runRef") != report.get("runRef"):
        raise ValueError("Sealed evidence belongs to a different validation run")
    if overall_status(sealed_report) != "passed" or sealed_report.get("overallStatus") != "passed":
        missing = [
            name
            for name in REQUIRED_CHECKS
            if sealed_report.get("checks", {}).get(name, {}).get("status") != "passed"
        ]
        raise ValueError(f"Sealed physical evidence is incomplete: {', '.join(missing)}")
    evidence_digest = sha256_file(args.sealed_report)
    evidence_uri = f"sha256:{evidence_digest}"
    source = json.loads(args.spec.read_text(encoding="utf-8"))
    if source.get("embodimentKey") != "so101_follower":
        raise ValueError("Input spec is not so101_follower")
    output = json.loads(json.dumps(source))
    output["revision"] = int(source["revision"]) + 1
    output["kinematics"]["reachMm"] = sealed_report["checks"]["reach"]["valueMm"]
    output["kinematics"]["payloadKg"] = sealed_report["checks"]["payload"]["valueKg"]
    output["kinematics"]["measurementUncertainty"] = {
        "reachMm": sealed_report["checks"]["reach"]["uncertaintyMm"],
        "payloadKg": sealed_report["checks"]["payload"]["uncertaintyKg"],
    }
    previous_safety = output.get("safetyLayer")
    safety = sealed_report["checks"]["emergencyStop"]
    limits = sealed_report["checks"]["deterministicLimits"]
    output["safetyLayer"] = {
        "mechanism": safety["mechanism"],
        "implementedIn": limits["implementedIn"],
        "verifiedAgainstHardware": True,
        "measuredStopTimeMs": safety["stopTimeMs"],
        "testedScenarios": safety["testedScenarios"],
        "deterministicLimits": limits["testedLimits"],
        "evidenceUri": safety["evidenceUri"],
        "supportingSoftwareLimit": previous_safety,
    }
    output["provenance"]["sourcedFrom"] = "hardware_validation"
    output["provenance"]["verifiedAgainstHardware"] = True
    sources = list(output["provenance"].get("sources", []))
    if evidence_uri not in sources:
        sources.append(evidence_uri)
    output["provenance"]["sources"] = sources
    output["provenance"]["evidenceDigest"] = evidence_digest
    output["provenance"]["evidenceRunRef"] = sealed_report["runRef"]
    output["provenance"]["note"] = (
        f"Physical validation completed {sealed_report['generatedAt']} on "
        f"{sealed_report.get('port')}; evidence: {evidence_uri}."
    )
    if args.output.exists():
        raise FileExistsError(f"Refusing to overwrite existing revision: {args.output}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Created immutable hardware-verified revision: {args.output}")
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument(
        "--report",
        type=Path,
        default=Path(".runtime/so101-validation/evidence.json"),
        help="JSON evidence accumulated across commands",
    )
    commands = root.add_subparsers(dest="command", required=True)

    commands.add_parser("scan", help="List serial ports; never contacts a motor")

    inspect_cmd = commands.add_parser("inspect", help="Read bus identity and registers without writes")
    inspect_cmd.add_argument("--port", required=True)

    calibrate = commands.add_parser("calibrate", help="Run interactive official LeRobot calibration")
    calibrate.add_argument("--port", required=True)
    calibrate.add_argument("--robot-id", default="mercato-so101-01")
    calibrate.add_argument("--calibration-dir", type=Path, default=Path(".runtime/so101-validation/calibration"))
    calibrate.add_argument("--valid-days", type=int, required=True)
    calibrate.add_argument("--uncertainty-deg", type=float, required=True)
    calibrate.add_argument("--confirm", required=True)

    measure = commands.add_parser("measure", help="Record independently measured reach and payload")
    measure.add_argument("--reach-mm", type=float, required=True)
    measure.add_argument("--payload-kg", type=float, required=True)
    measure.add_argument("--reach-uncertainty-mm", type=float, required=True)
    measure.add_argument("--payload-uncertainty-kg", type=float, required=True)
    measure.add_argument("--payload-hold-seconds", type=int, default=30)
    measure.add_argument("--instrument", required=True)
    measure.add_argument("--operator", required=True)
    measure.add_argument("--method", required=True)
    measure.add_argument("--notes", default="")
    measure.add_argument("--confirm", required=True)

    power = commands.add_parser("power", help="Record measured idle and loaded motor-bus voltage")
    power.add_argument("--expected-min-v", type=float, required=True)
    power.add_argument("--expected-max-v", type=float, required=True)
    power.add_argument("--measured-idle-v", type=float, required=True)
    power.add_argument("--measured-loaded-v", type=float, required=True)
    power.add_argument("--instrument", required=True)
    power.add_argument("--operator", required=True)
    power.add_argument("--method", required=True)
    power.add_argument("--evidence-uri", required=True)
    power.add_argument("--confirm", required=True)

    safety = commands.add_parser("safety", help="Record physical E-stop and deterministic-limit tests")
    safety.add_argument("--mechanism", choices=SAFETY_MECHANISMS, required=True)
    safety.add_argument("--stop-time-ms", type=float, required=True)
    safety.add_argument("--estop-scenarios", required=True, help="Comma-separated: idle,motion,grasp")
    safety.add_argument("--limit-tests", required=True, help="Comma-separated: position,speed,command_timeout")
    safety.add_argument("--implemented-in", required=True)
    safety.add_argument("--reset-procedure", required=True)
    safety.add_argument("--operator", required=True)
    safety.add_argument("--method", required=True)
    safety.add_argument("--evidence-uri", required=True)
    safety.add_argument("--confirm", required=True)

    torque = commands.add_parser("torque-off", help="Disable torque and verify all six registers")
    torque.add_argument("--port", required=True)
    torque.add_argument("--confirm", required=True)

    artifacts = commands.add_parser("artifacts", help="Hash real policy artifacts")
    artifacts.add_argument("--policy-dir", type=Path, required=True)
    artifacts.add_argument("--artifact-base-uri", required=True)
    artifacts.add_argument("--task-key", required=True)
    artifacts.add_argument("--training-run-ref", required=True)
    artifacts.add_argument("--framework", required=True)
    artifacts.add_argument("--dataset-version", required=True)
    artifacts.add_argument("--declared-spec-digest", required=True)

    seal = commands.add_parser("seal", help="Create an immutable evidence snapshot and calculate its digest")
    seal.add_argument("--output", type=Path, required=True)
    seal.add_argument("--confirm", required=True)

    finalize = commands.add_parser("finalize", help="Create the next immutable verified embodiment revision")
    finalize.add_argument("--spec", type=Path, required=True)
    finalize.add_argument("--output", type=Path, required=True)
    finalize.add_argument("--sealed-report", type=Path, required=True)
    finalize.add_argument("--confirm", required=True)
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    report = load_report(args.report)
    command = {
        "scan": command_scan,
        "inspect": command_inspect,
        "calibrate": command_calibrate,
        "measure": command_measure,
        "power": command_power,
        "safety": command_safety,
        "torque-off": command_torque_off,
        "artifacts": command_artifacts,
        "seal": command_seal,
        "finalize": command_finalize,
    }[args.command]
    try:
        result = command(args, report)
    except Exception as exc:
        report["checks"][args.command] = {
            "status": "blocked",
            "observedAt": now_iso(),
            "reason": f"{type(exc).__name__}: {exc}",
        }
        save_report(args.report, report)
        print(f"BLOCKED: {exc}", file=sys.stderr)
        return 2
    save_report(args.report, report)
    print(f"Evidence: {args.report.resolve()} ({report['overallStatus']})")
    return result


if __name__ == "__main__":
    raise SystemExit(main())
