#!/usr/bin/env bash
# Launch an interactive teleop session WITH keyboard gripper control.
#
# Must be run from your own terminal (not through Claude), because the keyboard
# reader needs a real TTY -- `docker compose exec -T` does not provide one.
#
#   ./teleop.sh [seconds] [max_deg_per_sec]
#
# Keys while running:   o = open   c = close (force-limited)   space = toggle   q = quit
set -e
cd "$(dirname "$(readlink -f "$0")")"
SECS="${1:-120}"
RATE="${2:-90}"

# DO NOT send FunctionFrame codes to the leader.
#
# The arm reports joint position by default and is hand-movable in that state.
# Codes 2, 3 and 4 ("release") stop the encoders reporting: the arm keeps
# transmitting 0x052 at 200 Hz but with a FROZEN payload, so nothing sees your
# hand movement. Codes 1/5/6+ leave it reporting but energise the motors, which
# locks it. Neither is wanted -- the untouched power-on state is correct.
#
# Just restart the leader driver read-only and leave the arm alone.
echo "restarting leader driver (read-only, no function frames)"
docker compose exec -T ros2 bash -lc 'pkill -f "[d]river_node" 2>/dev/null; sleep 2' || true
# NOTE: `exec -T ... nohup ... &` does NOT survive the exec session ending.
# Use `exec -d` (detached) so the driver keeps running for the whole session.
docker compose exec -T -d ros2 bash -lc '
  source /opt/ros/humble/setup.bash
  source /home/ros/ros2_ws/install/setup.bash
  exec ros2 run galaxea_a1xy_driver driver_node --ros-args -r __ns:=/leader \
    -p can_interface:=can1 > /tmp/drv_l.log 2>&1'
sleep 6
docker compose exec -T ros2 bash -lc 'grep -E "READ-ONLY|listening" /tmp/drv_l.log | tail -2' \
  | sed "s/^/  /"
# fail fast if the leader is not actually publishing
if ! docker compose exec -T ros2 bash -lc '
      source /opt/ros/humble/setup.bash
      source /home/ros/ros2_ws/install/setup.bash
      timeout 5 ros2 topic echo /leader/hdas/feedback_arm --once >/dev/null 2>&1'; then
  echo "  ERROR: leader driver is not publishing -- aborting before teleop starts"
  exit 1
fi
echo "  leader publishing OK"
echo

echo "starting teleop: ${SECS}s, rate limit ${RATE} deg/s"
echo "keys:  o = open   c = close   space = toggle   q = quit"
echo

# note: NO -T here, so the container gets a TTY and the keyboard works
exec docker compose exec ros2 bash -lc "
  source /opt/ros/humble/setup.bash
  source /home/ros/a1xy/atc_host_install/setup.bash
  source /home/ros/ros2_ws/install/setup.bash
  python3 /home/ros/ros2_ws/teleop.py ${SECS} ${RATE}
"
