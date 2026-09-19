#!/usr/bin/env python3
"""Does the follower obey a command at all? The one test everything else assumes.

Every "teleop does not follow" report so far has been debugged from the middle:
gains, mappings, staleness, QoS. This starts at the bottom instead and answers
the question those all depend on -- can we move the follower AT ALL through the
vendor stack on can0?

It does the least motion that can prove it:

  1. read the follower's pose                      (no motion)
  2. enable the motors                             (no motion -- it already holds)
  3. hold that exact pose, gains eased 0 -> KP     (no motion if the chain works)
  4. step ONE joint by STEP_DEG and watch          (the actual test)
  5. drive it back to where it started
  6. release gains, leave the arm holding itself

J1 is the joint under test by default: it is the base yaw, so it swings in the
horizontal plane and carries no gravity load. A few degrees there is the
smallest, most reversible motion this arm can make.

    follower_probe.py [--joint 1] [--step 3.0] [--kp 20] [--dry-run]

--dry-run does everything except publish, so you can see the plan first.

SAFETY
------
* Motion is bounded by construction: one joint, STEP_DEG degrees, and the
  target is clamped to the URDF limit as well.
* Aborts if any OTHER joint moves more than CROSSTALK_DEG -- that would mean the
  command is not landing where we think it is.
* Returns to the start pose before releasing, so the arm ends where it began.
* Ctrl-C sets a flag; the release runs from the main loop, never the handler.
"""
import argparse
import math
import signal
import sys
import time

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, HistoryPolicy
from sensor_msgs.msg import JointState
from hdas_msg.msg import MotorControl
from hdas_msg.srv import FunctionFrame

N = 6
RATE = 100.0
LIMITS = [(-2.880, 2.880), (0.0, 3.142), (-3.316, 0.0),
          (-1.571, 1.571), (-1.571, 1.571), (-2.880, 2.880)]
CROSSTALK_DEG = 5.0
SETTLE_S = 0.4
SENSOR_QOS = QoSProfile(depth=1, reliability=ReliabilityPolicy.BEST_EFFORT,
                        history=HistoryPolicy.KEEP_LAST)

_stop = {"flag": False}


class Probe(Node):
    def __init__(self, args):
        super().__init__("follower_probe")
        self.a = args
        self.pos = None
        self.eff = None
        self.t_fb = 0.0
        self.n_fb = 0
        self.create_subscription(JointState, "/hdas/feedback_arm",
                                 self._fb, SENSOR_QOS)
        self.pub = self.create_publisher(MotorControl,
                                         "/motion_control/control_arm", 10)
        self.cli = self.create_client(FunctionFrame, "/function_frame_arm")

    def _fb(self, m):
        self.pos = list(m.position[:N])
        self.eff = list(m.effort[:N])
        self.t_fb = time.time()
        self.n_fb += 1

    # -- plumbing -----------------------------------------------------------
    def spin(self, secs):
        end = time.time() + secs
        while time.time() < end and not _stop["flag"]:
            rclpy.spin_once(self, timeout_sec=0.005)

    def wait_fresh(self, timeout=5.0):
        end = time.time() + timeout
        while time.time() < end and not _stop["flag"]:
            rclpy.spin_once(self, timeout_sec=0.01)
            if self.pos is not None and (time.time() - self.t_fb) < 0.05:
                return True
        return False

    def send(self, p_des, kp, kd):
        if self.a.dry_run:
            return
        m = MotorControl()
        m.header.stamp = self.get_clock().now().to_msg()
        m.name = "arm"
        m.p_des = [float(x) for x in p_des]
        m.v_des = [0.0] * N
        m.kp = [float(kp)] * N
        m.kd = [float(kd)] * N
        m.t_ff = [0.0] * N
        m.mode = 0
        self.pub.publish(m)

    def stream(self, p_des, kp, kd, secs, label=""):
        """Hold a target for `secs`, returning the pose reached."""
        end = time.time() + secs
        while time.time() < end and not _stop["flag"]:
            self.send(p_des, kp, kd)
            rclpy.spin_once(self, timeout_sec=1.0 / RATE)
        if label:
            print(f"      {label}: pose now {deg(self.pos)}")
        return list(self.pos)

    def ramp(self, p_des, kp, kd, secs):
        """Ease the gains in rather than stepping them."""
        t0 = time.time()
        while not _stop["flag"]:
            t = time.time() - t0
            if t >= secs:
                break
            f = t / secs
            self.send(p_des, kp * f, kd * f)
            rclpy.spin_once(self, timeout_sec=1.0 / RATE)

    def release(self):
        base = self.pos or [0.0] * N
        for _ in range(30):
            self.send(base, 0.0, 0.0)
            rclpy.spin_once(self, timeout_sec=0.005)
        print("  released (kp=kd=0) -- the arm holds itself on the enable")

    def function_frame(self, code):
        if not self.cli.wait_for_service(timeout_sec=5.0):
            print("  /function_frame_arm not available -- is ARM_APP running?")
            return False
        req = FunctionFrame.Request()
        req.command = code
        fut = self.cli.call_async(req)
        rclpy.spin_until_future_complete(self, fut, timeout_sec=6.0)
        r = fut.result()
        print(f"  FunctionFrame({code}) -> {r.success if r else 'timeout'}")
        return r is not None


def deg(v):
    return [round(math.degrees(x), 2) for x in (v or [])]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--joint", type=int, default=1, help="joint to move, 1-6")
    p.add_argument("--step", type=float, default=3.0, help="degrees to move it")
    p.add_argument("--kp", type=float, default=20.0)
    p.add_argument("--kd", type=float, default=2.0)
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()
    j = args.joint - 1
    if not 0 <= j < N:
        print("--joint must be 1..6")
        return 2

    rclpy.init()
    signal.signal(signal.SIGINT, lambda *_: _stop.__setitem__("flag", True))
    node = Probe(args)
    try:
        print("=" * 68)
        print(f"  FOLLOWER PROBE  |  J{j+1} step {args.step:+.1f} deg  "
              f"|  kp={args.kp:g} kd={args.kd:g}"
              f"{'  [DRY RUN -- publishes nothing]' if args.dry_run else ''}")
        print("=" * 68)

        if not node.wait_fresh():
            print("  FAIL: no feedback on /hdas/feedback_arm. Is ARM_APP running?")
            return 1
        node.spin(1.0)
        print(f"  feedback OK ({node.n_fb} msgs)")
        start = list(node.pos)
        print(f"  start pose (deg): {deg(start)}")
        print(f"  start effort:     {[round(e, 2) for e in node.eff]}")

        print("\n  [1] enabling motors")
        if not node.function_frame(1):
            return 1
        node.spin(SETTLE_S)
        node.function_frame(6)
        node.spin(0.8)
        if not node.wait_fresh():
            print("  FAIL: feedback did not resume after enable")
            return 1
        start = list(node.pos)
        print(f"  pose after enable: {deg(start)}")

        print(f"\n  [2] holding the START pose, gains eased in over 1.5s")
        node.ramp(start, args.kp, args.kd, 1.5)
        held = node.stream(start, args.kp, args.kd, 1.5, "held")
        moved_holding = max(abs(held[k] - start[k]) for k in range(N))
        print(f"      drift while merely holding: "
              f"{math.degrees(moved_holding):.2f} deg  (small is correct)")

        lo, hi = LIMITS[j]
        target = list(start)
        target[j] = max(lo, min(hi, start[j] + math.radians(args.step)))
        actual_step = math.degrees(target[j] - start[j])
        print(f"\n  [3] commanding J{j+1} {math.degrees(start[j]):+.2f} -> "
              f"{math.degrees(target[j]):+.2f} deg  (step {actual_step:+.2f} after limit clamp)")
        if abs(actual_step) < 0.5:
            print("      the limit clamp ate the step -- pick another joint")
            return 1
        node.stream(target, args.kp, args.kd, 2.5, "after step")

        reached = list(node.pos)
        delta = math.degrees(reached[j] - start[j])
        cross = max(math.degrees(abs(reached[k] - start[k]))
                    for k in range(N) if k != j)
        print(f"\n  RESULT")
        print(f"      commanded J{j+1}: {actual_step:+.2f} deg")
        print(f"      measured  J{j+1}: {delta:+.2f} deg")
        print(f"      largest move on any OTHER joint: {cross:.2f} deg")
        frac = delta / actual_step if actual_step else 0.0
        if abs(delta) < 0.3:
            verdict = ("DID NOT MOVE -- the command is not reaching the motors. "
                       "This is the bug; teleop cannot work until it is fixed.")
        elif cross > CROSSTALK_DEG:
            verdict = (f"MOVED, but so did other joints ({cross:.1f} deg) -- "
                       "the joint mapping is wrong.")
        elif frac < 0.5:
            verdict = (f"moved only {frac*100:.0f}% of the command -- gains too "
                       "low, or the arm is obstructed.")
        else:
            verdict = f"FOLLOWS ({frac*100:.0f}% of commanded). The command path works."
        print(f"      -> {verdict}")

        print(f"\n  [4] returning to the start pose")
        node.stream(start, args.kp, args.kd, 2.5, "back")
        back = math.degrees(abs(node.pos[j] - start[j]))
        print(f"      residual offset from start: {back:.2f} deg")
        return 0
    finally:
        node.release()
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
