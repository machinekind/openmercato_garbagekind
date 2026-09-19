"""Exercise teleop_node end-to-end against a synthetic leader and follower.

Everything runs on /fake/* topics, so no CAN frame ever reaches an arm and no
motor is ever energised. This is the way to regression-test the teleop pipeline
without putting two brakeless arms at risk.

    # terminal 1 -- teleop wired to the fake topics
    ros2 run galaxea_a1xy_teleop teleop_node --ros-args \
        -p keyboard:=false -p auto_enable:=false \
        -p leader_topic:=/fake/leader -p follower_topic:=/fake/follower \
        -p control_topic:=/fake/control -p follower_gripper_topic:=/fake/grip

    # terminal 2
    python3 sim_harness.py moving     # tracking, ramp, clamp, slew, release
    python3 sim_harness.py frozen     # must REFUSE to engage

What "moving" asserts:
  * the first commanded target equals the follower's own pose (no startup jump)
  * kp ramps 0 -> 25 monotonically rather than stepping
  * a 0.002 rad/s creep on J3 still reaches the target -- the property a
    deadband on the leader delta would destroy
  * J5 driven far past its limit is clamped at the URDF limit + margin
  * neither the slew rate nor v_des exceeds max_speed
  * releasing leaves kp = kd = 0
"""
import math
import os
import sys
import threading
import time

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, HistoryPolicy
from sensor_msgs.msg import JointState
from std_msgs.msg import String
from hdas_msg.msg import MotorControl

MODE = sys.argv[1] if len(sys.argv) > 1 else "moving"
FOLLOWER_POS = [0.30, 1.10, -1.40, 0.20, -0.30, 0.10, 0.0]   # 7: joints + gripper
LEADER_BASE = [0.05, 0.90, -1.20, -0.10, 0.40, -0.05]


class Harness(Node):
    def __init__(self):
        super().__init__("harness")
        q = QoSProfile(reliability=ReliabilityPolicy.RELIABLE,
                       history=HistoryPolicy.KEEP_LAST, depth=10)
        self.pl = self.create_publisher(JointState, "/fake/leader", q)
        self.pf = self.create_publisher(JointState, "/fake/follower", q)
        self.pc = self.create_publisher(String, "/a1x_teleop/command", q)
        self.create_subscription(MotorControl, "/fake/control", self.on_ctl,
                                 QoSProfile(reliability=ReliabilityPolicy.RELIABLE,
                                            history=HistoryPolicy.KEEP_LAST, depth=50))
        self.ctl = []
        self.t0 = time.monotonic()
        self.lock = threading.Lock()
        threading.Thread(target=self.feed, daemon=True).start()

    def on_ctl(self, m):
        with self.lock:
            self.ctl.append((time.monotonic() - self.t0, list(m.p_des),
                             list(m.kp), list(m.kd), list(m.v_des)))

    def leader_at(self, t):
        q = list(LEADER_BASE)
        if MODE == "moving" and t > 4.0:
            # J1 sweeps +-25 deg; J3 creeps slowly to prove slow motion is kept;
            # J5 is driven far past its limit to prove the clamp bites.
            q[0] += math.radians(25.0) * math.sin(2 * math.pi * 0.25 * (t - 4.0))
            q[2] += 0.002 * (t - 4.0)
            q[4] += 0.5 * (t - 4.0)
        if MODE == "frozen":
            return LEADER_BASE
        # 1-LSB encoder dither so the freeze detector sees a live arm
        return [v + (1.0 / 4700.0 if int(t * 200) % 2 else 0.0) for v in q]

    def feed(self):
        while rclpy.ok():
            t = time.monotonic() - self.t0
            now = self.get_clock().now().to_msg()
            m = JointState(); m.header.stamp = now
            m.name = [f"arm_joint{i}" for i in range(1, 7)]
            m.position = self.leader_at(t)
            m.velocity = [0.0] * 6; m.effort = [0.0] * 6
            self.pl.publish(m)
            f = JointState(); f.header.stamp = now
            f.name = ["arm"]; f.position = list(FOLLOWER_POS)
            f.velocity = [0.0] * 7; f.effort = [0.0] * 7
            self.pf.publish(f)
            time.sleep(0.005)

    def say(self, w):
        self.pc.publish(String(data=w))


def _done():
    """Leave without racing the spin thread against context teardown."""
    sys.stdout.flush()
    os._exit(0)


def main():
    rclpy.init()
    h = Harness()
    def _spin():
        try:
            rclpy.spin(h)
        except Exception:
            pass
    threading.Thread(target=_spin, daemon=True).start()

    time.sleep(2.0)
    print(f"[harness] mode={MODE}; sending engage")
    h.say("engage")
    time.sleep(12.0 if MODE == "moving" else 3.0)
    h.say("release")
    time.sleep(1.0)

    with h.lock:
        ctl = list(h.ctl)
    print(f"[harness] {len(ctl)} control msgs")
    if not ctl:
        print("FAIL: no control messages"); return

    engaged = [c for c in ctl if max(c[2]) > 0]
    if MODE == "frozen":
        print("PASS: no gains ever applied" if not engaged
              else f"FAIL: engaged despite frozen leader ({len(engaged)} msgs)")
        return _done()

    if not engaged:
        print("FAIL: never engaged"); return _done()

    first = engaged[0]
    jump = max(abs(a - b) for a, b in zip(first[1], FOLLOWER_POS[:6]))
    print(f"[startup jump] {math.degrees(jump):.4f} deg  "
          f"{'PASS' if jump < 1e-3 else 'FAIL'} (target must start at follower pose)")

    ramp = [(c[0], c[2][0]) for c in engaged[:400]]
    kps = [k for _, k in ramp]
    mono = all(b >= a - 1e-9 for a, b in zip(kps, kps[1:]))
    print(f"[gain ramp] {kps[0]:.2f} -> {max(kps):.2f} over "
          f"{ramp[-1][0]-ramp[0][0]:.1f}s monotonic={mono} "
          f"{'PASS' if mono and kps[0] < 1.0 and max(kps) > 24 else 'FAIL'}")

    late = [c for c in engaged if c[0] > 6.0]
    if late:
        # J3 slow creep: target must actually track it, not drop it
        j3_span = max(c[1][2] for c in late) - min(c[1][2] for c in late)
        print(f"[slow J3 creep] target moved {math.degrees(j3_span):.3f} deg "
              f"{'PASS' if j3_span > 1e-3 else 'FAIL'} (deadband would drop this)")
        j1_span = max(c[1][0] for c in late) - min(c[1][0] for c in late)
        print(f"[J1 sweep] target span {math.degrees(j1_span):.1f} deg "
              f"{'PASS' if math.degrees(j1_span) > 20 else 'FAIL'}")
        j5 = [c[1][4] for c in late]
        print(f"[J5 clamp] max {math.degrees(max(j5)):.2f} deg (limit 90 + margin) "
              f"{'PASS' if max(j5) <= 1.5708 + 0.05 + 1e-6 else 'FAIL'}")
        vmax = max(max(abs(v) for v in c[4]) for c in late)
        print(f"[v_des] peak {math.degrees(vmax):.1f} deg/s "
              f"{'PASS' if vmax <= 1.5708 + 1e-6 else 'FAIL'}")
        # slew limit: consecutive targets must never jump more than max_speed*dt
        worst = 0.0
        for a, b in zip(late, late[1:]):
            dt = b[0] - a[0]
            if dt <= 0:
                continue
            worst = max(worst, max(abs(x - y) for x, y in zip(b[1], a[1])) / dt)
        print(f"[slew] peak {math.degrees(worst):.1f} deg/s "
              f"{'PASS' if worst <= math.degrees(1.5708) * 1.35 else 'FAIL'}")

    tail = ctl[-1]
    print(f"[release] final kp={max(tail[2]):.2f} kd={max(tail[3]):.2f} "
          f"{'PASS' if max(tail[2]) == 0 and max(tail[3]) == 0 else 'FAIL'}")
    _done()


main()
