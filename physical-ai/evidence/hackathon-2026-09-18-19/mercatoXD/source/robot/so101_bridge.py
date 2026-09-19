#!/usr/bin/env python3
"""SO-101 (LeRobot) as leader -> Galaxea A1X as follower.

WHY THIS EXISTS
    The A1X cannot be hand-guided: measured, its CAN-FD interface is pure
    position control (t_ff inert to +/-12 Nm, kp ignored), and J2/J3 will not
    backdrive. The SO-101 is built to be hand-guided, so using it as the leader
    removes the problem instead of fighting it. Its gripper backdrives too, so
    the operator's grip maps straight through.

TWO RETARGETING MODES

  --mode joint   (default, recommended)
      The topologies line up almost 1:1 --
          shoulder_pan  -> arm_joint1 (yaw)
          shoulder_lift -> arm_joint2 (pitch)
          elbow_flex    -> arm_joint3 (pitch)
          wrist_flex    -> arm_joint4 (pitch)
          wrist_roll    -> arm_joint6 (roll)
          arm_joint5 (wrist yaw) has NO SO-101 counterpart and is held.
      Mapping is RELATIVE to the pose both arms start in, so neither absolute
      calibration nor matching zero points is needed, and the A1X never jumps
      on start. Singularity-free and exact.

  --mode ik
      FK the SO-101 tip, scale the displacement into the A1X workspace
      (measured ratio of 95th-percentile reach = 1.657), then solve A1X IK.
      Use this when Cartesian correspondence matters more than posture.
      NOTE: the SO-101 has 5 DOF, so it cannot specify a full 6-DOF
      orientation. Position is prioritised (--w-rot, default 0.15); demanding
      exact orientation costs ~10 mm of position error on reachable targets.

SAFETY
    * --dry-run prints targets and transmits nothing. Use it first.
    * The A1X follower is slew-limited (--follow-rate) and clamped to URDF
      limits; targets are relative to its start pose.
    * The gripper closes force-limited: if |effort| exceeds --grip-force the
      target freezes, so it grips rather than crushes.
    * Aborts on stale CAN feedback or on losing the SO-101.
    * Ctrl-C stops streaming; an uncommanded A1X holds where it is.
"""
from __future__ import annotations
import argparse, math, os, signal, socket, struct, sys, time
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kinematics import Chain, ik as solve_ik

N = 6
CMD_ID, GRIP_ID, FB_ID = 0x050, 0x051, 0x052
S_POS, S_VEL, S_EFF = 4700.0, 750.0, 600.0
FIELDS = ((-6.5,6.5,4700.0), (-40.0,40.0,750.0), (0.0,500.0,60.0),
          (0.0,200.0,150.0), (-50.0,50.0,600.0))
A1X_JOINTS = [f"arm_joint{i}" for i in range(1, 7)]
SO_ARM = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll"]
# SO-101 joint -> A1X joint index. arm_joint5 (index 4) is deliberately absent.
JOINT_MAP = {"shoulder_pan": 0, "shoulder_lift": 1, "elbow_flex": 2,
             "wrist_flex": 3, "wrist_roll": 5}
HERE = os.path.dirname(os.path.abspath(__file__))
A1X_URDF = os.path.join(HERE, "ros2_ws/src/galaxea_a1xy_description/urdf/a1x.urdf")
SO_URDF  = os.path.join(HERE, "so101/so101_new_calib.urdf")
_stop = {"flag": False}


def encode(p, v, kp, kd, tff):
    out = bytearray(60)
    for j in range(N):
        for k, vals in enumerate((p, v, kp, kd, tff)):
            lo, hi, sc = FIELDS[k]
            x = lo if vals[j] < lo else (hi if vals[j] > hi else vals[j])
            raw = max(-32768, min(32767, int(x * sc)))
            o = j*10 + k*2
            out[o] = (raw >> 8) & 0xFF; out[o+1] = raw & 0xFF
    return bytes(out)


def encode_grip(p, v, kp, kd, tff):
    """10-byte 0x051: one group, same five fields and scales as an arm joint."""
    out = bytearray(10)
    for k, val in enumerate((p, v, kp, kd, tff)):
        lo, hi, sc = FIELDS[k]
        x = lo if val < lo else (hi if val > hi else val)
        raw = max(-32768, min(32767, int(x * sc)))
        out[k*2] = (raw >> 8) & 0xFF; out[k*2+1] = raw & 0xFF
    return bytes(out)


class A1X:
    def __init__(self, iface):
        self.iface = iface
        self.s = socket.socket(socket.AF_CAN, socket.SOCK_RAW, socket.CAN_RAW)
        self.s.setsockopt(socket.SOL_CAN_RAW, socket.CAN_RAW_FD_FRAMES, 1)
        try:
            self.s.bind((iface,))
        except OSError as ex:
            raise SystemExit(f"  cannot bind {iface}: {ex}\n"
                             f"  The CAN link is down. Run:  ./can_up.sh") from None
        self.s.settimeout(0.0)
        self.q = None; self.e = None; self.t = 0.0; self.n = 0

    def drain(self):
        """Read every queued frame; a partial drain yields seconds-stale data."""
        got = False
        while True:
            try: b = self.s.recv(72)
            except (BlockingIOError, socket.timeout): break
            except OSError as ex:            # link went down mid-run
                raise RuntimeError(f"{self.iface}: {ex}. Run ./can_up.sh") from None
            if (struct.unpack("=I", b[:4])[0] & 0x1FFFFFFF) != FB_ID: continue
            r = struct.unpack(">21h", b[8:8+42])
            self.q = [r[g*3]/S_POS for g in range(7)]
            self.e = [r[g*3+2]/S_EFF for g in range(7)]
            self.t = time.time(); self.n += 1; got = True
        return got

    def wait(self, secs=3.0):
        end = time.time() + secs
        while time.time() < end:
            if self.drain() and self.q is not None: return True
            time.sleep(0.002)
        return False

    def enable(self, kp, kd):
        """Vendor enable sequence 1 -> 5 -> 6 on 0x053.

        MEASURED: code 1 alone leaves the arm holding and reporting but DEAF to
        0x050; code 5 (clear DISCONNECT) restores command acceptance; 6 brings
        tracking to 100%.

        SAFETY: enabling with nothing streamed drove an arm 76 deg at SATURATED
        torque (effort 50.0) because it chased a stale internal target. So
        p_des = q is streamed before, during and after every code.
        """
        for code in (1, 5, 6):
            t0 = time.time()
            while time.time() - t0 < 0.3:
                self.drain()
                if self.q is not None:
                    self.send_arm(self.q[:N], kp, kd)
                time.sleep(0.005)
            self.s.send(struct.pack("=IBBBB", 0x053, 1, 0, 0, 0)
                        + bytes([code]).ljust(8, b"\x00"))
        t0 = time.time()
        while time.time() - t0 < 0.3:
            self.drain()
            if self.q is not None:
                self.send_arm(self.q[:N], kp, kd)
            time.sleep(0.005)

    def ensure_listening(self, kp, kd, chain=None, nudge_deg=1.0):
        """The A1X intermittently stops accepting 0x050/0x051 while still
        reporting 0x052 at 200 Hz -- it looks perfectly healthy and silently
        ignores every command. Only FF 1->5->6 clears it.

        We test rather than enable unconditionally, because FF 5 briefly
        DISENGAGES the motors. A 1 deg nudge on J1 (base yaw, no gravity load)
        is the cheapest probe that distinguishes the two states.
        """
        import math as _m
        self.drain()
        if self.q is None:
            return False
        start = list(self.q[:N])
        tgt = list(start); tgt[0] = start[0] + _m.radians(nudge_deg)

        def _probe(target):
            t0 = time.time(); peak = 0.0
            while time.time() - t0 < 1.2:
                self.send_arm(target, kp, kd); self.drain()
                peak = max(peak, abs(self.q[0] - start[0]))
                time.sleep(0.005)
            return _m.degrees(peak)

        moved = _probe(tgt)
        if moved > 0.3:
            _probe(start)
            print(f"  arm is listening (probe moved {moved:.2f} deg)")
            return True

        print(f"  arm is DEAF (probe moved {moved:.2f} deg) -- sending FF 1->5->6")
        print("    motors disengage briefly; the setpoint is pinned to the "
              "measured pose throughout")
        self.enable(kp, kd)
        moved = _probe(tgt)
        _probe(start)
        if moved > 0.3:
            print(f"  recovered (probe moved {moved:.2f} deg)")
            return True
        print(f"  STILL DEAF after enable (probe moved {moved:.2f} deg). "
              f"Power-cycle the arm.")
        return False

    def ensure_gripper(self, kp, grip_kp, kd, nudge=1.0):
        """Same intermittent deafness affects the gripper (0x051) independently
        of the arm joints (0x050): group 7 was seen reporting position with
        effort pinned at exactly 0.00 while ignoring every command, then
        recovering later. Probe it separately so a dead gripper is reported at
        startup instead of silently producing an episode with no grasp in it.
        """
        import math as _m
        self.drain()
        if self.q is None:
            return False
        p0 = self.q[6]

        def _probe(target):
            t0 = time.time(); peak = 0.0
            while time.time() - t0 < 1.5:
                self.send_grip(target, grip_kp, kd); self.drain()
                peak = max(peak, abs(self.q[6] - p0))
                time.sleep(0.005)
            return _m.degrees(peak)

        moved = _probe(p0 - nudge)
        _probe(p0)
        if moved > 3.0:
            print(f"  gripper is listening (probe moved {moved:.1f} deg)")
            return True
        print(f"  gripper NOT RESPONDING (probe moved {moved:.1f} deg) "
              f"-- sending FF 1->5->6")
        self.enable(kp, kd)
        moved = _probe(p0 - nudge); _probe(p0)
        if moved > 3.0:
            print(f"  gripper recovered (probe moved {moved:.1f} deg)")
            return True
        print(f"  gripper STILL DEAD. Run without --grip, or power-cycle.")
        return False

    def send_arm(self, p, kp, kd):
        self.s.send(struct.pack("=IBBBB", CMD_ID, 60, 0x01, 0, 0)
                    + encode(p, [0.0]*N, [kp]*N, [kd]*N, [0.0]*N).ljust(64, b"\x00"))

    def send_grip(self, p, kp, kd):
        self.s.send(struct.pack("=IBBBB", GRIP_ID, 10, 0x01, 0, 0)
                    + encode_grip(p, 0.0, kp, kd, 0.0).ljust(64, b"\x00"))


class SO101:
    """Reads the SO-101. Falls back to the raw bus so a missing servo can be
    skipped for dry runs -- lerobot's SOLeader refuses to connect at all."""
    def __init__(self, port, cal_id, allow_missing=False):
        from lerobot.motors import Motor, MotorNormMode
        from lerobot.motors.feetech.feetech import FeetechMotorsBus
        ids = {"shoulder_pan":1, "shoulder_lift":2, "elbow_flex":3,
               "wrist_flex":4, "wrist_roll":5, "gripper":6}
        motors = {n: Motor(i, "sts3215",
                           MotorNormMode.RANGE_0_100 if n == "gripper"
                           else MotorNormMode.RANGE_M100_100)
                  for n, i in ids.items()}
        cal_path = os.path.expanduser(
            f"~/.cache/huggingface/lerobot/calibration/teleoperators/so_leader/{cal_id}.json")
        cal = None
        if os.path.exists(cal_path):
            import json
            from lerobot.motors import MotorCalibration
            raw = json.load(open(cal_path))
            cal = {n: MotorCalibration(**v) for n, v in raw.items()}
        self.bus = FeetechMotorsBus(port=port, motors=motors, calibration=cal)
        self.bus.connect(handshake=False)
        self.present = []
        for n, i in ids.items():
            try: ok = self.bus.ping(i) is not None
            except Exception: ok = False
            if ok: self.present.append(n)
        missing = [n for n in ids if n not in self.present]
        if missing and not allow_missing:
            raise RuntimeError(
                f"SO-101 motors not responding: {missing}. "
                f"Check the cable and power at those servos, or pass --allow-missing "
                f"to run degraded (missing joints are held at their start value).")
        self.missing = missing

    def read(self, retries=3):
        """Keys come back as bare motor names; the rest of this file (and
        lerobot's own get_action) uses the '<name>.pos' convention. Returning
        bare names here silently yields 0.0 everywhere via dict .get defaults.

        Retries: this Feetech bus intermittently returns 'Incorrect status
        packet!', which would otherwise abort a run or a recording episode.
        """
        last = None
        for _ in range(retries):
            try:
                d = self.bus.sync_read("Present_Position")
                self.bad = 0
                return {f"{k}.pos": float(v) for k, v in d.items()}
            except Exception as ex:
                last = ex; time.sleep(0.002)
        self.bad = getattr(self, "bad", 0) + 1
        raise RuntimeError(f"SO-101 bus read failed {retries}x: {last}")

    def close(self):
        try: self.bus.disconnect()
        except Exception: pass


def norm_to_rad(chain, name, val):
    """lerobot normalized (-100..100, or 0..100 for the gripper) -> radians,
    using the URDF limits for that joint."""
    i = chain.names.index(name)
    lo, hi = chain.lower[i], chain.upper[i]
    if name == "gripper":
        f = np.clip(val, 0.0, 100.0) / 100.0
    else:
        f = (np.clip(val, -100.0, 100.0) + 100.0) / 200.0
    return lo + f * (hi - lo)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=("joint", "ik"), default="joint")
    ap.add_argument("--follower", default="can0", help="A1X CAN interface")
    ap.add_argument("--port", default="/dev/ttyACM0")
    ap.add_argument("--cal-id", default="my_leader")
    ap.add_argument("--secs", type=float, default=60.0)
    ap.add_argument("--kp", type=float, default=20.0)
    ap.add_argument("--kd", type=float, default=1.0)
    ap.add_argument("--rate", type=float, default=200.0, help="CAN stream Hz")
    ap.add_argument("--solve-rate", type=float, default=50.0, help="IK solve Hz")
    ap.add_argument("--follow-rate", type=float, default=90.0, help="deg/s slew cap")
    ap.add_argument("--signs", default="+++++",
                    help="sign per SO-101 arm joint, in order "
                         "pan,lift,elbow,wristflex,wristroll. Flip any that "
                         "move the A1X the wrong way.")
    ap.add_argument("--gain", type=float, default=1.0, help="joint-mode motion gain")
    ap.add_argument("--scale", type=float, default=1.657,
                    help="ik-mode workspace scale (A1X reach / SO-101 reach)")
    ap.add_argument("--w-rot", type=float, default=0.15, help="ik orientation weight")
    ap.add_argument("--grip", action="store_true", help="map the gripper too")
    ap.add_argument("--grip-open", type=float, default=-2.0,
                    help="A1X gripper p_des at fully open. MEASURED: group-7 position is linear at 57.1 deg per unit of p_des, with no stall (effort flat ~3.3) out to -3.0, where travel starts tapering. -0.6 used only ~40%% of the range.")
    ap.add_argument("--grip-closed", type=float, default=0.6,
                    help="A1X gripper p_des when SO-101 grip is fully closed")
    ap.add_argument("--grip-kp", type=float, default=25.0)
    ap.add_argument("--grip-force", type=float, default=1.2,
                    help="freeze the close target above this |effort|")
    ap.add_argument("--home", default="",
                    help='comma-separated degrees, e.g. "0,60,-90,0,0,0". The '
                         'A1X is slewed here BEFORE teleop starts. Relative '
                         'mapping can only move AWAY from a limit, so a folded '
                         'home pose (J2 at 0, J3 at 0) gives one-directional '
                         'range on the shoulder and elbow.')
    ap.add_argument("--home-rate", type=float, default=25.0, help="deg/s while homing")
    ap.add_argument("--smooth", type=float, default=0.35,
                    help="EMA factor on SO-101 readings, 0..1. Lower = smoother "
                         "but laggier. Feetech position reads are noisy and the "
                         "noise becomes A1X jitter without this.")
    ap.add_argument("--allow-missing", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="transmit nothing")
    a = ap.parse_args()

    signs = [1.0 if c != "-" else -1.0 for c in a.signs.ljust(5, "+")[:5]]
    a1x_chain = Chain(A1X_URDF, A1X_JOINTS)
    so_chain  = Chain(SO_URDF, SO_ARM)
    so_grip   = Chain(SO_URDF, ["gripper"])

    print("=" * 74)
    print(f"  SO-101 -> A1X   mode={a.mode}  follower={a.follower}"
          f"{'  [DRY RUN]' if a.dry_run else ''}")
    print("=" * 74)

    lead = SO101(a.port, a.cal_id, a.allow_missing)
    if lead.missing:
        print(f"  WARNING degraded: {lead.missing} not responding, held at start value")
    arm = A1X(a.follower)
    if not arm.wait(3.0):
        print(f"  FAIL: no 0x052 on {a.follower}. Arm off, or bus down?"); return 1
    t0 = time.time()
    while time.time() - t0 < 0.6: arm.drain(); time.sleep(0.002)

    if a.home and not a.dry_run:
        hp = np.array([math.radians(float(x)) for x in a.home.split(",")])
        if len(hp) != N: print(f"  --home needs {N} values"); return 1
        hp = np.clip(hp, a1x_chain.lower, a1x_chain.upper)
        cur = np.array(arm.q[:N])
        dist = np.max(np.abs(hp - cur))
        secs = float(dist / math.radians(a.home_rate)) + 0.5
        print(f"  HOMING to {np.round(np.degrees(hp),1)} over {secs:.1f}s "
              f"at {a.home_rate:g} deg/s -- KEEP CLEAR")
        time.sleep(2.0)
        t0 = time.time()
        while time.time() - t0 < secs and not _stop["flag"]:
            f = min(1.0, (time.time() - t0) / secs)
            arm.send_arm(list(cur + f * (hp - cur)), a.kp, a.kd)
            arm.drain(); time.sleep(1.0 / a.rate)
        arm.drain()
        print(f"  homed: {np.round(np.degrees(arm.q[:N]),1)}")

    if not a.dry_run:
        if not arm.ensure_listening(a.kp, a.kd):
            return 1
        if a.grip and not arm.ensure_gripper(a.kp, a.grip_kp, a.kd):
            return 1

    s0 = lead.read()
    print(f"  SO-101 raw read: { {k: round(v,1) for k,v in s0.items()} }")
    if not any(k.endswith(".pos") for k in s0):
        print("  FAIL: unexpected key format from the SO-101 bus"); return 1
    q_so0 = np.array([norm_to_rad(so_chain, n, s0.get(f"{n}.pos", 0.0)) for n in SO_ARM])
    q_a0 = np.array(arm.q[:N])
    print(f"  SO-101 start (deg): {np.round(np.degrees(q_so0),1)}")
    print(f"  A1X    start (deg): {np.round(np.degrees(q_a0),1)}")
    T_so0 = so_chain.fk(q_so0); T_a0 = a1x_chain.fk(q_a0)
    print(f"  SO-101 tip {np.round(T_so0[:3,3],3)}   A1X tip {np.round(T_a0[:3,3],3)}")
    print("  A1X headroom from this start pose (relative mapping needs BOTH):")
    tight = []
    for j in range(N):
        rm = math.degrees(q_a0[j] - a1x_chain.lower[j])
        rp = math.degrees(a1x_chain.upper[j] - q_a0[j])
        mark = ""
        if j == 4:
            mark = "  (held: no SO-101 counterpart)"
        elif min(rm, rp) < 20.0:
            mark = "  <-- TIGHT"; tight.append(j + 1)
        print(f"    J{j+1}: -{rm:6.1f} deg / +{rp:6.1f} deg{mark}")
    if tight:
        print(f"  WARNING J{tight} start near a limit -- that direction will clamp.")
        print(f"           Use --home to start mid-range, e.g. --home \"0,60,-90,0,0,0\"")
    if a.mode == "ik":
        print(f"  workspace scale {a.scale:.3f}, orientation weight {a.w_rot:g}")

    target = q_a0.copy(); seed = q_a0.copy(); q_filt = None; g_filt = None
    goal = q_a0.copy()          # latest retargeted pose, updated at solve rate
    last_can = time.time()      # target is interpolated toward goal at CAN rate
    grip_t = a.grip_open; grip_frozen = False
    slew = math.radians(a.follow_rate)
    print(f"\n  streaming {a.secs:g}s -- MOVE THE SO-101 BY HAND.  Ctrl-C stops.\n")
    print(f"  {'t':>5}  {'A1X target (deg)':<38} {'tip err':>8} {'grip':>6}")
    signal.signal(signal.SIGINT, lambda *_: _stop.__setitem__("flag", True))

    t0 = time.time(); nxt = t0; nxt_solve = t0; prev = t0; last_rep = 0.0
    tip_err = float("nan"); reason = "completed"; n_tx = 0
    while time.time() - t0 < a.secs and not _stop["flag"]:
        arm.drain(); now = time.time()
        if now - arm.t > 0.15:
            reason = f"ABORT: stale A1X feedback ({(now-arm.t)*1e3:.0f} ms)"; break
        dt = max(1e-4, now - prev); prev = now

        if now >= nxt_solve:
            nxt_solve = now + 1.0 / a.solve_rate
            try: s = lead.read()
            except Exception as ex:
                reason = f"ABORT: SO-101 read failed: {ex}"; break
            q_raw = np.array([norm_to_rad(so_chain, n, s.get(f"{n}.pos", 0.0))
                              for n in SO_ARM])
            for i, n in enumerate(SO_ARM):
                if n in lead.missing: q_raw[i] = q_so0[i]
            if q_filt is None:
                q_filt = q_raw.copy()
            else:
                q_filt += a.smooth * (q_raw - q_filt)
            q_so = q_filt

            if a.mode == "joint":
                goal[:] = q_a0
                for i, n in enumerate(SO_ARM):
                    j = JOINT_MAP[n]
                    goal[j] = q_a0[j] + signs[i] * a.gain * (q_so[i] - q_so0[i])
            else:
                T_so = so_chain.fk(q_so)
                T_des = T_a0.copy()
                T_des[:3, 3] = T_a0[:3, 3] + a.scale * (T_so[:3, 3] - T_so0[:3, 3])
                T_des[:3, :3] = T_so[:3, :3] @ T_so0[:3, :3].T @ T_a0[:3, :3]
                seed, T_got = solve_ik(a1x_chain, T_des, seed, iters=40,
                                       w_rot=a.w_rot, q_bias=q_a0, k_bias=0.01)
                goal[:] = seed
                tip_err = float(np.linalg.norm(T_got[:3, 3] - T_des[:3, 3]))

            goal[:] = np.clip(goal, a1x_chain.lower, a1x_chain.upper)
            if a.grip and "gripper" in lead.present:
                g_raw = np.clip(s.get("gripper.pos", 0.0), 0.0, 100.0) / 100.0
                g_filt = g_raw if g_filt is None else g_filt + a.smooth*(g_raw-g_filt)
                g = g_filt
                want = a.grip_open + (1.0 - g) * (a.grip_closed - a.grip_open)
                eff = abs(arm.e[6]) if arm.e else 0.0
                closing = want > grip_t
                if closing and eff > a.grip_force:
                    grip_frozen = True                 # contact: hold, don't crush
                elif not closing:
                    grip_frozen = False
                if not grip_frozen:
                    grip_t = want
        if now >= nxt:
            nxt = now + 1.0 / a.rate
            # Interpolate toward the goal HERE, at the CAN rate, using real
            # elapsed time. Stepping the target only on solve ticks made the
            # arm see the same setpoint 4x then a jump of up to slew/solve_rate
            # -- a 20 ms staircase that a stiff position loop turns into
            # visible jitter.
            dt_can = min(0.05, now - last_can); last_can = now
            step = slew * dt_can
            target += np.clip(goal - target, -step, step)
            if not a.dry_run:
                arm.send_arm(list(target), a.kp, a.kd)
                if a.grip: arm.send_grip(grip_t, a.grip_kp, 1.0)
            n_tx += 1

        if now - last_rep > 0.5:
            last_rep = now
            ge = f"{grip_t:+.2f}" if a.grip else "  -"
            te = f"{tip_err*1000:7.1f}" if a.mode == "ik" else "      -"
            print(f"  {now-t0:5.1f}  {str(np.round(np.degrees(target),1)):<38} {te} {ge:>6}")
        time.sleep(0.0005)

    print(f"\n  {reason}   tx={n_tx}  A1X rx={arm.n}")
    arm.drain()
    print(f"  A1X final (deg): {np.round(np.degrees(arm.q[:N]),1)}")
    lead.close()
    print("  stopped -- the A1X re-latches where it is")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
