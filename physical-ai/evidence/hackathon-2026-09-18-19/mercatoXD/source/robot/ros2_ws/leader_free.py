#!/usr/bin/env python3
"""Force the leader fully backdrivable: send every release code, then stream
zero-gain commands (kp=kd=t_ff=0 -> zero commanded torque)."""
import sys, time
sys.path.insert(0, "/home/ros/ros2_ws/src/galaxea_a1xy_driver/galaxea_a1xy_driver")
import can_io
from protocol import (CMD_CAN_ID, FF_CAN_ID, FB_CAN_ID, FB_LEN, N_JOINTS,
                      ArmCommand, decode_feedback, encode_command, encode_function_frame)

IFACE = sys.argv[1] if len(sys.argv) > 1 else "can1"
s = can_io.open_socket(IFACE); s.settimeout(0.05)

def eff_sum():
    dl = time.time() + 1.0
    while time.time() < dl:
        try: fr = can_io.recv_frame(s)
        except (OSError, TimeoutError): continue
        if fr and fr[0] == FB_CAN_ID and len(fr[1]) == FB_LEN:
            fb = decode_feedback(fr[1])
            return sum(abs(e) for e in fb.effort[:N_JOINTS])
    return None

print(f"{IFACE}: effort_sum before = {eff_sum()}")
for code in (2, 3, 4):
    can_io.send_frame(s, FF_CAN_ID, encode_function_frame(code))
    time.sleep(0.4)
    print(f"  after release code {code}: effort_sum = {eff_sum()}")
# zero-gain stream guarantees zero commanded torque regardless of latched state
for _ in range(200):
    can_io.send_frame(s, CMD_CAN_ID, encode_command(ArmCommand.zero_torque()))
    time.sleep(0.005)
print(f"{IFACE}: effort_sum after zero-torque stream = {eff_sum()}")
s.close()
