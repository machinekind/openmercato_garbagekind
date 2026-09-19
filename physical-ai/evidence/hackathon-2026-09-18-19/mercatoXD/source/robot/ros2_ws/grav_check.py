#!/usr/bin/env python3
"""Compute gravity-compensation torques for the leader's CURRENT pose.

Read-only: prints what would be commanded, sends nothing.
"""
import math
import sys
import numpy as np
import pinocchio

sys.path.insert(0, "/home/ros/ros2_ws/src/galaxea_a1xy_driver/galaxea_a1xy_driver")
import can_io
from protocol import FB_CAN_ID, FB_LEN, N_JOINTS, decode_feedback

URDF = "/home/ros/ros2_ws/src/galaxea_a1xy_description/urdf/a1x.urdf"
TFF_LIMIT = 50.0          # protocol clamp

model = pinocchio.buildModelFromUrdf(URDF)
data = model.createData()
print(f"model: nq={model.nq} nv={model.nv}")
names = [model.names[i] for i in range(1, len(model.names))]
print(f"joints in model order: {names}")

iface = sys.argv[1] if len(sys.argv) > 1 else "can1"
sock = can_io.open_socket(iface)
sock.settimeout(2.0)
fb = None
import time
end = time.time() + 2
while time.time() < end:
    fr = can_io.recv_frame(sock)
    if fr and fr[0] == FB_CAN_ID and len(fr[1]) == FB_LEN:
        fb = decode_feedback(fr[1]); break
sock.close()
if fb is None:
    print(f"no feedback on {iface}")
    raise SystemExit(1)

q = pinocchio.neutral(model)
# map our 6 arm joints into the model's configuration vector
for j in range(N_JOINTS):
    jid = model.getJointId(f"arm_joint{j+1}")
    if jid < len(model.joints):
        q[model.joints[jid].idx_q] = fb.position[j]

g = pinocchio.computeGeneralizedGravity(model, data, q)
print(f"\npose (deg): {[round(math.degrees(p),1) for p in fb.position[:N_JOINTS]]}")
print(f"\n{'joint':>10} {'gravity torque (Nm)':>21} {'within +/-50?':>14}")
tau = []
for j in range(N_JOINTS):
    jid = model.getJointId(f"arm_joint{j+1}")
    v = float(g[model.joints[jid].idx_v]) if jid < len(model.joints) else 0.0
    tau.append(v)
    print(f"{'arm_joint'+str(j+1):>10} {v:21.3f} {'yes' if abs(v) <= TFF_LIMIT else 'NO - CLAMPED':>14}")
print(f"\nmax |tau| = {max(abs(t) for t in tau):.3f} Nm   (protocol clamp is +/-{TFF_LIMIT:g})")
print("\nSanity: with the arm extended, J2 (shoulder) should carry the largest")
print("torque and its sign should flip when the arm swings past vertical.")
