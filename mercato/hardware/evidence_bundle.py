#!/usr/bin/env python3
"""Verify integrity and minimum semantics of a Physical AI evidence bundle."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlparse
from uuid import UUID


REQUIRED_FILES = (
    "run.json",
    "hardware.json",
    "calibration.json",
    "safety.json",
    "telemetry.ndjson",
    "interventions.ndjson",
    "media-index.json",
    "checksums.sha256",
)
SAFETY_LAYER_KINDS = {
    "hardware_estop",
    "safety_plc",
    "safety_rated_torque_limit",
    "safety_rated_speed_limit",
    "light_curtain",
    "fence_interlock",
    "dual_channel_relay",
}
INTERVENTION_KINDS = {"adjust", "manual_reset", "teleop_takeover", "abort", "estop"}
REASON_CATEGORIES = {
    "grasp_failure",
    "object_not_detected",
    "workspace_obstruction",
    "person_in_safety_zone",
    "policy_stall",
    "unsafe_motion",
    "joint_limit",
    "camera_fault",
    "tracking_loss",
    "material_jam",
    "power_fault",
    "hardware_fault",
    "communications_loss",
    "calibration_error",
    "operator_request",
    "other",
}
REQUIRED_P0_TRIALS = {
    ("estop", "idle"),
    ("estop", "motion"),
    ("estop", "grasp"),
    ("limit", "position"),
    ("limit", "speed"),
    ("limit", "command_timeout"),
    ("zone", "person_in_safety_zone"),
}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class EvidenceError(ValueError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise EvidenceError(f"{label} must be a JSON object")
    return value


def require_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise EvidenceError(f"{label} must be a non-empty string")
    return value


def require_sha256(value: Any, label: str) -> str:
    text = require_text(value, label).lower()
    if not SHA256_RE.fullmatch(text):
        raise EvidenceError(f"{label} must be a 64-character SHA-256")
    return text


def parse_utc(value: Any, label: str) -> datetime:
    text = require_text(value, label)
    if not (text.endswith("Z") or text.endswith("+00:00")):
        raise EvidenceError(f"{label} must include an explicit UTC offset")
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise EvidenceError(f"{label} is not an ISO-8601 timestamp") from exc
    if parsed.utcoffset() is None or parsed.utcoffset().total_seconds() != 0:
        raise EvidenceError(f"{label} must be UTC")
    return parsed


def read_json(path: Path) -> dict[str, Any]:
    try:
        return require_object(json.loads(path.read_text(encoding="utf-8")), path.name)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise EvidenceError(f"{path.name} is not valid JSON: {exc}") from exc


def validate_run(document: dict[str, Any]) -> tuple[str, str]:
    if document.get("schemaVersion") != 1:
        raise EvidenceError("run.json schemaVersion must be 1")
    run_ref = require_text(document.get("runRef"), "run.json runRef")
    try:
        UUID(run_ref)
    except ValueError as exc:
        raise EvidenceError("run.json runRef must be a UUID") from exc
    robot_key = require_text(document.get("robotKey"), "run.json robotKey")
    embodiment = require_object(document.get("embodiment"), "run.json embodiment")
    require_text(embodiment.get("key"), "run.json embodiment.key")
    revision = embodiment.get("revision")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        raise EvidenceError("run.json embodiment.revision must be a positive integer")
    require_sha256(embodiment.get("specDigest"), "run.json embodiment.specDigest")
    started = parse_utc(document.get("startedAt"), "run.json startedAt")
    ended = parse_utc(document.get("endedAt"), "run.json endedAt")
    if ended < started:
        raise EvidenceError("run.json endedAt precedes startedAt")
    clock = require_object(document.get("clockSync"), "run.json clockSync")
    require_text(clock.get("source"), "run.json clockSync.source")
    parse_utc(clock.get("measuredAt"), "run.json clockSync.measuredAt")
    offset = clock.get("maxOffsetMs")
    if not isinstance(offset, (int, float)) or isinstance(offset, bool) or offset < 0:
        raise EvidenceError("run.json clockSync.maxOffsetMs must be non-negative")
    require_text(document.get("operatorRef"), "run.json operatorRef")
    return run_ref, robot_key


def validate_bound_document(document: dict[str, Any], name: str, run_ref: str, robot_key: str) -> None:
    if document.get("runRef") != run_ref:
        raise EvidenceError(f"{name} runRef does not match run.json")
    if document.get("robotKey") != robot_key:
        raise EvidenceError(f"{name} robotKey does not match run.json")


def validate_hardware(document: dict[str, Any], run_ref: str, robot_key: str) -> None:
    validate_bound_document(document, "hardware.json", run_ref, robot_key)
    devices = document.get("devices")
    if not isinstance(devices, list) or not devices:
        raise EvidenceError("hardware.json devices must be a non-empty array")
    roles: set[str] = set()
    for index, raw in enumerate(devices):
        device = require_object(raw, f"hardware.json devices[{index}]")
        role = require_text(device.get("role"), f"hardware.json devices[{index}].role")
        if role in roles:
            raise EvidenceError(f"hardware.json contains duplicate device role: {role}")
        roles.add(role)
        require_text(device.get("model"), f"hardware.json devices[{index}].model")
        require_sha256(device.get("serialHash"), f"hardware.json devices[{index}].serialHash")
        require_text(device.get("firmware"), f"hardware.json devices[{index}].firmware")
        require_text(device.get("connection"), f"hardware.json devices[{index}].connection")


def validate_calibrations(document: dict[str, Any], run_ref: str, robot_key: str) -> None:
    validate_bound_document(document, "calibration.json", run_ref, robot_key)
    calibrations = document.get("calibrations")
    if not isinstance(calibrations, list) or not calibrations:
        raise EvidenceError("calibration.json calibrations must be a non-empty array")
    keys: set[str] = set()
    for index, raw in enumerate(calibrations):
        calibration = require_object(raw, f"calibration.json calibrations[{index}]")
        key = require_text(calibration.get("key"), f"calibration.json calibrations[{index}].key")
        if key in keys:
            raise EvidenceError(f"calibration.json contains duplicate key: {key}")
        keys.add(key)
        require_text(calibration.get("producedBy"), f"calibration {key}.producedBy")
        require_text(calibration.get("artifactUri"), f"calibration {key}.artifactUri")
        require_sha256(calibration.get("sha256"), f"calibration {key}.sha256")
        measured = parse_utc(calibration.get("measuredAt"), f"calibration {key}.measuredAt")
        valid_until = parse_utc(calibration.get("validUntil"), f"calibration {key}.validUntil")
        if valid_until <= measured:
            raise EvidenceError(f"calibration {key}.validUntil must follow measuredAt")
        uncertainty = require_object(calibration.get("uncertainty"), f"calibration {key}.uncertainty")
        value = uncertainty.get("value")
        if not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0:
            raise EvidenceError(f"calibration {key}.uncertainty.value must be non-negative")
        require_text(uncertainty.get("unit"), f"calibration {key}.uncertainty.unit")


def validate_safety(
    document: dict[str, Any], run_ref: str, robot_key: str
) -> tuple[set[tuple[str, str]], list[tuple[str, str]]]:
    validate_bound_document(document, "safety.json", run_ref, robot_key)
    layer = require_object(document.get("deterministicLayer"), "safety.json deterministicLayer")
    if layer.get("kind") not in SAFETY_LAYER_KINDS:
        raise EvidenceError("safety.json deterministicLayer.kind is outside the closed vocabulary")
    require_text(layer.get("implementedIn"), "safety.json deterministicLayer.implementedIn")
    if not isinstance(layer.get("bypassable"), bool):
        raise EvidenceError("safety.json deterministicLayer.bypassable must be boolean")
    trials = document.get("trials")
    if not isinstance(trials, list):
        raise EvidenceError("safety.json trials must be an array")
    observed: set[tuple[str, str]] = set()
    failed: list[tuple[str, str]] = []
    for index, raw in enumerate(trials):
        trial = require_object(raw, f"safety.json trials[{index}]")
        key = (
            require_text(trial.get("kind"), f"safety trial {index}.kind"),
            require_text(trial.get("scenario"), f"safety trial {index}.scenario"),
        )
        if key in observed:
            raise EvidenceError(f"safety.json contains duplicate trial: {key[0]}/{key[1]}")
        observed.add(key)
        result = trial.get("result")
        if result not in {"passed", "failed"}:
            raise EvidenceError(f"safety trial {key[0]}/{key[1]} result must be passed or failed")
        if result == "failed":
            failed.append(key)
        parse_utc(trial.get("occurredAt"), f"safety trial {key[0]}/{key[1]}.occurredAt")
        require_text(trial.get("method"), f"safety trial {key[0]}/{key[1]}.method")
        require_text(trial.get("evidenceUri"), f"safety trial {key[0]}/{key[1]}.evidenceUri")
    missing = REQUIRED_P0_TRIALS - observed
    if missing:
        formatted = ", ".join(f"{kind}/{scenario}" for kind, scenario in sorted(missing))
        raise EvidenceError(f"safety.json is missing P0 trials: {formatted}")
    return observed, failed


def validate_ndjson(path: Path, run_ref: str, interventions: bool) -> int:
    count = 0
    external_refs: set[str] = set()
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                record = require_object(json.loads(line), f"{path.name}:{line_number}")
            except json.JSONDecodeError as exc:
                raise EvidenceError(f"{path.name}:{line_number} is not valid JSON") from exc
            if record.get("runRef") != run_ref:
                raise EvidenceError(f"{path.name}:{line_number} runRef does not match run.json")
            timestamp_key = "occurredAt" if interventions else "timestamp"
            parse_utc(record.get(timestamp_key), f"{path.name}:{line_number} {timestamp_key}")
            external_ref = require_text(record.get("externalRef"), f"{path.name}:{line_number} externalRef")
            if external_ref in external_refs:
                raise EvidenceError(f"{path.name} contains duplicate externalRef: {external_ref}")
            external_refs.add(external_ref)
            if interventions:
                if record.get("kind") not in INTERVENTION_KINDS:
                    raise EvidenceError(f"{path.name}:{line_number} kind is outside the closed vocabulary")
                if record.get("reasonCategory") not in REASON_CATEGORIES:
                    raise EvidenceError(
                        f"{path.name}:{line_number} reasonCategory is outside the closed vocabulary"
                    )
                require_text(record.get("reason"), f"{path.name}:{line_number} reason")
            else:
                sequence = record.get("sequence")
                if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 0:
                    raise EvidenceError(f"{path.name}:{line_number} sequence must be non-negative")
                require_text(record.get("stream"), f"{path.name}:{line_number} stream")
            count += 1
    return count


def validate_media(document: dict[str, Any], run_ref: str) -> int:
    if document.get("runRef") != run_ref:
        raise EvidenceError("media-index.json runRef does not match run.json")
    entries = document.get("entries")
    if not isinstance(entries, list):
        raise EvidenceError("media-index.json entries must be an array")
    uris: set[str] = set()
    for index, raw in enumerate(entries):
        entry = require_object(raw, f"media-index.json entries[{index}]")
        uri = require_text(entry.get("uri"), f"media entry {index}.uri")
        parsed_uri = urlparse(uri)
        if not parsed_uri.scheme or parsed_uri.scheme.lower() == "file":
            raise EvidenceError(f"media entry {index}.uri must point to non-local object storage")
        if uri in uris:
            raise EvidenceError(f"media-index.json contains duplicate URI: {uri}")
        uris.add(uri)
        require_sha256(entry.get("sha256"), f"media entry {index}.sha256")
        require_text(entry.get("cameraKey"), f"media entry {index}.cameraKey")
        recorded = parse_utc(entry.get("recordedAt"), f"media entry {index}.recordedAt")
        retention = parse_utc(entry.get("retentionUntil"), f"media entry {index}.retentionUntil")
        if retention <= recorded:
            raise EvidenceError(f"media entry {index}.retentionUntil must follow recordedAt")
        if entry.get("anonymized") is not True:
            raise EvidenceError(f"media entry {index} must explicitly confirm anonymized=true")
    return len(entries)


def checksum_entries(path: Path) -> dict[str, str]:
    entries: dict[str, str] = {}
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        match = re.fullmatch(r"([0-9a-fA-F]{64})  (.+)", line)
        if not match:
            raise EvidenceError(f"checksums.sha256:{line_number} has invalid format")
        digest, relative = match.groups()
        normalized = PurePosixPath(relative)
        if normalized.is_absolute() or ".." in normalized.parts or str(normalized) != relative:
            raise EvidenceError(f"checksums.sha256:{line_number} contains an unsafe path")
        if relative == "checksums.sha256":
            raise EvidenceError("checksums.sha256 must not hash itself")
        if relative in entries:
            raise EvidenceError(f"checksums.sha256 contains duplicate path: {relative}")
        entries[relative] = digest.lower()
    return entries


def validate_checksums(root: Path) -> int:
    declared = checksum_entries(root / "checksums.sha256")
    actual_files: set[str] = set()
    for path in root.rglob("*"):
        if path.is_symlink():
            raise EvidenceError(f"Evidence bundle must not contain symlinks: {path.relative_to(root)}")
        if path.is_file() and path != root / "checksums.sha256":
            actual_files.add(path.relative_to(root).as_posix())
    missing = sorted(actual_files - declared.keys())
    unknown = sorted(declared.keys() - actual_files)
    if missing:
        raise EvidenceError(f"checksums.sha256 omits files: {', '.join(missing)}")
    if unknown:
        raise EvidenceError(f"checksums.sha256 references missing files: {', '.join(unknown)}")
    for relative, expected in declared.items():
        observed = sha256_file(root / Path(*PurePosixPath(relative).parts))
        if observed != expected:
            raise EvidenceError(f"SHA-256 mismatch: {relative}")
    return len(declared)


def verify_bundle(root: Path, require_p0_pass: bool = False) -> dict[str, Any]:
    if not root.is_dir():
        raise EvidenceError(f"Evidence bundle directory does not exist: {root}")
    missing_files = [name for name in REQUIRED_FILES if not (root / name).is_file()]
    if missing_files:
        raise EvidenceError(f"Evidence bundle is missing: {', '.join(missing_files)}")

    run = read_json(root / "run.json")
    run_ref, robot_key = validate_run(run)
    validate_hardware(read_json(root / "hardware.json"), run_ref, robot_key)
    validate_calibrations(read_json(root / "calibration.json"), run_ref, robot_key)
    _, failed_trials = validate_safety(read_json(root / "safety.json"), run_ref, robot_key)
    telemetry_count = validate_ndjson(root / "telemetry.ndjson", run_ref, interventions=False)
    intervention_count = validate_ndjson(root / "interventions.ndjson", run_ref, interventions=True)
    media_count = validate_media(read_json(root / "media-index.json"), run_ref)
    checksum_count = validate_checksums(root)
    if require_p0_pass and failed_trials:
        formatted = ", ".join(f"{kind}/{scenario}" for kind, scenario in failed_trials)
        raise EvidenceError(f"P0 safety gate failed: {formatted}")
    return {
        "schemaVersion": 1,
        "runRef": run_ref,
        "robotKey": robot_key,
        "integrity": "verified",
        "p0SafetyGate": "failed" if failed_trials else "passed",
        "failedP0Trials": [f"{kind}/{scenario}" for kind, scenario in failed_trials],
        "counts": {
            "telemetry": telemetry_count,
            "interventions": intervention_count,
            "media": media_count,
            "checksums": checksum_count,
        },
    }


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("bundle", type=Path, help="Directory containing one evidence run")
    root.add_argument(
        "--require-p0-pass",
        action="store_true",
        help="Reject a structurally valid bundle if any required P0 trial failed",
    )
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        result = verify_bundle(args.bundle.resolve(), require_p0_pass=args.require_p0_pass)
    except EvidenceError as exc:
        print(f"INVALID: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
