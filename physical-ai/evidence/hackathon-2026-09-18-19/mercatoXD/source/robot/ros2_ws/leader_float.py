#!/usr/bin/env python3
"""Put the LEADER arm into zero-gravity float mode: compliant AND reporting.

    leader_float.py --check   [--iface can1] [--poses 5]   # READ-ONLY, transmits nothing
    leader_float.py           [--iface can1] [--factor 1.0] [--secs 30]
    leader_float.py --status  [--iface can1]                # READ-ONLY, one-shot state dump

The problem this solves
-----------------------
An A1X used as a hand-guided leader has to be two things at once, and the two
states we already knew how to reach each give exactly one of them:

    enabled  (function frame 1/6)   reports at 200 Hz -- but holds itself rigid
    released (function frame 2/3/4) hand-movable      -- but 0x052 freezes solid

Galaxea's own A1Z SDK reaches a third state, and the A1X speaks the same MIT
impedance law on 0x050, so it is reachable here as well. Keep the motors
ENERGISED -- that is what keeps the encoders alive -- and command:

    kp   = 0            no position servo; nothing pulls the arm to a pose
    kd   = small        damping only, so it cannot oscillate or run away
    t_ff = g(q)         cancels the arm's own weight, recomputed every cycle

The arm then carries its own weight but offers no resistance to being moved,
and keeps reporting the whole time. See gravity.py for the full reasoning,
including why `kd` is deliberately NOT zero -- an all-zero payload was already
measured on this hardware and does not soften the arm.

Why --check comes first, and is not optional
--------------------------------------------
t_ff is open loop. Nothing corrects it. A wrong SIGN means the compensation adds
to gravity instead of cancelling it, and a brakeless arm then accelerates
downward harder than free fall. So the sign and scale are never taken from the
URDF on faith.

While the motors are enabled and the arm is stationary and unsupported, the
effort reported in 0x052 IS the torque holding that pose up. --check parks the
arm in several poses, records (position, effort) at each, and regresses the
measurement against the URDF model. Only a fit that actually explains the data
is allowed to drive torque; joints that fail, or that no sampled pose ever
loaded, get zero compensation instead of a guess.

--check transmits nothing at all. It is safe to run at any time.

SAFETY -- read before running without --check
---------------------------------------------
* The arm has NO BRAKES. The instant float mode engages, the arm's own hold is
  replaced by our torque. If the calibration is wrong it will sag. SUPPORT THE
  ARM BY HAND for the first run, and use --factor 0.3 to make a sign error mild
  and obvious rather than violent.
* The acceleration watchdog in safety.py runs throughout and cuts the motors on
  a runaway.
* Every exit path -- clean, exception, Ctrl-C, watchdog -- first commands a
  position hold at the last good pose so the arm cannot drop, and only then
  stops. Ctrl-C sets a flag; it never touches the CAN socket from the handler.
* The e-stop remains the only hardware override.
"""
import argparse

import math
import os
import signal
import struct
import sys
import time

sys.path.insert(0, "/home/ros/ros2_ws/src/galaxea_a1xy_driver/galaxea_a1xy_driver")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "src/galaxea_a1xy_driver/galaxea_a1xy_driver"))

from collections import deque                                  # noqa: E402

import can_io                                                    # noqa: E402
from protocol import (CMD_CAN_ID, FB_CAN_ID, FB_LEN, FF_CAN_ID,  # noqa: E402
                      N_JOINTS, FF_ENABLE, FF_ENABLE2, ArmCommand,
                      decode_feedback, encode_command, encode_function_frame)
from safety import SafetyMonitor, SafetyTrip                     # noqa: E402
import gravity                                                   # noqa: E402

CAL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "leader_gravity.json")

RATE = 250.0                  # Hz; matches the vendor SDK's control frequency
FLOAT_KD = (0.6, 0.6, 0.6, 0.3, 0.3, 0.3)   # damping only -- never zero
HOLD_KP = (25.0, 25.0, 25.0, 15.0, 8.0, 8.0)
HOLD_KD = (2.0, 2.0, 2.0, 1.0, 1.0, 1.0)

# A1X URDF joint limits (rad). Every commanded target is clamped to these.
LIMITS = [(-2.880, 2.880), (0.0, 3.142), (-3.316, 0.0),
          (-1.571, 1.571), (-1.571, 1.571), (-2.880, 2.880)]
# Calibration poses, as (dJ2, dJ3, dJ4) offsets in DEGREES from wherever the arm
# starts. These are chosen to DECORRELATE the joints, which matters more than
# covering ground:
#
# J2 and J3 have PARALLEL axes (both `0 1 0` in the URDF), so the gravity torque
# about the elbow depends on J2+J3 -- the forearm's absolute angle -- not on J3
# alone. Sweeping J2 up while sweeping J3 down holds J2+J3 roughly constant and
# the elbow model barely moves, which is exactly what happened on the first
# attempt: 1.09 Nm of model spread on J3 and an unfittable R^2 of 0.019. So the
# set below varies J2 alone, J3 alone, and both together, giving J2 and J2+J3
# independent spread. J4 gets its own poses for the same reason -- with the
# wrist never moving, its gravity torque is a constant no fit can resolve.
# Chosen by searching the model for the set that maximises the SMALLEST
# per-joint spread (the binding constraint), under two hard safety limits
# learned the hard way:
#   J2 <= 70 deg  -- a sweep to +120 dropped J2 off the bus entirely; it froze
#                    at 98.45 deg and reported one identical payload until the
#                    arm was power-cycled. Vertical is around +68, so this stays
#                    below the far side.
#   J2 + J3 >= 0  -- J2 and J3 have parallel axes, so J2+J3 is the forearm's
#                    absolute angle. Folding the elbow with the shoulder down
#                    drove the forearm into the bench, and a joint leaning on
#                    the bench reports contact force, not gravity.
# Resulting model spread J2/J3/J4 = 3.77 / 2.19 / 1.54 Nm, all comfortably
# fittable, versus 5.27 / 1.26 / 0.33 for the first attempt.
CAL_OFFSETS = [(0, 0, 0),
               (40, -10, 0), (40, -40, 0), (40, -40, -35),
               (50, 0, -35), (60, 0, 0), (60, -40, 0), (60, -50, 0),
               (70, 0, 35)]

# Tracking tolerance. If the arm settles more than this away from what we asked
# for, it is leaning on something -- the bench, a cable, its own limit -- and
# the torque it reports then includes the contact force, which is not gravity.
# Such a sample is poison for the fit: it looks like a legitimate reading and is
# not. Earlier pose sets folded the elbow down into the bench and produced 20-25
# Nm of disagreement between passes at the same pose; this is the check that
# catches that instead of averaging it in.
TRACK_TOL = math.radians(2.0)
CAL_SPEED = math.radians(25.0)     # rad/s of commanded travel between poses

# Stillness is judged from POSITION, not from the velocity field. Measured on
# this arm, a joint pinned by a position servo -- position steady to 0.01 deg
# for seconds -- still reports 4-5 deg/s of velocity noise. Any threshold below
# that never fires, and any threshold above it is too coarse to mean anything.
# Position is quantised at 1/4700 rad (0.012 deg) and is rock steady, so a small
# window on position is both reliable and strict.
FREEZE_WINDOW = 600               # frames (~3 s at 200 Hz) of identical
                                  # position AND torque -> that joint is gone
STILL_POS = math.radians(0.2)     # rad of drift allowed across the window
STILL_FOR = 0.6                   # s of continuous stillness before sampling
SAMPLE_FOR = 0.8                  # s averaged into one calibration sample
ABORT_DRIFT = math.radians(40.0)  # per-joint drift from float entry -> abort
FRESH_S = 0.05

_stop = {"flag": False}


class Bus:
    """Read/write helper around the raw CAN-FD socket, with freshness tracking."""

    def __init__(self, iface: str):
        self.iface = iface
        self.sock = can_io.open_socket(iface)
        # Non-blocking, so drain() can empty the socket completely instead of
        # working to a time budget. A budget cannot keep up: while it reads,
        # 200 Hz of new frames keep arriving, so a backlog once formed is never
        # cleared and every read after that returns something already old.
        self.sock.setblocking(False)
        self.pos = None
        self.vel = None
        self.eff = None
        self.t_fb = 0.0
        self.frames = 0
        self.distinct = set()
        self._last = None
        self._hist = deque(maxlen=FREEZE_WINDOW)

    def drain(self, _budget: float = 0.0) -> bool:
        """Empty the socket, keeping the newest feedback. True if anything came.

        Reads until the kernel buffer is exhausted, so `pos`/`vel`/`eff` always
        reflect the LAST frame on the wire rather than the head of a backlog.
        """
        got = False
        while True:
            try:
                fr = self.sock.recv(can_io.CANFD_MTU)
            except (BlockingIOError, InterruptedError):
                break
            except (OSError, TimeoutError):
                break
            if len(fr) < can_io.CAN_MTU:
                continue
            can_id, length = struct.unpack_from("=IB", fr, 0)[0:2]
            can_id &= 0x1FFFFFFF
            if can_id != FB_CAN_ID or length != FB_LEN:
                continue
            payload = fr[8:8 + length]
            fb = decode_feedback(payload)
            self.pos = list(fb.position[:N_JOINTS])
            self.vel = list(fb.velocity[:N_JOINTS])
            self.eff = list(fb.effort[:N_JOINTS])
            self.t_fb = time.time()
            self.frames += 1
            if payload != self._last:
                self.distinct.add(payload)
                self._last = payload
            self._hist.append((tuple(self.pos), tuple(self.eff)))
            got = True
        return got

    def wait_fresh(self, timeout: float = 3.0) -> bool:
        end = time.time() + timeout
        while time.time() < end and not _stop["flag"]:
            if self.drain() and (time.time() - self.t_fb) < FRESH_S:
                return True
            time.sleep(0.001)
        return False

    def send(self, cmd: ArmCommand) -> None:
        try:
            can_io.send_frame(self.sock, CMD_CAN_ID, encode_command(cmd))
        except OSError:
            pass

    def function_frame(self, code: int) -> None:
        try:
            can_io.send_frame(self.sock, FF_CAN_ID, encode_function_frame(code))
        except OSError:
            pass

    def frozen_joints(self):
        """Joints whose position AND torque have not changed at all recently.

        A joint that drops off the arm's internal bus keeps appearing in 0x052
        at full rate, repeating its last value forever -- the whole frame still
        looks alive because the OTHER joints keep moving. Watching the frame as
        a whole cannot see it; watching each joint can. Any torque we command
        such a joint is being applied blind, so this is a hard stop.
        """
        if len(self._hist) < self._hist.maxlen:
            return []
        out = []
        for j in range(N_JOINTS):
            if (len({h[0][j] for h in self._hist}) == 1
                    and len({h[1][j] for h in self._hist}) == 1):
                out.append(j)
        return out

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


def _feedback_is_live(bus: Bus, secs: float = 1.5) -> tuple:
    """Count frames and DISTINCT payloads. A frozen arm reports 1 distinct."""
    bus.frames = 0
    bus.distinct = set()
    bus._last = None
    end = time.time() + secs
    while time.time() < end and not _stop["flag"]:
        bus.drain()
        time.sleep(0.001)
    return bus.frames, len(bus.distinct)


def _deg(v):
    return [round(math.degrees(x), 1) for x in v]


# --------------------------------------------------------------------- status
def cmd_status(args) -> int:
    """One-shot read-only state dump. Transmits nothing."""
    bus = Bus(args.iface)
    try:
        if not bus.wait_fresh():
            print(f"  {args.iface}: NO FEEDBACK -- arm powered off or CAN down")
            return 1
        n, d = _feedback_is_live(bus, 2.0)
        print(f"  {args.iface}: {n/2.0:.0f} Hz, {d} distinct payloads in 2 s "
              f"({'LIVE' if d > 1 else 'FROZEN -- motors released or not reporting'})")
        print(f"  position (deg): {_deg(bus.pos)}")
        print(f"  velocity (deg/s): {_deg(bus.vel)}")
        print(f"  effort:         {[round(e, 2) for e in bus.eff]}")
        if os.path.exists(CAL_PATH):
            cal = gravity.GravityCalibration.load(CAL_PATH)
            print(f"  calibration:    {CAL_PATH}")
            print(cal.describe())
            print(f"  usable: {cal.usable}")
        else:
            print("  calibration:    none (only needed for FLOATING; "
                  "--limp needs no calibration)")
        return 0
    finally:
        bus.close()


# -------------------------------------------------------------------- autocal
def cmd_autocal(args) -> int:
    """Calibrate the gravity model by driving the arm to the poses ourselves.

    --check needs the arm parked in several poses, holding itself unsupported.
    That normally means a human pushing a rigid arm around, which is exactly the
    thing we are trying to make unnecessary -- and on a stiff leader it is hard
    to do at all. Since the probe proved our command path drives this arm
    accurately, we can just take it there.

    At each pose we hold with a position gain and wait for the arm to settle.
    Once it is stationary the motor torque is, by definition, whatever it takes
    to hold that pose against gravity -- the position error term has converged
    and nothing else is acting. So the reported effort is the same ground truth
    --check collects by hand, and `gravity.fit` is none the wiser.

    Cross-check built in: kp * (p_des - p) should equal the reported effort. If
    it does not, the effort field is not the torque we think it is, and the fit
    is rejected rather than used.
    """
    model = gravity.GravityModel(args.urdf or gravity.default_urdf())
    print("=" * 72)
    print("  LEADER AUTO-CALIBRATION -- the arm drives ITSELF through the poses")
    print(f"  interface {args.iface} | kp={args.kp:g} kd={args.kd:g} | "
          f"{len(CAL_OFFSETS)} poses")
    print(f"  URDF {model.urdf_path} ({model.mass:.2f} kg)")
    print("=" * 72)
    print("  It sweeps the SHOULDER upward through roughly:")
    for dj2, dj3, dj4 in CAL_OFFSETS:
        print(f"      J2 {dj2:+3d}   J3 {dj3:+3d}   J4 {dj4:+3d}  deg "
              f"(relative to where it is now)")
    print("""
  CLEAR THE WORKSPACE AROUND THE LEADER ARM. It moves under position control,
  slowly, and returns to its start pose at the end -- but it does sweep.
""")
    if not args.yes:
        try:
            if input("  workspace clear? [y/N] ").strip().lower() not in ("y", "yes"):
                print("  aborted.")
                return 1
        except (EOFError, KeyboardInterrupt):
            print("\n  aborted.")
            return 1

    bus = Bus(args.iface)
    start = None
    try:
        if not bus.wait_fresh():
            print(f"  ABORT: no feedback on {args.iface}")
            return 1
        n, d = _feedback_is_live(bus, 1.5)
        if d <= 1:
            print(f"  ABORT: feedback frozen ({d} distinct) -- motors released")
            return 1
        for code in (FF_ENABLE, FF_ENABLE2):
            bus.function_frame(code)
            time.sleep(0.3)
        if not bus.wait_fresh():
            print("  ABORT: feedback did not resume after enable")
            return 1
        start = list(bus.pos)
        print(f"  start pose (deg): {_deg(start)}\n")

        # Each pose is visited TWICE, once on the way out and once on the way
        # back. Static friction opposes the direction of approach, so it enters
        # the two readings with opposite sign; averaging them cancels it and
        # leaves gravity. Without this the elbow reads up to 5 Nm apart at the
        # same pose depending on which way it arrived, and no model fits that.
        sweep = list(enumerate(CAL_OFFSETS)) + list(reversed(list(enumerate(CAL_OFFSETS))))
        by_pose = {}
        residuals = []
        target = list(start)
        _ramp_gains(bus, target, args.kp, args.kd, 1.5)
        for i, (dj2, dj3, dj4) in sweep:
            if _stop["flag"]:
                break
            goal = list(start)
            goal[1] = start[1] + math.radians(dj2)
            goal[2] = start[2] + math.radians(dj3)
            goal[3] = start[3] + math.radians(dj4)
            for k in range(N_JOINTS):
                lo, hi = LIMITS[k]
                goal[k] = max(lo, min(hi, goal[k]))
            seen = len(by_pose.get(i, ()))
            print(f"  [{i+1}/{len(CAL_OFFSETS)}]{' (return pass)' if seen else ''} "
                  f"-> J2{dj2:+d} J3{dj3:+d} J4{dj4:+d}")
            target = _glide(bus, target, goal, args.kp, args.kd)
            if not _settle(bus, target, args.kp, args.kd):
                print("      did not settle -- skipping")
                continue
            dead = bus.frozen_joints()
            if dead:
                print(f"      ABORT: J{', J'.join(str(k+1) for k in dead)} stopped "
                      f"reporting (identical position and torque for "
                      f"{FREEZE_WINDOW} frames). The joint has dropped off the "
                      f"arm's internal bus -- stopping before we command it blind.")
                break
            q, eff = _average_cmd(bus, target, args.kp, args.kd)
            if q is None:
                print("      lost feedback -- skipping")
                continue
            miss = max(abs(q[k] - goal[k]) for k in range(N_JOINTS))
            if miss > TRACK_TOL:
                bad = max(range(N_JOINTS), key=lambda k: abs(q[k] - goal[k]))
                print(f"      SKIP: settled {math.degrees(miss):.1f} deg short on "
                      f"J{bad+1} -- the arm is against something, so its reported "
                      f"torque is not gravity")
                continue
            # kp * position error should reproduce the reported effort
            pred = [args.kp * (target[k] - q[k]) for k in range(N_JOINTS)]
            residuals.append((pred, eff))
            by_pose.setdefault(i, []).append((q, eff))
            print(f"      pose  {_deg(q)}")
            print(f"      eff   {[round(e, 2) for e in eff]}")
            print(f"      model {[round(t, 2) for t in model.tau(q)]}")

        print(f"\n  returning to the start pose")
        _glide(bus, target, start, args.kp, args.kd)
        _settle(bus, start, args.kp, args.kd, timeout=4.0)

        # Average the out-and-back readings for each pose.
        samples = []
        for i, reads in sorted(by_pose.items()):
            n = len(reads)
            q = [sum(r[0][k] for r in reads) / n for k in range(N_JOINTS)]
            e = [sum(r[1][k] for r in reads) / n for k in range(N_JOINTS)]
            if n > 1:
                spread = max(abs(reads[0][1][k] - reads[1][1][k])
                             for k in range(N_JOINTS))
                print(f"  pose {i+1}: averaged {n} passes, "
                      f"friction spread {spread:.2f} Nm")
            samples.append((q, e))

        if len(samples) < gravity.MIN_SAMPLES:
            print(f"  only {len(samples)} usable samples "
                  f"(need {gravity.MIN_SAMPLES}) -- nothing written")
            return 1

        # Informational only. kp*(p_des-p) is NOT this arm's applied torque: the
        # joint servo drives the position error to ~0.01 deg whatever kp we ask
        # for, so kp*e reads ~0 while the motor is really holding several Nm.
        # That does not weaken the ground truth -- at rest the motor's REPORTED
        # torque is still exactly what it takes to hold the pose. The fit is
        # gated on its own per-joint R^2 instead, in gravity.py.
        print(f"\n  (kp*(p_des-p) vs reported effort: R^2 = {_agreement(residuals):.3f}"
              f" -- expected to be low on this arm; the servo is stiffer than kp implies)")

        cal = gravity.fit(samples, model, urdf=model.urdf_path,
                          note=f"autocal, {len(samples)} poses on {args.iface} "
                               f"at {time.strftime('%Y-%m-%d %H:%M')}")
        print("\n  fit (effort = gain * model + offset, per joint):")
        print(cal.describe())
        cal.save(CAL_PATH)
        print(f"\n  written to {CAL_PATH}")
        print(f"  overall verdict: {'USABLE' if cal.usable else 'NOT USABLE'}")
        return 0 if cal.usable else 1
    finally:
        _park(bus, start)
        bus.close()


def _cmd_at(target, kp, kd):
    c = ArmCommand()
    c.p_des = list(target)
    c.v_des = [0.0] * N_JOINTS
    c.kp = [kp] * N_JOINTS
    c.kd = [kd] * N_JOINTS
    c.t_ff = [0.0] * N_JOINTS
    return c


def _ramp_gains(bus, target, kp, kd, secs):
    t0 = time.time()
    while time.time() - t0 < secs and not _stop["flag"]:
        f = (time.time() - t0) / secs
        bus.send(_cmd_at(target, kp * f, kd * f))
        time.sleep(1.0 / RATE)
        bus.drain()


def _glide(bus, frm, to, kp, kd):
    """Walk the target from `frm` to `to` at CAL_SPEED. Never step it."""
    cur = list(frm)
    period = 1.0 / RATE
    while not _stop["flag"]:
        step = CAL_SPEED * period
        done = True
        for k in range(N_JOINTS):
            d = to[k] - cur[k]
            if abs(d) > step:
                cur[k] += math.copysign(step, d)
                done = False
            else:
                cur[k] = to[k]
        bus.send(_cmd_at(cur, kp, kd))
        time.sleep(period)
        bus.drain()
        if done:
            return cur
    return cur


def _settle(bus, target, kp, kd, timeout=6.0):
    """Hold `target` until no joint has moved more than STILL_POS for STILL_FOR."""
    deadline = time.time() + timeout
    ref = None
    since = 0.0
    while time.time() < deadline and not _stop["flag"]:
        bus.send(_cmd_at(target, kp, kd))
        time.sleep(1.0 / RATE)
        bus.drain()
        if bus.pos is None:
            ref = None
            continue
        if ref is None or max(abs(bus.pos[k] - ref[k])
                              for k in range(N_JOINTS)) > STILL_POS:
            ref = list(bus.pos)
            since = time.time()
        elif time.time() - since >= STILL_FOR:
            return True
    return False


def _average_cmd(bus, target, kp, kd):
    """Mean pose and effort over SAMPLE_FOR, while still holding the target."""
    qs, es = [], []
    end = time.time() + SAMPLE_FOR
    while time.time() < end and not _stop["flag"]:
        bus.send(_cmd_at(target, kp, kd))
        time.sleep(1.0 / RATE)
        bus.drain()
        if bus.pos is not None:
            qs.append(list(bus.pos))
            es.append(list(bus.eff))
    if not qs:
        return None, None
    n = len(qs)
    return ([sum(s[k] for s in qs) / n for k in range(N_JOINTS)],
            [sum(s[k] for s in es) / n for k in range(N_JOINTS)])


def _agreement(residuals):
    """R^2 of reported effort against kp*(p_des - p), pooled over all joints."""
    xs = [p for pred, _ in residuals for p in pred]
    ys = [e for _, eff in residuals for e in eff]
    if len(xs) < 3:
        return 0.0
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    sxx = sum((v - mx) ** 2 for v in xs)
    syy = sum((v - my) ** 2 for v in ys)
    if sxx <= 0 or syy <= 0:
        return 0.0
    sxy = sum((a - mx) * (b - my) for a, b in zip(xs, ys))
    a = sxy / sxx
    b = my - a * mx
    resid = sum((y - (a * x + b)) ** 2 for x, y in zip(xs, ys))
    return max(0.0, 1.0 - resid / syy)


# ---------------------------------------------------------------------- probe
def cmd_probe(args) -> int:
    """Does the LEADER obey a command sent over OUR raw-CAN path at all?

    Everything float mode does rests on this and it had never been tested. The
    follower's commands go through the vendor ARM_APP on can0, so proving the
    follower moves proves nothing about `protocol.encode_command` +
    `can_io.send_frame`, which is the path float mode uses on can1.

    Same shape as follower_probe.py: hold the current pose, step ONE joint by a
    few degrees, measure, drive back, release. J1 by default -- base yaw, no
    gravity load, swings in the horizontal plane.
    """
    j = args.joint - 1
    if not 0 <= j < N_JOINTS:
        print("  --joint must be 1..6")
        return 2
    bus = Bus(args.iface)
    start = None
    try:
        print("=" * 68)
        print(f"  LEADER PROBE (raw CAN on {args.iface})  |  J{j+1} step "
              f"{args.step:+.1f} deg  |  kp={args.kp:g} kd={args.kd:g}")
        print("=" * 68)
        if not bus.wait_fresh():
            print(f"  FAIL: no feedback on {args.iface}")
            return 1
        n, d = _feedback_is_live(bus, 1.5)
        print(f"  feedback: {n/1.5:.0f} Hz, {d} distinct payloads "
              f"({'LIVE' if d > 1 else 'FROZEN'})")
        if d <= 1:
            print("  FAIL: feedback frozen -- motors released. Enable first.")
            return 1

        for code in (FF_ENABLE, FF_ENABLE2):
            bus.function_frame(code)
            time.sleep(0.3)
        if not bus.wait_fresh():
            print("  FAIL: feedback did not resume after enable")
            return 1
        start = list(bus.pos)
        print(f"  start pose (deg): {_deg(start)}")

        def stream(target, kp, kd, secs, ramp=False):
            t0 = time.time()
            while time.time() - t0 < secs and not _stop["flag"]:
                f = min(1.0, (time.time() - t0) / secs) if ramp else 1.0
                c = ArmCommand()
                c.p_des = list(target)
                c.v_des = [0.0] * N_JOINTS
                c.kp = [kp * f] * N_JOINTS
                c.kd = [kd * f] * N_JOINTS
                c.t_ff = [0.0] * N_JOINTS
                bus.send(c)
                time.sleep(1.0 / RATE)
                bus.drain()

        print(f"  holding the start pose, gains eased in over 1.5s")
        stream(start, args.kp, args.kd, 1.5, ramp=True)
        stream(start, args.kp, args.kd, 1.5)
        bus.drain()
        drift = max(abs(bus.pos[k] - start[k]) for k in range(N_JOINTS))
        print(f"      drift while merely holding: {math.degrees(drift):.2f} deg")

        target = list(start)
        target[j] = start[j] + math.radians(args.step)
        print(f"  commanding J{j+1} {math.degrees(start[j]):+.2f} -> "
              f"{math.degrees(target[j]):+.2f} deg")
        stream(target, args.kp, args.kd, 2.5)
        bus.drain()
        reached = list(bus.pos)
        delta = math.degrees(reached[j] - start[j])
        cross = max(math.degrees(abs(reached[k] - start[k]))
                    for k in range(N_JOINTS) if k != j)
        frac = delta / args.step if args.step else 0.0
        print(f"\n  RESULT")
        print(f"      commanded J{j+1}: {args.step:+.2f} deg")
        print(f"      measured  J{j+1}: {delta:+.2f} deg")
        print(f"      largest move on any OTHER joint: {cross:.2f} deg")
        if abs(delta) < 0.3:
            print("      -> DID NOT MOVE. Our raw-CAN command path does not reach "
                  "this arm, so float mode cannot work either. THIS is the bug.")
        elif frac > 0.5:
            print(f"      -> FOLLOWS ({frac*100:.0f}% of commanded). Our encoder "
                  "works; float mode is viable.")
        else:
            print(f"      -> moved only {frac*100:.0f}% -- gains low or obstructed.")

        print("  returning to start")
        stream(start, args.kp, args.kd, 2.5)
        return 0
    finally:
        _park(bus, start)
        bus.close()


# ---------------------------------------------------------------------- check
def cmd_check(args) -> int:
    """Record (pose, effort) at several resting poses and fit the gravity model.

    READ-ONLY: this function never transmits. The arm holds itself the whole
    time under its own enabled-state hold, exactly as it does now.
    """
    model = gravity.GravityModel(args.urdf or gravity.default_urdf())
    print("=" * 72)
    print("  LEADER GRAVITY CHECK -- read-only, nothing is transmitted")
    print(f"  interface: {args.iface}")
    print(f"  URDF:      {model.urdf_path}  ({model.mass:.2f} kg)")
    print("=" * 72)
    print("""
  The arm must be ENERGISED and holding itself (it is, if teleop works today).
  For each sample: push the arm by hand into a new pose, LET GO, and let it
  hold itself in the air. The effort it then reports is the torque holding that
  pose up -- which is what we are calibrating against.

  Choose poses that actually LOAD the arm: reach out, up, down, to each side.
  Do NOT rest the arm on the bench for a sample -- the bench would carry the
  weight and the reading would be a lie.
""")
    bus = Bus(args.iface)
    try:
        if not bus.wait_fresh():
            print(f"  ABORT: no feedback on {args.iface}")
            return 1
        n, d = _feedback_is_live(bus, 2.0)
        if d <= 1:
            print(f"  ABORT: feedback is FROZEN ({d} distinct payload in 2 s). "
                  "The motors are released; enable them first.")
            return 1
        print(f"  feedback OK: {n/2.0:.0f} Hz, {d} distinct payloads\n")

        samples = []
        for i in range(args.poses):
            if _stop["flag"]:
                break
            try:
                input(f"  [{i+1}/{args.poses}] move the arm, let go, then press ENTER "
                      f"(Ctrl-C to stop early)... ")
            except (EOFError, KeyboardInterrupt):
                print()
                break
            if not _wait_still(bus):
                print("      arm never settled -- skipping this pose")
                continue
            q, eff = _average(bus)
            if q is None:
                print("      lost feedback -- skipping this pose")
                continue
            tau = model.tau(q)
            samples.append((q, eff))
            print(f"      pose(deg) {_deg(q)}")
            print(f"      effort    {[round(e, 2) for e in eff]}")
            print(f"      model(Nm) {[round(t, 2) for t in tau]}")

        if len(samples) < gravity.MIN_SAMPLES:
            print(f"\n  only {len(samples)} usable samples "
                  f"(need {gravity.MIN_SAMPLES}) -- nothing written")
            return 1

        cal = gravity.fit(samples, model, urdf=model.urdf_path,
                          note=f"{len(samples)} poses on {args.iface} "
                               f"at {time.strftime('%Y-%m-%d %H:%M')}")
        print("\n  fit (effort = gain * model + offset, per joint):")
        print(cal.describe())
        unloaded = cal.unloaded_joints()
        if unloaded:
            print(f"\n  J{', J'.join(str(j+1) for j in unloaded)} carried no gravity "
                  "in any sampled pose -> they will get ZERO compensation, which is "
                  "correct for a joint that needs none. If that surprises you, add "
                  "poses that load them.")
        bad = cal.unusable_joints()
        if bad:
            print(f"\n  REJECTED: J{', J'.join(str(j+1) for j in bad)} are loaded but "
                  "do not fit the model. Float mode will leave them uncompensated "
                  "(they will sag). Do not raise --factor to compensate.")
        cal.save(CAL_PATH)
        print(f"\n  written to {CAL_PATH}")
        print(f"  overall verdict: {'USABLE' if cal.usable else 'NOT USABLE'}")
        if not cal.usable:
            print("  -> float mode will refuse to run. Re-check with more, "
                  "better-loaded poses.")
            return 1
        return 0
    finally:
        bus.close()


def _wait_still(bus: Bus, timeout: float = 20.0) -> bool:
    """Wait until no joint has moved more than STILL_POS for STILL_FOR."""
    deadline = time.time() + timeout
    ref = None
    since = 0.0
    while time.time() < deadline and not _stop["flag"]:
        bus.drain()
        time.sleep(0.002)
        if bus.pos is None or (time.time() - bus.t_fb) > FRESH_S:
            ref = None
            continue
        if ref is None or max(abs(bus.pos[k] - ref[k])
                              for k in range(N_JOINTS)) > STILL_POS:
            ref = list(bus.pos)
            since = time.time()
        elif time.time() - since >= STILL_FOR:
            return True
    return False


def _average(bus: Bus):
    """Mean position and effort over SAMPLE_FOR seconds of fresh feedback."""
    qs, es = [], []
    end = time.time() + SAMPLE_FOR
    while time.time() < end and not _stop["flag"]:
        if bus.drain() and (time.time() - bus.t_fb) < FRESH_S:
            qs.append(list(bus.pos))
            es.append(list(bus.eff))
    if not qs:
        return None, None
    n = len(qs)
    q = [sum(s[j] for s in qs) / n for j in range(N_JOINTS)]
    e = [sum(s[j] for s in es) / n for j in range(N_JOINTS)]
    return q, e


# ---------------------------------------------------------------------- float
def cmd_float(args) -> int:
    # --limp: kp = 0, kd = small, t_ff = 0.
    #
    # This needs no gravity model and no calibration, and it is the safest
    # command that can possibly soften the arm: with kp = 0 and t_ff = 0 the
    # only torque commanded is -kd * velocity, which is purely DISSIPATIVE. It
    # can take energy out of the arm and cannot put any in, so unlike gravity
    # compensation there is no sign to get wrong and nothing that can drive the
    # arm anywhere. The arm simply stops resisting.
    #
    # It is not the same as the all-zero payload that was measured here and did
    # nothing: kd is non-zero, so this is a real MIT command.
    #
    # The cost is that the arm carries no weight, so it sags -- you hold it.
    # For a hand-guided leader that is usually fine, and it is the whole of what
    # teleop actually needs: an arm that MOVES and REPORTS.
    if args.limp:
        cal = None
        print("=" * 72)
        print("  LEADER LIMP MODE -- kp=0, kd=%s, t_ff=0 (no gravity model)"
              % (list(FLOAT_KD),))
        print(f"  interface {args.iface} | {args.secs:g}s | {RATE:.0f} Hz")
        print("=" * 72)
        print("""
  Commanded torque is -kd * velocity only: dissipative, so it cannot drive the
  arm. But the arm then carries NO weight and has NO brakes -- it WILL sag.
  HOLD IT.
""")
        if not args.yes:
            try:
                if input("  holding the arm? [y/N] ").strip().lower() not in ("y", "yes"):
                    print("  aborted.")
                    return 1
            except (EOFError, KeyboardInterrupt):
                print("\n  aborted.")
                return 1
        return _run_float(args, cal, None)

    if not os.path.exists(CAL_PATH):
        print(f"  ABORT: no calibration at {CAL_PATH}. Run --check first "
              "(it is read-only and transmits nothing).")
        return 1
    cal = gravity.GravityCalibration.load(CAL_PATH)
    if not cal.usable and not args.force:
        print("  ABORT: the stored calibration is NOT usable:")
        print(cal.describe())
        print("  Re-run --check with poses that load the failing joints.")
        return 1

    model = gravity.GravityModel(cal.urdf or args.urdf or gravity.default_urdf())
    print("=" * 72)
    print("  LEADER ZERO-GRAVITY FLOAT MODE")
    print(f"  interface {args.iface} | factor {args.factor:g} | {args.secs:g}s "
          f"| {RATE:.0f} Hz")
    print(f"  kp = 0, kd = {FLOAT_KD}, t_ff = {args.factor:g} * g(q)")
    print("=" * 72)
    print(cal.describe())
    print("""
  THE ARM HAS NO BRAKES. Float mode replaces its own hold with our torque the
  instant the first frame goes out. SUPPORT IT BY HAND NOW.
""")
    if not args.yes:
        try:
            if input("  holding the arm? [y/N] ").strip().lower() not in ("y", "yes"):
                print("  aborted.")
                return 1
        except (EOFError, KeyboardInterrupt):
            print("\n  aborted.")
            return 1

    return _run_float(args, cal, model)


def _run_float(args, cal, model) -> int:
    bus = Bus(args.iface)
    guard = None
    entry = None
    try:
        if not bus.wait_fresh():
            print(f"  ABORT: no feedback on {args.iface}")
            return 1
        n, d = _feedback_is_live(bus, 1.5)
        print(f"  feedback before: {n/1.5:.0f} Hz, {d} distinct")
        if d <= 1:
            print("  ABORT: feedback frozen -- motors are released. Enable first.")
            return 1

        # Energise. Already-enabled arms take this harmlessly; it also guarantees
        # the state if the arm was released between --check and now.
        for code in (FF_ENABLE, FF_ENABLE2):
            bus.function_frame(code)
            time.sleep(0.3)
        if not bus.wait_fresh():
            print("  ABORT: feedback did not resume after enable")
            return 1

        entry = list(bus.pos)
        print(f"  entry pose (deg): {_deg(entry)}")
        guard = SafetyMonitor(bus.sock)

        period = 1.0 / RATE
        t0 = time.time()
        next_tick = t0
        tau = [0.0] * N_JOINTS
        moved = 0.0
        n_frames = 0
        report = t0
        print("  floating -- move the arm by hand. Ctrl-C to stop.\n")

        while not _stop["flag"]:
            next_tick += period
            while True:
                remain = next_tick - time.time()
                if remain <= 0:
                    break
                bus.drain()
            if time.time() - next_tick > period:
                next_tick = time.time()
            now = time.time()
            t = now - t0
            if t > args.secs:
                break

            bus.drain()
            if bus.pos is None or (now - bus.t_fb) > 0.25:
                print(f"  ABORT: leader feedback stale {(now - bus.t_fb)*1000:.0f} ms")
                break

            q = list(bus.pos)
            drift = max(abs(q[j] - entry[j]) for j in range(N_JOINTS))
            moved = max(moved, drift)
            if drift > ABORT_DRIFT:
                w = max(range(N_JOINTS), key=lambda j: abs(q[j] - entry[j]))
                print(f"  ABORT: J{w+1} drifted {math.degrees(drift):.1f} deg "
                      f"from the entry pose")
                break

            dead = bus.frozen_joints()
            if dead:
                print(f"  ABORT: J{', J'.join(str(k+1) for k in dead)} stopped "
                      "reporting -- dropped off the arm's internal bus")
                break
            tau = ([0.0] * N_JOINTS if cal is None
                   else cal.tau(model.tau(q), factor=args.factor))
            guard.update(_fb_view(bus), tau)      # watchdog sees every sample

            cmd = ArmCommand()
            cmd.p_des = q                          # ignored: kp = 0
            cmd.v_des = [0.0] * N_JOINTS
            cmd.kp = [0.0] * N_JOINTS
            cmd.kd = list(FLOAT_KD)
            cmd.t_ff = tau
            bus.send(cmd)
            n_frames += 1

            if now - report >= 2.0:
                report = now
                print(f"    t={t:5.1f}s  pos(deg) {_deg(q)}")
                print(f"              t_ff(Nm) {[round(x, 2) for x in tau]}  "
                      f"eff {[round(e, 2) for e in bus.eff]}  "
                      f"drift {math.degrees(drift):4.1f} deg")

        print(f"\n  float ran {time.time() - t0:.1f}s, {n_frames} command frames, "
              f"max drift {math.degrees(moved):.1f} deg")
        return 0
    except SafetyTrip:
        print("  watchdog tripped -- motors cut")
        return 1
    finally:
        if guard is not None:
            guard.report()
        _park(bus, entry)
        bus.close()


def _fb_view(bus: Bus):
    """SafetyMonitor expects an object with .position/.velocity/.effort."""
    class _V:
        pass
    v = _V()
    v.position = list(bus.pos or [0.0] * N_JOINTS)
    v.velocity = list(bus.vel or [0.0] * N_JOINTS)
    v.effort = list(bus.eff or [0.0] * N_JOINTS)
    return v


def _park(bus: Bus, entry) -> None:
    """Leave the arm holding, never limp.

    Simply stopping the command stream hands the arm back to its own enabled
    hold, but there is a window before that takes over, and a brakeless arm
    falls in that window. So we first command a real position hold at the pose
    the arm is in right now, let it settle, and only then stop transmitting.
    """
    if bus.pos is None:
        return
    bus.drain()
    hold = list(bus.pos)
    cmd = ArmCommand()
    cmd.p_des = hold
    cmd.v_des = [0.0] * N_JOINTS
    cmd.kp = list(HOLD_KP)
    cmd.kd = list(HOLD_KD)
    cmd.t_ff = [0.0] * N_JOINTS
    end = time.time() + 0.6
    while time.time() < end:
        bus.send(cmd)
        time.sleep(1.0 / RATE)
        bus.drain()
    print(f"  parked: holding at {_deg(hold)} (kp={HOLD_KP[0]:g}), stream stopped")


def main() -> int:
    p = argparse.ArgumentParser(
        description="Zero-gravity float mode for the A1X leader arm",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--iface", default="can1", help="leader CAN interface (default can1)")
    p.add_argument("--check", action="store_true",
                   help="READ-ONLY: calibrate the gravity model against measured hold effort")
    p.add_argument("--status", action="store_true", help="READ-ONLY: dump arm state and exit")
    p.add_argument("--limp", action="store_true",
                   help="kp=0, kd=small, t_ff=0 -- compliant, no gravity model needed")
    p.add_argument("--autocal", action="store_true",
                   help="drive the arm through the calibration poses itself")
    p.add_argument("--probe", action="store_true",
                   help="move ONE joint a few degrees to prove our raw-CAN path works")
    p.add_argument("--joint", type=int, default=1, help="--probe: joint to move, 1-6")
    p.add_argument("--step", type=float, default=3.0, help="--probe: degrees")
    p.add_argument("--kp", type=float, default=20.0, help="--probe: position gain")
    p.add_argument("--kd", type=float, default=2.0, help="--probe: damping")
    p.add_argument("--poses", type=int, default=5, help="calibration poses (default 5)")
    p.add_argument("--factor", type=float, default=1.0,
                   help="gravity compensation scale; use 0.3 for a first run")
    p.add_argument("--secs", type=float, default=30.0, help="how long to float")
    p.add_argument("--urdf", default=None, help="override the URDF path")
    p.add_argument("--yes", "-y", action="store_true", help="skip the hold-the-arm prompt")
    p.add_argument("--force", action="store_true",
                   help="run float mode on a calibration that failed its own checks")
    args = p.parse_args()

    # Never touch the CAN socket from a signal handler; just raise the flag.
    signal.signal(signal.SIGINT, lambda *_: _stop.__setitem__("flag", True))

    if args.status:
        return cmd_status(args)
    if args.autocal:
        return cmd_autocal(args)
    if args.probe:
        return cmd_probe(args)
    if args.check:
        return cmd_check(args)
    return cmd_float(args)


if __name__ == "__main__":
    raise SystemExit(main())
