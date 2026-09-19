#!/usr/bin/env python3
"""Minimal, bounded motion test for the Galaxea A1X.

Safety design:
  * ONE joint only (arm_joint6 - wrist roll: lightest, lowest inertia).
  * Gentle gains: kp=20 of 0..500, kd=2 of 0..200, t_ff=0.
  * Target starts at the joint's CURRENT position, so commanded motion is
    initially zero, then ramps by AMPLITUDE over RAMP_S and returns.
  * Aborts if the joint deviates more than ABORT_ERR from target.
  * Always releases (kp=kd=0) on exit, including on exception.
"""
import math
import time

import rclpy
from rclpy.node import Node
from sensor_msgs.msg import JointState
from hdas_msg.msg import MotorControl
from hdas_msg.srv import FunctionFrame

import sys
# joint (1-based) and amplitude in degrees may be given on the command line
JOINT = int(sys.argv[1]) - 1 if len(sys.argv) > 1 else 5
AMPLITUDE = math.radians(float(sys.argv[2]) if len(sys.argv) > 2 else 6.0)
RAMP_S = 3.0
HOLD_S = 1.0
RATE = 100.0
KP = float(sys.argv[3]) if len(sys.argv) > 3 else 20.0
KD = float(sys.argv[4]) if len(sys.argv) > 4 else 2.0
ABORT_ERR = math.radians(25.0)


class Mover(Node):
    def __init__(self):
        super().__init__("move_test")
        self.pos = None
        self.create_subscription(JointState, "/hdas/feedback_arm", self._cb, 50)
        self.pub = self.create_publisher(MotorControl, "/motion_control/control_arm", 10)
        self.cli = self.create_client(FunctionFrame, "/function_frame_arm")
        self.cli.wait_for_service(timeout_sec=5.0)

    def _cb(self, msg):
        self.pos = list(msg.position)

    def wait_pos(self, t=3.0):
        end = time.time() + t
        while time.time() < end and self.pos is None:
            rclpy.spin_once(self, timeout_sec=0.05)
        return self.pos

    def enable(self, code):
        req = FunctionFrame.Request(); req.command = code
        f = self.cli.call_async(req)
        rclpy.spin_until_future_complete(self, f, timeout_sec=6.0)
        r = f.result()
        print(f"  FunctionFrame({code}) -> {r.success if r else 'timeout'} {r.message if r else ''}")

    def send(self, targets, kp, kd):
        m = MotorControl()
        m.header.stamp = self.get_clock().now().to_msg()
        m.name = "arm"
        m.p_des = [float(x) for x in targets]
        m.v_des = [0.0] * 6
        m.kp = [float(kp)] * 6
        m.kd = [float(kd)] * 6
        m.t_ff = [0.0] * 6
        m.mode = 0
        self.pub.publish(m)

    def run(self):
        start = list(self.wait_pos()[:6])
        print(f"  start pos (deg): {[round(math.degrees(x),2) for x in start]}")
        print(f"  moving arm_joint{JOINT+1} by {math.degrees(AMPLITUDE):.1f} deg, kp={KP}, kd={KD}")
        t0 = time.time()
        total = RAMP_S + HOLD_S + RAMP_S
        peak_err = 0.0
        try:
            while True:
                t = time.time() - t0
                if t > total:
                    break
                if t < RAMP_S:
                    frac = t / RAMP_S
                elif t < RAMP_S + HOLD_S:
                    frac = 1.0
                else:
                    frac = max(0.0, 1.0 - (t - RAMP_S - HOLD_S) / RAMP_S)
                tgt = list(start)
                tgt[JOINT] = start[JOINT] + AMPLITUDE * frac
                self.send(tgt, KP, KD)
                rclpy.spin_once(self, timeout_sec=1.0 / RATE)
                if self.pos:
                    err = abs(self.pos[JOINT] - tgt[JOINT])
                    peak_err = max(peak_err, err)
                    if err > ABORT_ERR:
                        print(f"  ABORT: tracking error {math.degrees(err):.1f} deg")
                        break
                if abs(t % 1.0) < 0.02 and self.pos:
                    print(f"    t={t:4.1f}s  target={math.degrees(tgt[JOINT]):7.2f}  "
                          f"actual={math.degrees(self.pos[JOINT]):7.2f} deg")
        finally:
            for _ in range(20):
                self.send(start, 0.0, 0.0)      # release
                rclpy.spin_once(self, timeout_sec=0.01)
            end = self.pos[:6] if self.pos else []
            print(f"  end pos   (deg): {[round(math.degrees(x),2) for x in end]}")
            moved = math.degrees(abs(end[JOINT] - start[JOINT])) if end else 0
            print(f"  peak tracking error: {math.degrees(peak_err):.2f} deg")
            print(f"  net displacement of arm_joint{JOINT+1}: {moved:.2f} deg")


def main():
    rclpy.init()
    m = Mover()
    print("enabling motors:")
    m.enable(1); time.sleep(0.5)
    m.enable(6); time.sleep(1.0)
    m.run()
    m.destroy_node(); rclpy.shutdown()


if __name__ == "__main__":
    main()
