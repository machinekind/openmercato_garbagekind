#!/usr/bin/env python3
"""Disentangle: does the leader report position when RELEASED, or only when ENABLED?

Three conditions, each measured by counting DISTINCT 0x052 payloads:
  A  released (FF 2)                      -- current teleop.sh behaviour
  B  enabled  (FF 1,6), no commands       -- motors on, latched
  C  enabled + zero-gain command stream   -- motors on, ZERO commanded torque
Condition C is the one that should both report AND stay backdrivable.
"""
import subprocess, sys, threading, time
sys.path.insert(0, "/home/ros/ros2_ws/src/galaxea_a1xy_driver/galaxea_a1xy_driver")
import can_io
from protocol import (CMD_CAN_ID, FF_CAN_ID, ArmCommand,
                      encode_command, encode_function_frame)

s = can_io.open_socket("can1"); s.settimeout(0.05)
stop = threading.Event()
zero = threading.Event()

def streamer():
    while not stop.is_set():
        if zero.is_set():
            try: can_io.send_frame(s, CMD_CAN_ID, encode_command(ArmCommand.zero_torque()))
            except OSError: pass
        time.sleep(0.01)

threading.Thread(target=streamer, daemon=True).start()

def distinct(label):
    out = subprocess.run(["timeout", "-k", "1", "3", "candump", "can1"],
                         capture_output=True, text=True).stdout
    f = [l.split("]")[1].strip() for l in out.splitlines() if " 052 " in l]
    print(f"  {label:<38} {len(f)} frames, {len(set(f))} distinct")
    return len(set(f))

print("A: released (FF 2)")
can_io.send_frame(s, FF_CAN_ID, encode_function_frame(2)); time.sleep(1)
a = distinct("released, no commands")

print("B: enabled (FF 1,6), no commands")
for c in (1, 6):
    can_io.send_frame(s, FF_CAN_ID, encode_function_frame(c)); time.sleep(0.4)
b = distinct("enabled, no commands")

print("C: enabled + zero-gain command stream")
zero.set(); time.sleep(1)
c = distinct("enabled + zero-torque stream")
zero.clear(); stop.set(); s.close()

print()
print(f"  released={a}  enabled={b}  enabled+zero={c}")
if c > 1 and a <= 1:
    print("  -> leader reports ONLY when motors are energised.")
    print("     Use condition C: enabled with zero commanded torque")
    print("     (reports position AND stays backdrivable).")
