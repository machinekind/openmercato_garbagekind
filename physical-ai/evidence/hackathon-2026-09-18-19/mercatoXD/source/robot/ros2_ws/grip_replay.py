#!/usr/bin/env python3
"""Capture HDAS's own 0x051 bytes (follower), then replay them to the leader.

If replay works, our encoder was wrong. If it does not, the difference is bus
state, not the payload.
"""
import re, subprocess, sys, threading, time
sys.path.insert(0, "/home/ros/ros2_ws/src/galaxea_a1xy_driver/galaxea_a1xy_driver")
import can_io
from protocol import FB_CAN_ID, FB_LEN, FF_CAN_ID, encode_function_frame

import rclpy
from rclpy.node import Node
from hdas_msg.msg import MotorControl

cap = {"txt": ""}
def capture():
    cap["txt"] = subprocess.run(["timeout", "-k", "1", "7", "candump", "-t", "a", "can0"],
                                capture_output=True, text=True).stdout

class P(Node):
    def __init__(self):
        super().__init__("replay_cap")
        self.pub = self.create_publisher(MotorControl, "/motion_control/control_gripper", 10)
    def cmd(self, p, kp):
        m = MotorControl(); m.name = "gripper"
        m.p_des=[float(p)]; m.v_des=[0.0]; m.kp=[float(kp)]; m.kd=[1.0]; m.t_ff=[0.0]; m.mode=0
        self.pub.publish(m)

print("1) capturing HDAS 0x051 payloads while it drives the FOLLOWER gripper")
rclpy.init(); n = P()
th = threading.Thread(target=capture, daemon=True); th.start()
time.sleep(1)
t0 = time.time()
while time.time() - t0 < 5:
    t = time.time() - t0
    n.cmd(0.6 if (int(t)//2) % 2 == 0 else -0.6, 30.0)
    rclpy.spin_once(n, timeout_sec=0.01)
for _ in range(20):
    n.cmd(0.0, 0.0); rclpy.spin_once(n, timeout_sec=0.005)
th.join(); rclpy.shutdown()

payloads = []
for line in cap["txt"].splitlines():
    m = re.search(r'can0\s+051\s+\[(\d+)\]\s+((?:[0-9A-F]{2} ?)+)', line)
    if m:
        payloads.append((int(m.group(1)), bytes.fromhex(m.group(2).replace(' ', ''))))
if not payloads:
    print("   no 0x051 captured"); raise SystemExit(1)
lens = sorted({l for l, _ in payloads})
uniq = sorted({p.hex(' ') for _, p in payloads})
print(f"   captured {len(payloads)} frames, len(s)={lens}, {len(uniq)} distinct payloads")
for u in uniq[:4]:
    print(f"     {u}")

print("\n2) replaying those exact bytes to the LEADER on can1")
s = can_io.open_socket("can1"); s.settimeout(0.05)
def slot():
    dl = time.time() + 1.0
    while time.time() < dl:
        try: fr = can_io.recv_frame(s)
        except (OSError, TimeoutError): continue
        if fr and fr[0] == FB_CAN_ID and len(fr[1]) == FB_LEN:
            return int.from_bytes(fr[1][36:38], 'big', signed=True)
    return None
print(f"   leader grp7 before = {slot()}")
for c in (1, 6):
    can_io.send_frame(s, FF_CAN_ID, encode_function_frame(c)); time.sleep(0.3)
t0 = time.time(); i = 0
while time.time() - t0 < 6:
    _l, pl = payloads[i % len(payloads)]
    can_io.send_frame(s, 0x051, pl)
    i += 1
    time.sleep(0.01)
for _ in range(25):
    can_io.send_frame(s, 0x051, bytes(10)); time.sleep(0.005)
print(f"   leader grp7 after  = {slot()}   ({i} frames replayed)")
s.close()
