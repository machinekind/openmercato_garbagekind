#!/usr/bin/env python3
"""Ruchowa warstwa demonstracyjna SO-101: załączenie momentu, poza losowa, zwolnienie.

W odróżnieniu od `validate.py` ten moduł **wysyła pozycję zadaną i włącza
moment**, więc każda operacja jest jawnie potwierdzana przez wołającego.

Granice, które ten moduł respektuje i których nie wolno z niego usunąć:

- `release()` zwalnia moment. **To nie jest E-stop** — idzie tą samą magistralą
  i tym samym procesem, który może zawisnąć. Deterministyczną warstwę
  zatrzymania stanowi wyłącznie zewnętrzny przerywacz zasilania napędów.
- Załączenie momentu odbywa się przy `p_des = q` utrzymywanym przez
  `HOLD_BEFORE_ENABLE_MS`. Reguła pochodzi z incydentu 76,36° na A1X
  (`physical-ai/PHYSICAL-VALIDATION-BACKLOG.md`) i jest warunkiem, nie opcją.
- Cel losowy powstaje w okienku wyliczonym z limitów EEPROM zawężonych o
  marginesy, dodatkowo ograniczonym przyrostem na jeden ruch. Poza nie jest
  losowana z całego zakresu stawu.
"""

from __future__ import annotations

import dataclasses
import random
import sys
import time
from pathlib import Path
from typing import Any, Iterable

sys.path.insert(0, str(Path(__file__).resolve().parent))

from validate import JOINTS, json_value, make_bus, now_iso  # noqa: E402

TICKS_PER_TURN = 4096
DEGREES_PER_TICK = 360.0 / TICKS_PER_TURN

HOLD_BEFORE_ENABLE_MS = 500
HOLD_SAMPLE_INTERVAL_S = 0.05
MAX_DEVIATION_DURING_HOLD_TICKS = 40

SOFT_LIMIT_MARGIN_TICKS = 120
MAX_DELTA_TICKS = 350
GRIPPER_MAX_DELTA_TICKS = 150

# Stawy i przyrost demonstracji: dwa pierwsze stawy, około 30° na ruch.
DEMO_JOINTS = ("shoulder_pan", "shoulder_lift")
DEMO_DELTA_DEG = 30.0

GOAL_VELOCITY = 300
ACCELERATION = 10

MOVE_TIMEOUT_S = 8.0
MOVE_SAMPLE_INTERVAL_S = 0.1
POSITION_TOLERANCE_TICKS = 30

MIN_VOLTAGE_DECIVOLT = 100
MAX_VOLTAGE_DECIVOLT = 130
MAX_TEMPERATURE_C = 50
MAX_ABS_LOAD = 900

READ_RETRY = 2
WRITE_RETRY = 3


@dataclasses.dataclass(frozen=True)
class JointWindow:
    """Dozwolone okno pozycji jednego stawu, w surowych tickach."""

    name: str
    motor_id: int
    soft_min: int
    soft_max: int
    max_delta: int

    def clamp(self, value: int) -> int:
        return max(self.soft_min, min(self.soft_max, value))


def build_window(
    name: str,
    motor_id: int,
    limit_min: int,
    limit_max: int,
    margin: int = SOFT_LIMIT_MARGIN_TICKS,
) -> JointWindow:
    """Zawęża limity z EEPROM o margines; przy zbyt wąskim zakresie margines topnieje."""
    if limit_min >= limit_max:
        raise ValueError(f"{name}: limity EEPROM niespójne ({limit_min}..{limit_max})")
    span = limit_max - limit_min
    applied = min(margin, max(0, (span - 1) // 2))
    max_delta = GRIPPER_MAX_DELTA_TICKS if name == "gripper" else MAX_DELTA_TICKS
    return JointWindow(
        name=name,
        motor_id=motor_id,
        soft_min=limit_min + applied,
        soft_max=limit_max - applied,
        max_delta=max_delta,
    )


def plan_random_targets(
    current: dict[str, int],
    windows: dict[str, JointWindow],
    rng: random.Random,
    joints: Iterable[str] | None = None,
    delta_ticks: int | None = None,
) -> dict[str, int]:
    """Losuje cel w przecięciu okna stawu z przyrostem dozwolonym na jeden ruch.

    `delta_ticks` może zawęzić przyrost, nigdy go nie rozszerza — górną granicą
    pozostaje `JointWindow.max_delta`.
    """
    selected = list(joints) if joints is not None else [name for name, _ in JOINTS]
    targets: dict[str, int] = {}
    for name in selected:
        window = windows[name]
        allowed = window.max_delta if delta_ticks is None else min(window.max_delta, abs(delta_ticks))
        anchor = window.clamp(current[name])
        low = max(window.soft_min, anchor - allowed)
        high = min(window.soft_max, anchor + allowed)
        targets[name] = rng.randint(low, high) if low < high else low
    return targets


def evaluate_health(readings: dict[str, dict[str, Any]]) -> tuple[bool, list[str]]:
    """Brama sprzętowa przed każdym ruchem. Zwraca (czy_wolno, lista_powodów)."""
    problems: list[str] = []
    for name, values in readings.items():
        voltage = values.get("voltageDecivolt")
        if not isinstance(voltage, int) or not MIN_VOLTAGE_DECIVOLT <= voltage <= MAX_VOLTAGE_DECIVOLT:
            problems.append(f"{name}: napięcie {voltage} poza {MIN_VOLTAGE_DECIVOLT}..{MAX_VOLTAGE_DECIVOLT}")
        temperature = values.get("temperatureC")
        if not isinstance(temperature, int) or temperature > MAX_TEMPERATURE_C:
            problems.append(f"{name}: temperatura {temperature} °C powyżej {MAX_TEMPERATURE_C}")
        load = values.get("load")
        if isinstance(load, int) and abs(load) > MAX_ABS_LOAD:
            problems.append(f"{name}: obciążenie {load} powyżej {MAX_ABS_LOAD}")
    return not problems, problems


def ticks_to_degrees(ticks: int) -> float:
    return round(ticks * DEGREES_PER_TICK, 2)


def degrees_to_ticks(degrees: float) -> int:
    return int(round(degrees / DEGREES_PER_TICK))


class ArmSession:
    """Otwarta magistrala SO-101 z operacjami ruchowymi. Jedna instancja na proces."""

    def __init__(self, port: str) -> None:
        self.port = port
        self._bus: Any | None = None
        self._windows: dict[str, JointWindow] | None = None
        self.torque_enabled = False
        # Poza zastana w chwili załączenia momentu; punkt powrotu przy zwolnieniu.
        self.home_position: dict[str, int] | None = None

    def connect(self) -> None:
        if self._bus is not None:
            return
        bus = make_bus(self.port)
        bus.connect(handshake=False)
        self._bus = bus

    def close(self) -> None:
        bus, self._bus = self._bus, None
        if bus is not None and getattr(bus, "is_connected", False):
            bus.disconnect(disable_torque=False)

    @property
    def bus(self) -> Any:
        if self._bus is None:
            raise RuntimeError("Magistrala nie jest otwarta; wywołaj connect()")
        return self._bus

    def _read(self, register: str, joint: str) -> Any:
        return json_value(self.bus.read(register, joint, normalize=False, num_retry=READ_RETRY))

    def _write(self, register: str, joint: str, value: int) -> None:
        self.bus.write(register, joint, value, normalize=False, num_retry=WRITE_RETRY)

    def windows(self) -> dict[str, JointWindow]:
        if self._windows is None:
            self._windows = {
                name: build_window(
                    name,
                    motor_id,
                    int(self._read("Min_Position_Limit", name)),
                    int(self._read("Max_Position_Limit", name)),
                )
                for name, motor_id in JOINTS
            }
        return self._windows

    def read_positions(self) -> dict[str, int]:
        return {name: int(self._read("Present_Position", name)) for name, _ in JOINTS}

    def read_state(self) -> dict[str, Any]:
        joints: dict[str, dict[str, Any]] = {}
        for name, motor_id in JOINTS:
            window = self.windows()[name]
            joints[name] = {
                "id": motor_id,
                "positionRaw": int(self._read("Present_Position", name)),
                "torqueEnabled": int(self._read("Torque_Enable", name)),
                "voltageDecivolt": int(self._read("Present_Voltage", name)),
                "temperatureC": int(self._read("Present_Temperature", name)),
                "load": int(self._read("Present_Load", name)),
                "firmware": f"{self._read('Firmware_Major_Version', name)}."
                f"{self._read('Firmware_Minor_Version', name)}",
                "softWindow": [window.soft_min, window.soft_max],
            }
        healthy, problems = evaluate_health(joints)
        return {
            "observedAt": now_iso(),
            "port": self.port,
            "joints": joints,
            "healthy": healthy,
            "problems": problems,
            "torqueEnabledCount": sum(1 for row in joints.values() if row["torqueEnabled"]),
        }

    def enable(self) -> dict[str, Any]:
        """Bezpieczne załączenie: `p_des = q` utrzymywane przed i po włączeniu momentu."""
        state = self.read_state()
        if not state["healthy"]:
            return {"status": "refused", "reason": "brama sprzętowa", "problems": state["problems"]}

        held = {name: row["positionRaw"] for name, row in state["joints"].items()}
        for name, _ in JOINTS:
            self._write("Acceleration", name, ACCELERATION)
            self._write("Goal_Velocity", name, GOAL_VELOCITY)
            self._write("Goal_Position", name, held[name])

        deadline = time.monotonic() + HOLD_BEFORE_ENABLE_MS / 1000.0
        while time.monotonic() < deadline:
            for name, _ in JOINTS:
                self._write("Goal_Position", name, held[name])
            time.sleep(HOLD_SAMPLE_INTERVAL_S)

        for name, _ in JOINTS:
            self._write("Torque_Enable", name, 1)
        self.torque_enabled = True
        self.home_position = dict(held)

        max_deviation = 0
        deadline = time.monotonic() + HOLD_BEFORE_ENABLE_MS / 1000.0
        while time.monotonic() < deadline:
            positions = self.read_positions()
            for name, _ in JOINTS:
                self._write("Goal_Position", name, held[name])
                max_deviation = max(max_deviation, abs(positions[name] - held[name]))
            time.sleep(HOLD_SAMPLE_INTERVAL_S)

        verified = {name: int(self._read("Torque_Enable", name)) for name, _ in JOINTS}
        return {
            "status": "enabled" if all(verified.values()) else "partial",
            "observedAt": now_iso(),
            "heldPositionRaw": held,
            "holdMs": HOLD_BEFORE_ENABLE_MS,
            "maxDeviationTicks": max_deviation,
            "maxDeviationDeg": ticks_to_degrees(max_deviation),
            "deviationWithinBudget": max_deviation <= MAX_DEVIATION_DURING_HOLD_TICKS,
            "torqueEnabled": verified,
            "homePositionRaw": dict(held),
            "note": "Zwolnienie momentu nie jest E-stopem.",
        }

    def move_to(
        self,
        targets: dict[str, int],
        timeout_s: float = MOVE_TIMEOUT_S,
        clamp: bool = True,
    ) -> dict[str, Any]:
        """Jedzie do celu, próbkując pozycję; przy przekroczeniu obciążenia zatrzymuje na miejscu.

        `clamp=False` pomija zawężone okno i służy wyłącznie powrotowi do pozy
        zastanej: ta poza była fizycznie zajęta, więc obcięcie jej do okna
        oznaczałoby powrót w inne miejsce niż obiecane. Limity EEPROM serwa
        obowiązują nadal, bo wymusza je sam sterownik.
        """
        if not self.torque_enabled:
            return {"status": "refused", "reason": "moment wyłączony; najpierw enable()"}
        windows = self.windows()
        clamped = {
            name: (windows[name].clamp(int(value)) if clamp else int(value))
            for name, value in targets.items()
        }
        start = self.read_positions()

        for name, value in clamped.items():
            self._write("Goal_Position", name, value)

        samples: list[dict[str, Any]] = []
        began = time.monotonic()
        reached = False
        halted: list[str] = []
        while time.monotonic() - began < timeout_s:
            positions = self.read_positions()
            loads = {name: int(self._read("Present_Load", name)) for name in clamped}
            samples.append(
                {
                    "tS": round(time.monotonic() - began, 3),
                    "positionRaw": positions,
                    "load": loads,
                }
            )
            overloaded = [name for name, load in loads.items() if abs(load) > MAX_ABS_LOAD]
            if overloaded:
                for name in clamped:
                    self._write("Goal_Position", name, positions[name])
                halted = overloaded
                break
            if all(abs(positions[name] - value) <= POSITION_TOLERANCE_TICKS for name, value in clamped.items()):
                reached = True
                break
            time.sleep(MOVE_SAMPLE_INTERVAL_S)

        final = self.read_positions()
        errors = {name: final[name] - value for name, value in clamped.items()}
        if halted:
            status = "halted_on_load"
        elif reached:
            status = "reached"
        else:
            status = "timeout"
        return {
            "status": status,
            "observedAt": now_iso(),
            "startPositionRaw": start,
            "targetPositionRaw": clamped,
            "finalPositionRaw": final,
            "errorTicks": errors,
            "maxErrorDeg": ticks_to_degrees(max((abs(value) for value in errors.values()), default=0)),
            "durationS": round(time.monotonic() - began, 3),
            "haltedJoints": halted,
            "samples": samples,
        }

    def move_random(
        self,
        rng: random.Random | None = None,
        joints: Iterable[str] | None = None,
        delta_deg: float = DEMO_DELTA_DEG,
        timeout_s: float = MOVE_TIMEOUT_S,
    ) -> dict[str, Any]:
        """Poza losowa na wskazanych stawach; domyślnie dwa pierwsze, o ~30°."""
        generator = rng if rng is not None else random.Random()
        selected = list(joints) if joints is not None else list(DEMO_JOINTS)
        targets = plan_random_targets(
            self.read_positions(),
            self.windows(),
            generator,
            selected,
            delta_ticks=degrees_to_ticks(delta_deg),
        )
        result = self.move_to(targets, timeout_s=timeout_s)
        result["plannedTargets"] = targets
        result["deltaBudgetDeg"] = delta_deg
        return result

    def return_home(self, timeout_s: float = MOVE_TIMEOUT_S) -> dict[str, Any]:
        """Wraca do pozy zastanej z chwili załączenia momentu."""
        if self.home_position is None:
            return {"status": "refused", "reason": "brak zapisanej pozy zastanej"}
        result = self.move_to(dict(self.home_position), timeout_s=timeout_s, clamp=False)
        result["homePositionRaw"] = dict(self.home_position)
        return result

    def release(self, return_home: bool = True) -> dict[str, Any]:
        """Wraca do pozy zastanej, potem zwalnia moment na wszystkich stawach.

        Powrót jest domyślny, bo ramię zwolnione w podniesionej pozie opada
        swobodnie. Zwolnienie momentu pozostaje zwolnieniem momentu, nie E-stopem.
        """
        homecoming: dict[str, Any] | None = None
        if return_home and self.torque_enabled and self.home_position is not None:
            homecoming = self.return_home()
        for name, _ in JOINTS:
            self._write("Torque_Enable", name, 0)
        verified = {name: int(self._read("Torque_Enable", name)) for name, _ in JOINTS}
        self.torque_enabled = any(verified.values())
        return {
            "status": "released" if not self.torque_enabled else "partial",
            "observedAt": now_iso(),
            "torqueEnabled": verified,
            "returnHome": homecoming,
            "positionRaw": self.read_positions(),
            "note": "Zwolnienie momentu nie jest E-stopem ani funkcją bezpieczeństwa.",
        }
