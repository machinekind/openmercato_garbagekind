# Hardware

The setup this repo was developed against: a **Galaxea A1X** 6-DOF arm with a
gripper, wired directly to an x86_64 Ubuntu laptop over CAN-FD. Some work was
done with two identical arms on two adapters.

## Power and wiring

* **24 V** supply — not 48 V, despite what some notes elsewhere say.
* The CAN box has termination switches **R1 and R2, both in the top position**.
* Adapters: XCAN / PEAK USB-CAN-FD, USB id `0c72:0012`, kernel driver
  `peak_usb`.

> **No brakes.** Cutting power drops the arm. Read [SAFETY.md](SAFETY.md).

## Bus settings

These are the vendor's own timings, from `start_hdas_r1.sh`:

```bash
ip link set can0 type can \
    bitrate 1000000 sample-point 0.875 \
    dbitrate 5000000 dsample-point 0.875 \
    fd on restart-ms 100
ip link set can0 txqueuelen 65535
ip link set can0 up
```

**Omit `berr-reporting on`.** It appears in Galaxea's R1 script, but
`pcan_usb_fd` does not support it and its presence makes the whole `ip link
set` fail. `can_up.sh` leaves it out.

Links come up **down** after every replug. Re-run `./can_up.sh`.

## Telling two adapters apart

Both XCAN adapters report the identical `ID_SERIAL` (`XCAN_XCAN-USB_FD`), so
the serial is useless as a handle. Two options, both imperfect:

* **By traffic** — what `can_up.sh` does. It configures every interface,
  listens 2 s on each, and takes whichever carries frames. Reliable with one
  arm; a coin flip with two, since **both** arms transmit unprompted at 200 Hz.
* **By USB port path** — stable within a session, but enumeration order has
  been observed to move across replugs (`1-1.4`, `1-2.4`, `1-1` on different
  days).

With two arms, settle it empirically instead:

```bash
python3 which_arm.py can0 can1
```

Read-only. Push each arm by hand in turn and watch which line reacts:

| output | meaning |
| --- | --- |
| `MOVING` | joints changing — compliant *and* reporting |
| `still` | reporting but not moving: nobody is pushing, or it is holding against you |
| `FROZEN` | identical payloads — transmitting but not reporting. This is the released state (function frame 2); such an arm is useless as a leader |

The vendor's `ARM_APP` **hardcodes `can0`** and has no parameter to change it,
so whichever arm the vendor stack drives has to be `can0`. Our own code takes
an interface argument and doesn't care.

## Joint limits

From the A1X URDF in `ros2_ws/src/galaxea_a1xy_description/`.

| joint | axis | limit (rad) | limit (deg) |
| --- | --- | --- | --- |
| `arm_joint1` | base yaw | −2.880 … 2.880 | −165 … 165 |
| `arm_joint2` | shoulder pitch | 0.0 … 3.142 | 0 … 180 |
| `arm_joint3` | elbow pitch | −3.316 … 0.0 | −190 … 0 |
| `arm_joint4` | wrist pitch | −1.571 … 1.571 | −90 … 90 |
| `arm_joint5` | wrist yaw | −1.571 … 1.571 | −90 … 90 |
| `arm_joint6` | wrist roll | −2.880 … 2.880 | −165 … 165 |

`arm_joint3` reads about **+1.5 deg** at rest, i.e. just outside its own upper
limit. This is systematic across every capture and is a zero-offset, not a
decode error — the group→joint mapping was confirmed independently by a push
test. Compensate with `joint_offsets` in
`ros2_ws/src/galaxea_a1xy_driver/config/driver.yaml`, after measuring your own.

## Resting behaviour

Worth knowing, because it looks like a fault and isn't:

* An arm with **zero frames transmitted to it** still holds its position and
  still reports `0x052` at 200 Hz. That is the hardware's resting state.
* It is a position servo with finite stiffness, not a brake. You can deflect it
  by hand and the motors put it back. Measured excursion under hand force with
  nothing transmitting: 0.05–0.07 deg.
* An arm that has been released (function frame 2) goes limp **and stops
  reporting** — the same payload repeats forever.

## The SO-101 leader

The arm cannot be hand-guided (see
[STEERING.md](STEERING.md#why-there-is-no-float-mode)), so hand teleoperation
uses a [SO-101](https://github.com/TheRobotStudio/SO-ARM100) as the leader.

* USB serial, `/dev/ttyACM0`.
* Calibrated through LeRobot under a calibration id — `my_leader` by default in
  these scripts.
* Its URDF is at `so101/so101_new_calib.urdf`; `kinematics.py` parses it
  directly, no ROS and no pinocchio involved.
* Measured workspace ratio, A1X / SO-101 95th-percentile reach: **1.657**.

One gotcha that costs an afternoon: `bus.sync_read("Present_Position")` returns
**bare motor names**, while lerobot's `get_action()` returns `<name>.pos`.
Mixing the two yields a silent 0.0 everywhere through `dict.get` defaults
rather than an error.
