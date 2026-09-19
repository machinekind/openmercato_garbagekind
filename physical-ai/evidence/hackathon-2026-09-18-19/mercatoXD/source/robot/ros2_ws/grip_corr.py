"""Find which bytes of 0x052 carry the gripper value the vendor publishes."""
import re, subprocess, time, threading
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import JointState

val = {}
rclpy.init()
n = Node("corr")
n.create_subscription(JointState, "/hdas/feedback_gripper",
                      lambda m: val.__setitem__("g", (list(m.position), list(m.effort))), 20)
end = time.time() + 3
while time.time() < end and "g" not in val:
    rclpy.spin_once(n, timeout_sec=0.05)
rclpy.shutdown()
if "g" not in val:
    print("no gripper feedback"); raise SystemExit(1)
gp, ge = val["g"]
print(f"vendor /hdas/feedback_gripper: position={gp}  effort={ge}")

raw = subprocess.run(["timeout", "-k", "1", "2", "candump", "can0"],
                     capture_output=True, text=True).stdout
frames = []
for line in raw.splitlines():
    m = re.search(r'\s052\s+\[48\]\s+((?:[0-9A-F]{2} ?)+)', line)
    if m:
        frames.append(bytes.fromhex(m.group(1).replace(' ', '')))
print(f"captured {len(frames)} x 0x052 frames")
d = frames[len(frames)//2]
print(f"sample frame: {d.hex(' ')}")

target = gp[0] if gp else None
print(f"\nlooking for a field that yields {target!r}")
print(f"{'off':>4} {'int16_be':>9} {'/4700':>10} {'/750':>10} {'/600':>10} {'/1000':>10}")
for off in range(0, 47, 2):
    v = int.from_bytes(d[off:off+2], 'big', signed=True)
    cands = {"/4700": v/4700, "/750": v/750, "/600": v/600, "/1000": v/1000}
    hit = [k for k, x in cands.items() if target is not None and abs(x - target) < 2e-3]
    mark = "  <== MATCH " + ",".join(hit) if hit else ""
    print(f"{off:>4} {v:>9} {v/4700:>10.5f} {v/750:>10.5f} {v/600:>10.5f} {v/1000:>10.5f}{mark}")
