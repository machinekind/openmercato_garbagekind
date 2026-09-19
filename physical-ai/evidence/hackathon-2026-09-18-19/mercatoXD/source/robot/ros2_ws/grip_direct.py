#!/usr/bin/env python3
"""Drive a gripper directly on CAN 0x051 (works on either bus).

    grip_direct.py <iface> [travel_rad] [kp] [secs]

Sweeps p_des out and back, printing the raw 0x051 bytes sent plus the arm's
0x052 group-7 slot, so we can see command vs any feedback change.
"""
import math, sys, time
sys.path.insert(0, "/home/ros/ros2_ws/src/galaxea_a1xy_driver/galaxea_a1xy_driver")
import can_io
from protocol import (FB_CAN_ID, FB_LEN, FF_CAN_ID, ArmCommand,
                      decode_feedback, encode_function_frame, FIELDS)
import struct

GRIP_CAN_ID = 0x051
IFACE  = sys.argv[1] if len(sys.argv) > 1 else "can1"
TRAVEL = float(sys.argv[2]) if len(sys.argv) > 2 else 0.6
KP     = float(sys.argv[3]) if len(sys.argv) > 3 else 30.0
SECS   = float(sys.argv[4]) if len(sys.argv) > 4 else 6.0


def encode_gripper(p_des, v_des, kp, kd, t_ff):
    """10-byte gripper frame: same 5 fields/clamps/scales as an arm joint."""
    out = bytearray(10)
    vals = (p_des, v_des, kp, kd, t_ff)
    for k, (name, lo, hi, scale) in enumerate(FIELDS):
        v = vals[k]
        v = lo if v < lo else (hi if v > hi else v)
        raw = max(-32768, min(32767, int(v * scale)))
        out[k*2] = (raw >> 8) & 0xFF
        out[k*2+1] = raw & 0xFF
    return bytes(out)


s = can_io.open_socket(IFACE); s.settimeout(0.05)

def fb():
    deadline = time.time() + 1.0          # retry until deadline, don't bail
    while time.time() < deadline:          # on the first socket timeout
        try: fr = can_io.recv_frame(s)
        except (OSError, TimeoutError): continue
        if fr and fr[0] == FB_CAN_ID and len(fr[1]) == FB_LEN:
            return fr[1]
    return None

d0 = fb()
if d0 is None:
    print(f"no feedback on {IFACE}"); raise SystemExit(1)
g7_0 = int.from_bytes(d0[36:38], 'big', signed=True)
print(f"{IFACE}: enabling, then sweeping gripper +/-{TRAVEL} rad at kp={KP}")
for c in (1, 6):
    can_io.send_frame(s, FF_CAN_ID, encode_function_frame(c)); time.sleep(0.3)

t0 = time.time(); peak_eff = 0.0
try:
    while time.time() - t0 < SECS:
        t = time.time() - t0
        frac = math.sin(2 * math.pi * t / SECS)      # out and back
        p = TRAVEL * frac
        can_io.send_frame(s, GRIP_CAN_ID, encode_gripper(p, 0.0, KP, 1.0, 0.0))
        d = fb()
        if d:
            g7 = int.from_bytes(d[36:38], 'big', signed=True)
            e7 = int.from_bytes(d[40:42], 'big', signed=True)
            peak_eff = max(peak_eff, abs(e7) / 600.0)
            if abs(t % 1.5) < 0.03:
                print(f"    t={t:4.1f}s  p_des={p:+.3f} rad  "
                      f"0x052 grp7 pos_raw={g7:5d}  eff={e7/600.0:+.3f}")
        time.sleep(0.01)
finally:
    for _ in range(25):
        can_io.send_frame(s, GRIP_CAN_ID, encode_gripper(0, 0, 0, 0, 0))
        time.sleep(0.005)
    d = fb()
    g7 = int.from_bytes(d[36:38], 'big', signed=True) if d else None
    print(f"  grp7 raw before={g7_0}  after={g7}   peak |eff|={peak_eff:.3f}")
    print("  released")
    s.close()
