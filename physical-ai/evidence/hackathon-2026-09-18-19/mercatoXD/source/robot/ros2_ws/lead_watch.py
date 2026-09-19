import math, time
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import JointState
from rclpy.qos import QoSProfile, ReliabilityPolicy, HistoryPolicy
Q = QoSProfile(depth=1, reliability=ReliabilityPolicy.BEST_EFFORT, history=HistoryPolicy.KEEP_LAST)
rclpy.init(); n = Node("lw"); s = []
n.create_subscription(JointState, "/leader/hdas/feedback_arm",
                      lambda m: s.append(list(m.position[:6])), Q)
end = time.time() + 10
while time.time() < end:
    rclpy.spin_once(n, timeout_sec=0.02)
rclpy.shutdown()
if not s:
    print("NO leader feedback at all")
else:
    print(f"samples: {len(s)}")
    print(f"{'joint':>7} {'min(deg)':>10} {'max(deg)':>10} {'range':>9}")
    moved = False
    for j in range(6):
        c = [math.degrees(x[j]) for x in s]
        r = max(c) - min(c)
        if r > 1.0: moved = True
        print(f"{'J'+str(j+1):>7} {min(c):>10.2f} {max(c):>10.2f} {r:>9.2f}")
    print("\n-> leader motion IS being read" if moved else
          "\n-> leader did NOT move in the data (locked, or not moved)")
