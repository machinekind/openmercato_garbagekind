#!/usr/bin/env python3
"""Find which CAN bytes carry gripper position.

Drives the FOLLOWER's gripper via HDAS while capturing raw CAN, then correlates
every int16 field of every arm->host frame against the value HDAS publishes on
/hdas/feedback_gripper.
"""
import re, subprocess, threading, time
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import JointState
from hdas_msg.msg import MotorControl

samples = []          # (t, published gripper position)


class Drv(Node):
    def __init__(self):
        super().__init__("grip_find")
        self.create_subscription(JointState, "/hdas/feedback_gripper", self.cb, 50)
        self.pub = self.create_publisher(MotorControl, "/motion_control/control_gripper", 10)

    def cb(self, m):
        if m.position:
            samples.append((time.time(), m.position[0]))

    def cmd(self, p, kp):
        m = MotorControl()
        m.header.stamp = self.get_clock().now().to_msg()
        m.name = "gripper"
        m.p_des = [float(p)]; m.v_des = [0.0]
        m.kp = [float(kp)]; m.kd = [1.0]; m.t_ff = [0.0]; m.mode = 0
        self.pub.publish(m)


cap = {"txt": ""}
def capture():
    cap["txt"] = subprocess.run(["timeout", "-k", "1", "9", "candump", "-t", "a", "can0"],
                                capture_output=True, text=True).stdout

rclpy.init()
n = Drv()
th = threading.Thread(target=capture, daemon=True); th.start()
time.sleep(1)
print("driving gripper open/close via HDAS...")
t0 = time.time()
while time.time() - t0 < 7:
    t = time.time() - t0
    p = 0.6 if (int(t) // 2) % 2 == 0 else -0.6
    n.cmd(p, 30.0)
    rclpy.spin_once(n, timeout_sec=0.01)
for _ in range(30):
    n.cmd(0.0, 0.0); rclpy.spin_once(n, timeout_sec=0.005)
th.join()
rclpy.shutdown()

vals = [v for _, v in samples]
print(f"published gripper positions: {len(vals)} samples, "
      f"min={min(vals):.5f} max={max(vals):.5f} range={max(vals)-min(vals):.5f}")

frames = {}
for line in cap["txt"].splitlines():
    m = re.search(r'\(([\d.]+)\)\s+can0\s+(\w+)\s+\[(\d+)\]\s+((?:[0-9A-F]{2} ?)+)', line)
    if m:
        cid = m.group(2)
        frames.setdefault(cid, []).append(bytes.fromhex(m.group(4).replace(' ', '')))
print("frames captured: " + ", ".join(f"0x{k}:{len(v)}" for k, v in frames.items()))

print("\nfields whose value RANGE is large enough to carry the gripper motion:")
for cid, fl in frames.items():
    if len(fl) < 5:
        continue
    n_i16 = len(fl[0]) // 2
    for off in range(n_i16):
        series = [int.from_bytes(d[off*2:off*2+2], 'big', signed=True) for d in fl]
        rng = max(series) - min(series)
        if rng > 200:
            print(f"  0x{cid} int16[{off:2d}] byte{off*2:2d}  min={min(series):7d} "
                  f"max={max(series):7d} range={rng:7d}")
