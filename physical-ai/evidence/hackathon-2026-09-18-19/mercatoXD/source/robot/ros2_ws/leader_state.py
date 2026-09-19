import math, time, statistics
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import JointState

rclpy.init()
n = Node("ls")
s = []
n.create_subscription(JointState, "/leader/hdas/feedback_arm",
                      lambda m: s.append((list(m.position[:6]), list(m.effort[:6]))), 50)
end = time.time() + 3
while time.time() < end:
    rclpy.spin_once(n, timeout_sec=0.05)
if not s:
    print("no leader feedback")
else:
    eff = [statistics.mean(abs(x[1][j]) for x in s) for j in range(6)]
    rng = [math.degrees(max(x[0][j] for x in s) - min(x[0][j] for x in s)) for j in range(6)]
    print(f"samples: {len(s)}")
    print("joint    |effort|   pos_range(deg)")
    for j in range(6):
        print(f"  J{j+1}      {eff[j]:7.3f}      {rng[j]:7.3f}")
    print(f"\neffort_sum = {sum(eff):.3f}   "
          f"({'MOTORS ENGAGED - arm is rigid' if sum(eff) > 0.8 else 'motors released - arm should be backdrivable'})")
rclpy.shutdown()
