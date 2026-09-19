#!/usr/bin/env python3
"""Kanoniczne postacie komunikatów kanału brzegowego — odpowiednik `edge/lib/crypto.ts`.

Ten moduł nie ma wejścia/wyjścia i nie dotyka kluczy. Zawiera wyłącznie to, co
musi się zgadzać co do bajtu z centralą, bo rozjazd tutaj objawia się jako
„podpis nieprawidłowy" bez wskazania przyczyny.

Dwie pułapki, dla których ten plik istnieje osobno:

- **Przedrostki wiążą kontekst.** Podpis zebrany przy uderzeniu serca nie może
  przejść jako żądanie dzierżawy ani jako zgłoszenie stanu. Każdy komunikat ma
  własny przedrostek i nie wolno ich uogólniać do jednej funkcji z parametrem.
- **Kanoniczny JSON to nie `json.dumps`.** Centrala liczy skrót z JSON-u o
  kluczach posortowanych na każdym poziomie i liczbach zapisanych po
  javascriptowemu (`1.0` zapisuje się jako `1`). `json.dumps` daje inny ciąg,
  więc inny skrót, więc odrzucony podpis.
"""

from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime, timezone
from typing import Any

TELEMETRY_KINDS = (
    "episode",
    "intervention",
    "detection_window",
    "clip",
    "clip_deletion_confirmation",
)
EPISODE_OUTCOMES = ("success", "failure", "aborted", "timeout")
INTERVENTION_KINDS = ("adjust", "manual_reset", "teleop_takeover", "abort", "estop")
INTERVENTION_REASON_CATEGORIES = (
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
)
REPORTED_STATES = ("running", "stopped")


def iso_timestamp(moment: datetime | None = None) -> str:
    """Czas w postaci, którą `new Date(x).toISOString()` po stronie centrali odtwarza bez zmian.

    Milisekundy są obowiązkowe: `heartbeat` i `connect` podpisują czas *po*
    konwersji na Date, więc znacznik bez milisekund zostałby podpisany inaczej,
    niż centrala go odczyta.
    """
    value = moment.astimezone(timezone.utc) if moment else datetime.now(timezone.utc)
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _javascript_number(value: float | int) -> str:
    """Zapis liczby zgodny z `JSON.stringify`, nie z `json.dumps`."""
    if isinstance(value, int):
        return str(value)
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Podpisywany JSON nie może zawierać NaN ani nieskończoności.")
    if number == int(number) and abs(number) < 1e21:
        return str(int(number))
    text = repr(number)
    # Python zapisuje wykladnik z zerem wiodacym (1e-07), JavaScript bez (1e-7).
    if "e" in text:
        mantissa, exponent = text.split("e")
        sign = "+" if not exponent.startswith("-") else "-"
        digits = exponent.lstrip("+-").lstrip("0") or "0"
        text = f"{mantissa}e{sign}{digits}"
    return text


def canonical_json(value: Any) -> str:
    """JSON o kluczach posortowanych na każdym poziomie; kolejność tablic zostaje.

    Kolejność elementów tablicy jest znacząca (wektor obserwacji jest z definicji
    uporządkowany), więc sortowane są wyłącznie klucze obiektów.
    """
    if value is None or isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _javascript_number(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        entries = [
            f"{json.dumps(str(key), ensure_ascii=False)}:{canonical_json(value[key])}"
            for key in sorted(value)
        ]
        return "{" + ",".join(entries) + "}"
    raise ValueError(f"Nieobsługiwana wartość w podpisywanym JSON: {type(value).__name__}.")


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def enroll_payload(token: str, fingerprint: str) -> str:
    return f"edge.enroll:{token}:{fingerprint}"


def connect_payload(agent_id: str, timestamp_iso: str) -> str:
    return f"edge.connect:{agent_id}:{timestamp_iso}"


def heartbeat_payload(session_id: str, sequence: int, timestamp_iso: str) -> str:
    return f"edge.heartbeat:{session_id}:{sequence}:{timestamp_iso}"


def telemetry_payload(
    session_id: str,
    sequence: int,
    timestamp_iso: str,
    kind: str,
    payload: Any,
) -> str:
    if kind not in TELEMETRY_KINDS:
        raise ValueError(f"Nieznany rodzaj telemetrii: {kind}")
    digest = sha256_hex(canonical_json(payload))
    return f"edge.telemetry:{session_id}:{sequence}:{timestamp_iso}:{kind}:{digest}"


def rotate_payload(agent_id: str, new_fingerprint: str) -> str:
    return f"edge.rotate:{agent_id}:{new_fingerprint}"


def lease_payload(session_id: str, sequence: int, timestamp_iso: str) -> str:
    return f"deployment.lease:{session_id}:{sequence}:{timestamp_iso}"


def report_payload(session_id: str, reported_state: str, timestamp_iso: str) -> str:
    if reported_state not in REPORTED_STATES:
        raise ValueError(f"Nieznany stan zgłaszany: {reported_state}")
    return f"deployment.report:{session_id}:{reported_state}:{timestamp_iso}"
