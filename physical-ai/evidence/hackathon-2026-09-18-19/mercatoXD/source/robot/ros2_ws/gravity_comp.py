#!/usr/bin/env python3
"""Zero-force (gravity-compensated) mode for the LEADER arm.

Sends t_ff = SCALE * g(q) with kp = kd = 0, recomputing g(q) at 100 Hz from the
URDF via Pinocchio RNEA. With SCALE=1 the arm should feel weightless: it holds
position wherever you leave it and moves with almost no force.

    gravity_comp.py [scale] [seconds] [iface]

SAFETY
------
* kp = kd = 0 throughout, so the arm is never driven to a position -- the only
  torque commanded is the gravity estimate.
* START AT LOW SCALE (0.3). If the torque SIGN were inverted, compensation would
  add to gravity instead of cancelling it and the arm would drop faster than
  free-fall; at low scale that is mild and obvious rather than violent.
* Aborts if any joint moves more than ABORT_DRIFT from its start pose.
* SafetyMonitor watchdog cuts the motors on excess velocity/acceleration, and
  on acceleration that is sustained AND aligned with the commanded torque --
  i.e. the arm driving itself, which hand motion cannot produce.
* Always releases (all-zero command) on exit.
* SUPPORT THE ARM for the first run.
"""
import math
import sys
import time

import numpy as np
import pinocchio

sys.path.insert(0, "/home/ros/ros2_ws/src/galaxea_a1xy_driver/galaxea_a1xy_driver")
import can_io
from protocol import (CMD_CAN_ID, FB_CAN_ID, FB_LEN, N_JOINTS,
                      ArmCommand, decode_feedback, encode_command)
from safety import SafetyMonitor, SafetyTrip

URDF = "/home/ros/ros2_ws/src/galaxea_a1xy_description/urdf/a1x.urdf"
RATE = 100.0
ABORT_DRIFT = math.radians(35.0)
TFF_CLAMP = 45.0          # stay inside the protocol's +/-50


def main():
    scale = float(sys.argv[1]) if len(sys.argv) > 1 else 0.3
    secs = float(sys.argv[2]) if len(sys.argv) > 2 else 15.0
    iface = sys.argv[3] if len(sys.argv) > 3 else "can1"

    model = pinocchio.buildModelFromUrdf(URDF)
    data = model.createData()
    idx_q = [model.joints[model.getJointId(f"arm_joint{j+1}")].idx_q for j in range(N_JOINTS)]
    idx_v = [model.joints[model.getJointId(f"arm_joint{j+1}")].idx_v for j in range(N_JOINTS)]

    sock = can_io.open_socket(iface)
    sock.settimeout(0.05)

    def pose():
        for _ in range(30):
            try:
                fr = can_io.recv_frame(sock)
            except (OSError, TimeoutError):
                return None
            if fr and fr[0] == FB_CAN_ID and len(fr[1]) == FB_LEN:
                return decode_feedback(fr[1])
        return None

    fb = pose()
    if fb is None:
        print(f"no feedback on {iface}")
        return 1
    start = list(fb.position[:N_JOINTS])
    print(f"gravity compensation on {iface}: scale={scale:g}, {secs:g}s, kp=kd=0")
    print(f"  start (deg): {[round(math.degrees(p),1) for p in start]}")

    q = pinocchio.neutral(model)
    t0 = time.time()
    peak = [0.0] * N_JOINTS
    guard = SafetyMonitor(sock)
    tau = [0.0] * N_JOINTS
    try:
        while time.time() - t0 < secs:
            fb = pose()
            if fb is None:
                continue
            guard.update(fb, tau)          # watchdog sees every sample
            for j in range(N_JOINTS):
                q[idx_q[j]] = fb.position[j]
            g = pinocchio.computeGeneralizedGravity(model, data, q)
            tau = []
            for j in range(N_JOINTS):
                v = float(g[idx_v[j]]) * scale
                v = max(-TFF_CLAMP, min(TFF_CLAMP, v))
                tau.append(v)
                peak[j] = max(peak[j], abs(v))
            drift = [abs(fb.position[j] - start[j]) for j in range(N_JOINTS)]
            if max(drift) > ABORT_DRIFT:
                w = max(range(N_JOINTS), key=lambda j: drift[j])
                print(f"  ABORT: J{w+1} drifted {math.degrees(drift[w]):.1f} deg")
                break
            c = ArmCommand()
            c.p_des = list(fb.position[:N_JOINTS])   # ignored: kp=0
            c.t_ff = tau
            can_io.send_fd_frame(sock, CMD_CAN_ID, encode_command(c))
            t = time.time() - t0
            if abs(t % 3.0) < 0.012:
                print(f"    t={t:4.1f}s  tau(Nm)={[round(x,2) for x in tau]}  "
                      f"drift(deg)={[round(math.degrees(d),1) for d in drift]}")
            time.sleep(1.0 / RATE)
    except SafetyTrip:
        pass                                # watchdog already cut the motors
    finally:
        guard.report()
        for _ in range(30):
            can_io.send_fd_frame(sock, CMD_CAN_ID, encode_command(ArmCommand.zero_torque()))
            time.sleep(0.005)
        fb = pose()
        if fb:
            d = [math.degrees(fb.position[j] - start[j]) for j in range(N_JOINTS)]
            print(f"  net drift (deg): {[round(x,2) for x in d]}")
        print(f"  peak |tau| per joint (Nm): {[round(p,2) for p in peak]}")
        print("  released")
        sock.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
