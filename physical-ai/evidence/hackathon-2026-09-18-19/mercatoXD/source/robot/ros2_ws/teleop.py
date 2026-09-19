#!/usr/bin/env python3
"""Arm-to-arm teleoperation for two Galaxea A1X arms.

  leader  (can1) -> read by galaxea_a1xy_driver, namespaced /leader
  follower(can0) -> driven by the vendor HDAS on /motion_control/control_arm

Replaces the vendor's TELEOP_MODE_1, which is absent from the x86 v2.0.4 build.

Safety design
-------------
* RELATIVE (delta) mapping: the follower mirrors the leader's MOTION, not its
  absolute angles --  p_des = follower_start + (leader_now - leader_start).
  Any constant offset between the two arms (different zero calibration, or
  simply starting in different poses) is therefore irrelevant, and there is no
  initial jump: at t=0 the commanded pose IS the follower's current pose.
* RATE LIMIT: each joint's target may move at most MAX_RATE rad/s.
* LIMIT CLAMP: every target is clamped to the A1X URDF joint limits.
* Gentle gains, and an unconditional release (kp=kd=0) on exit.
"""
import math
import os
import select
import signal
import sys
import termios
import time
import tty

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, HistoryPolicy
from sensor_msgs.msg import JointState
from std_msgs.msg import Float32
from hdas_msg.msg import MotorControl
from hdas_msg.srv import FunctionFrame

# A1X URDF limits (rad)
LIMITS = [(-2.880, 2.880), (0.0, 3.142), (-3.316, 0.0),
          (-1.571, 1.571), (-1.571, 1.571), (-2.880, 2.880)]
N = 6
RATE = 100.0
# Two 200 Hz feedback streams deliver ~400 msg/s, but spin_once() handles ONE
# callback per call. Queuing them makes the newest PROCESSED sample fall further
# and further behind real time, which reads as staleness. Depth-1 best-effort
# drops stale samples instead of queuing them, and we drain each cycle.
SENSOR_QOS = QoSProfile(depth=1,
                        reliability=ReliabilityPolicy.BEST_EFFORT,
                        history=HistoryPolicy.KEEP_LAST)
# Feedback staleness limits. Both arms publish at 200 Hz; if either stream stops
# we must NOT keep commanding from the last cached sample. A frozen leader means
# the follower holds a stale target indefinitely; a frozen follower blinds the
# divergence check entirely. Either is a silent failure, so both abort.
# The two streams are NOT equivalent, so they get different limits:
#   leader   = the control INPUT. Stale leader data means we would keep
#              commanding the follower from a stale target -> abort.
#   follower = used only for divergence reporting and the start pose. A brief
#              gap is cosmetic, so warn but keep running.
MAX_STALE_LEADER = 0.25       # s -> hold the target (ignore stale sample)
ABORT_STALE_LEADER = 5.0      # s -> give up entirely
MAX_STALE_FOLLOWER = 1.0      # s -> abort (much more tolerant)
WARN_STALE_FOLLOWER = 0.25    # s -> warn once
MIN_RATE_HZ = 50.0            # sustained leader rate below this -> abort
FRESH_S = 0.05                # a sample older than this is not "fresh"
# Energising the motors knocks the vendor publisher over for a few hundred ms,
# and the payloads it resumes with can read exactly 0.0 on individual joints.
# A fixed sleep cannot tell that apart from real data, so we wait for an
# unbroken run of fresh samples and then check the pose did not jump.
SETTLE_S = 0.4                # s of CONTINUOUS fresh feedback before trusting it
SETTLE_TIMEOUT = 5.0          # s to wait for the stream to come back
POSE_TOL = 0.15               # rad; a bigger shift across the enable is junk
BLEND_S = 4.0
MAX_RATE = math.radians(float(sys.argv[2]) if len(sys.argv) > 2 else 90.0)  # deg/s per joint
KP, KD = 25.0, 3.0
DEADBAND = math.radians(0.15)

# --- gripper ---------------------------------------------------------------
# The gripper is NOT backdrivable, so the leader's gripper cannot be a teleop
# input -- it cannot be moved by hand, so there is nothing to read. It is driven
# from the keyboard instead (or /teleop/gripper_cmd when there is no TTY).
#   o = open      c = close      space = toggle      q = quit
#
# Closing is FORCE-LIMITED: the target stops advancing on contact and then holds,
# so grasp force is bounded by CONTACT_EFFORT instead of by how far past the
# object the commanded position happens to sit. A plain position command with a
# stiff gain crushes whatever is between the jaws.
GRIP_OPEN_PDES = -3.0     # negative opens
GRIP_CLOSE_PDES = 0.5     # positive closes
GRIP_RATE = 0.5           # rad/s of commanded travel
GRIP_KP, GRIP_KD = 25.0, 1.0
GRIP_HOLD_KP = 12.0       # gentle stiffness once holding an object
CONTACT_EFFORT = 1.2      # |effort| indicating contact
CONTACT_GRACE = 1.0       # s before contact detection arms after a move starts
CONTACT_SAMPLES = 8       # consecutive samples over threshold
POS_CLOSED, POS_PER_RAD = 3.0, 33.06


def pos_to_pdes(pos):
    return -max(0.0, (pos - POS_CLOSED) / POS_PER_RAD)


class Keyboard:
    """Non-blocking single-key reader; a no-op when stdin is not a TTY."""

    def __init__(self):
        self.ok = sys.stdin.isatty()
        self.saved = None
        if self.ok:
            self.fd = sys.stdin.fileno()
            self.saved = termios.tcgetattr(self.fd)
            tty.setcbreak(self.fd)

    def get(self):
        if not self.ok:
            return None
        if select.select([sys.stdin], [], [], 0)[0]:
            return sys.stdin.read(1)
        return None

    def restore(self):
        if self.ok and self.saved is not None:
            termios.tcsetattr(self.fd, termios.TCSADRAIN, self.saved)


class Gripper:
    """Force-limited gripper state machine, driven one step per control cycle."""

    def __init__(self):
        self.pos = None
        self.eff = 0.0
        self.target = None        # commanded p_des
        self.goal = None          # where we are ramping to
        self.kp = 0.0
        self.holding = False
        self.t_move = 0.0
        self.over = 0

    def feedback(self, pos, eff):
        self.pos, self.eff = pos, eff
        if self.target is None and pos is not None:
            self.target = pos_to_pdes(pos)

    def command(self, goal):
        """Begin moving toward `goal` (a p_des)."""
        if self.pos is None:
            return
        self.goal = goal
        self.target = pos_to_pdes(self.pos)
        self.kp = GRIP_KP
        self.holding = False
        self.t_move = time.time()
        self.over = 0

    def step(self, dt):
        """Advance one cycle; returns (p_des, kp, kd) to send, or None."""
        if self.target is None or self.goal is None:
            return None
        if self.holding:
            return self.target, GRIP_HOLD_KP, GRIP_KD

        closing = self.goal > self.target
        if closing and (time.time() - self.t_move) > CONTACT_GRACE:
            if abs(self.eff) > CONTACT_EFFORT:
                self.over += 1
                if self.over >= CONTACT_SAMPLES:
                    self.holding = True
                    self.target = pos_to_pdes(self.pos)
                    return self.target, GRIP_HOLD_KP, GRIP_KD
            else:
                self.over = 0

        step = GRIP_RATE * dt
        d = self.goal - self.target
        self.target += max(-step, min(step, d))
        return self.target, self.kp, GRIP_KD


class Teleop(Node):
    def __init__(self, duration):
        super().__init__("a1x_teleop")
        self.duration = duration
        self.leader = None
        self.follower = None
        self.t_leader = 0.0
        self.t_follower = 0.0
        self.n_leader = 0
        self.n_follower = 0
        self.target = None
        self.create_subscription(JointState, "/leader/hdas/feedback_arm",
                                 self._leader_cb, SENSOR_QOS)
        self.create_subscription(JointState, "/hdas/feedback_arm",
                                 self._follower_cb, SENSOR_QOS)
        self.pub = self.create_publisher(MotorControl, "/motion_control/control_arm", 10)
        self.gpub = self.create_publisher(MotorControl, "/motion_control/control_gripper", 10)
        # fallback input when there is no TTY: ros2 topic pub /teleop/gripper_cmd
        self.create_subscription(Float32, "/teleop/gripper_cmd",
                                 self._grip_cmd_cb, 10)
        self.gripper = Gripper()
        self.create_subscription(JointState, "/hdas/feedback_gripper",
                                 self._grip_fb_cb, SENSOR_QOS)
        self.cli = self.create_client(FunctionFrame, "/function_frame_arm")
        self.cli.wait_for_service(timeout_sec=5.0)
        self.released = False
        self.stop = False

    def _grip_fb_cb(self, m):
        self.gripper.feedback(m.position[0] if m.position else None,
                              m.effort[0] if m.effort else 0.0)

    def _grip_cmd_cb(self, m):
        """<=0 closes, >0 opens."""
        self.gripper.command(GRIP_CLOSE_PDES if float(m.data) <= 0.0 else GRIP_OPEN_PDES)

    def send_gripper(self, dt):
        out = self.gripper.step(dt)
        if out is None:
            return
        p, kp, kd = out
        m = MotorControl()
        m.header.stamp = self.get_clock().now().to_msg()
        m.name = "gripper"
        m.p_des = [float(p)]; m.v_des = [0.0]
        m.kp = [float(kp)]; m.kd = [float(kd)]; m.t_ff = [0.0]; m.mode = 0
        self.gpub.publish(m)

    def _leader_cb(self, m):
        self.leader = list(m.position[:N])
        self.t_leader = time.time()
        self.n_leader += 1

    def _follower_cb(self, m):
        self.follower = list(m.position[:N])
        self.t_follower = time.time()
        self.n_follower += 1

    def enable(self, code):
        req = FunctionFrame.Request(); req.command = code
        f = self.cli.call_async(req)
        rclpy.spin_until_future_complete(self, f, timeout_sec=6.0)
        r = f.result()
        print(f"  FunctionFrame({code}) -> {r.success if r else 'timeout'}")

    def idle(self, secs):
        """Sleep while still servicing callbacks. time.sleep() starves them,
        which lets the feedback timestamps go stale before the loop starts and
        false-trips the staleness watchdog."""
        end = time.time() + secs
        while time.time() < end:
            rclpy.spin_once(self, timeout_sec=0.01)

    def drain(self):
        """Process all pending callbacks so we always act on the newest sample."""
        for _ in range(12):
            rclpy.spin_once(self, timeout_sec=0.0)

    def refresh(self, timeout=2.0):
        """Spin until both feedback streams are demonstrably fresh."""
        end = time.time() + timeout
        while time.time() < end:
            rclpy.spin_once(self, timeout_sec=0.01)
            now = time.time()
            if (now - self.t_leader) < 0.05 and (now - self.t_follower) < 0.05:
                return True
        return False

    def wait_settled(self, settle=SETTLE_S, timeout=SETTLE_TIMEOUT):
        """Wait for an unbroken run of `settle` seconds of fresh feedback.

        Not the same as refresh(): this requires the stream to stay fresh for a
        continuous stretch, so a publisher that is stuttering back to life after
        an enable cannot pass by delivering one lucky sample."""
        deadline = time.time() + timeout
        stable_since = None
        while time.time() < deadline and not self.stop:
            rclpy.spin_once(self, timeout_sec=0.01)
            now = time.time()
            fresh = ((now - self.t_leader) < FRESH_S
                     and (now - self.t_follower) < FRESH_S)
            if not fresh:
                stable_since = None
            elif stable_since is None:
                stable_since = now
            elif now - stable_since >= settle:
                return True
        return False

    def engage(self):
        """Energise the follower and capture a trustworthy start reference.

        `start` is what the gain ramp drives toward, so a corrupted sample here
        walks the arm to a pose it was never in. Fixed sleeps around the enable
        are not a check: the vendor publisher drops out while the motors
        energise and the payload it resumes with can read 0.0 on individual
        joints. So wait for the stream to be continuously fresh, then confirm
        the pose did not jump across the enable. Returns the reference pose, or
        None if anything about it is untrustworthy."""
        if not self.wait_ready():
            print(f"  ERROR: leader={self.leader is not None} "
                  f"follower={self.follower is not None}")
            return None
        if not self.wait_settled():
            print(f"  ABORT: feedback not continuously fresh before enabling "
                  f"(need {SETTLE_S:.1f}s unbroken)")
            return None
        pre = list(self.follower)

        print("enabling follower motors:")
        self.enable(1)
        self.enable(6)

        if not self.wait_settled():
            print(f"  ABORT: follower feedback did not resume within "
                  f"{SETTLE_TIMEOUT:.1f}s of energising")
            self.release()
            return None
        post = list(self.follower)
        shift = max(abs(a - b) for a, b in zip(post, pre))
        if shift > POSE_TOL:
            bad = max(range(N), key=lambda j: abs(post[j] - pre[j]))
            print(f"  ABORT: pose shifted {math.degrees(shift):.1f} deg (J{bad+1}) "
                  f"across the enable: {math.degrees(pre[bad]):+.1f} -> "
                  f"{math.degrees(post[bad]):+.1f} deg. One of the two readings "
                  f"is junk, so the reference is unreliable")
            self.release()
            return None
        return post

    def send(self, tgt, kp, kd):
        m = MotorControl()
        m.header.stamp = self.get_clock().now().to_msg()
        m.name = "arm"
        m.p_des = [float(x) for x in tgt]
        m.v_des = [0.0] * N
        m.kp = [float(kp)] * N
        m.kd = [float(kd)] * N
        m.t_ff = [0.0] * N
        m.mode = 0
        self.pub.publish(m)

    def release(self):
        if self.released:
            return
        self.released = True
        base = self.follower or [0.0] * N
        for _ in range(25):
            self.send(base, 0.0, 0.0)
            rclpy.spin_once(self, timeout_sec=0.005)
        print("  released (kp=kd=0)")

    def wait_ready(self, t=10.0):
        end = time.time() + t
        while (time.time() < end and not self.stop
               and (self.leader is None or self.follower is None)):
            rclpy.spin_once(self, timeout_sec=0.05)
        return self.leader is not None and self.follower is not None

    def run(self, start):
        """Track the leader. `start` is the reference pose verified by engage()."""
        self.drain()
        lead0 = list(self.leader)          # leader reference pose
        self.target = list(start)
        self.sat = [0] * N
        print(f"  follower start (deg): {[round(math.degrees(x),1) for x in start]}")
        print(f"  leader   ref   (deg): {[round(math.degrees(x),1) for x in lead0]}")
        print(f"  RELATIVE mapping: follower mirrors leader MOTION (no initial jump)")
        print(f"  tracking for {self.duration:.0f}s  |  move the leader by hand")

        if not self.refresh():
            print("  ABORT: feedback not fresh at start "
                  f"(leader {(time.time()-self.t_leader)*1000:.0f} ms, "
                  f"follower {(time.time()-self.t_follower)*1000:.0f} ms)")
            self.release()
            return
        self.n_leader = self.n_follower = 0      # count only from loop start
        self._warned_follower = False
        self._holding = False
        t0 = time.time()
        period = 1.0 / RATE
        last = t0
        next_tick = t0
        last_print = -99.0
        kb = Keyboard()
        if kb.ok:
            print("  gripper keys:  o = open   c = close   space = toggle   q = quit")
        else:
            print("  no TTY -> gripper via:  ros2 topic pub -1 /teleop/gripper_cmd "
                  "std_msgs/msg/Float32 \"{data: 0.0}\"   (0=close, 1=open)")
        try:
            while True:
                # Pace to a fixed deadline and measure the interval we actually
                # got. spin_once() returns as soon as ONE callback is ready, so
                # a loop that just calls it free-runs far above RATE against
                # three 200 Hz streams -- and every dt-scaled quantity (the rate
                # limit, the gripper ramp) is then silently that many times too
                # large. Spinning while we wait keeps callbacks serviced.
                next_tick += period
                while True:
                    remain = next_tick - time.time()
                    if remain <= 0:
                        break
                    rclpy.spin_once(self, timeout_sec=min(remain, 0.005))
                if time.time() - next_tick > period:
                    next_tick = time.time()      # fell behind; resynchronise
                now = time.time()
                dt = min(max(now - last, 1e-4), 0.1)
                last = now
                self.drain()                     # act on the newest sample
                t = now - t0
                if t > self.duration or self.stop:
                    break
                ramp = min(1.0, t / BLEND_S)     # eases the gain in, not the pose
                age_l = now - self.t_leader
                age_f = now - self.t_follower
                if age_l > MAX_STALE_LEADER:
                    # Ignore the stale sample: hold the current target rather
                    # than abort. The follower simply stops where it is until
                    # fresh leader data arrives. Only a long outage aborts.
                    if not self._holding:
                        self._holding = True
                        print(f"  leader feedback stale ({age_l*1000:.0f} ms) "
                              "-- HOLDING target until it returns")
                    if age_l > ABORT_STALE_LEADER:
                        print(f"  ABORT: leader gone {age_l:.1f}s "
                              f"(limit {ABORT_STALE_LEADER:.0f}s)")
                        break
                    self.send(self.target, KP * ramp, KD * ramp)
                    self.send_gripper(dt)
                    continue
                elif self._holding:
                    self._holding = False
                    print("  leader feedback restored -- resuming")
                if age_f > MAX_STALE_FOLLOWER:
                    print(f"  ABORT: stale FOLLOWER feedback {age_f*1000:.0f} ms "
                          f"(limit {MAX_STALE_FOLLOWER*1000:.0f} ms)")
                    break
                if age_f > WARN_STALE_FOLLOWER and not self._warned_follower:
                    self._warned_follower = True
                    print(f"  note: follower feedback gapped {age_f*1000:.0f} ms "
                          "(reporting only, not control) -- continuing")
                if t > 5.0:
                    hz_l = self.n_leader / t
                    if hz_l < MIN_RATE_HZ:
                        print(f"  ABORT: leader feedback rate collapsed to "
                              f"{hz_l:.0f} Hz (limit {MIN_RATE_HZ:.0f} Hz)")
                        break
                lead = list(self.leader)
                for j in range(N):
                    goal = start[j] + (lead[j] - lead0[j])
                    lo, hi = LIMITS[j]
                    goal = max(lo, min(hi, goal))          # clamp to URDF limits
                    # Track the absolute goal. The rate limit only bounds how
                    # fast the target approaches it -- deltas are never dropped,
                    # so slow leader motion cannot silently accumulate drift.
                    delta = goal - self.target[j]
                    step = MAX_RATE * dt
                    if abs(delta) > step:
                        self.sat[j] += 1
                        self.target[j] += math.copysign(step, delta)
                    else:
                        self.target[j] = goal
                self.send(self.target, KP * ramp, KD * ramp)
                self.send_gripper(dt)

                k = kb.get()
                if k:
                    if k == "o":
                        self.gripper.command(GRIP_OPEN_PDES); print("    [gripper] OPEN")
                    elif k == "c":
                        self.gripper.command(GRIP_CLOSE_PDES)
                        print("    [gripper] CLOSE (force-limited)")
                    elif k == " ":
                        g = self.gripper.goal
                        nxt = GRIP_CLOSE_PDES if (g is None or g < 0) else GRIP_OPEN_PDES
                        self.gripper.command(nxt)
                        print(f"    [gripper] {'CLOSE' if nxt > 0 else 'OPEN'}")
                    elif k == "q":
                        print("    [quit]")
                        break
                if t - last_print >= 2.0:
                    last_print = t
                    goals = [start[j] + (lead[j] - lead0[j]) for j in range(N)]
                    div = [abs(self.follower[j] - goals[j]) for j in range(N)]
                    worst = max(range(N), key=lambda j: div[j])
                    err = div[worst]
                    dl = [math.degrees(lead[j] - lead0[j]) for j in range(N)]
                    df = [math.degrees(self.follower[j] - start[j]) for j in range(N)]
                    big = max(range(N), key=lambda j: abs(dl[j]))
                    print(f"    t={t:5.1f}s  lead J{big+1} {dl[big]:7.1f} -> foll {df[big]:7.1f} deg | "
                          f"WORST DIVERGENCE J{worst+1} {math.degrees(err):5.2f} deg | "
                          f"rate-limited {sum(self.sat)} cycles")
        finally:
            kb.restore()
            for _ in range(15):           # release the gripper too
                m = MotorControl(); m.name = "gripper"
                m.p_des=[0.0]; m.v_des=[0.0]; m.kp=[0.0]; m.kd=[0.0]; m.t_ff=[0.0]; m.mode=0
                self.gpub.publish(m)
                rclpy.spin_once(self, timeout_sec=0.005)
            el = time.time() - t0
            if el >= 1.0:
                print(f"  feedback rates: leader {self.n_leader/el:.0f} Hz, "
                      f"follower {self.n_follower/el:.0f} Hz over {el:.0f}s")
            else:
                print(f"  ran {el:.2f}s -- too short to measure feedback rate")
            if self.follower and self.leader:
                goals = [start[j] + (self.leader[j] - lead0[j]) for j in range(N)]
                div = [math.degrees(abs(self.follower[j] - goals[j])) for j in range(N)]
                print(f"  final divergence per joint (deg): "
                      f"{[round(d,2) for d in div]}")
                print(f"  rate-limit saturation per joint (cycles): {self.sat}")
                if max(div) > 5.0:
                    print(f"  NOTE: worst divergence {max(div):.1f} deg -- raise MAX_RATE "
                          f"(currently {math.degrees(MAX_RATE):.0f} deg/s) or move the leader slower")
            self.release()


def main():
    dur = float(sys.argv[1]) if len(sys.argv) > 1 else 20.0
    rclpy.init()
    t = Teleop(dur)
    # Do NOT call rclpy from a signal handler. release() publishes and spins,
    # and rclpy is not reentrant -- doing that inside the handler can deadlock
    # in its internals, so Ctrl-C would hang without ever releasing and leave
    # the follower energised with the gains applied. Set a flag instead; the
    # control loop sees it, exits, and its `finally` does the release.
    signal.signal(signal.SIGINT, lambda *_: setattr(t, "stop", True))
    start = t.engage()
    if start is not None:
        t.run(start)
    t.destroy_node(); rclpy.shutdown()


if __name__ == "__main__":
    main()
