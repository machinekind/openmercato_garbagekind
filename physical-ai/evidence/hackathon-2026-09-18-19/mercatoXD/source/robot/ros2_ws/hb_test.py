#!/usr/bin/env python3
"""Stream the 0x023 host heartbeat on can1 and see if 0x052 starts varying."""
import subprocess, sys, threading, time
sys.path.insert(0, "/home/ros/ros2_ws/src/galaxea_a1xy_driver/galaxea_a1xy_driver")
import can_io
from protocol import FF_CAN_ID, encode_function_frame

s = can_io.open_socket("can1"); s.settimeout(0.05)
stop = threading.Event()

def beat():
    while not stop.is_set():
        try: can_io.send_frame(s, 0x023, b"\x00")
        except OSError: pass
        time.sleep(0.4)

print("streaming 0x023 heartbeat on can1 (plus enable codes)...")
threading.Thread(target=beat, daemon=True).start()
for c in (1, 5, 6):
    can_io.send_frame(s, FF_CAN_ID, encode_function_frame(c)); time.sleep(0.4)
time.sleep(2)

out = subprocess.run(["timeout", "-k", "1", "4", "candump", "can1"],
                     capture_output=True, text=True).stdout
stop.set(); s.close()
f52 = [l.split("]")[1].strip() for l in out.splitlines() if " 052 " in l]
print(f"0x052: {len(f52)} frames, {len(set(f52))} distinct payloads")
print("-> HEARTBEAT REVIVED IT" if len(set(f52)) > 1 else
      "-> still frozen: heartbeat is not the trigger")
