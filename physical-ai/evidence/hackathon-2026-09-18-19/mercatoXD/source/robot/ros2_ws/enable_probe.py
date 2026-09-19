#!/usr/bin/env python3
"""Find which FunctionFrame code enables the A1X motors.

Signal: with motors released the arm is limp (near-zero effort). When motors
engage, effort rises as they hold position against gravity.
Read-only apart from the service calls; sends no motion command.
"""
import statistics
import time

import rclpy
from rclpy.node import Node
from sensor_msgs.msg import JointState
from hdas_msg.srv import FunctionFrame


class Probe(Node):
    def __init__(self):
        super().__init__("enable_probe")
        self.samples = []
        self.create_subscription(JointState, "/hdas/feedback_arm", self.cb, 50)
        self.cli = self.create_client(FunctionFrame, "/function_frame_arm")
        self.cli.wait_for_service(timeout_sec=5.0)

    def cb(self, msg):
        self.samples.append((list(msg.position), list(msg.effort)))

    def measure(self, secs=1.5):
        self.samples.clear()
        end = time.time() + secs
        while time.time() < end:
            rclpy.spin_once(self, timeout_sec=0.05)
        if not self.samples:
            return None, None
        eff = [statistics.mean(abs(s[1][j]) for s in self.samples) for j in range(6)]
        pos = [statistics.mean(s[0][j] for s in self.samples) for j in range(6)]
        return pos, eff

    def call(self, code):
        req = FunctionFrame.Request()
        req.command = code
        fut = self.cli.call_async(req)
        rclpy.spin_until_future_complete(self, fut, timeout_sec=8.0)
        r = fut.result()
        return (r.success, r.message) if r else (None, "timeout")


def fmt(v):
    return " ".join(f"{x:6.3f}" for x in v) if v else "  (no data)"


def main():
    rclpy.init()
    p = Probe()
    pos, eff = p.measure(2.0)
    print(f"baseline   effort: {fmt(eff)}   sum={sum(eff):.3f}" if eff else "no feedback")
    print(f"           pos   : {fmt(pos)}")
    for c in (1, 2, 3, 4, 5, 6):
        ok, msg = p.call(c)
        time.sleep(0.8)
        pos, eff = p.measure(1.5)
        s = sum(eff) if eff else 0.0
        print(f"cmd={c} {str(ok):<5} {msg[:18]:<18} effort_sum={s:7.3f}  {fmt(eff)}")
    p.destroy_node()
    rclpy.shutdown()


if __name__ == "__main__":
    main()
