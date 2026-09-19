"""A1X control thread for the web panel.

Reuses the proven A1X CAN class from so101_bridge.py (drain / enable /
send_arm / send_grip) and wraps it in the streaming loop the arm requires:
the A1X tracks a setpoint you keep sending at 100-200 Hz, so a single frame
is not a move command.

Safety model (see docs/STEERING.md):
  * Starts DISENGAGED - transmits nothing until the operator engages.
  * Engage latches target = measured q, so nothing jumps.
  * Every target passes through the safety.Envelope (URDF-intersected
    per-joint window) and is slew-limited on the way out.
  * Stale feedback (> STALE_S) while engaged -> auto-disengage. An
    uncommanded arm holds position, so ceasing TX is the safe failure mode.
  * The FF 1->5->6 enable sequence runs only on explicit request and streams
    p_des = q throughout (A1X.enable already does this).
  * `engaged_via` records WHO holds the arm: "operator" (manual driving) or
    "agent" (operator engaged with agent control allowed). The DGX agent
    reads it to decide whether to pause its own patrol.
"""
from __future__ import annotations

import logging
import math
import os
import sys
import threading
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, REPO)

from kinematics import Chain                      # noqa: E402
from so101_bridge import A1X, A1X_URDF, A1X_JOINTS, N  # noqa: E402

from safety import Envelope                       # noqa: E402

log = logging.getLogger("arm")

RATE_HZ = 200.0
STALE_S = 0.15
GRIP_OPEN = -2.0     # measured usable range, so101_bridge defaults
GRIP_CLOSED = 0.6
DEFAULT_KP = 20.0
DEFAULT_KD = 1.0
GRIP_KP = 25.0
GRIP_KD = 1.0
GOAL_REACHED_RAD = math.radians(1.0)
# Gripper probe (see A1X.ensure_gripper in so101_bridge.py): the gripper
# channel 0x051 goes deaf independently of the arm - it keeps reporting a
# position with effort pinned at 0.00 while ignoring every command. Nudge it
# and watch whether it answers; only FF 1->5->6 clears the condition.
GRIP_PROBE_NUDGE = 1.0
GRIP_PROBE_MIN_DEG = 3.0
GRIP_PROBE_S = 1.5


def urdf_limits() -> tuple[np.ndarray, np.ndarray]:
    """Hard per-joint limits from the A1X URDF, in radians."""
    chain = Chain(A1X_URDF, A1X_JOINTS)
    return chain.lower, chain.upper


class ArmController:
    """Background thread owning the CAN socket. Thread-safe public API."""

    def __init__(self, iface: str, envelope: Envelope,
                 slew_deg_s: float = 30.0, kp: float = DEFAULT_KP,
                 kd: float = DEFAULT_KD):
        self.iface = iface
        self.env = envelope
        self.kp = kp
        self.kd = kd
        self.lock = threading.Lock()
        # state guarded by lock
        self.connected = False
        self.engaged = False
        self.engaged_via = "none"
        self.agent_control = True   # may the DGX agent command motion?
        self.q: list[float] | None = None       # measured, 7 (6 joints + grip)
        self.e: list[float] | None = None       # effort
        self.fb_t = 0.0
        self.goal = np.zeros(N)                 # requested pose
        self.target = np.zeros(N)               # slewed setpoint on the wire
        self.grip_goal = GRIP_OPEN
        self.grip_target = GRIP_OPEN
        self.grip_on = False
        self.slew = math.radians(slew_deg_s)
        self.status = "starting"
        self.tx_count = 0
        self._enable_req = False
        self._grip_probe_req = False
        self.grip_alive: bool | None = None   # None = never probed
        self._stop = False
        self._arm: A1X | None = None
        self._thread = threading.Thread(target=self._run, daemon=True,
                                        name="arm-ctl")

    # ---- public API (called from the aiohttp event loop) ----

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop = True
        self._thread.join(timeout=2.0)

    def snapshot(self) -> dict:
        with self.lock:
            fresh = self.q is not None and (time.time() - self.fb_t) < STALE_S
            at_goal = bool(np.max(np.abs(self.goal - self.target))
                           < GOAL_REACHED_RAD) if self.engaged else True
            return {
                "connected": self.connected,
                "feedback_fresh": fresh,
                "engaged": self.engaged,
                "engaged_via": self.engaged_via,
                "agent_control": self.agent_control,
                "status": self.status,
                "q": list(self.q) if self.q else None,
                "effort": list(self.e) if self.e else None,
                "target": [float(x) for x in self.target],
                "goal": [float(x) for x in self.goal],
                "goal_reached": at_goal,
                "moving": not at_goal,
                "grip": {"goal": self.grip_goal, "target": self.grip_target,
                         "on": self.grip_on,
                         "measured": self.q[6] if self.q else None,
                         "alive": self.grip_alive},
                "limits": {"lower": [float(x) for x in self.env.lower],
                           "upper": [float(x) for x in self.env.upper],
                           "grip": [GRIP_OPEN, GRIP_CLOSED]},
                "tx": self.tx_count,
            }

    def engage(self, via: str = "operator") -> str:
        with self.lock:
            if not self.connected or self.q is None:
                return "cannot engage: no CAN feedback"
            if time.time() - self.fb_t > STALE_S:
                return "cannot engage: feedback stale"
            cur = self.env.clamp(self.q[:N])
            self.goal = cur.copy()
            self.target = np.array(self.q[:N], dtype=float)
            self.grip_goal = self.grip_target = float(
                np.clip(self.q[6], GRIP_OPEN, GRIP_CLOSED))
            self.engaged = True
            self.engaged_via = via
            self.status = "engaged"
            return "engaged: target latched to measured pose"

    def disengage(self) -> str:
        with self.lock:
            self.engaged = False
            self.engaged_via = "none"
            self.grip_on = False
            self.status = "disengaged (arm holds where it is)"
            return self.status

    def set_agent_control(self, allowed: bool) -> str:
        with self.lock:
            self.agent_control = bool(allowed)
            if self.engaged:
                self.engaged_via = "agent" if allowed else "operator"
            return ("agent control enabled" if allowed
                    else "agent control disabled")

    def set_goal(self, joints_rad: list[float]) -> str:
        if len(joints_rad) != N:
            return f"need {N} joint values"
        if not Envelope.finite(joints_rad):
            return "rejected: non-finite joint value"
        with self.lock:
            if not self.engaged:
                return "not engaged"
            self.goal = self.env.clamp(joints_rad)
            return "ok"

    def move_joints(self, deltas_rad: list[float]) -> str:
        """Relative move, capped per joint then clamped into the window."""
        if len(deltas_rad) != N:
            return f"need {N} deltas"
        if not Envelope.finite(deltas_rad):
            return "rejected: non-finite delta"
        with self.lock:
            if not self.engaged:
                return "not engaged"
            step = self.env.clamp_deltas(deltas_rad)
            self.goal = self.env.clamp(self.goal + step)
            return "ok"

    def goto_preset(self, name: str) -> str:
        preset = self.env.presets.get(name)
        if preset is None:
            return f"unknown preset {name!r}"
        with self.lock:
            if not self.engaged:
                return "not engaged"
            self.goal = self.env.clamp(preset["q"])
            return "ok"

    def jog(self, joint: int, delta_deg: float) -> str:
        if not 0 <= joint < N:
            return "bad joint index"
        if not Envelope.finite([delta_deg]):
            return "rejected: non-finite delta"
        deltas = [0.0] * N
        deltas[joint] = math.radians(delta_deg)
        return self.move_joints(deltas)

    def set_grip(self, value: float) -> str:
        if not Envelope.finite([value]):
            return "rejected: non-finite grip value"
        with self.lock:
            if not self.engaged:
                return "not engaged"
            self.grip_goal = float(np.clip(value, GRIP_OPEN, GRIP_CLOSED))
            self.grip_on = True
            return "ok"

    def request_grip_probe(self) -> str:
        """Ask the control thread to test the gripper channel and revive it."""
        with self.lock:
            if not self.connected or self.q is None:
                return "cannot probe: no CAN feedback"
            self._grip_probe_req = True
            return "gripper probe requested"

    def request_enable(self) -> str:
        """FF 1->5->6. Motors disengage briefly; p_des=q streamed throughout."""
        with self.lock:
            if not self.connected or self.q is None:
                return "cannot enable: no CAN feedback"
            self._enable_req = True
            return "enable sequence requested (FF 1->5->6)"

    # ---- control thread ----

    def _run(self) -> None:
        period = 1.0 / RATE_HZ
        last = time.time()
        while not self._stop:
            if self._arm is None:
                self._connect()
                if self._arm is None:
                    time.sleep(2.0)
                    continue
            try:
                got = self._arm.drain()
            except RuntimeError as ex:
                self._drop_link(f"CAN link lost: {ex}")
                continue
            now = time.time()
            with self.lock:
                if got:
                    self.q = self._arm.q
                    self.e = self._arm.e
                    self.fb_t = self._arm.t
                    if self.status == "connected, waiting for feedback":
                        self.status = "ready (disengaged)"
                stale = self.q is None or (now - self.fb_t) > STALE_S
                if self.engaged and stale:
                    self.engaged = False
                    self.engaged_via = "none"
                    self.grip_on = False
                    self.status = "AUTO-DISENGAGED: stale feedback"
                    log.warning("auto-disengage: stale feedback")
                do_enable = self._enable_req and not stale
                if do_enable:
                    self._enable_req = False
                do_grip_probe = self._grip_probe_req and not stale
                if do_grip_probe:
                    self._grip_probe_req = False
                engaged = self.engaged
                dt = min(0.05, now - last)
                step = self.slew * dt
                self.target += np.clip(self.goal - self.target, -step, step)
                d = max(-step, min(step, self.grip_goal - self.grip_target))
                self.grip_target += d
                target = list(self.target)
                grip_target = self.grip_target
                grip_on = self.grip_on
            last = now

            try:
                if do_enable:
                    log.info("running FF 1->5->6 enable sequence")
                    self._arm.enable(self.kp, self.kd)
                    with self.lock:
                        self.status = "enable sequence sent"
                if do_grip_probe:
                    self._run_grip_probe()
                if engaged:
                    self._arm.send_arm(target, self.kp, self.kd)
                    if grip_on:
                        self._arm.send_grip(grip_target, GRIP_KP, GRIP_KD)
                    with self.lock:
                        self.tx_count += 1
            except OSError as ex:
                self._drop_link(f"CAN TX failed: {ex}")
                continue
            time.sleep(max(0.0, period - (time.time() - now)))

    def _grip_nudge(self, target: float, ref: float) -> float:
        """Stream one grip setpoint for GRIP_PROBE_S; return how far it moved."""
        arm = self._arm
        t0 = time.time()
        peak = 0.0
        while time.time() - t0 < GRIP_PROBE_S and not self._stop:
            arm.send_grip(target, GRIP_KP, GRIP_KD)
            arm.drain()
            if arm.q is not None:
                peak = max(peak, abs(arm.q[6] - ref))
            time.sleep(0.005)
        return math.degrees(peak)

    def _run_grip_probe(self) -> None:
        """Test 0x051 and, if it is deaf, clear it with FF 1->5->6.

        Runs inside the control thread, which owns the socket, so nothing else
        transmits meanwhile. The arm holds position while we work the gripper.
        """
        arm = self._arm
        arm.drain()
        if arm.q is None:
            return
        ref = arm.q[6]
        log.info("probing the gripper channel")
        with self.lock:
            self.status = "probing gripper..."

        moved = self._grip_nudge(ref - GRIP_PROBE_NUDGE, ref)
        self._grip_nudge(ref, ref)
        if moved <= GRIP_PROBE_MIN_DEG:
            log.warning("gripper deaf (probe moved %.1f deg) -> FF 1->5->6",
                        moved)
            arm.enable(self.kp, self.kd)
            moved = self._grip_nudge(ref - GRIP_PROBE_NUDGE, ref)
            self._grip_nudge(ref, ref)

        alive = moved > GRIP_PROBE_MIN_DEG
        with self.lock:
            self.grip_alive = alive
            self.grip_goal = self.grip_target = float(
                np.clip(ref, GRIP_OPEN, GRIP_CLOSED))
            self.status = (f"gripper alive (probe moved {moved:.1f} deg)"
                           if alive else
                           f"GRIPPER DEAD (probe moved {moved:.1f} deg) - "
                           f"power-cycle the arm")
        log.info("gripper probe: %s", self.status)

    def _connect(self) -> None:
        try:
            arm = A1X(self.iface)
        except (SystemExit, OSError) as ex:
            with self.lock:
                self.connected = False
                self.status = f"CAN down ({self.iface}): run ./can_up.sh"
            log.debug("connect failed: %s", ex)
            return
        self._arm = arm
        with self.lock:
            self.connected = True
            self.status = "connected, waiting for feedback"
        log.info("bound to %s", self.iface)

    def _drop_link(self, msg: str) -> None:
        log.warning(msg)
        try:
            if self._arm:
                self._arm.s.close()
        except OSError:
            pass
        self._arm = None
        with self.lock:
            self.connected = False
            self.engaged = False
            self.engaged_via = "none"
            self.grip_on = False
            self.q = None
            self.status = msg
        time.sleep(1.0)
