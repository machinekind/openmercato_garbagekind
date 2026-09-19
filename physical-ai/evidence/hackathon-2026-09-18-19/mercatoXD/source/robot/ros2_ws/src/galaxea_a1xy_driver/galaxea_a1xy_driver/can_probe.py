"""Standalone CAN sanity check - no ROS required beyond the entry point.

    ros2 run galaxea_a1xy_driver can_probe [interface] [seconds]

Prints frame rate, per-ID counts and the decoded joint state. Read-only.
"""
import math
import sys
import time
from collections import Counter

from . import can_io
from .protocol import FB_CAN_ID, FB_LEN, decode_feedback

LIMITS_DEG = [(-165, 165), (0, 180), (-190, 0), (-90, 90), (-90, 90), (-165, 165)]


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    iface = argv[0] if argv else "can0"
    secs = float(argv[1]) if len(argv) > 1 else 3.0

    try:
        sock = can_io.open_socket(iface)
    except OSError as exc:
        print(f"cannot open {iface}: {exc}")
        return 1
    sock.settimeout(1.0)

    counts, last = Counter(), None
    end = time.time() + secs
    while time.time() < end:
        try:
            frame = can_io.recv_frame(sock)
        except (OSError, TimeoutError):
            continue
        if frame is None:
            continue
        can_id, payload = frame
        counts[can_id] += 1
        if can_id == FB_CAN_ID and len(payload) == FB_LEN:
            last = payload
    sock.close()

    total = sum(counts.values())
    print(f"\n{iface}: {total} frames in {secs:g}s ({total / secs:.0f} Hz)")
    for cid, n in counts.most_common():
        print(f"  0x{cid:03x}: {n}")
    if last is None:
        print("\nno 0x052 feedback seen - arm powered off, or CAN unplugged?")
        return 2

    fb = decode_feedback(last)
    print(f"\n{'joint':>8} {'rad':>9} {'deg':>9} {'vel':>8} {'eff':>8}  {'limit ok':>9}")
    for i in range(7):
        name = f"arm_joint{i + 1}" if i < 6 else "gripper"
        deg = math.degrees(fb.position[i])
        ok = "-"
        if i < 6:
            lo, hi = LIMITS_DEG[i]
            ok = "yes" if lo <= deg <= hi else "NO"
        print(f"{name:>8} {fb.position[i]:>9.4f} {deg:>9.2f} "
              f"{fb.velocity[i]:>8.3f} {fb.effort[i]:>8.3f}  {ok:>9}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
