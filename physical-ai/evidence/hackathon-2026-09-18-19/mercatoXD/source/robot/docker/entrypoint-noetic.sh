#!/usr/bin/env bash
# Sources the ROS Noetic environment before handing off to the requested command.
set -e
# shellcheck disable=SC1091
source /etc/ros1_env.sh
exec "$@"
