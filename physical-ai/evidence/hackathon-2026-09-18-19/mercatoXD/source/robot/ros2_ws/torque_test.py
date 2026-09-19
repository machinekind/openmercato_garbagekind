#!/usr/bin/env python3
"""Does t_ff actually drive the leader? Test on J1 (base yaw: no gravity load).

Applies a small constant torque to arm_joint1 with kp=kd=0 for a few seconds
and reports whether the joint moved. Safe: J1 rotates horizontally.
"""
import math, sys, time
sys.path.insert(0, "/home/ros/ros2_ws/src/galaxea_a1xy_driver/galaxea_a1xy_driver")
import can_io
from protocol import (CMD_CAN_ID, FF_CAN_ID, FB_CAN_ID, FB_LEN, N_JOINTS,
                      ArmCommand, decode_feedback, encode_command, encode_function_frame)

TAU = float(sys.argv[1]) if len(sys.argv) > 1 else 1.5
SECS = float(sys.argv[2]) if len(sys.argv) > 2 else 3.0
IFACE = sys.argv[3] if len(sys.argv) > 3 else "can1"
ENABLE = sys.argv[4] if len(sys.argv) > 4 else "1"

s = can_io.open_socket(IFACE); s.settimeout(0.05)

def pose():
    for _ in range(40):
        try: fr = can_io.recv_frame(s)
        except (OSError, TimeoutError): return None
        if fr and fr[0] == FB_CAN_ID and len(fr[1]) == FB_LEN:
            return decode_feedback(fr[1])
    return None

if ENABLE != "none":
    for c in (int(ENABLE),):
        can_io.send_frame(s, FF_CAN_ID, encode_function_frame(c)); time.sleep(0.3)
    print(f"sent function frame {ENABLE}")

fb = pose()
if not fb: print("no feedback"); raise SystemExit(1)
start = list(fb.position[:N_JOINTS])
print(f"J1 start: {math.degrees(start[0]):.2f} deg   applying t_ff={TAU:+.2f} Nm for {SECS:g}s")
t0 = time.time()
try:
    while time.time() - t0 < SECS:
        c = ArmCommand(); c.t_ff = [TAU, 0, 0, 0, 0, 0]
        can_io.send_frame(s, CMD_CAN_ID, encode_command(c))
        time.sleep(0.01)
finally:
    for _ in range(30):
        can_io.send_frame(s, CMD_CAN_ID, encode_command(ArmCommand.zero_torque()))
        time.sleep(0.005)
fb = pose()
if fb:
    moved = math.degrees(fb.position[0] - start[0])
    print(f"J1 end  : {math.degrees(fb.position[0]):.2f} deg   moved {moved:+.2f} deg")
    print("t_ff IS driving the motors" if abs(moved) > 0.5 else
          "no motion -> motors not accepting torque (or torque too small)")
s.close()
