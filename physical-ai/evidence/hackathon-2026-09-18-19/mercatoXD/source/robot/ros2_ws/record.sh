#!/usr/bin/env bash
# Record a teleop demonstration to MCAP.
#
#   ./record.sh <episode_name> [seconds] [--cams]
#
# Records the LEADER (the demonstration you perform by hand) and the FOLLOWER
# (what the arm actually did), plus the commands sent. --cams also starts
# usb_cam nodes for /dev/video0 and /dev/video2.
set -euo pipefail
NAME="${1:-episode}"
SECS="${2:-30}"
CAMS="${3:-}"
OUT="$HOME/a1xy/recordings/${NAME}_$(date +%Y%m%d_%H%M%S)"

TOPICS=(
  /leader/hdas/feedback_arm        # the demonstration (action source)
  /leader/hdas/feedback_gripper
  /hdas/feedback_arm               # follower state (observation)
  /hdas/feedback_gripper
  /motion_control/control_arm      # commands actually sent
  /hdas/feedback_status_arm
)

if [[ "$CAMS" == "--cams" ]]; then
  for dev in 0 2; do
    ros2 run usb_cam usb_cam_node_exe --ros-args \
      -r __ns:=/cam$dev -p video_device:="/dev/video$dev" \
      -p image_width:=640 -p image_height:=480 -p framerate:=30.0 \
      > /tmp/cam$dev.log 2>&1 &
  done
  sleep 4
  TOPICS+=(/cam0/image_raw /cam2/image_raw)
fi

mkdir -p "$(dirname "$OUT")"
echo "recording -> $OUT"
echo "topics: ${TOPICS[*]}"
timeout "$SECS" ros2 bag record -s mcap -o "$OUT" "${TOPICS[@]}" || true
echo "done: $OUT"
ros2 bag info "$OUT" 2>/dev/null | head -20
