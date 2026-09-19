#!/usr/bin/env bash
# Find the gripper command CAN id by watching what HDAS transmits when we
# publish a gripper command. Same method that established 0x050 for the arm.
#
# Expectation: a NEW 10-byte frame appears. 0x051 is the prime candidate
# (0x050 arm cmd, 0x052 arm fb, 0x053 function frame -- 0x051 is the gap).
set -o pipefail
source /opt/ros/humble/setup.bash
source /home/ros/a1xy/atc_host_install/setup.bash

echo "=== baseline: ids on can0 for 3s (no gripper command) ==="
timeout -k 1 3 candump can0 </dev/null 2>/dev/null | awk '{print $2, $4}' | sort | uniq -c | sort -rn

timeout -k 1 8 candump -t d can0 </dev/null 2>/dev/null > /tmp/grip.log &
sleep 1

echo "=== publishing gripper commands (zero torque: kp=kd=t_ff=0) ==="
timeout 4 ros2 topic pub -r 50 /motion_control/control_gripper hdas_msg/msg/MotorControl \
  "{name: gripper, p_des: [0.0], v_des: [0.0], kp: [0.0], kd: [0.0], t_ff: [0.0], mode: 0}" \
  >/dev/null 2>&1
echo "  (also trying the Float32 stroke topic)"
timeout 3 ros2 topic pub -r 20 /motion_control/position_control_gripper std_msgs/msg/Float32 \
  "{data: 0.0}" >/dev/null 2>&1
wait

echo "=== ids seen DURING gripper commands ==="
awk '{print $2, $4}' /tmp/grip.log | sort | uniq -c | sort -rn
echo "=== any 10-byte frame? (the gripper command size) ==="
grep -E '\[10\]' /tmp/grip.log | head -5 || echo "  none"
echo "=== anything on 0x051? ==="
grep -E ' 051 ' /tmp/grip.log | head -3 || echo "  none"
