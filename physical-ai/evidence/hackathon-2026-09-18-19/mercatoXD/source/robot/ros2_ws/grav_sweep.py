"""Gravity torque across the workspace: which joint carries the load?"""
import math
import numpy as np
import pinocchio

URDF = "/home/ros/ros2_ws/src/galaxea_a1xy_description/urdf/a1x.urdf"
N = 6
model = pinocchio.buildModelFromUrdf(URDF)
data = model.createData()
iq = [model.joints[model.getJointId(f"arm_joint{j+1}")].idx_q for j in range(N)]
iv = [model.joints[model.getJointId(f"arm_joint{j+1}")].idx_v for j in range(N)]

def tau(pose_deg):
    q = pinocchio.neutral(model)
    for j in range(N):
        q[iq[j]] = math.radians(pose_deg[j])
    g = pinocchio.computeGeneralizedGravity(model, data, q)
    return [float(g[iv[j]]) for j in range(N)]

poses = {
    "folded / home      ": [0, 0, 0, 0, 0, 0],
    "shoulder 37 (yours)": [-9, 37, 2, -3, 0, -2],
    "shoulder 90        ": [0, 90, 0, 0, 0, 0],
    "arm out, elbow -90 ": [0, 90, -90, 0, 0, 0],
    "elbow -45          ": [0, 45, -45, 0, 0, 0],
    "worst extension    ": [0, 90, -180, 0, 0, 0],
}
print(f"{'pose':<20} " + " ".join(f"{'J'+str(j+1):>7}" for j in range(N)) + "   dominant")
peak = [0.0] * N
for name, p in poses.items():
    t = tau(p)
    for j in range(N):
        peak[j] = max(peak[j], abs(t[j]))
    d = max(range(N), key=lambda j: abs(t[j]))
    print(f"{name:<20} " + " ".join(f"{v:7.2f}" for v in t) + f"   J{d+1}")
print(f"\n{'peak |tau|':<20} " + " ".join(f"{v:7.2f}" for v in peak))
print(f"max over workspace: {max(peak):.2f} Nm on J{peak.index(max(peak))+1}"
      f"   (protocol t_ff clamp is +/-50 Nm)")
