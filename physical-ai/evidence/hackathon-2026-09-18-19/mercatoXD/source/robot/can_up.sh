#!/usr/bin/env bash
# Bring up the Galaxea A1X arm's CAN-FD bus as can0.
#
# Selects the arm's adapter by LISTENING FOR TRAFFIC rather than by USB port
# path: the two XCAN-USB FD adapters report an identical serial
# (XCAN_XCAN-USB_FD), and enumeration order has proven unstable across replugs
# (observed at 1-1.4, 1-2.4 and 1-1 on different days). Traffic is the only
# reliable discriminator.
#
# HDAS / ARM_APP hardcode the interface name "can0", so the arm's adapter is
# renamed to can0 if it came up as something else.
#
# Runs inside a container that has NET_ADMIN and shares the host network
# namespace -- no sudo on the host required.
#
#   ./can_up.sh                # ROS 2 (Humble) container
#   ./can_up.sh --noetic       # ROS 1 (Noetic) container
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

SERVICE=ros2
COMPOSE=(docker compose -f docker-compose.yml)
if [[ "${1:-}" == "--noetic" ]]; then
    SERVICE=noetic; COMPOSE+=(--profile noetic); shift
fi

BITRATE=1000000; DBITRATE=5000000; SP=0.875
# NOTE: 'berr-reporting on' (present in the vendor's R1 script) is NOT supported
# by pcan_usb_fd and makes `ip link set` fail. Deliberately omitted.

"${COMPOSE[@]}" exec -T "${SERVICE}" bash -s <<EOF
set -uo pipefail

configure() {  # \$1 = interface
    sudo ip link set "\$1" down 2>/dev/null
    sudo ip link set "\$1" type can \
         bitrate ${BITRATE} sample-point ${SP} \
         dbitrate ${DBITRATE} dsample-point ${SP} \
         fd on restart-ms 100 || return 1
    sudo ip link set "\$1" txqueuelen 65535
    sudo ip link set "\$1" up || return 1
}

ifaces=\$(ls /sys/class/net 2>/dev/null | grep -E '^can[0-9]+\$' || true)
if [ -z "\$ifaces" ]; then
    echo "ERROR: no CAN interfaces. Is the adapter plugged in?"
    exit 1
fi

echo "--- candidates ---"
for n in \$ifaces; do
    dev=\$(readlink -f "/sys/class/net/\$n/device" 2>/dev/null)
    echo "  \$n  usb=\$(basename "\$(dirname "\$dev")" 2>/dev/null)"
done

# Configure every candidate, then pick whichever actually carries traffic.
arm=""
for n in \$ifaces; do
    configure "\$n" >/dev/null 2>&1 || { echo "  \$n: config failed"; continue; }
    frames=\$(timeout -k 1 2 candump "\$n" </dev/null 2>/dev/null | wc -l)
    echo "  \$n: \$frames frames in 2s"
    [ "\$frames" -gt 0 ] && [ -z "\$arm" ] && arm="\$n"
done

if [ -z "\$arm" ]; then
    echo
    echo "ERROR: no CAN traffic on any interface."
    echo "  * is the arm powered on (48V supply, switch ON)?"
    echo "  * is the CAN cable seated at BOTH ends?"
    echo "  * check bus health:  ip -det -s link show can0"
    exit 2
fi
echo "--- arm is on \$arm ---"

# HDAS hardcodes can0, so make the arm's adapter be can0.
if [ "\$arm" != "can0" ]; then
    if ip link show can0 >/dev/null 2>&1; then
        sudo ip link set can0 down
        sudo ip link set can0 name can_other
        echo "renamed the other adapter can0 -> can_other"
    fi
    sudo ip link set "\$arm" down
    sudo ip link set "\$arm" name can0
    echo "renamed \$arm -> can0"
    configure can0 >/dev/null 2>&1
fi

echo "--- can0 ---"
ip -det link show can0 | sed -n '1,3p'
n=\$(timeout -k 1 2 candump can0 </dev/null 2>/dev/null | wc -l)
echo "frames in 2s: \$n  (~\$((n/2)) Hz)"
[ "\$n" -gt 0 ] && echo "OK: arm is streaming on can0."
EOF
