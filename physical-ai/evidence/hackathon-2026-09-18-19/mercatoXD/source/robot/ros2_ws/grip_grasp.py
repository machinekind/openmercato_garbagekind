#!/usr/bin/env python3
"""Force-limited gripper control for the FOLLOWER (via HDAS on can0).

    grip_grasp.py open  [secs] [kp]
    grip_grasp.py close [secs] [kp] [max_effort]

Why this exists
---------------
Commanding a closed position with a stiff gain drives the jaws to that target no
matter what is between them -- which crushes the object. Here, closing STOPS
ADVANCING the target as soon as contact is detected (|effort| > MAX_EFFORT) and
then holds at the contact position. The grasp force is therefore bounded by
MAX_EFFORT rather than by how far past the object the target happened to be.

Opening is unrestricted (nothing to crush) but still ramps gently.
"""
import sys, time
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import JointState
from hdas_msg.msg import MotorControl

POS_CLOSED, POS_PER_RAD = 3.0, 33.06
OPEN_PDES, CLOSE_PDES = -3.0, 0.5
MAX_EFFORT = 1.2          # contact threshold -- well below the 6+ seen crushing
HOLD_KP = 12.0            # gentle holding stiffness once contact is made

# Applying kp produces an effort transient before the jaws move at all, which
# reads as a false contact. Arm detection only after the command has settled,
# and require the threshold to persist -- same debounce the safety watchdog needs.
CONTACT_GRACE = 1.0       # seconds before contact detection arms
CONTACT_SAMPLES = 8       # consecutive samples over threshold (~0.08 s)


def pos_to_pdes(pos):
    return -max(0.0, (pos - POS_CLOSED) / POS_PER_RAD)


class G(Node):
    def __init__(self):
        super().__init__("grip_grasp")
        self.pos, self.eff = None, 0.0
        self.create_subscription(JointState, "/hdas/feedback_gripper", self.cb, 50)
        self.pub = self.create_publisher(MotorControl, "/motion_control/control_gripper", 10)

    def cb(self, m):
        if m.position: self.pos = m.position[0]
        if m.effort:   self.eff = m.effort[0]

    def cmd(self, p, kp, kd=1.0):
        m = MotorControl(); m.header.stamp = self.get_clock().now().to_msg()
        m.name = "gripper"
        m.p_des=[float(p)]; m.v_des=[0.0]
        m.kp=[float(kp)]; m.kd=[float(kd)]; m.t_ff=[0.0]; m.mode=0
        self.pub.publish(m)


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "open"
    secs = float(sys.argv[2]) if len(sys.argv) > 2 else 7.5
    kp = float(sys.argv[3]) if len(sys.argv) > 3 else 25.0
    max_eff = float(sys.argv[4]) if len(sys.argv) > 4 else MAX_EFFORT

    rclpy.init(); n = G()
    end = time.time() + 3
    while time.time() < end and n.pos is None:
        rclpy.spin_once(n, timeout_sec=0.05)
    if n.pos is None:
        print("no gripper feedback"); return 1

    start_p = pos_to_pdes(n.pos)
    target_p = OPEN_PDES if action == "open" else CLOSE_PDES
    print(f"{action}: pos {n.pos:.2f}, p_des {start_p:+.3f} -> {target_p:+.3f} over {secs:g}s")
    if action == "close":
        print(f"  force-limited: stops advancing at |effort| > {max_eff}")

    t0 = time.time(); frozen = None; over = 0
    try:
        while True:
            t = time.time() - t0
            if t > secs:
                break
            p_ramp = start_p + (target_p - start_p) * (t / secs)
            if action == "close":
                if frozen is None and t > CONTACT_GRACE and abs(n.eff) > max_eff:
                    over += 1
                    if over >= CONTACT_SAMPLES:
                        frozen = pos_to_pdes(n.pos)     # hold at the contact point
                        print(f"    CONTACT at pos {n.pos:.2f}, effort {n.eff:+.2f} "
                              f"-> holding, not squeezing further")
                elif frozen is None:
                    over = 0
                if frozen is not None:
                    n.cmd(frozen, HOLD_KP)
                    rclpy.spin_once(n, timeout_sec=0.01)
                    continue
            n.cmd(p_ramp, kp)
            rclpy.spin_once(n, timeout_sec=0.01)
            if abs(t % 2.0) < 0.012:
                print(f"    t={t:4.1f}s  p_des={p_ramp:+.3f}  pos={n.pos:7.2f}  "
                      f"effort={n.eff:+.2f}")
    finally:
        if action == "close" and frozen is not None:
            print(f"  holding grasp at pos {n.pos:.2f}, effort {n.eff:+.2f} (kp={HOLD_KP})")
            for _ in range(50):
                n.cmd(frozen, HOLD_KP); rclpy.spin_once(n, timeout_sec=0.01)
        else:
            for _ in range(30):
                n.cmd(0.0, 0.0, 0.0); rclpy.spin_once(n, timeout_sec=0.005)
            print(f"  final pos {n.pos:.2f} (released)")
    n.destroy_node(); rclpy.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
