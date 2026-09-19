#!/usr/bin/env python3
"""Passive: is the leader moving at all, and is it resisting? Sends nothing."""
import math, sys, time
sys.path.insert(0, "/home/ros/ros2_ws/src/galaxea_a1xy_driver/galaxea_a1xy_driver")
import can_io
from protocol import FB_CAN_ID, FB_LEN, N_JOINTS, decode_feedback

IFACE = sys.argv[1] if len(sys.argv) > 1 else "can1"
SECS = float(sys.argv[2]) if len(sys.argv) > 2 else 10.0
s = can_io.open_socket(IFACE); s.settimeout(0.05)
pos, eff, raw = [], [], set()
t0 = time.time()
while time.time() - t0 < SECS:
    try: fr = can_io.recv_frame(s)
    except (OSError, TimeoutError): continue
    if fr and fr[0] == FB_CAN_ID and len(fr[1]) == FB_LEN:
        raw.add(fr[1])
        fb = decode_feedback(fr[1])
        pos.append(list(fb.position[:N_JOINTS]))
        eff.append(list(fb.effort[:N_JOINTS]))
s.close()
if not pos:
    print("no feedback"); raise SystemExit(1)
print(f"samples={len(pos)}  distinct payloads={len(raw)}")
print(f"{'joint':>7} {'range(deg)':>11} {'|eff| max':>10}")
for j in range(N_JOINTS):
    c = [math.degrees(p[j]) for p in pos]
    e = max(abs(x[j]) for x in eff)
    print(f"{'J'+str(j+1):>7} {max(c)-min(c):>11.3f} {e:>10.3f}")
mv = max(max(math.degrees(p[j]) for p in pos) - min(math.degrees(p[j]) for p in pos)
         for j in range(N_JOINTS))
me = max(max(abs(x[j]) for x in eff) for j in range(N_JOINTS))
print()
if mv > 0.5:
    print(f"  MOVED {mv:.2f} deg -> the arm IS backdrivable")
elif me > 1.0:
    print(f"  no motion but effort reached {me:.2f} -> motors are RESISTING (locked)")
else:
    print(f"  no motion, effort only {me:.2f} -> not moving and not resisting")
