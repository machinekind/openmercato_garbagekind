#!/usr/bin/env python3
"""Release the leader, then find WHICH BYTES of any frame change while it moves."""
import sys, time
from collections import defaultdict
sys.path.insert(0, "/home/ros/ros2_ws/src/galaxea_a1xy_driver/galaxea_a1xy_driver")
import can_io
from protocol import FF_CAN_ID, encode_function_frame

s = can_io.open_socket("can1"); s.settimeout(0.05)
print("releasing (code 2) -- SUPPORT THE ARM")
can_io.send_frame(s, FF_CAN_ID, encode_function_frame(2))
time.sleep(1.0)
print(">>> MOVE THE LEADER THROUGH A BIG RANGE for 12 seconds <<<")

frames = defaultdict(list)
t0 = time.time()
while time.time() - t0 < 12:
    try: fr = can_io.recv_frame(s)
    except (OSError, TimeoutError): continue
    if fr:
        frames[fr[0]].append(fr[1])
s.close()

for cid, fl in sorted(frames.items()):
    n = len(fl)
    uniq = len({bytes(f) for f in fl})
    print(f"\n0x{cid:03x}: {n} frames, {uniq} distinct")
    if n < 2:
        continue
    L = min(len(f) for f in fl)
    varying = []
    for b in range(L):
        vals = {f[b] for f in fl}
        if len(vals) > 1:
            varying.append((b, len(vals), min(vals), max(vals)))
    if not varying:
        print("   no byte varies at all")
    else:
        print(f"   {len(varying)} varying bytes:")
        for b, k, lo, hi in varying[:20]:
            print(f"     byte {b:2d}: {k:3d} values, 0x{lo:02x}..0x{hi:02x}")
        # int16 interpretation of varying regions
        print("   as big-endian int16 pairs:")
        offs = sorted({b - (b % 2) for b, *_ in varying})
        for off in offs[:12]:
            vals = [int.from_bytes(f[off:off+2], 'big', signed=True) for f in fl]
            print(f"     int16@{off:2d}: min={min(vals):7d} max={max(vals):7d} "
                  f"range={max(vals)-min(vals):7d}")
