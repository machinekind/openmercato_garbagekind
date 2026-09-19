import math, time
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import JointState

rclpy.init()
n = Node("cmp")
st = {}
n.create_subscription(JointState, "/hdas/feedback_arm",
                      lambda m: st.__setitem__("f", list(m.position[:6])), 20)
n.create_subscription(JointState, "/leader/hdas/feedback_arm",
                      lambda m: st.__setitem__("l", list(m.position[:6])), 20)
end = time.time() + 4
while time.time() < end and len(st) < 2:
    rclpy.spin_once(n, timeout_sec=0.05)
if len(st) < 2:
    print("missing feedback from:", {"f", "l"} - set(st))
else:
    f, l = st["f"], st["l"]
    print(f"{'joint':>6} {'follower':>9} {'leader':>9} {'diff':>8}")
    for i in range(6):
        print(f"{'J'+str(i+1):>6} {math.degrees(f[i]):9.2f} "
              f"{math.degrees(l[i]):9.2f} {math.degrees(l[i]-f[i]):8.2f}")
    print(f"max |diff| = {max(abs(math.degrees(l[i]-f[i])) for i in range(6)):.2f} deg")
rclpy.shutdown()
