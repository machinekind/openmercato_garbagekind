# Task: write arm-to-arm teleoperation for two Galaxea A1X arms

You are working in `~/Desktop/GALAXEO` on a Ubuntu 24.04 laptop with two
**Galaxea A1X** 6-DOF robot arms, each on its own PEAK/XCAN USB-CAN FD adapter.

**Do not delete or move anything in this folder.** Existing files are reference
material even where they are not to be reused. Add new files; do not rewrite
history.

---

## Role assignment — fixed, do not swap

    can1  =  LEADER    (moved by hand; read by our driver, namespaced /leader)
    can0  =  FOLLOWER  (mirrors the leader; driven by the vendor HDAS)

This is forced by the hardware, not a preference: **`ARM_APP` hardcodes `can0`**,
so the arm the vendor stack drives can only ever be `can0`. The second arm
(`can1`) must therefore be the leader and is read through our own driver.

## Hardware

* Two identical A1X arms (serial `6117`), grippers fitted on both.
* Each arm is on its own CAN-FD bus: `can0` and `can1`. Bring them up with
  `./can_up.sh` (it picks the arm's adapter by traffic, since both adapters
  report the same USB serial and enumeration order is unstable).
* Bus settings: `bitrate 1000000 sample-point 0.875 dbitrate 5000000
  dsample-point 0.875 fd on`. **`berr-reporting on` is NOT supported** by
  `pcan_usb_fd` and makes `ip link set` fail.
* 24 V supply. The arms have **NO joint brakes** — an unpowered or released arm
  falls under its own weight.
* An e-stop is fitted. When engaged the arm still transmits CAN but reports a
  frozen payload.

## Environment

Everything runs in Docker. `./ros2.sh shell` opens a ROS 2 Humble container
(`docker-compose.yml`, `docker/Dockerfile`). `./ros2.sh colcon` builds the
workspace. The container has host networking, `NET_ADMIN`, and sees `can0`/`can1`
directly. There is also a ROS 1 Noetic container (`--noetic`) that is **not
needed**.

## The vendor SDK (this is the important part)

`a1xy/atc_host_install/` is Galaxea's **x86_64 ATC host SDK V2.0.4**, extracted
and working. It is mounted into the container at `/home/ros/a1xy/atc_host_install`.

Start the vendor driver for the arm on `can0`:

```bash
source /opt/ros/humble/setup.bash
source /home/ros/a1xy/atc_host_install/setup.bash
export LD_LIBRARY_PATH=/home/ros/a1xy/atc_host_install/HDAS/lib:/home/ros/a1xy/atc_host_install/rlog/lib:$LD_LIBRARY_PATH
cd /home/ros/a1xy/atc_host_install && ros2 launch HDAS A1XY.py
```

That gives you, for the `can0` arm only:

| interface | type | direction |
| --- | --- | --- |
| `/hdas/feedback_arm` | `sensor_msgs/JointState` | 6 joints + gripper, 200 Hz |
| `/hdas/feedback_gripper` | `sensor_msgs/JointState` | gripper |
| `/hdas/feedback_status_arm` | `hdas_msg/FeedbackStatus` | error bitfield |
| `/motion_control/control_arm` | `hdas_msg/MotorControl` | joint command |
| `/motion_control/control_gripper` | `hdas_msg/MotorControl` | gripper command |
| `/function_frame_arm` | `hdas_msg/FunctionFrame` | `uint8 command` |

`hdas_msg/MotorControl` is:

```
std_msgs/Header header
string name
float32[] p_des    # rad,   clamped +/-6.5
float32[] v_des    # rad/s, clamped +/-40
float32[] kp       # 0..500
float32[] kd       # 0..200
float32[] t_ff     # +/-50
uint8 mode
```

Control law is MIT impedance: `tau = kp*(p_des-p) + kd*(v_des-v) + t_ff`.
`kp=kd=t_ff=0` therefore commands **exactly zero torque** and cannot move the
arm — use it as the safe idle/release command.

**`ARM_APP` hardcodes `can0`.** The vendor stack can only ever drive one arm, so
the second arm needs its own path.

### Inspect what the SDK actually puts on the wire

This is worth doing before writing anything: run the vendor stack, publish to
`/motion_control/control_arm` or `/motion_control/control_gripper`, and watch
`candump can0`. The decoded CAN protocol is documented below but you should
confirm it yourself.

## Decoded CAN protocol (verified on the wire)

| id | dir | size | meaning |
| --- | --- | --- | --- |
| `0x023` | host->arm | 1 B | heartbeat emitted by vendor HDAS |
| `0x050` | host->arm | 60 B | joint command, 6 joints x 5 int16 |
| `0x051` | host->arm | 10 B | gripper command, 1 x 5 int16 |
| `0x052` | arm->host | 48 B | feedback, 7 groups x 3 int16 (6 joints + gripper) |
| `0x053` | host->arm | 1 B | function frame, payload = code |
| `0x054` | arm->host | 16 B | temperatures |
| `0x055` | arm->host | 64 B | version / serial |

All fields are **big-endian int16**. Per joint, in order:

| field | clamp | scale (divide raw by this) |
| --- | --- | --- |
| position / `p_des` | +/-6.5 rad | 4700 |
| velocity / `v_des` | +/-40 rad/s | 750 |
| `kp` | 0..500 | 60 |
| `kd` | 0..200 | 150 |
| effort / `t_ff` | +/-50 | 600 |

`0x052` is 7 groups of `[position, velocity, effort]` then a constant 6-byte
footer `5C2E 0024 A827`. The gripper is group 7.

**SocketCAN detail that will bite you:** you must write a complete frame struct
— 16 bytes for classic `can_frame`, 72 for `canfd_frame` — and the `len` field
must carry the *actual* payload length. Rounding 10 up to 12 makes the gripper
silently ignore the frame.

`0x053` function frame codes, established empirically:
`1` and `6` energise the motors; `2`, `3`, `4` release them; `5` clears the
DISCONNECT error bit; `0` is rejected as `Invalid command`. Codes above 6 are
**undocumented — do not send them.** Sweeping 7..16 appears to have left one arm
in a persistently locked state that survives power cycling.

## Our own driver — use this for the second arm

`ros2_ws/src/galaxea_a1xy_driver/` is a working SocketCAN driver:

* `protocol.py` — encode/decode, CAN ids, scales. Self-tested (`python3 protocol.py`).
* `can_io.py` — socket open/read/write.
* `driver_node.py` — publishes `hdas/feedback_arm`, `hdas/feedback_gripper`,
  `joint_states` (relative names, so `__ns:=/leader` works). Read-only unless
  `command_can_id` is set. Silent by default.
* `can_probe.py` — standalone read-only bus check.

Run it against the second arm:

```bash
ros2 run galaxea_a1xy_driver driver_node --ros-args \
  -r __ns:=/leader -p can_interface:=can1
```

`ros2_ws/src/galaxea_a1xy_description/` has the A1X URDF and meshes.
`ros2_ws/src/galaxea_a1xy_msgs/` has a `MotorControl` mirror.

## THE BLOCKER — read this before designing anything

Hand-guided teleoperation currently **does not work**, and it is a hardware
state problem, not a code problem:

* With motors **enabled**, the arm reports joint position at 200 Hz but resists
  by hand and will not move (effort rises to ~1.7, motion ~0.02 deg).
* With motors **released** (codes 2/3/4), the arm is freely hand-movable but
  `0x052` freezes to a **single identical payload** — 2601 frames, 1 distinct,
  zero varying bytes while being moved. No encoder data at all.
* Streaming zero-gain commands (`kp=kd=t_ff=0`) while enabled does **not**
  release the hold.

Earlier in the project the arm was both reporting and compliant, before anything
had ever transmitted on its bus, so a correct teach/backdrive mode exists — we
do not know how to enter it. **Do not brute-force function-frame codes to look
for it.**

Practical consequence: if the leader is stiff, teleop still works when the arm
is forced by hand, but that is not the intended feel. Treat finding the teach
mode as a separate question (ask Galaxea support: support@galaxea.ai).

## IGNORE the existing teleop work

**Do not read, run, reuse, or extend any of these. Write teleop from scratch.**

* `teleop.sh`, `teleop_1.sh` (top level)
* `ros2_ws/teleop.py`, `ros2_ws/teleop_1.py`

They accumulated patch-on-patch and are not a good base. Leave the files in
place; just do not build on them.

Everything else in `ros2_ws/*.py` is one-off diagnostic scripts from protocol
reverse engineering (gripper probes, function-frame sweeps, gravity/torque
tests, CAN byte correlation). They are **reference only** — useful to read for
how something was measured, not to be run or imported.

`ros2_ws/record.sh` (MCAP recording) and `ros2_ws/to_lerobot.py` (MCAP ->
LeRobot v2.1 parquet, `robot_type: galaxea_a1x`) do work if you need datasets.
`a1xy/recordings/` and `a1xy/lerobot/` hold earlier captures.

## What to build

A fresh arm-to-arm teleop node: read the leader arm's joint positions from our
driver on `can1`, command the follower through the vendor HDAS on `can0`.

Design points learned the hard way:

* **Use relative (delta) mapping**: `p_des = follower_start + (leader_now -
  leader_ref)`. The two arms sit at different poses and have different zero
  calibrations; absolute mirroring produces a large jump at startup.
* **Clamp every target** to the A1X URDF limits: J1 +/-165 deg, J2 0..180,
  J3 -190..0, J4 +/-90, J5 +/-90, J6 +/-165. J3 in particular sits near its
  limit and reads ~1.5 deg outside it (a zero offset).
* **Rate-limit** target motion; ~90 deg/s is comfortable.
* **Ease the gains in** over a few seconds rather than stepping them.
* **Drain the callback queue each cycle** and use depth-1 sensor QoS. Two 200 Hz
  streams against a 100 Hz loop will otherwise starve and you will act on stale
  samples.
* **Never integrate a deadband into the target** — discarded increments
  accumulate as drift and slow leader motion is silently dropped.
* **Release (`kp=kd=0`) on every exit path**, including exceptions and Ctrl-C.
  Do not call `rclpy` from a signal handler; set a flag instead.
* **Detect a frozen leader** (identical payload) and say so, rather than
  silently doing nothing.
* Start gains gentle: `kp=25, kd=3`. Gravity-loaded joints (J2, J3) sag slightly
  at that stiffness; that is expected.

Gripper is optional and separate. It is **not backdrivable**, so the leader's
gripper cannot be a teleop input — drive it from a key/button instead. Closing
must be force-limited (stop advancing the target on contact, ~1.2 effort) or it
crushes whatever it is holding.

## Safety

* No joint brakes. Support any arm before releasing it or powering it down.
* Verify before commanding: leader and follower both publishing, leader data
  actually varying, service available.
* First command of any session should be zero-torque.
* The e-stop is the only hardware override; the grippers are not backdrivable.
