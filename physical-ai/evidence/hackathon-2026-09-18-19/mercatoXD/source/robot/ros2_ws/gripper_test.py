#!/usr/bin/env python3
"""Does the FOLLOWER's gripper respond to commands?

Sends a gentle position command on /motion_control/control_gripper (HDAS encodes
it onto CAN 0x051) and watches the gripper slot of /hdas/feedback_gripper.

Gentle by design: kp=10 of 0..500, small commanded travel, auto-release.
"""
import math
import statistics
import time

import rclpy
from rclpy.node import Node
from sensor_msgs.msg import JointState
from hdas_msg.msg import MotorControl
from hdas_msg.srv import FunctionFrame

KP, KD = 10.0, 1.0
TRAVEL = 0.30          # rad of commanded travel
RAMP_S = 3.0


class GripTest(Node):
    def __init__(self):
        super().__init__("grip_test")
        self.g = []
        self.create_subscription(JointState, "/hdas/feedback_gripper",
                                 lambda m: self.g.append((list(m.position), list(m.effort))), 50)
        self.pub = self.create_publisher(MotorControl, "/motion_control/control_gripper", 10)
        self.cli = self.create_client(FunctionFrame, "/function_frame_arm")
        self.cli.wait_for_service(timeout_sec=5.0)

    def sample(self, secs=1.5):
        self.g.clear()
        end = time.time() + secs
        while time.time() < end:
            rclpy.spin_once(self, timeout_sec=0.02)
        if not self.g:
            return None, None
        pos = [s[0][0] for s in self.g if s[0]]
        eff = [s[1][0] for s in self.g if s[1]]
        return pos, eff

    def enable(self, code):
        r = FunctionFrame.Request(); r.command = code
        f = self.cli.call_async(r)
        rclpy.spin_until_future_complete(self, f, timeout_sec=6.0)

    def send(self, p, kp, kd):
        m = MotorControl()
        m.header.stamp = self.get_clock().now().to_msg()
        m.name = "gripper"
        m.p_des = [float(p)]; m.v_des = [0.0]
        m.kp = [float(kp)]; m.kd = [float(kd)]; m.t_ff = [0.0]
        m.mode = 0
        self.pub.publish(m)


def stat(pos, eff, label):
    if not pos:
        print(f"  {label}: NO feedback")
        return
    print(f"  {label}: pos min={min(pos):.5f} max={max(pos):.5f} "
          f"range={max(pos)-min(pos):.5f} | |eff| max={max(abs(e) for e in eff):.4f}")


def main():
    rclpy.init()
    n = GripTest()
    print("baseline (no command):")
    p0, e0 = n.sample(2.0)
    stat(p0, e0, "baseline")

    print("enabling motors (FunctionFrame 1, 6)")
    n.enable(1); time.sleep(0.4); n.enable(6); time.sleep(0.8)

    print(f"commanding gripper: kp={KP}, travel={TRAVEL} rad over {RAMP_S}s")
    t0 = time.time()
    try:
        while time.time() - t0 < RAMP_S:
            frac = (time.time() - t0) / RAMP_S
            n.send(TRAVEL * frac, KP, KD)
            rclpy.spin_once(n, timeout_sec=0.01)
        p1, e1 = n.sample(1.5)
        stat(p1, e1, "commanded")
    finally:
        for _ in range(30):
            n.send(0.0, 0.0, 0.0)
            rclpy.spin_once(n, timeout_sec=0.005)
        print("  released")
    if p0 and p1:
        moved = abs(statistics.mean(p1) - statistics.mean(p0))
        print(f"\n  gripper moved {moved:.5f} rad")
        print("  -> GRIPPER RESPONDS" if moved > 1e-4 else
              "  -> NO RESPONSE: gripper not on the bus (check the 4-pin connector)")
    n.destroy_node(); rclpy.shutdown()


if __name__ == "__main__":
    main()
