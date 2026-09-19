#!/usr/bin/env bash
# Sources the ROS 2 environment before handing off to the requested command.
# Note: `docker exec` bypasses this entrypoint entirely, which is why the same
# environment is also installed as /etc/profile.d/10-ros2.sh and in ~/.bashrc.
set -e

# shellcheck disable=SC1091
source /etc/ros2_env.sh

exec "$@"
