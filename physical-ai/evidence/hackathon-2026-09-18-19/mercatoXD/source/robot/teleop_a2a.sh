#!/usr/bin/env bash
# Arm-to-arm teleoperation for two Galaxea A1X arms.
#
#   can0 = FOLLOWER   vendor HDAS / ARM_APP (hardcoded to can0), impedance control
#   can1 = LEADER     our SocketCAN driver, read-only, guided by hand
#
#   ./teleop_a2a.sh              bring up all three pieces and attach to teleop
#   ./teleop_a2a.sh --teach      leader in zero-gravity float mode (see below)
#   ./teleop_a2a.sh --gripper    also enable the (uncalibrated) gripper
#   ./teleop_a2a.sh --stop       stop everything started here
#
# TEACH MODE = ZERO-GRAVITY FLOAT, and it needs a calibration first
# -----------------------------------------------------------------
# An A1X has two OBVIOUS motor states, and neither is usable as a leader:
#
#   enabled (code 1 or 6)   stiff, and REPORTING
#   released (code 2/3/4)   free, but the 0x052 payload FREEZES -- no encoders
#
# Streaming ZERO torque (kp = kd = t_ff = 0) at an enabled arm does NOT soften
# it -- measured here, J2 effort stayed at 1.28 -> 1.57 with 301 zero-torque
# frames confirmed on the wire, on our SocketCAN path and the vendor's alike.
# An all-zero payload does not appear to count as a command at all.
#
# The state that DOES work is the one Galaxea's own A1Z SDK calls zero-gravity
# mode, and the A1X speaks the same MIT law on 0x050. Keep the motors ENERGISED
# -- that is what keeps the encoders alive -- and command
#
#   kp = 0            no position servo
#   kd = small, > 0   damping only (never zero -- see above)
#   t_ff = g(q)       cancels the arm's own weight, recomputed every cycle
#
# so the arm carries itself, resists nothing, and keeps reporting.
#
# t_ff is OPEN LOOP: a wrong sign makes a brakeless arm fall faster than free
# fall. So --teach refuses to transmit until a calibration exists that was
# fitted against this arm's own measured hold torque and passed its checks:
#
#   ./ros2.sh run "cd /home/ros/ros2_ws && python3 leader_float.py --check"
#
# --check is READ-ONLY -- it transmits nothing. It walks you through a handful
# of poses, regresses measured effort against the URDF model, and writes
# ros2_ws/leader_gravity.json. Try float mode on its own before teleop:
#
#   ./ros2.sh run "cd /home/ros/ros2_ws && python3 leader_float.py --factor 0.3"
#
# --factor N scales the compensation here too; start below 1.0.
#
# SAFETY
# ------
# Neither arm has joint brakes. The moment the leader enters float mode its own
# hold is replaced by our torque -- if the calibration is off it WILL SAG.
# Support it before confirming, and use a low --factor the first time. The
# follower goes limp on every teleop release (key 'r', spacebar, Ctrl-C, or any
# lost-feedback fault). The e-stop is the only hardware override.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

COMPOSE=(docker compose -f docker-compose.yml)
SERVICE=ros2
GRIPPER=false
TEACH=false
ASSUME_YES=false
GRAV_FACTOR=1.0

# pgrep/pkill run inside `bash -lc "<pattern>"`, so a bare pattern matches the
# shell that is running it and every check returns true. Bracketing the first
# character ("ARM_APP" -> "[A]RM_APP") still matches the real process but no
# longer matches the command line doing the matching.
bracket() { printf '[%s]%s' "${1:0:1}" "${1:1}"; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --gripper)  GRIPPER=true ;;
        --teach)    TEACH=true ;;
        --factor)   shift; GRAV_FACTOR="$1" ;;
        --yes|-y)   ASSUME_YES=true ;;
        --stop)
            "${COMPOSE[@]}" exec -T "${SERVICE}" bash -lc \
                "pkill -f '$(bracket "ros2 launch HDAS")' ; \
                 pkill -f '$(bracket ARM_APP)' ; \
                 pkill -f '$(bracket galaxea_a1xy_driver)' ; \
                 pkill -f '$(bracket teleop_node)' ; true"
            echo "stopped."
            exit 0 ;;
        *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
    esac
    shift
done

# ROS 2 infers a parameter's type from how it is written: `0` is an INTEGER and
# `0.0` is a DOUBLE. Pass the bare 0 and the driver refuses the parameter and
# exits, which surfaces only as "leader is not publishing".
case "${GRAV_FACTOR}" in *.*) ;; *) GRAV_FACTOR="${GRAV_FACTOR}.0" ;; esac

SETUP='source /opt/ros/humble/setup.bash
source /home/ros/a1xy/atc_host_install/setup.bash
source /home/ros/ros2_ws/install/setup.bash
export LD_LIBRARY_PATH=/home/ros/a1xy/atc_host_install/HDAS/lib:/home/ros/a1xy/atc_host_install/rlog/lib:${LD_LIBRARY_PATH:-}'

running() {
    "${COMPOSE[@]}" exec -T "${SERVICE}" bash -lc \
        "pgrep -f '$(bracket "$1")' >/dev/null" 2>/dev/null
}

kill_all() {
    "${COMPOSE[@]}" exec -T "${SERVICE}" bash -lc \
        "pkill -f '$(bracket "$1")'; true" >/dev/null 2>&1
    sleep 1
}

# Count ROS NODES, not processes. Process counting cannot answer this question:
# `ros2 run` leaves a wrapper process beside the node it launches, so one
# driver already reads as two, and any pattern loose enough to catch the real
# binary also catches the shell that is doing the matching.
# `ros2 node list` counts the thing we actually care about -- how many nodes are
# on the graph publishing and subscribing.
node_count() {
    "${COMPOSE[@]}" exec -T "${SERVICE}" bash -lc \
        "${SETUP}; timeout 12 ros2 node list 2>/dev/null | grep -cx '$1' || true" \
        2>/dev/null | tr -d '\r\n '
}

# A second copy of any of these is worse than none. Two ARM_APP instances both
# subscribe to /motion_control/control_arm and both publish /hdas/feedback_arm,
# so the follower's feedback reaches teleop from two publishers into a depth-1
# best-effort subscription -- which reads as a feedback GAP. Teleop then
# releases itself mid-session and the follower goes limp and stops following.
# The old guard only asked "is one running?", which is equally true of two, so
# duplicates accumulated silently across runs. Insist on exactly one.
require_single() {
    local node="$1" proc="$2" n
    n="$(node_count "${node}")"
    if [ "${n:-0}" -gt 1 ]; then
        echo "    found ${n} copies of ${node} on the graph -- killing all, starting one"
        kill_all "${proc}"
        return 1
    fi
    [ "${n:-0}" -eq 1 ]
}

# ---------------------------------------------------------------- follower ---
echo "--- follower: vendor HDAS on can0 ---"
if require_single /arm_node ARM_APP; then
    echo "    already running (1 instance)"
else
    "${COMPOSE[@]}" exec -d "${SERVICE}" bash -lc \
        "${SETUP}; cd /home/ros/a1xy/atc_host_install && ros2 launch HDAS A1XY.py"
    sleep 4
fi

# ------------------------------------------------------------------ leader ---
# The driver must be restarted to change teach mode, since backdrive is set at
# construction. Only bounce it if it is not already in the mode we want.
WANT_BD="$([ "${TEACH}" = true ] && echo true || echo false)"
require_single /leader/a1xy_driver galaxea_a1xy_driver || true
if running "backdrive:=${WANT_BD}"; then
    echo "--- leader: driver on can1 already in the requested mode ---"
else
    if running galaxea_a1xy_driver; then
        echo "--- leader: restarting driver to switch teach mode ---"
        "${COMPOSE[@]}" exec -T "${SERVICE}" bash -lc \
            "pkill -f '$(bracket galaxea_a1xy_driver)'; true"
        sleep 1
    fi
    if [ "${TEACH}" = true ]; then
        echo
        echo "=============================================================="
        echo " The LEADER arm on can1 is about to be energised and made"
        if [ "${GRAV_FACTOR}" = "0.0" ]; then
            echo " COMPLIANT: kp=0, light damping, NO feedforward torque."
            echo " Nothing can drive it -- but it carries none of its own"
            echo " weight either, so it WILL SAG the moment you let go."
        else
            echo " to FLOAT: kp=0, light damping, and a feedforward torque of"
            echo " ${GRAV_FACTOR}x its own weight, so it carries itself."
            echo " If the calibration is off it WILL SAG."
        fi
        echo
        echo " It has NO BRAKES."
        echo " SUPPORT THE LEADER ARM NOW."
        echo "=============================================================="
        if [ "${ASSUME_YES}" != true ]; then
            read -r -p " holding it? [y/N] " ok </dev/tty
            [[ "${ok}" =~ ^[Yy]$ ]] || { echo "aborted."; exit 1; }
        fi
    fi
    echo "--- leader: driver on can1 (teach=${TEACH}) ---"
    "${COMPOSE[@]}" exec -d "${SERVICE}" bash -lc \
        "${SETUP}; ros2 run galaxea_a1xy_driver driver_node \
         --ros-args -r __ns:=/leader -p can_interface:=can1 \
         -p backdrive:=${WANT_BD} -p gravity_factor:=${GRAV_FACTOR}"
    sleep 3
fi

# ------------------------------------------------------------------ teleop ---
# Any teleop_node left over from a previous run still publishes to
# /motion_control/control_arm -- including the zero-torque stream it emits once
# released. Interleaved with a live session's commands on the same topic, that
# is a follower that twitches and does not track. Never leave one behind.
if [ "$(node_count /a1x_teleop)" != "0" ]; then
    echo "--- teleop: stopping a teleop_node left over from an earlier run ---"
    kill_all teleop_node
fi
echo
echo "--- teleop ---"
echo "    move the LEADER (can1) by hand; the FOLLOWER (can0) copies it"
echo "    e engage/clutch   r release   space panic   o/c/x gripper   ? status   q quit"
echo
exec "${COMPOSE[@]}" exec "${SERVICE}" bash -lc \
    "${SETUP}; ros2 run galaxea_a1xy_teleop teleop_node \
     --ros-args --params-file /home/ros/ros2_ws/install/galaxea_a1xy_teleop/share/galaxea_a1xy_teleop/config/teleop.yaml \
     -p enable_gripper:=${GRIPPER}"
