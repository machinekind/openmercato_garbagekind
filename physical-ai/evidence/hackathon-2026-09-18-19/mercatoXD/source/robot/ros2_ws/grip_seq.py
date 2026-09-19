#!/usr/bin/env python3
"""Sequenced gripper test on one bus: open -> close -> open -> release.

    grip_seq.py <iface> [travel] [kp]

Holds each phase long enough to watch, prints the 0x052 group-7 slot at every
phase, and always ends OPEN and released (kp=0) rather than clamped.
"""
import sys, threading, time
sys.path.insert(0, "/home/ros/ros2_ws/src/galaxea_a1xy_driver/galaxea_a1xy_driver")
import can_io
from protocol import FB_CAN_ID, FB_LEN, FF_CAN_ID, FIELDS, encode_function_frame

GRIP = 0x051
IFACE = sys.argv[1] if len(sys.argv) > 1 else "can0"
TRAVEL = float(sys.argv[2]) if len(sys.argv) > 2 else 0.6
KP = float(sys.argv[3]) if len(sys.argv) > 3 else 30.0
PHASE = 2.5


def enc(p, kp, kd=1.0):
    out = bytearray(10)
    for k, (_n, lo, hi, sc) in enumerate(FIELDS):
        v = (p, 0.0, kp, kd, 0.0)[k]
        v = lo if v < lo else (hi if v > hi else v)
        r = max(-32768, min(32767, int(v * sc)))
        out[k*2] = (r >> 8) & 0xFF
        out[k*2+1] = r & 0xFF
    return bytes(out)


s = can_io.open_socket(IFACE); s.settimeout(0.05)

# HDAS continuously emits a 1-byte heartbeat on 0x023 on its own bus. can1 has
# no HDAS, so nothing sends it there -- and the arm may gate command acceptance
# on it. Emit it ourselves for the duration of the test.
HEARTBEAT_ID = 0x023
_stop = threading.Event()


def _heartbeat():
    while not _stop.is_set():
        try:
            can_io.send_frame(s, HEARTBEAT_ID, b"\x00")
        except OSError:
            pass
        time.sleep(0.4)


threading.Thread(target=_heartbeat, daemon=True).start()


def slot():
    deadline = time.time() + 1.0
    while time.time() < deadline:
        try: fr = can_io.recv_frame(s)
        except (OSError, TimeoutError): continue
        if fr and fr[0] == FB_CAN_ID and len(fr[1]) == FB_LEN:
            d = fr[1]
            return (int.from_bytes(d[36:38], 'big', signed=True),
                    int.from_bytes(d[38:40], 'big', signed=True),
                    int.from_bytes(d[40:42], 'big', signed=True))
    return None


def hold(p, label):
    t0 = time.time()
    while time.time() - t0 < PHASE:
        can_io.send_frame(s, GRIP, enc(p, KP))
        time.sleep(0.01)
    v = slot()
    print(f"  {label:<22} p_des={p:+.2f}  grp7 = {v}")


print(f"=== {IFACE} gripper sequence (travel {TRAVEL}, kp {KP}) ===")
print(f"  {'at rest':<22} p_des= ----  grp7 = {slot()}")
for c in (1, 6):
    can_io.send_frame(s, FF_CAN_ID, encode_function_frame(c)); time.sleep(0.3)
print("  motors enabled")
try:
    hold(+TRAVEL, "OPEN")
    hold(-TRAVEL, "CLOSE")
    hold(+TRAVEL, "OPEN again")
finally:
    for _ in range(30):
        can_io.send_frame(s, GRIP, enc(0.0, 0.0, 0.0))
        time.sleep(0.005)
    _stop.set()
    time.sleep(0.5)
    print(f"  {'released (kp=0)':<22} p_des= ----  grp7 = {slot()}")
    s.close()
