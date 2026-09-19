#!/usr/bin/env python3
"""Direct control of the LEADER arm over its own CAN bus (default can1).

The vendor HDAS only ever talks to can0, so the leader needs its own path.
Everything here uses the protocol we verified on the wire:
    0x053 (1 B)  function frame  -> enable / release motors
    0x050 (60 B) joint command   -> position control
    0x052 (48 B) joint feedback  -> read back

Usage:
    leader_ctl.py status
    leader_ctl.py release              # motors off -> backdrivable (SUPPORT IT)
    leader_ctl.py enable
    leader_ctl.py home [secs] [kp]     # drive smoothly to the all-zero pose
"""
import math
import sys
import time

sys.path.insert(0, "/home/ros/ros2_ws/src/galaxea_a1xy_driver/galaxea_a1xy_driver")
import can_io
from protocol import (
    CMD_CAN_ID, FF_CAN_ID, FB_CAN_ID, FB_LEN, N_JOINTS,
    ArmCommand, decode_feedback, encode_command, encode_function_frame,
    FF_ENABLE, FF_ENABLE2, FF_RELEASE,
)

LIMITS = [(-2.880, 2.880), (0.0, 3.142), (-3.316, 0.0),
          (-1.571, 1.571), (-1.571, 1.571), (-2.880, 2.880)]
MAX_RATE = math.radians(25.0)     # rad/s while homing


def read_pose(sock, timeout=2.0):
    sock.settimeout(timeout)
    end = time.time() + timeout
    while time.time() < end:
        try:
            fr = can_io.recv_frame(sock)
        except (OSError, TimeoutError):
            continue
        if fr and fr[0] == FB_CAN_ID and len(fr[1]) == FB_LEN:
            return decode_feedback(fr[1])
    return None


def send_ff(sock, code):
    can_io.send_fd_frame(sock, FF_CAN_ID, encode_function_frame(code))


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    iface = "can1"
    sock = can_io.open_socket(iface)

    if cmd == "status":
        fb = read_pose(sock)
        if not fb:
            print(f"{iface}: no feedback")
            return 1
        print(f"{iface} joints (deg): " +
              " ".join(f"{math.degrees(p):7.2f}" for p in fb.position[:N_JOINTS]))
        print(f"{iface} |effort|    : " +
              " ".join(f"{abs(e):7.3f}" for e in fb.effort[:N_JOINTS]))
        s = sum(abs(e) for e in fb.effort[:N_JOINTS])
        print(f"effort_sum={s:.3f}  -> {'ENGAGED (rigid)' if s > 0.8 else 'released (backdrivable)'}")

    elif cmd == "release":
        for c in (FF_RELEASE,):
            send_ff(sock, c)
            time.sleep(0.2)
        # zero-gain stream guarantees zero commanded torque
        for _ in range(50):
            can_io.send_fd_frame(sock, CMD_CAN_ID,
                                 encode_command(ArmCommand.zero_torque()))
            time.sleep(0.01)
        print("leader released - it is now backdrivable and WILL SAG (no brakes)")

    elif cmd == "enable":
        send_ff(sock, FF_ENABLE); time.sleep(0.3)
        send_ff(sock, FF_ENABLE2); time.sleep(0.5)
        print("leader motors enabled")

    elif cmd == "home":
        secs = float(sys.argv[2]) if len(sys.argv) > 2 else 6.0
        kp = float(sys.argv[3]) if len(sys.argv) > 3 else 25.0
        fb = read_pose(sock)
        if not fb:
            print("no feedback; aborting")
            return 1
        start = list(fb.position[:N_JOINTS])
        print("homing leader from (deg): " +
              " ".join(f"{math.degrees(p):7.2f}" for p in start))
        send_ff(sock, FF_ENABLE); time.sleep(0.3)
        send_ff(sock, FF_ENABLE2); time.sleep(0.5)
        target = list(start)
        t0 = time.time()
        dt = 0.01
        try:
            while True:
                t = time.time() - t0
                if t > secs:
                    break
                ramp = min(1.0, t / 2.0)
                for j in range(N_JOINTS):
                    goal = start[j] * max(0.0, 1.0 - t / (secs * 0.8))
                    lo, hi = LIMITS[j]
                    goal = max(lo, min(hi, goal))
                    d = goal - target[j]
                    step = MAX_RATE * dt
                    target[j] += max(-step, min(step, d))
                c = ArmCommand(); c.p_des = target
                c.kp = [kp * ramp] * N_JOINTS
                c.kd = [3.0 * ramp] * N_JOINTS
                can_io.send_fd_frame(sock, CMD_CAN_ID, encode_command(c))
                time.sleep(dt)
        finally:
            for _ in range(30):
                can_io.send_fd_frame(sock, CMD_CAN_ID,
                                     encode_command(ArmCommand.zero_torque()))
                time.sleep(0.005)
            fb = read_pose(sock)
            if fb:
                print("leader now      (deg): " +
                      " ".join(f"{math.degrees(p):7.2f}" for p in fb.position[:N_JOINTS]))
            print("released (kp=kd=0)")
    else:
        print(__doc__)
        return 2
    sock.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
