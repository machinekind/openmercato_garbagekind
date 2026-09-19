#!/usr/bin/env bash
source /opt/ros/humble/setup.bash
source /home/ros/a1xy/atc_host_install/setup.bash
echo "--- closing ---"
python3 /home/ros/ros2_ws/grip_open_slow.py 0.5 4 25 2>&1 | tail -3
echo "--- opening at 2x speed ---"
python3 /home/ros/ros2_ws/grip_open_slow.py -3.0 7.5 25 2>&1 | tail -8
