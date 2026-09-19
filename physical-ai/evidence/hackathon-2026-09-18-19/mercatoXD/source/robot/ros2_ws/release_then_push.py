#!/usr/bin/env python3
"""Release the motors, then watch for encoder motion while the arm is pushed."""
import math, sys, time
sys.path.insert(0, "/home/ros/ros2_ws/src/galaxea_a1xy_driver/galaxea_a1xy_driver")
import can_io
from protocol import (FB_CAN_ID, FB_LEN, FF_CAN_ID, N_JOINTS,
                      decode_feedback, encode_function_frame)

s = can_io.open_socket("can1"); s.settimeout(0.05)
print("sending release code 2 -- SUPPORT THE ARM, it may go limp")
can_io.send_frame(s, FF_CAN_ID, encode_function_frame(2))
time.sleep(1.0)
print(">>> PUSH / MOVE THE LEADER NOW for 12 seconds <<<")
pos, raw = [], set()
t0 = time.time()
while time.time() - t0 < 12:
    try: fr = can_io.recv_frame(s)
    except (OSError, TimeoutError): continue
    if fr and fr[0] == FB_CAN_ID and len(fr[1]) == FB_LEN:
        raw.add(fr[1])
        pos.append(list(decode_feedback(fr[1]).position[:N_JOINTS]))
s.close()
print(f"samples={len(pos)}  distinct payloads={len(raw)}")
if pos:
    print(f"{'joint':>7} {'range(deg)':>11}")
    for j in range(N_JOINTS):
        c = [math.degrees(p[j]) for p in pos]
        print(f"{'J'+str(j+1):>7} {max(c)-min(c):>11.3f}")
    mv = max(max(math.degrees(p[j]) for p in pos) - min(math.degrees(p[j]) for p in pos)
             for j in range(N_JOINTS))
    print()
    print(f"  MOVED {mv:.2f} deg while released -> released state DOES report motion"
          if mv > 0.5 else
          f"  only {mv:.2f} deg -> released state reports nothing even when moved")
