#!/usr/bin/env python3
"""Sweep FunctionFrame codes on can1; report which make the arm REPORT position.

For each code: send it, then count distinct 0x052 payloads over 2s.
  distinct == 1  -> arm transmits a frozen payload (not reporting)
  distinct >> 1  -> encoders live
Also prints effort_sum as a (weak) proxy for whether the motors are holding.
"""
import subprocess, sys, time
sys.path.insert(0, "/home/ros/ros2_ws/src/galaxea_a1xy_driver/galaxea_a1xy_driver")
import can_io
from protocol import (FB_CAN_ID, FB_LEN, FF_CAN_ID, N_JOINTS,
                      decode_feedback, encode_function_frame)

s = can_io.open_socket("can1"); s.settimeout(0.05)

def measure():
    out = subprocess.run(["timeout", "-k", "1", "2", "candump", "can1"],
                         capture_output=True, text=True).stdout
    f = [l.split("]")[1].strip() for l in out.splitlines() if " 052 " in l]
    eff = None
    dl = time.time() + 1.0
    while time.time() < dl:
        try: fr = can_io.recv_frame(s)
        except (OSError, TimeoutError): continue
        if fr and fr[0] == FB_CAN_ID and len(fr[1]) == FB_LEN:
            fb = decode_feedback(fr[1])
            eff = sum(abs(e) for e in fb.effort[:N_JOINTS]); break
    return len(f), len(set(f)), eff

n, d, e = measure()
print(f"{'code':>5} {'frames':>7} {'distinct':>9} {'effort_sum':>11}   verdict")
print(f"{'--':>5} {n:>7} {d:>9} {str(round(e,3) if e else e):>11}   baseline")
for code in list(range(1, 17)):
    can_io.send_frame(s, FF_CAN_ID, encode_function_frame(code))
    time.sleep(0.6)
    n, d, e = measure()
    verdict = "REPORTING" if d > 1 else "frozen"
    print(f"{code:>5} {n:>7} {d:>9} {str(round(e,3) if e else e):>11}   {verdict}")
s.close()
