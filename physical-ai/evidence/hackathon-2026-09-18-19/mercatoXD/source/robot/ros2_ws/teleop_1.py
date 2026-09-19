#!/usr/bin/env python3
"""Arm-to-arm teleoperation for two Galaxea A1X arms -- minimal version.

    leader   (can1) -> read by galaxea_a1xy_driver, namespaced /leader
    follower (can0) -> driven by the vendor HDAS on /motion_control/control_arm

No gripper, no keyboard, no watchdogs. Just the arm mirroring.

    teleop_1.py [seconds] [max_deg_per_sec]

Mapping is RELATIVE: the follower mirrors the leader's MOTION, not its absolute
angles --  p_des = follower_start + (leader_now - leader_ref).  Any constant
offset between the two arms (different zero calibration, or simply starting in
different poses) is therefore irrelevant, and there is no jump at t=0.
"""
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
RATE = 100.0                                  # control loop Hz
BLEND_S = 4.0                                 # gains ease in over this
KP, KD = 25.0, 3.0
_pos = [a for a in sys.argv[1:] if not a.startswith("--")]
MAX_RATE = math.radians(float(_pos[1]) if len(_pos) > 1 else 90.0)

# A1X URDF joint limits (rad); every target is clamped to these.
LIMITS = [(-2.880, 2.880), (0.0, 3.142), (-3.316, 0.0),
          (-1.571, 1.571), (-1.571, 1.571), (-2.880, 2.880)]

# Both feedback streams run at 200 Hz. spin_once() handles ONE callback per
# call, so queuing them makes the newest sample we act on fall behind. Depth-1
# best-effort drops stale samples instead of queuing them.
SENSOR_QOS = QoSProfile(depth=1,
                        reliability=ReliabilityPolicy.BEST_EFFORT,
                        history=HistoryPolicy.KEEP_LAST)


class Teleop(Node):
    def __init__(self, duration):
        super().__init__("a1x_teleop")
        self.duration = duration
        self.leader = None
        self.follower = None
        self.released = False
        self.stop = False
        self._nl = 0
        self._nf = 0
        self.create_subscription(JointState, "/leader/hdas/feedback_arm",
                                 self._leader_cb, SENSOR_QOS)
        self.create_subscription(JointState, "/hdas/feedback_arm",
                                 self._follower_cb, SENSOR_QOS)
        self.pub = self.create_publisher(MotorControl, "/motion_control/control_arm", 10)
        self.cli = self.create_client(FunctionFrame, "/function_frame_arm")
        self.cli.wait_for_service(timeout_sec=5.0)

    def _leader_cb(self, m):
        self.leader = list(m.position[:N])
        self._nl += 1

    def _follower_cb(self, m):
        self.follower = list(m.position[:N])
        self._nf += 1

    def enable(self, code):
        """Enable the FOLLOWER only -- this service is the vendor HDAS on can0."""
        req = FunctionFrame.Request()
        req.command = code
        fut = self.cli.call_async(req)
        rclpy.spin_until_future_complete(self, fut, timeout_sec=6.0)
        r = fut.result()
        print(f"  FunctionFrame({code}) -> {r.success if r else 'timeout'}")

    def idle(self, secs):
        """Sleep while still servicing callbacks (time.sleep starves them)."""
        end = time.time() + secs
        while time.time() < end:
            rclpy.spin_once(self, timeout_sec=0.01)

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
        while time.time() < end and (self.leader is None or self.follower is None):
            rclpy.spin_once(self, timeout_sec=0.05)
        return self.leader is not None and self.follower is not None

    def run(self):
        if not self.wait_ready():
            print(f"  ERROR: leader={self.leader is not None} "
                  f"follower={self.follower is not None}")
            return
        start = list(self.follower)
        lead0 = list(self.leader)
        target = list(start)
        print(f"  follower start (deg): {[round(math.degrees(x), 1) for x in start]}")
        print(f"  leader   ref   (deg): {[round(math.degrees(x), 1) for x in lead0]}")
        print(f"  tracking for {self.duration:.0f}s  |  move the leader by hand")

        t0 = time.time()
        dt = 1.0 / RATE
        last_print = -99.0
        frozen_since = None
        try:
            while True:
                t = time.time() - t0
                if t > self.duration or self.stop:
                    break
                lead = list(self.leader)
                # A leader that is powered but not reporting sends an identical
                # payload forever; teleop then looks fine but does nothing.
                if lead == lead0:
                    if frozen_since is None:
                        frozen_since = t
                    elif t - frozen_since > 10.0 and frozen_since >= 0:
                        print("    WARNING: leader has not changed in 10s -- "
                              "it may be reporting a frozen payload")
                        frozen_since = -1.0
                else:
                    frozen_since = None
                ramp = min(1.0, t / BLEND_S)
                for j in range(N):
                    goal = start[j] + (lead[j] - lead0[j])
                    lo, hi = LIMITS[j]
                    goal = max(lo, min(hi, goal))
                    # Rate limit bounds how fast the target approaches the goal.
                    # Nothing is ever discarded, so slow leader motion cannot
                    # accumulate drift.
                    delta = goal - target[j]
                    step = MAX_RATE * dt
                    if abs(delta) > step:
                        target[j] += math.copysign(step, delta)
                    else:
                        target[j] = goal
                self.send(target, KP * ramp, KD * ramp)
                # Drain the queue: spin_once() handles ONE callback, but two
                # 200 Hz streams deliver ~400/s. Processing one per cycle means
                # acting on samples that are already stale.
                rclpy.spin_once(self, timeout_sec=dt)
                for _ in range(8):
                    rclpy.spin_once(self, timeout_sec=0.0)
                if t - last_print >= 2.0 and self.follower:
                    last_print = t
                    dl = [math.degrees(lead[j] - lead0[j]) for j in range(N)]
                    df = [math.degrees(self.follower[j] - start[j]) for j in range(N)]
                    big = max(range(N), key=lambda j: abs(dl[j]))
                    goals = [start[j] + (lead[j] - lead0[j]) for j in range(N)]
                    div = max(abs(self.follower[j] - goals[j]) for j in range(N))
                    print(f"    t={t:5.1f}s  lead J{big+1} {dl[big]:7.1f} -> "
                          f"foll {df[big]:7.1f} deg | divergence "
                          f"{math.degrees(div):5.2f} deg")
        finally:
            if self.follower and self.leader:
                goals = [start[j] + (self.leader[j] - lead0[j]) for j in range(N)]
                div = [round(math.degrees(abs(self.follower[j] - goals[j])), 2)
                       for j in range(N)]
                print(f"  final divergence per joint (deg): {div}")
            self.release()


    def check(self):
        """Validate everything WITHOUT commanding the arm. Returns True if ready."""
        ok = True
        print("pre-flight check (nothing is commanded):")
        if not self.wait_ready(6.0):
            print(f"  FAIL  feedback: leader={self.leader is not None} "
                  f"follower={self.follower is not None}")
            return False
        print("  ok    both feedback streams present")

        n0l, n0f = self._nl, self._nf
        lead_seen, foll_seen = set(), set()
        end = time.time() + 4.0
        while time.time() < end:
            rclpy.spin_once(self, timeout_sec=0.005)
            if self.leader:
                lead_seen.add(tuple(round(x, 6) for x in self.leader))
            if self.follower:
                foll_seen.add(tuple(round(x, 6) for x in self.follower))
        hz_l = (self._nl - n0l) / 4.0
        hz_f = (self._nf - n0f) / 4.0
        print(f"  {'ok  ' if hz_l > 50 else 'FAIL'}  leader rate   {hz_l:6.1f} Hz")
        print(f"  {'ok  ' if hz_f > 50 else 'FAIL'}  follower rate {hz_f:6.1f} Hz")
        ok &= hz_l > 50 and hz_f > 50

        print(f"  {'ok  ' if len(lead_seen) > 1 else 'FAIL'}  leader distinct samples: "
              f"{len(lead_seen)}"
              + ("" if len(lead_seen) > 1 else "   <- FROZEN: powered but not reporting"))
        ok &= len(lead_seen) > 1
        print(f"  {'ok  ' if len(foll_seen) > 1 else 'warn'}  follower distinct samples: "
              f"{len(foll_seen)}")

        avail = self.cli.service_is_ready()
        print(f"  {'ok  ' if avail else 'FAIL'}  /function_frame_arm available")
        ok &= avail
        print(f"  {'READY' if ok else 'NOT READY'}")
        return ok


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    check_only = "--check" in sys.argv
    dur = float(args[0]) if args else 120.0
    rclpy.init()
    t = Teleop(dur)
    # Do NOT call rclpy from a signal handler -- it is not reentrant and can
    # deadlock. Just set a flag; the control loop exits and its `finally`
    # releases the arm.
    signal.signal(signal.SIGINT, lambda *_: setattr(t, "stop", True))
    if check_only:
        good = t.check()
        t.destroy_node()
        rclpy.shutdown()
        sys.exit(0 if good else 1)

    print("enabling follower motors:")
    t.enable(1)
    t.idle(0.4)
    t.enable(6)
    t.idle(0.8)
    t.run()
    t.destroy_node()
    rclpy.shutdown()


if __name__ == "__main__":
    main()
