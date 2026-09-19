#!/usr/bin/env python3
"""Time-aligned correlation: which CAN field carries the published gripper position?"""
import re, subprocess, threading, time
import rclpy
from rclpy.node import Node
from hdas_msg.msg import MotorControl
from sensor_msgs.msg import JointState

pub = []          # (t, published gripper position)
cap = {"txt": ""}


def capture():
    cap["txt"] = subprocess.run(["timeout", "-k", "1", "9", "candump", "-t", "a", "can0"],
                                capture_output=True, text=True).stdout


class D(Node):
    def __init__(self):
        super().__init__("gc2")
        self.create_subscription(JointState, "/hdas/feedback_gripper",
                                 lambda m: pub.append((time.time(), m.position[0])) if m.position else None, 100)
        self.p = self.create_publisher(MotorControl, "/motion_control/control_gripper", 10)

    def cmd(self, x, kp):
        m = MotorControl(); m.name = "gripper"
        m.p_des=[float(x)]; m.v_des=[0.0]; m.kp=[float(kp)]; m.kd=[1.0]; m.t_ff=[0.0]; m.mode=0
        self.p.publish(m)


rclpy.init(); n = D()
th = threading.Thread(target=capture, daemon=True); th.start()
time.sleep(1)
t0 = time.time()
while time.time() - t0 < 7:
    t = time.time() - t0
    n.cmd(0.6 if (int(t) // 2) % 2 == 0 else -0.6, 30.0)
    rclpy.spin_once(n, timeout_sec=0.01)
for _ in range(20):
    n.cmd(0.0, 0.0); rclpy.spin_once(n, timeout_sec=0.005)
th.join(); rclpy.shutdown()

# candump -t a gives absolute epoch timestamps
rows = {}
for line in cap["txt"].splitlines():
    m = re.search(r'\(([\d.]+)\)\s+can0\s+(\w+)\s+\[(\d+)\]\s+((?:[0-9A-F]{2} ?)+)', line)
    if m:
        rows.setdefault(m.group(2), []).append(
            (float(m.group(1)), bytes.fromhex(m.group(4).replace(' ', ''))))

print(f"published samples: {len(pub)}  range {min(v for _,v in pub):.3f}..{max(v for _,v in pub):.3f}")
best = []
for cid, fl in rows.items():
    if len(fl) < 20:
        continue
    ts = [t for t, _ in fl]
    for off in range(len(fl[0][1]) // 2):
        series = [int.from_bytes(d[off*2:off*2+2], 'big', signed=True) for _, d in fl]
        if max(series) - min(series) < 50:
            continue
        # nearest-neighbour align each published sample to a frame
        xs, ys = [], []
        j = 0
        for tp, vp in pub:
            while j + 1 < len(ts) and abs(ts[j+1] - tp) <= abs(ts[j] - tp):
                j += 1
            if abs(ts[j] - tp) < 0.05:
                xs.append(series[j]); ys.append(vp)
        if len(xs) < 50:
            continue
        mx = sum(xs)/len(xs); my = sum(ys)/len(ys)
        sxy = sum((a-mx)*(b-my) for a, b in zip(xs, ys))
        sxx = sum((a-mx)**2 for a in xs); syy = sum((b-my)**2 for b in ys)
        if sxx <= 0 or syy <= 0:
            continue
        r = sxy / (sxx*syy) ** 0.5
        best.append((abs(r), r, cid, off, sxy/sxx, my - (sxy/sxx)*mx, len(xs)))

best.sort(reverse=True)
print(f"\n{'|r|':>6} {'frame':>6} {'int16':>6} {'byte':>5} {'slope':>12} {'intercept':>11} {'n':>6}")
for a, r, cid, off, sl, ic, n_ in best[:8]:
    print(f"{a:6.4f} {'0x'+cid:>6} {off:>6} {off*2:>5} {sl:12.6f} {ic:11.4f} {n_:>6}")
