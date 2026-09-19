#!/usr/bin/env python3
"""Which physical arm is on which CAN bus, and which one can you actually move?

Read-only: opens can0 and can1, decodes the 0x052 feedback, and reports how far
each arm's joints have moved. Transmits nothing, so it cannot disturb whatever
state either arm is in.

    python3 which_arm.py

Then push each arm by hand in turn and watch which line reacts.

  MOVING   - joints are changing: the arm is compliant AND reporting.
  still    - reporting, but not moving. Either nobody is pushing it, or it is
             energised and holding against you.
  FROZEN   - identical payloads: transmitting, but the encoders are not
             reporting at all. This is the released-motor state described in
             the project notes, and such an arm is useless as a leader.

Roles are fixed by the vendor stack, which hardcodes can0:
    can0 = FOLLOWER (commanded through HDAS/ARM_APP)
    can1 = LEADER   (read by our driver; never transmitted to)
So the arm you want to guide by hand has to be the one on can1.
"""
import math
import selectors
import socket
import struct
import sys
import time

FB_ID, FB_LEN, POS_DIV, N = 0x052, 48, 4700.0, 6
IFACES = sys.argv[1:] or ["can0", "can1"]
ROLE = {"can0": "FOLLOWER (vendor HDAS)", "can1": "LEADER (our driver)"}


def open_bus(name):
    s = socket.socket(socket.AF_CAN, socket.SOCK_RAW, socket.CAN_RAW)
    s.setsockopt(101, 5, 1)                      # CAN_RAW_FD_FRAMES
    s.bind((name,))
    s.setblocking(False)
    return s


def main():
    sel = selectors.DefaultSelector()
    st = {}
    for name in IFACES:
        try:
            sock = open_bus(name)
        except OSError as exc:
            print(f"{name}: cannot open ({exc})")
            continue
        sel.register(sock, selectors.EVENT_READ, name)
        st[name] = {"lo": [9e9] * N, "hi": [-9e9] * N, "n": 0,
                    "last": None, "same": 0, "pos": [0.0] * N}
    if not st:
        sys.exit("no CAN interfaces opened")

    print(__doc__.split("Roles are fixed")[0].strip().splitlines()[0])
    print("push each arm by hand; Ctrl-C to stop\n")
    print(f"{'bus':6s} {'role':24s} {'Hz':>5s}  {'moved (deg, per joint)':38s} verdict")
    tick = time.monotonic()
    try:
        while True:
            for key, _ in sel.select(timeout=0.2):
                try:
                    data = key.fileobj.recv(72)
                except OSError:
                    continue
                if len(data) < 16:
                    continue
                cid = struct.unpack_from("=I", data, 0)[0] & 0x1FFFFFFF
                ln = data[4]
                if cid != FB_ID or ln != FB_LEN:
                    continue
                pay = data[8:8 + ln]
                d = st[key.data]
                d["n"] += 1
                d["same"] = d["same"] + 1 if pay == d["last"] else 0
                d["last"] = pay
                for j in range(N):
                    p = struct.unpack_from(">h", pay, j * 6)[0] / POS_DIV
                    d["pos"][j] = p
                    d["lo"][j] = min(d["lo"][j], p)
                    d["hi"][j] = max(d["hi"][j], p)

            now = time.monotonic()
            if now - tick < 1.0:
                continue
            el, tick = now - tick, now
            for name in IFACES:
                if name not in st:
                    continue
                d = st[name]
                span = [math.degrees(h - l) if h > -9e8 else 0.0
                        for l, h in zip(d["lo"], d["hi"])]
                worst = max(span) if span else 0.0
                if d["n"] == 0:
                    verdict = "NO DATA - powered off? cable?"
                elif d["same"] > 150:
                    verdict = "FROZEN - encoders not reporting"
                elif worst > 0.5:
                    verdict = "*** MOVING ***"
                else:
                    verdict = "still"
                bars = " ".join(f"{s:5.1f}" for s in span)
                print(f"{name:6s} {ROLE.get(name, '?'):24s} {d['n']/el:5.0f}  "
                      f"{bars:38s} {verdict}", flush=True)
                d["lo"] = [9e9] * N
                d["hi"] = [-9e9] * N
                d["n"] = 0
            print(flush=True)
    except KeyboardInterrupt:
        print("\nstopped.")


if __name__ == "__main__":
    main()
