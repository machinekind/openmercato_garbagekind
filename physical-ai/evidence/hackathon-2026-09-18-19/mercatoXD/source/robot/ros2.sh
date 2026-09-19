#!/usr/bin/env bash
# GALAXEO — ROS 2 Humble container control script.
#
#   ./ros2.sh build          Build (or rebuild) the image
#   ./ros2.sh up             Start the container in the background
#   ./ros2.sh shell          Open an interactive ROS 2 shell (starts it if needed)
#   ./ros2.sh run <cmd...>   Run one command inside the container
#   ./ros2.sh colcon         colcon build the workspace
#   ./ros2.sh down           Stop and remove the container
#   ./ros2.sh clean          Remove build/install/log from the workspace
#   ./ros2.sh logs           Follow container logs
#
# Add --gpu before the command to layer in the NVIDIA runtime overlay.

set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

SERVICE=${SERVICE:-ros2}
COMPOSE=(docker compose -f docker-compose.yml)

if [[ "${1:-}" == "--gpu" ]]; then
    COMPOSE+=(-f docker-compose.gpu.yml)
    shift
fi

# --noetic targets the ROS 1 Noetic service (the A1XY SDK's environment).
if [[ "${1:-}" == "--noetic" ]]; then
    SERVICE=noetic
    COMPOSE+=(--profile noetic)
    shift
fi

# Let containers on the local machine talk to the X server (RViz, Gazebo, rqt).
allow_x11() {
    if command -v xhost >/dev/null 2>&1 && [[ -n "${DISPLAY:-}" ]]; then
        xhost +local:root >/dev/null 2>&1 || true
    fi
}

ensure_up() {
    if [[ -z "$("${COMPOSE[@]}" ps -q "${SERVICE}" 2>/dev/null)" ]] \
       || [[ -z "$(docker ps -q --filter "id=$("${COMPOSE[@]}" ps -q "${SERVICE}")")" ]]; then
        allow_x11
        "${COMPOSE[@]}" up -d "${SERVICE}"
    fi
}

CMD="${1:-shell}"
shift || true

case "${CMD}" in
    build)
        "${COMPOSE[@]}" build "$@"
        ;;
    up)
        allow_x11
        "${COMPOSE[@]}" up -d "$@"
        ;;
    shell|sh|bash)
        ensure_up
        allow_x11
        "${COMPOSE[@]}" exec "${SERVICE}" bash
        ;;
    run|exec)
        ensure_up
        allow_x11
        "${COMPOSE[@]}" exec "${SERVICE}" bash -lc "$*"
        ;;
    colcon)
        ensure_up
        "${COMPOSE[@]}" exec "${SERVICE}" bash -lc \
            "colcon build --symlink-install --cmake-args -DCMAKE_BUILD_TYPE=RelWithDebInfo $*"
        ;;
    down|stop)
        "${COMPOSE[@]}" down "$@"
        ;;
    clean)
        rm -rf ros2_ws/build ros2_ws/install ros2_ws/log
        echo "Workspace build artifacts removed."
        ;;
    logs)
        "${COMPOSE[@]}" logs -f "${SERVICE}"
        ;;
    *)
        sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
        exit 1
        ;;
esac
