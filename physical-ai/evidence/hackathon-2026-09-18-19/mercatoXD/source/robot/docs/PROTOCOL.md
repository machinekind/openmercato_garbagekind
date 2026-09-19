# A1X CAN-FD protocol

Galaxea does not publish this. It was recovered by disassembling
`a1_arm_analysis::arm_decode_impl` / `arm_encode_impl` in the vendor's
`libprotocol_modules.so`, then verified frame-by-frame against a live arm and
against the vendor's own HDAS transmitting on the wire. Every constant below is
read out of the binary, not guessed, and every saturation branch cross-checks.

Implemented in
[`ros2_ws/src/galaxea_a1xy_driver/galaxea_a1xy_driver/protocol.py`](../ros2_ws/src/galaxea_a1xy_driver/galaxea_a1xy_driver/protocol.py).

## Bus

CAN-FD, `bitrate 1000000 sample-point 0.875`, `dbitrate 5000000
dsample-point 0.875`, `fd on`, `restart-ms 100`. See [HARDWARE.md](HARDWARE.md).

## Frame map

All ids verified on the wire.

| id | direction | size | meaning |
| --- | --- | --- | --- |
| `0x023` | host → arm | 1 B | heartbeat the vendor HDAS emits at 2–4 Hz. Not required |
| `0x050` | host → arm | 60 B | joint command, 6 joints × 5 int16 |
| `0x051` | host → arm | 10 B | gripper command, 1 joint × 5 int16 |
| `0x052` | arm → host | 48 B | feedback at 200 Hz, 7 groups × 3 int16 |
| `0x053` | host → arm | 1 B | function frame (enable / release / clear) |
| `0x054` | arm → host | 16 B | status word, 1 Hz — **not** temperatures, see below |
| `0x055` | arm → host | 64 B | version / serial, 1 Hz (ASCII `6117`) |

Everything is **big-endian int16**. `rev16` in the decoder's disassembly
confirms it on the read side; the encoder stores the high byte first with a
plain `strb`, no byte swap.

## 0x052 — feedback

48 bytes = **7 groups × 3 int16**, then a constant 6-byte footer
`5C2E 0024 A827`. Groups are J1…J6 then the gripper; fields per group are
`[position, velocity, effort]`.

| field | divisor | unit |
| --- | --- | --- |
| position | 4700.0 | rad |
| velocity | 750.0 | rad/s |
| effort | 600.0 | (N·m?) |

Constants materialised at `0x20774` / `0x2078c` / `0x2079c` in
`arm_decode_impl`.

**The group→joint mapping is confirmed**, not assumed. With the arm powered and
servo-holding, pushing on the forearm raised mean `|effort|` by 22.5× on J4,
7.8× on J3, 5.5× on J2 and 3.3× on J1, while J5, J6 and the gripper were
unchanged (0.9–1.2×). That is the correct kinematic signature for an elbow
push, so the slot order is right.

Which is also why J3 reading ~+0.026 rad (+1.49 deg) at rest is a **zero-offset
/ calibration difference and not a decode error**. The driver's `joint_offsets`
parameter (radians, subtracted from the raw reading) compensates.

### Group 7 is not the gripper position

An earlier reading of this protocol assumed it was. It is not. The vendor
publishes 3.1–3.4 rad on `/hdas/feedback_gripper`, and that value does not
appear anywhere in the 48-byte payload under any of the `/4700`, `/750`, `/600`
or `/1000` scales — all 24 int16 fields were checked. Gripper feedback is
decoded from elsewhere or derived, likely through the unexplained constants in
`arm_decode_impl` (100.0, 17.5, 6.69696, 20.09088, 46.87872, 33.48480, 5.5),
which look like a stroke conversion.

**Unresolved.** If you need gripper position, measure it, don't read it out of
`0x052`.

## 0x050 — joint command

60 bytes = **6 joints × 10 bytes**, five big-endian int16 per joint in the
order `p_des, v_des, kp, kd, t_ff`.

| field | clamp | scale | byte offset within the joint |
| --- | --- | --- | --- |
| `p_des` | ±6.5 rad | 4700.0 | 0,1 |
| `v_des` | ±40 rad/s | 750.0 | 2,3 |
| `kp` | 0 … 500 | 60.0 | 4,5 |
| `kd` | 0 … 200 | 150.0 | 6,7 |
| `t_ff` | ±50 | 600.0 | 8,9 |

Joint *j* starts at byte `j*10`; field *k* at `j*10 + k*2`.

The clamps cross-check against the scales exactly: 6.5 × 4700 = 30550 =
`0x7756`, and 40 × 750 = 200 × 150 = 50 × 600 = 30000 = `0x7530`. The `p_des`
and `t_ff` scales equal the decoder's position and effort divisors, so encode
and decode are self-consistent.

`arm_control_command` holds five `std::vector<float>` at offsets 0, 24, 48, 72,
96 — which is exactly `hdas_msg/MotorControl.msg`.

> **Only `p_des` does anything.** `t_ff`, `kp`, `kd`, `v_des` and `mode` were
> measured inert on this transport. Send sane values anyway (the driver uses
> kp 20 / kd 1), but do not build on them. Evidence:
> [STEERING.md](STEERING.md#why-there-is-no-float-mode).

A zero-torque command (all fields 0) produced 60 × `0x00` on the wire,
byte-identical to our encoder's output — which is how `0x050` was confirmed as
the command id in the first place, by watching the vendor's x86_64 HDAS
transmit.

## 0x051 — gripper command

The gripper is encoded as **a seventh joint with the identical field layout**:
one 10-byte frame, five int16, the same clamps and the same scales
(6.5/4700, 40/750, 500/60, 200/150, 50/600). There is no separate gripper
protocol — only a separate CAN id.

Confirmed by publishing to `/motion_control/control_gripper` and watching the
vendor HDAS emit `051 [10]`. Reproduce with `ros2_ws/gripper_probe.sh`.

**Grippers work.** Commanding one moved the follower's gripper 0.226 rad with
effort rising 0.013 → 2.25, end to end. (The A1XY unboxing guide's line about
grippers not being included is about what ships in the box, not about what this
protocol supports.)

## 0x053 — function frames

One byte. `hdas_msg/srv/FunctionFrame`, field `uint8 command`.

| code | effect |
| --- | --- |
| 0 | rejected — "Invalid command" |
| 1 | enable — but see below, it is not sufficient alone |
| 2 | **release**: motors go limp *and telemetry freezes* |
| 3, 4 | accepted; release-family |
| 5 | clears the DISCONNECT bit (error_code 18 → 16); briefly disengages motors |
| 6 | enable |

**Enable is the sequence 1 → 5 → 6.** Code 1 alone leaves the arm holding and
reporting but deaf to `0x050`. A freshly power-cycled arm obeys immediately —
you only need the sequence to recover from a release.

Never run it without streaming `p_des = q` throughout. See
[SAFETY.md](SAFETY.md#never-enable-without-streaming-a-setpoint).

After FF 2 the arm repeats one identical `0x052` payload forever. That is the
released state, not a dead bus.

`error_code` is a bitfield: 2 = DISCONNECT, 16 = RECEIVE_TIMEOUT.

## 0x054 — status, not temperatures

Eight big-endian int16. The first seven are constant `0x0010` and
**bit-identical across two different arms**, unchanging over 25 s — two arms in
one room cannot report equal temperatures to the count. Only the eighth field
moves (−7, −4, −1, +1).

So the first seven are a per-group status or config word. Anything labelling
`0x054` "temperatures", including earlier versions of this project's own
`protocol.py`, is wrong.

## 0x055 — version / serial

64 bytes, ASCII serial `6117`. Byte 7 is a **latch, not an arm id**: `0x01`
means the arm has received no host command since power-on, `0x02` means it has.
Two arms captured side by side differed at that one offset and nowhere else, so
firmware is identical between them.

Useful as a "has anything talked to this arm yet" check.

## How this was recovered

Reusable method, in case you need to attack a frame this document doesn't
cover.

`CAN_frame` has **sizeof 40**: a 16-byte header plus a `std::vector<uint8_t>`
at offset 16. That came out of
`_Sp_counted_ptr_inplace<CAN_frame>::_M_destroy` (`mov x1,#0x38` = 56, minus
the 16-byte shared_ptr control header) and `_M_dispose` (a vector
`_M_end_of_storage - _M_start` deallocation).

`libprotocol_modules.so` needs only librlog, libstdc++, libm, libgcc and libc —
no ROS — so it dlopens fine in a plain `arm64v8/ubuntu:22.04` container under
qemu. Calling `arm_decode_impl` directly faults at `0x87` on an uninitialised
global, but it executes far enough to log through librlog.

**Static disassembly was more productive than calling it.** Read the constants
out of the saturation branches and cross-check them against each other; when
two independent clamps agree on the same product, the scale is right.
