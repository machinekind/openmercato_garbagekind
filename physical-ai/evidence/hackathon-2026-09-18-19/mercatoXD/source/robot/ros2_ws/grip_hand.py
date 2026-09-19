#!/usr/bin/env python3
"""Read a gripper's position while it is moved BY HAND. No commands sent."""
import sys, time
sys.path.insert(0, "/home/ros/ros2_ws/src/galaxea_a1xy_driver/galaxea_a1xy_driver")
import can_io
from protocol import FB_CAN_ID, FB_LEN

IFACE = sys.argv[1] if len(sys.argv) > 1 else "can1"
SECS = float(sys.argv[2]) if len(sys.argv) > 2 else 12.0
s = can_io.open_socket(IFACE); s.settimeout(0.05)
vals, t0 = [], time.time()
print(f"{IFACE}: reading gripper for {SECS:g}s -- SQUEEZE / RELEASE IT BY HAND NOW")
while time.time() - t0 < SECS:
    try: fr = can_io.recv_frame(s)
    except (OSError, TimeoutError): continue
    if fr and fr[0] == FB_CAN_ID and len(fr[1]) == FB_LEN:
        d = fr[1]
        p = int.from_bytes(d[36:38], 'big', signed=True)
        vals.append(p)
        t = time.time() - t0
        if abs(t % 2.0) < 0.01:
            print(f"    t={t:4.1f}s  grp7 pos raw = {p:6d}  ({p/4700:+.4f} rad)")
s.close()
if vals:
    print(f"\n  samples={len(vals)}  min={min(vals)}  max={max(vals)}  range={max(vals)-min(vals)}")
    print("  -> gripper position TRACKS hand motion" if max(vals)-min(vals) > 50 else
          "  -> no change: gripper encoder not reporting hand motion")
