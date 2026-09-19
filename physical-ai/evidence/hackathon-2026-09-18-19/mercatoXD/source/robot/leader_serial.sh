#!/usr/bin/env bash
# Drive the LEADER arm over its USB SERIAL port instead of CAN-FD.
#
#   ./leader_serial.sh check     is the port there, and does the arm report?
#   ./leader_serial.sh driver    start the vendor signal_arm driver (ROS 1 Noetic)
#   ./leader_serial.sh limp      stream a zero-stiffness MIT command and watch
#   ./leader_serial.sh stop
#
# WHY THIS EXISTS
# ---------------
# Over CAN-FD the A1X will not go compliant, and that is measured, not assumed:
#
#   kp is not a stiffness knob   a 3 deg step tracks 98% and reaches half-way in
#                                ~0.18 s at kp=0.5 and at kp=20 alike
#   t_ff does nothing            +/-1.5 Nm -> 0.00 deg, on BOTH arms
#   kp=0 is discarded            the arm keeps holding its own setpoint
#   released (FF 2/3/4)          free, but 0x052 freezes -- and streaming
#                                commands while released does NOT revive it
#   the `mode` byte never ships  mode 0/1/2/3/10 all produce byte-identical
#                                60-byte 0x050 frames, and `arm_control_command`
#                                in libdispatcher.so has no mode field at all
#
# So the MIT impedance law is simply not reachable through the ATC host SDK's
# CAN-FD path. But Galaxea's OTHER driver -- `signal_arm`, the one behind their
# Tabletop Teleoperation product (github.com/userguide-galaxea/Tabletop_Teleoperation_SDK)
# and A1_SDK -- talks to the arm's ACU over USB SERIAL, and ITS command message
# carries the mode byte. The A1 driver docs describe it as:
#
#     mode | Control Mode | uint8 | Default is 0, MIT control
#
# That product is four arms teleoperating each other, leader ("host") included,
# and it makes the leader compliant by COMMANDING it: mobiman_tabletop_tele_node
# publishes to /arm_joint_command_host_*. So the capability exists on this
# hardware family -- over serial.
#
# CAVEAT, READ IT
# ---------------
# NONE of this has been run against your arm. The serial cable was not connected
# when it was written, so `check` is the first thing to run and the only thing
# proven to be safe. The SDK is prebuilt for Ubuntu 20.04 / ROS Noetic, which is
# why it runs in the `noetic` container rather than the Humble one.
#
# The A1 SDK targets the A1 (0.349 m upper arm); yours is an A1X (0.30 m). The
# kinematics differ, but the driver only moves joints -- it does no kinematics --
# so a mismatch shows up in mobiman, not here.
#
# SAFETY: the arm has NO BRAKES. `limp` is the command that makes it go slack.
# Hold it.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

PORT="${PORT:-/dev/ttyACM0}"
COMPOSE=(docker compose -f docker-compose.yml --profile noetic)
SVC=noetic
SDK=/home/ros/a1xy/a1_driver_sdk/install

SETUP="source /opt/ros/noetic/setup.bash; source ${SDK}/setup.bash"

need_port() {
    if [ ! -e "${PORT}" ]; then
        echo "  ${PORT} does not exist."
        echo
        echo "  Plug the LEADER arm's USB cable into the laptop, then re-run."
        echo "  Ports currently present:"
        ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null | sed 's/^/    /' || echo "    (none)"
        echo "  USB devices:"
        lsusb | grep -viE "root hub|Camera|Bluetooth|Genesys|Microdia" | sed 's/^/    /'
        exit 1
    fi
}

up() { sg docker -c "${COMPOSE[*]} up -d ${SVC}" >/dev/null; }

case "${1:-check}" in

check)
    need_port
    echo "  ${PORT} present:"
    ls -l "${PORT}" | sed 's/^/    /'
    echo "  bringing up the noetic container ..."
    up
    sg docker -c "${COMPOSE[*]} exec -T ${SVC} bash -lc '
        ls -l ${PORT} 2>&1 | sed \"s/^/    container sees: /\"
        test -r ${PORT} && echo \"    readable\" || echo \"    NOT READABLE -- run: sudo chmod 666 ${PORT}\"
        test -d ${SDK} && echo \"    SDK present at ${SDK}\" || echo \"    SDK MISSING at ${SDK}\"
    '"
    ;;

driver)
    need_port
    up
    echo "  starting signal_arm iarm_node on ${PORT} (ROS 1 Noetic)"
    echo "    feedback -> /joint_states_host        command -> /arm_joint_command_host"
    sg docker -c "${COMPOSE[*]} exec -T ${SVC} bash -lc '
        ${SETUP}
        (roscore >/tmp/roscore.log 2>&1 &) ; sleep 3
        roslaunch signal_arm single_arm_node.launch \
            single_arm_serial_port_path:=${PORT} >/tmp/iarm.log 2>&1 &
        sleep 6
        echo \"--- driver log ---\"; tail -15 /tmp/iarm.log
        echo \"--- is it reporting? ---\"
        timeout 6 rostopic hz /joint_states_host 2>&1 | tail -3
    '"
    ;;

limp)
    need_port
    echo "======================================================================"
    echo "  The LEADER is about to be commanded ZERO STIFFNESS over serial:"
    echo "    kp = 0, kd = 0.2, t_ff = 0, mode = 0 (MIT)"
    echo
    echo "  If serial MIT control works where CAN-FD did not, the arm goes"
    echo "  slack. It has NO BRAKES and carries none of its own weight."
    echo "  HOLD THE ARM NOW."
    echo "======================================================================"
    read -r -p "  holding it? [y/N] " ok </dev/tty
    [[ "${ok}" =~ ^[Yy]$ ]] || { echo "  aborted."; exit 1; }
    sg docker -c "${COMPOSE[*]} exec -T ${SVC} bash -lc '
        ${SETUP}
        python3 - <<\"PY\"
import rospy, time
from signal_arm.msg import arm_control
from sensor_msgs.msg import JointState

rospy.init_node(\"leader_limp\", anonymous=True)
pub = rospy.Publisher(\"/arm_joint_command_host\", arm_control, queue_size=10)
state = {\"q\": None, \"n\": 0}
def cb(m):
    state[\"q\"] = list(m.position[:6]); state[\"n\"] += 1
rospy.Subscriber(\"/joint_states_host\", JointState, cb)

t0 = time.time()
while state[\"q\"] is None and time.time() - t0 < 5:
    time.sleep(0.05)
if state[\"q\"] is None:
    print(\"  no feedback on /joint_states_host -- is the driver running?\")
    raise SystemExit(1)
start = list(state[\"q\"]); n0 = state[\"n\"]
print(\"  start pose (rad):\", [round(v, 3) for v in start])

r = rospy.Rate(200)
t0 = time.time()
while time.time() - t0 < 15 and not rospy.is_shutdown():
    m = arm_control()
    m.header.stamp = rospy.Time.now()
    m.p_des = list(state[\"q\"])      # ignored at kp=0; harmless if it is not
    m.v_des = [0.0]*6
    m.kp    = [0.0]*6               # zero stiffness
    m.kd    = [0.2]*6               # a little damping, never zero
    m.t_ff  = [0.0]*6
    m.mode  = 0                     # 0 = MIT control
    pub.publish(m)
    r.sleep()

moved = max(abs(a-b) for a, b in zip(state[\"q\"], start))
print(\"  end pose   (rad):\", [round(v, 3) for v in state[\"q\"]])
print(\"  feedback kept flowing:\", state[\"n\"] - n0, \"msgs\")
print(\"  largest joint movement: %.3f rad\" % moved)
print(\"  -> try moving it by hand NOW while this runs; if it yields, serial MIT works\")
PY
    '"
    ;;

stop)
    sg docker -c "${COMPOSE[*]} exec -T ${SVC} bash -lc \"pkill -f '[i]arm_node'; pkill -f '[r]oscore'; true\"" || true
    echo "  stopped."
    ;;

*)  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//' ; exit 1 ;;
esac
