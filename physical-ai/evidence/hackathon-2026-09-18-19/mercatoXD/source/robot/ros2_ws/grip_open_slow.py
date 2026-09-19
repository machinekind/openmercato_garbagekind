#!/usr/bin/env python3
"""Open the FOLLOWER's gripper fully and slowly, via HDAS (can0 only).

    grip_open_slow.py [target_rad] [secs] [kp]

Ramps p_des gradually rather than stepping, watches effort, and stops early if
it hits a mechanical stop (effort rising while position has stopped changing).
Leaves the gripper open and released.
"""
import sys, time
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import JointState
from hdas_msg.msg import MotorControl

TARGET = float(sys.argv[1]) if len(sys.argv) > 1 else 0.6     # +ve = open
SECS = float(sys.argv[2]) if len(sys.argv) > 2 else 10.0
KP = float(sys.argv[3]) if len(sys.argv) > 3 else 30.0
STALL_EFFORT = 6.0        # effort above this with no motion => at the stop

# Measured mapping between published position and commanded p_des:
#   pos ~= POS_CLOSED + POS_PER_RAD * |p_des|   (negative p_des opens)
POS_CLOSED = 3.0
POS_PER_RAD = 33.06


def pos_to_pdes(pos):
    """Approximate p_des that corresponds to the current position."""
    return -max(0.0, (pos - POS_CLOSED) / POS_PER_RAD)


class G(Node):
    def __init__(self):
        super().__init__("grip_open_slow")
        self.pos = None
        self.eff = 0.0
        self.create_subscription(JointState, "/hdas/feedback_gripper", self.cb, 50)
        self.pub = self.create_publisher(MotorControl, "/motion_control/control_gripper", 10)

    def cb(self, m):
        if m.position:
            self.pos = m.position[0]
        if m.effort:
            self.eff = m.effort[0]

    def cmd(self, p, kp, kd=1.0):
        m = MotorControl()
        m.header.stamp = self.get_clock().now().to_msg()
        m.name = "gripper"
        m.p_des = [float(p)]; m.v_des = [0.0]
        m.kp = [float(kp)]; m.kd = [float(kd)]; m.t_ff = [0.0]; m.mode = 0
        self.pub.publish(m)


def main():
    rclpy.init()
    n = G()
    end = time.time() + 3
    while time.time() < end and n.pos is None:
        rclpy.spin_once(n, timeout_sec=0.05)
    if n.pos is None:
        print("no gripper feedback on the follower"); return 1
    print(f"follower gripper: start position {n.pos:.3f}")
    print(f"opening slowly to p_des={TARGET:+.2f} rad over {SECS:g}s (kp={KP})")

    # Start the ramp from where the gripper already IS, not from 0 -- otherwise
    # an open gripper gets commanded shut before it reopens.
    start_p = pos_to_pdes(n.pos)
    print(f"  ramping p_des {start_p:+.3f} -> {TARGET:+.3f}")
    t0 = time.time()
    last_pos, still = n.pos, 0.0
    try:
        while True:
            t = time.time() - t0
            if t > SECS:
                break
            frac = t / SECS                      # linear, gentle
            p_now = start_p + (TARGET - start_p) * frac
            n.cmd(p_now, KP)
            rclpy.spin_once(n, timeout_sec=0.01)
            if abs(n.pos - last_pos) < 0.02:
                still += 0.01
            else:
                still = 0.0
                last_pos = n.pos
            if still > 1.5 and abs(n.eff) > STALL_EFFORT:
                print(f"    at mechanical stop: pos {n.pos:.3f}, effort {n.eff:.2f}")
                break
            if abs(t % 2.0) < 0.012:
                print(f"    t={t:4.1f}s  p_des={p_now:+.3f}  "
                      f"pos={n.pos:7.3f}  effort={n.eff:+.2f}")
    finally:
        for _ in range(30):
            n.cmd(0.0, 0.0, 0.0)             # release, stays where it is
            rclpy.spin_once(n, timeout_sec=0.005)
        print(f"  final position {n.pos:.3f}  (released, kp=0)")
    n.destroy_node(); rclpy.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
