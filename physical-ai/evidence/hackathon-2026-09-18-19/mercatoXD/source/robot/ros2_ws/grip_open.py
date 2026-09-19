#!/usr/bin/env python3
"""Gently open a gripper and leave it released.  grip_open.py <iface> [p_des] [kp] [secs]"""
import sys, time
sys.path.insert(0, "/home/ros/ros2_ws/src/galaxea_a1xy_driver/galaxea_a1xy_driver")
import can_io
from protocol import FB_CAN_ID, FB_LEN, FF_CAN_ID, FIELDS, encode_function_frame

GRIP = 0x051
IFACE = sys.argv[1] if len(sys.argv) > 1 else "can1"
TARGET = float(sys.argv[2]) if len(sys.argv) > 2 else 0.6
KP = float(sys.argv[3]) if len(sys.argv) > 3 else 25.0
SECS = float(sys.argv[4]) if len(sys.argv) > 4 else 4.0

def enc(p, kp, kd):
    out = bytearray(10)
    for k, (name, lo, hi, sc) in enumerate(FIELDS):
        v = (p, 0.0, kp, kd, 0.0)[k]
        v = lo if v < lo else (hi if v > hi else v)
        r = max(-32768, min(32767, int(v * sc)))
        out[k*2] = (r >> 8) & 0xFF; out[k*2+1] = r & 0xFF
    return bytes(out)

s = can_io.open_socket(IFACE); s.settimeout(0.05)
def grp7():
    deadline = time.time() + 1.0          # retry until deadline, don't bail
    while time.time() < deadline:          # on the first socket timeout
        try: fr = can_io.recv_frame(s)
        except (OSError, TimeoutError): continue
        if fr and fr[0] == FB_CAN_ID and len(fr[1]) == FB_LEN:
            return int.from_bytes(fr[1][36:38], 'big', signed=True)
    return None

print(f"{IFACE}: grp7 before = {grp7()}")
for c in (1, 6):
    can_io.send_frame(s, FF_CAN_ID, encode_function_frame(c)); time.sleep(0.25)
t0 = time.time()
try:
    while time.time() - t0 < SECS:
        f = min(1.0, (time.time() - t0) / (SECS * 0.6))
        can_io.send_frame(s, GRIP, enc(TARGET * f, KP, 1.0))
        time.sleep(0.01)
finally:
    for _ in range(30):
        can_io.send_frame(s, GRIP, enc(0.0, 0.0, 0.0))
        time.sleep(0.005)
    print(f"{IFACE}: grp7 after  = {grp7()}   (released, kp=0)")
    s.close()
