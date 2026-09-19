#!/usr/bin/env python3
"""Arm-to-arm teleoperation over raw CAN-FD. No ARM_APP, no ROS.

Built on what was MEASURED on 2026-08-23 (see diag/REPORT.md):

  * raw 0x050 frames drive an arm at 102%, no 0x023 heartbeat, no timeout
  * streaming p_des = q_measured makes an arm hand-movable AND keeps 0x052
    flowing -- the compliant+reporting state release can never give
  * an uncommanded arm is rigid; it holds position and does not drift
  * the RX socket MUST be drained every cycle or readings go seconds stale

ROLES  (verified by the user this session -- these are the PHYSICAL arms):

    can0 = LEADER    moved by hand, floated with p_des = q
    can1 = FOLLOWER  mirrors the leader

Note this is the OPPOSITE of teleop_1.sh / PROMPT.md, which were written when
USB enumeration happened to be the other way round. Pass --leader/--follower to
override if the cables move.

SAFETY
    * Gravity is NOT compensated. Floating J2/J3 gives zero holding torque, so
      they sag. Each joint is leashed to +/-LEASH deg of its start pose: inside
      the leash it floats, at the edge the setpoint clamps and the joint goes
      stiff, catching the sag. HOLD THE LEADER.
    * Aborts on: joint velocity over VMAX, feedback older than 100 ms on either
      bus, or follower divergence over DIVERGE deg.
    * Ctrl-C stops streaming. An uncommanded arm re-latches where it is, so
      stopping is safe -- it does not fall and does not snap to an old pose.
    * Exactly ONE writer per bus: refuses to start if ARM_APP or a driver node
      is running.
"""
import argparse, math, os, signal, socket, struct, subprocess, sys, time

N = 6
S_POS, S_VEL, S_EFF = 4700.0, 750.0, 600.0
FIELDS = ((-6.5,6.5,4700.0), (-40.0,40.0,750.0), (0.0,500.0,60.0),
          (0.0,200.0,150.0), (-50.0,50.0,600.0))
LIMITS = [(-2.880,2.880), (0.0,3.142), (-3.316,0.0),
          (-1.571,1.571), (-1.571,1.571), (-2.880,2.880)]
CMD_ID, FB_ID = 0x050, 0x052
_stop = {"flag": False}


def encode(p, v, kp, kd, tff):
    out = bytearray(60)
    for j in range(N):
        for k, vals in enumerate((p, v, kp, kd, tff)):
            lo, hi, sc = FIELDS[k]
            x = lo if vals[j] < lo else (hi if vals[j] > hi else vals[j])
            raw = max(-32768, min(32767, int(x * sc)))
            off = j*10 + k*2
            out[off]   = (raw >> 8) & 0xFF
            out[off+1] = raw & 0xFF
    return bytes(out)


class Bus:
    def __init__(self, iface):
        self.iface = iface
        self.s = socket.socket(socket.AF_CAN, socket.SOCK_RAW, socket.CAN_RAW)
        self.s.setsockopt(socket.SOL_CAN_RAW, socket.CAN_RAW_FD_FRAMES, 1)
        self.s.bind((iface,))
        self.s.settimeout(0.0)
        self.q = None; self.v = None; self.e = None
        self.t = 0.0; self.n = 0

    def drain(self):
        """Read EVERY queued frame. Skipping this makes readings seconds stale."""
        got = False
        while True:
            try:
                b = self.s.recv(72)
            except (BlockingIOError, socket.timeout):
                break
            if (struct.unpack("=I", b[:4])[0] & 0x1FFFFFFF) != FB_ID:
                continue
            r = struct.unpack(">21h", b[8:8+42])
            self.q = [r[g*3]   / S_POS for g in range(7)]
            self.v = [r[g*3+1] / S_VEL for g in range(7)]
            self.e = [r[g*3+2] / S_EFF for g in range(7)]
            self.t = time.time(); self.n += 1; got = True
        return got

    def wait(self, secs=3.0):
        end = time.time() + secs
        while time.time() < end and not _stop["flag"]:
            if self.drain() and self.q is not None:
                return True
            time.sleep(0.002)
        return False

    def enable(self, kp, kd):
        """Vendor enable sequence 1 -> 5 -> 6, with the setpoint pinned first.

        MEASURED: code 1 alone leaves the arm holding and reporting but DEAF to
        0x050. Code 5 (clear DISCONNECT) restores command acceptance; 6 brings
        tracking to 100%.

        SAFETY -- enabling with no setpoint streaming caused a 76 deg swing at
        SATURATED torque (effort 50.0, the top of the scale) because the arm
        drove to a STALE internal target. So we stream p_des = q THROUGHOUT the
        sequence: the arm is told where it already is before, during and after
        each code, and has no stale target to chase.
        """
        for code in (1, 5, 6):
            t0 = time.time()
            while time.time() - t0 < 0.3:
                self.drain()
                if self.q is not None:
                    self.send(self.q[:N], kp, kd)      # "stay exactly here"
                time.sleep(0.005)
            self.s.send(struct.pack("=IBBBB", 0x053, 1, 0, 0, 0)
                        + bytes([code]).ljust(8, b"\x00"))
        t0 = time.time()
        while time.time() - t0 < 0.3:
            self.drain()
            if self.q is not None:
                self.send(self.q[:N], kp, kd)
            time.sleep(0.005)

    def send(self, p, kp, kd):
        payload = encode(p, [0.0]*N, [kp]*N, [kd]*N, [0.0]*N)
        self.s.send(struct.pack("=IBBBB", CMD_ID, 60, 0x01, 0, 0)
                    + payload.ljust(64, b"\x00"))


def deg(v):
    return [round(math.degrees(x), 1) for x in v[:N]]


def conflicting_writers():
    try:
        out = subprocess.run(["ps", "-eo", "cmd"], capture_output=True,
                             text=True, timeout=5).stdout
    except Exception:
        return []
    bad = []
    for line in out.splitlines():
        if "teleop2" in line or "grep" in line:
            continue                     # never match ourselves
        if "HDAS/ARM_APP" in line or "galaxea_a1xy_driver" in line:
            bad.append(line.strip()[:70])
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--leader", default="can0")
    ap.add_argument("--follower", default="can1")
    ap.add_argument("--secs", type=float, default=60.0)
    ap.add_argument("--kp", type=float, default=20.0)
    ap.add_argument("--kd", type=float, default=1.0)
    ap.add_argument("--leash", type=float, default=60.0, help="deg, leader float bound")
    ap.add_argument("--vmax", type=float, default=200.0, help="deg/s abort")
    ap.add_argument("--diverge", type=float, default=25.0, help="deg abort")
    ap.add_argument("--rate", type=float, default=200.0)
    ap.add_argument("--follow-rate", type=float, default=90.0, help="deg/s follower slew")
    ap.add_argument("--enable", action="store_true",
                    help="send function frames 1->5->6 first. Only needed to "
                         "recover an arm from a release (FF 2). A freshly "
                         "power-cycled arm obeys 0x050 immediately, and FF 5 "
                         "briefly DISENGAGES the motors -- so this is off by default.")
    ap.add_argument("--gravity-adapt", action="store_true",
                    help="learn each joint's holding torque from its own sag")
    ap.add_argument("--adapt-gain", type=float, default=0.5)
    ap.add_argument("--adapt-vmax", type=float, default=15.0,
                    help="deg/s; only adapt below this, so hand motion is not learned")
    ap.add_argument("--bias-max", type=float, default=8.0, help="deg, bias clamp")
    ap.add_argument("--assist", type=float, default=0.0,
                    help="admittance gain, deg/s per unit of excess effort. "
                         "For NON-BACKDRIVABLE joints (J2/J3): sense the force "
                         "you apply and drive the setpoint that way, so the "
                         "motor moves the joint for you. 0 = off.")
    ap.add_argument("--assist-sign", type=float, default=-1.0,
                    help="flip to +1 if a joint runs AWAY from your push")
    ap.add_argument("--assist-deadband", type=float, default=2.0,
                    help="effort units above baseline before assist engages")
    ap.add_argument("--assist-rate", type=float, default=12.0,
                    help="deg/s cap on assisted motion")
    ap.add_argument("--adapt-deadband", type=float, default=1.0,
                    help="deg/s; ignore velocity below this so a sensor offset "
                         "cannot integrate into runaway bias")
    ap.add_argument("--check", action="store_true", help="validate, transmit nothing")
    a = ap.parse_args()

    leash = math.radians(a.leash); vmax = math.radians(a.vmax)
    diverge = math.radians(a.diverge); slew = math.radians(a.follow_rate)

    print("=" * 72)
    print(f"  TELEOP   leader={a.leader}  follower={a.follower}"
          f"{'   [CHECK -- transmits nothing]' if a.check else ''}")
    print("=" * 72)

    bad = conflicting_writers()
    if bad:
        print("  REFUSING TO START -- another writer is on the bus:")
        for b in bad: print(f"      {b}")
        print("  Stop it first (one writer per bus, SocketCAN does not arbitrate).")
        return 1
    print("  no ARM_APP / driver_node running -- we own both buses")

    lead = Bus(a.leader); foll = Bus(a.follower)
    for tag, bus in (("leader", lead), ("follower", foll)):
        if not bus.wait(3.0):
            print(f"  FAIL: no 0x052 on {bus.iface} ({tag}). Bus down, or arm off?")
            return 1
    t0 = time.time()
    while time.time() - t0 < 1.0:
        lead.drain(); foll.drain(); time.sleep(0.002)
    print(f"  leader   {lead.iface}: {lead.n} frames  pose {deg(lead.q)}")
    print(f"  follower {foll.iface}: {foll.n} frames  pose {deg(foll.q)}")

    if not a.check and a.enable:
        print("  enabling both arms (1 -> 5 -> 6)  [motors briefly disengage]")
        lead.enable(a.kp, a.kd); foll.enable(a.kp, a.kd)
        t0 = time.time()
        while time.time() - t0 < 0.5:
            lead.drain(); foll.drain(); time.sleep(0.002)

    lead0 = list(lead.q[:N]); foll0 = list(foll.q[:N])
    p_lead = list(lead0); p_foll = list(foll0)
    # Gravity bias. t_ff is inert on this hardware, but the servo demonstrably
    # honours POSITION error -- so a standing offset of q+bias produces a
    # standing torque of kp*bias. We do not model gravity; we learn it: a joint
    # that is sagging is drifting, and drift integrates into bias until it
    # stops. Only adapts below --adapt-vmax so deliberate hand motion, which is
    # faster, is never learned as gravity.
    bias = [0.0] * N
    adapt_v = math.radians(a.adapt_vmax); bias_max = math.radians(a.bias_max)
    dead_v = math.radians(a.adapt_deadband)
    assist_off = [0.0] * N
    base_e = [0.0] * N
    if a.assist > 0.0:
        acc = [[] for _ in range(N)]
        t0 = time.time()
        while time.time() - t0 < 1.0:
            if lead.drain():
                for j in range(N): acc[j].append(lead.e[j])
            time.sleep(0.002)
        base_e = [sum(c)/len(c) if c else 0.0 for c in acc]
        print(f"  assist ON gain={a.assist:g} deg/s per unit, "
              f"baseline effort {[round(x,2) for x in base_e]}")

    if a.check:
        print("\n  CHECK PASSED -- both arms reporting, no bus conflict.")
        print("  Re-run without --check to teleoperate.")
        return 0

    print(f"\n  kp={a.kp} kd={a.kd}  leash=+/-{a.leash:g} deg  "
          f"abort: v>{a.vmax:g} deg/s, divergence>{a.diverge:g} deg")
    print(f"  streaming for {a.secs:g}s at {a.rate:g} Hz -- Ctrl-C stops cleanly")
    print("\n  >>> MOVE THE LEADER BY HAND.  The follower mirrors it. <<<\n")
    print(f"  {'t':>5} {'leader J1..J6 (deg)':<34} {'divergence':>10} {'leashed':>8}")

    lo_l = list(lead0); hi_l = list(lead0)
    lo_f = list(foll0); hi_f = list(foll0)
    e_l = [0.0]*N; e_f = [0.0]*N

    signal.signal(signal.SIGINT, lambda *_: _stop.__setitem__("flag", True))
    t0 = time.time(); nxt = t0; last_report = 0.0
    n_tx = 0; reason = "completed"
    prev = time.time()
    while time.time() - t0 < a.secs and not _stop["flag"]:
        lead.drain(); foll.drain()
        now = time.time()
        if now - lead.t > 0.1 or now - foll.t > 0.1:
            reason = (f"ABORT: stale feedback -- leader {(now-lead.t)*1e3:.0f} ms, "
                      f"follower {(now-foll.t)*1e3:.0f} ms")
            break
        if max(abs(x) for x in lead.v[:N]) > vmax:
            reason = f"ABORT: leader velocity {math.degrees(max(abs(x) for x in lead.v[:N])):.0f} deg/s"
            break

        for j in range(N):
            lo_l[j] = min(lo_l[j], lead.q[j]); hi_l[j] = max(hi_l[j], lead.q[j])
            lo_f[j] = min(lo_f[j], foll.q[j]); hi_f[j] = max(hi_f[j], foll.q[j])
            e_l[j] = max(e_l[j], abs(lead.e[j])); e_f[j] = max(e_f[j], abs(foll.e[j]))

        dt = max(1e-4, now - prev); prev = now
        step = slew * dt
        leashed = []
        for j in range(N):
            # LEADER: setpoint chases the joint -> compliant. Clamped to the
            # leash so an ungravity-compensated joint cannot walk itself down.
            if a.gravity_adapt and dead_v < abs(lead.v[j]) < adapt_v:
                bias[j] -= a.adapt_gain * lead.v[j] * dt
                bias[j] = max(-bias_max, min(bias_max, bias[j]))
            if a.assist > 0.0:
                excess = lead.e[j] - base_e[j]
                if abs(excess) > a.assist_deadband:
                    rate = a.assist_sign * a.assist * (excess - math.copysign(
                        a.assist_deadband, excess))
                    cap = math.radians(a.assist_rate)
                    rate = max(-cap, min(cap, math.radians(rate)))
                    assist_off[j] += rate * dt
                else:
                    assist_off[j] *= max(0.0, 1.0 - 3.0 * dt)   # relax when released
            want = lead.q[j] + bias[j] + assist_off[j]
            tgt = max(lead0[j] - leash, min(lead0[j] + leash, want))
            if tgt != want:                       # genuinely clamped, not just biased
                leashed.append(j + 1)
            p_lead[j] = tgt
            # FOLLOWER: mirror the leader's displacement, slew-limited.
            goal = foll0[j] + (lead.q[j] - lead0[j])
            lo, hi = LIMITS[j]
            goal = max(lo, min(hi, goal))
            d = goal - p_foll[j]
            p_foll[j] += math.copysign(step, d) if abs(d) > step else d

        div = max(abs(foll.q[j] - (foll0[j] + (lead.q[j] - lead0[j]))) for j in range(N))
        if div > diverge:
            reason = f"ABORT: follower diverged {math.degrees(div):.1f} deg"
            break

        if now >= nxt:
            nxt = now + 1.0 / a.rate
            lead.send(p_lead, a.kp, a.kd)
            foll.send(p_foll, a.kp, a.kd)
            n_tx += 1

        if now - last_report > 0.5:
            last_report = now
            print(f"  {now-t0:5.1f} {str(deg(lead.q)):<34} "
                  f"{math.degrees(div):9.1f}  {str(leashed) if leashed else '-':>8}"
                  + (f"  bias {[round(math.degrees(b),1) for b in bias]}"
                     if a.gravity_adapt else ""))
        time.sleep(0.0005)

    print(f"\n  {reason}")
    print(f"  tx={n_tx}  leader rx={lead.n}  follower rx={foll.n}")
    lead.drain(); foll.drain()
    print(f"  final leader   {deg(lead.q)}")
    print(f"  final follower {deg(foll.q)}")
    print()
    print("  PER-JOINT SUMMARY -- how far each joint travelled, and whether it mirrored")
    print(f"  {'joint':>6} {'leader moved':>13} {'follower moved':>15} {'tracked':>9} "
          f"{'lead eff':>9} {'foll eff':>9}  verdict")
    for j in range(N):
        ml = math.degrees(hi_l[j] - lo_l[j])
        mf = math.degrees(hi_f[j] - lo_f[j])
        ratio = (mf / ml * 100.0) if ml > 0.5 else float('nan')
        if ml <= 0.5:
            v = "leader joint never moved (stiff, or you did not try it)"
        elif ratio < 25:
            v = "LEADER MOVED, FOLLOWER DID NOT -- command path issue"
        elif ratio < 75:
            v = "follower partially tracked"
        else:
            v = "tracked"
        rs = "  n/a" if ml <= 0.5 else f"{ratio:6.0f}%"
        print(f"  {'J'+str(j+1):>6} {ml:12.2f}d {mf:14.2f}d {rs:>9} "
              f"{e_l[j]:9.2f} {e_f[j]:9.2f}  {v}")
    print("  stream stopped -- both arms re-latch where they are (they will not fall)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
