#!/usr/bin/env bash
# Minimal arm-to-arm teleop: no gripper, no keyboard.
#
#   ./teleop_1.sh [seconds] [max_deg_per_sec]
#
# Sends the LEADER nothing. Enables only the follower, via the vendor HDAS.
set -e
cd "$(dirname "$(readlink -f "$0")")"
SECS="${1:-120}"
RATE="${2:-90}"

echo "restarting leader driver (read-only)"
docker compose exec -T ros2 bash -lc 'pkill -f "[d]river_node" 2>/dev/null; sleep 2' || true
docker compose exec -T -d ros2 bash -lc '
  source /opt/ros/humble/setup.bash
  source /home/ros/ros2_ws/install/setup.bash
  exec ros2 run galaxea_a1xy_driver driver_node --ros-args -r __ns:=/leader \
    -p can_interface:=can1 > /tmp/drv_l.log 2>&1'
sleep 6
if ! docker compose exec -T ros2 bash -lc '
      source /opt/ros/humble/setup.bash
      source /home/ros/ros2_ws/install/setup.bash
      timeout 5 ros2 topic echo /leader/hdas/feedback_arm --once >/dev/null 2>&1'; then
  echo "  ERROR: leader driver is not publishing -- aborting"
  exit 1
fi
echo "  leader publishing OK"
echo
echo "teleop_1: ${SECS}s, rate limit ${RATE} deg/s  (Ctrl-C to stop)"
echo

exec docker compose exec ros2 bash -lc "
  source /opt/ros/humble/setup.bash
  source /home/ros/a1xy/atc_host_install/setup.bash
  source /home/ros/ros2_ws/install/setup.bash
  python3 /home/ros/ros2_ws/teleop_1.py ${SECS} ${RATE}
"
