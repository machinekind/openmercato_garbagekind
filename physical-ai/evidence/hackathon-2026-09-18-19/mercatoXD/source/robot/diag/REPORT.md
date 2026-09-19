# A1X leader diagnosis — measured results, 2026-08-23

## 1. Verdict on E0

**Neither (A) nor (B). There is no leader-specific lock, and nothing is latched.**
Both arms, with zero frames transmitted to them, hold their own position and
report 0x052 at 200 Hz. This is the hardware's resting behaviour, not a fault.

## 2. Bus labelling — CORRECTED MID-SESSION

Every script in this folder declares `can1 = LEADER, can0 = FOLLOWER`.
**That is currently inverted.** Confirmed by the user: a release sent to can1
went limp on the arm they call the follower.

    can0  = 1-1.1.2  = physically the LEADER    (ARM_APP is bound here)
    can1  = 1-1.4    = physically the FOLLOWER

`can_up.sh` picks "the arm's adapter by traffic" — but BOTH arms transmit
unprompted at 200 Hz, so that heuristic cannot discriminate. It has been a
coin flip on every replug. USB port path is the only stable handle found.

## 3. Results

| Exp | Question | Result | Status |
|-----|----------|--------|--------|
| E0  | Leader rigid because latched, or because we lock it? | Neither. Rigid + reporting with TX=0 | ESTABLISHED |
| E0b | Does the follower behave differently? | No — identical | ESTABLISHED |
| E1  | Where does the leader report faults? | Nowhere found. Footer constant, no error field | ESTABLISHED (negative) |
| E2  | What is 0x054? | NOT temperature. 7x constant 0x0010 + 1 varying int16 | ESTABLISHED |
| E3  | Do the arms run different firmware? | No. 0x055 identical but for a state byte | ESTABLISHED |
| E5  | State transition map (codes 1-6) | 1/5/6 are no-ops; 2 releases and freezes telemetry | PARTIAL |
| E8  | Is the serial path available? | No. No ttyACM/ttyUSB exists | ESTABLISHED |
| E4  | E-stop signature | not run | UNTESTED |
| E6  | Classic vs FD framing | not run | UNTESTED |
| E7  | Gain law with error word visible | not run (no error word exists to log) | UNTESTED |

### E0 — the decisive measurement

40 s / 30 s passive captures, `candump` the only reader, TX counter 0 throughout.

| arm | frames | distinct payloads | max excursion under hand force | max effort |
|-----|--------|-------------------|-------------------------------|-----------|
| can1 | 8000 @ 200.0 Hz | 8000 / 8000 | 0.05 deg | 1.428 (g2) |
| can0 | 6000 @ 200.0 Hz | 6000 / 6000 | 0.07 deg | 1.525 (g2) |

Independent confirmation: 0x055 byte 7 read **0x01** on can1 during the capture,
which means that arm had received no host command since power-on. It was rigid
and reporting anyway.

User's tactile description: "I can deflect it but the motors put it back to the
initial position." That is a position servo with finite stiffness, not a brake.

### E2 — 0x054 is mislabelled as "temperatures"

Eight big-endian int16. First seven are constant `0x0010`, **bit-identical on
both arms**, unchanging across 25 s. Two arms in one room cannot report equal
temperatures to the count. Only the 8th field moves: -7, -4, -1, +1.
=> first seven are a per-group status/config word; `protocol.py` label is wrong.

### E3 — identical firmware

    can0: FFFFFF01010C0002 36313137 170625DF 36313137 000004020000040200000402...
    can1: FFFFFF01010C0001 36313137 170625DF 36313137 000004020000040200000402...
                        ^^
Differs at offset 7 only. That byte is NOT an arm ID — it is a latch:
1 = has received no host command since power-on, 2 = has. can1 flipped 1->2
after receiving 6 frames from us. **MIT is not firmware-gated between these arms.**

### E5 — state transitions (leader bus, codes 1-6 only)

| step | frames | distinct | pos range | max effort | telemetry |
|------|--------|----------|-----------|-----------|-----------|
| baseline | 600 | 600 | 0.02 deg | 1.672 | LIVE |
| after FF 1 | 800 | 800 | 0.02 deg | 1.575 | LIVE |
| after FF 5 | 800 | 800 | 0.02 deg | 1.477 | LIVE |
| after FF 6 | 698 | 698 | 0.07 deg | 1.135 | LIVE |
| **after FF 2** | **1200** | **1** | **0.00 deg** | **0.158** | **FROZEN** |
| after FF 1 (re-enable) | 800 | 800 | - | 1.257 | LIVE |

Enable codes are no-ops on an already-holding arm. Release genuinely freezes
0x052 — 1200 frames, one payload — and drops effort to ~0. The ACU keeps
transmitting at 200 Hz but the contents are a stale snapshot, so encoder data
reaches the bus *through* the motor drivers. **There is no motors-off/encoders-on
state on this interface.** Codes 3 and 4 were not tested (session halted).

### ARM_APP is a zombie — probable cause of many past failures

    [INFO]  Successfully bound to CAN interface
    [INFO]  CAN-FD mode enabled
    [ERROR] asyncRead encountered error: No such device
    [INFO]  Retrying asyncRead after error

Bound at 07:56, device disappeared, entered a retry loop it never leaves.
2.5 h later: 27% CPU, **zero ROS nodes registered**, TX=0 on can0.
`ros2 node list` returns empty; only /parameter_events and /rosout exist.

Every preflight check written so far tests for the PROCESS, which is always
present. **Check for the NODE or for publication rate instead.**

## 4. Claim status

**ESTABLISHED (measured this session)**
- Both arms hold position and report at 200 Hz with zero host transmission.
- Both resist hand force to within 0.07 deg; both spring back when deflected.
- Release (FF 2) freezes 0x052 to a single payload and zeroes effort.
- Enable codes 1/5/6 change nothing on an already-holding arm.
- 0x054's first seven int16 are a constant 0x0010, identical across arms.
- Both arms run identical firmware; 0x055 offset 7 is a host-contact latch.
- No serial device exists on this host.
- ARM_APP is in a permanent failed retry loop and publishes nothing.
- The can0/can1 role labels in every script are currently inverted.

**INFERRED**
- Encoder telemetry is produced by the motor controllers, not the ACU, because
  disabling torque freezes it.
- The ATC host CAN-FD interface exposes position control + enable/release only;
  no impedance layer is reachable through it.
- The "leader was once compliant AND reporting" memory is unlikely to describe
  this interface, since no reachable state produces both.

**UNTESTED**
- Whether codes 3 and 4 differ from 2.
- E-stop signature (E4).
- Classic vs CAN-FD framing of 1-byte frames (E6).
- Whether an arm boots with byte7=1 and rigid immediately after power-on
  (needs a genuine power cycle; arms were already powered this session).

## 5. Questions for support@galaxea.ai

1. On the ATC host SDK CAN-FD interface, is the MIT impedance law reachable at
   all? We send 0x050 as 6x[p_des, v_des, kp, kd, t_ff] int16 and observe:
   kp=0 frames discarded; kp=0.5 and kp=20 track a 3 deg step identically;
   t_ff of +/-1.5 Nm produces 0.00 deg of motion. Is 0x050 interpreted as pure
   position control on this firmware?
2. Function frame 0x053: codes 1/5/6 enable, 2/3/4 release. Release freezes
   0x052 entirely. **Is there a code, or any other mechanism, that disables
   torque while keeping joint feedback alive?** That single state is all a
   hand-guided leader needs.
3. What is 0x054? We read eight int16, the first seven a constant 0x0010 on two
   different arms. Our SDK notes call it "temperatures"; that cannot be right.
4. 0x055 offset 7 reads 1 before any host frame and 2 afterwards. Is that a
   host-contact latch, and is any of 0x055 an arm serial we can use to bind
   roles to a physical arm across USB replugs?
5. Firmware here is 0x55 = FFFFFF 01 01 0C 00 .. "6117" .. 17 06 25 DF.
   Is there a revision in which the leader/teach mode is available over CAN-FD?
6. Tabletop Teleoperation makes the host arm compliant over USB serial with a
   documented `mode` byte ("0 = MIT control"). Our A1X exposes no USB serial
   device. What connector carries it, and what cable is required?

## 6. Raw captures

    diag/E0_can1_handmove.log     40 s, can1, hand motion, TX=0
    diag/E0b_can0_handmove.raw    30 s, can0, hand motion, TX=0
    diag/E1_can0.raw              25 s, can0, passive
    diag/E1_can1.raw              25 s, can1, passive
    diag/can0_survey.log          2 s, can0
    diag/can1_survey.log          2 s, can1
    diag/E5_baseline.raw          pre-code baseline
    diag/E5_code1.raw             after FF 1
    diag/E5_code5.raw             after FF 5
    diag/E5_code6.raw             after FF 6
    diag/E5_code2.raw             after FF 2 (release) -- the frozen capture
    diag/verify_can0.raw          post-re-enable
    diag/verify_can1.raw          post-re-enable

## 7. Finding noted, not acted on

`driver_node._backdrive_loop` reads `self._q` and commands it with no staleness
check. If feedback stalls, p_des freezes at the last pose, turning follow mode
into a rigid hold at a stale point. `leader_float.py` has both a staleness check
and `frozen_joints()`; the driver loop has neither.

---

# ADDENDUM — command path and compliance (same session, after ARM_APP was stopped)

## Two of my own measurements were wrong. Both corrected.

**1. "Our raw 0x050 frames are ignored" — WRONG, harness bug.**
`step_test.py` streamed 2.5 s without ever reading the socket. The RX buffer
filled with ~500 stale 0x052 frames at 200 Hz, so the post-stream read returned
the position from 2.5 s earlier. Sampling *during* the stream:

| commanded | group 1 measured | other groups | reverts after stream? |
|-----------|------------------|--------------|----------------------|
| +2.00 deg | **+2.036 deg (102%)** | <= 0.024 deg | no (0.012 deg) |

**Our raw frames control the arm at 102%. No 0x023 heartbeat is required.
There is no command timeout.** ARM_APP is not needed to drive an arm.

**2. "The float test shows compliance" — the first two runs were confounded by
my own leash.** p_des was clamped to +/-6 deg (then +/-15 deg) of the start pose.
The user pushed past the clamp both times and felt the clamp spring back. The
arm settled at exactly 15.03 deg after the second run — the leash boundary.

## The compliant + reporting state EXISTS and was reached

Method: stream 0x050 continuously with `p_des = q_measured`. Position error goes
to ~0, so restoring torque goes to ~0, while the motors stay ENABLED and 0x052
keeps flowing. Tested on J1 alone (base yaw, no gravity load, so a wide range
needs no leash).

| condition | hand movement | telemetry | stayed put when released? |
|-----------|---------------|-----------|--------------------------|
| E0, nothing sent | 0.05 deg | LIVE | n/a (rigid) |
| J1, p_des = q | **29.18 deg** | LIVE, 3106 frames | **yes** — left at -6.01, sat at -4.60 |

Mean |effort| on J1 while being moved: 4.05 (noticeable viscous drag).
Run ended early on a velocity guard (user swung at 121 deg/s vs a 120 limit) —
not a runaway; peak excursion 29 deg inside a 50 deg range.

**This is the state the whole investigation assumed was unreachable.**
Release gives compliant-but-silent. Uncommanded gives rigid-but-reporting.
`p_des = q` gives compliant AND reporting.

## Uncommanded behaviour: re-latch, not recall

15 s passive watch, zero frames sent: **0.00 deg drift.** The arm holds position
and does not creep toward any stored pose. After a stream stops it settles at
its *current* position with ~0 effort (measured +8.40 deg, effort -0.01), NOT at
the last p_des we sent (-6.01). So stopping the stream re-latches the setpoint
where the arm physically is.

## Consequence for teleop design

- ARM_APP is unnecessary. One process can own both buses directly.
- Follower: stream p_des = q_leader. Proven 102% tracking.
- Leader: stream p_des = q_leader (self-tracking) to stay hand-movable AND
  reporting. Proven on J1.
- **Open problem: gravity-loaded joints.** With p_des = q the holding torque is
  zero, so J2/J3 sag, the setpoint follows the sag, and the arm walks itself
  down. `t_ff` is inert, so the fix is a position bias instead:
  `p_des = q + tau_gravity / kp`, using the Pinocchio RNEA torques already in
  `gravity.py`. UNTESTED.
- Any operator-facing test must announce when the stream starts and stops. Tool
  output is not visible to the person holding the arm; in the J1 run the abort
  fired silently and every push after it was against an uncommanded arm.

## Claim status for this addendum

**ESTABLISHED:** raw 0x050 controls the arm at 102% with no heartbeat and no
timeout; sampling must drain the RX socket or readings are seconds stale;
`p_des = q` yields 29 deg of hand compliance with live telemetry on J1 and the
joint stays where it is left; an uncommanded arm does not drift (0.00 deg/15 s)
and re-latches at its current position.

**INFERRED:** gravity-loaded joints will sag under `p_des = q`; a position-bias
gravity term should work because the servo demonstrably honours position error.

**UNTESTED:** gravity bias; compliance on J2/J3/J4/J5/J6; full-arm float;
whether drag (mean effort 4.05) is low enough for comfortable teleoperation.

---

# ADDENDUM 2 — function frames fully mapped, and a safety incident

## Complete map of codes 1-6 (all measured, leader bus)

| code | telemetry | torque | accepts 0x050? | effect |
|------|-----------|--------|----------------|--------|
| 1 | LIVE | on  | **NO** | no-op on an already-holding arm |
| 2 | **FROZEN** | **OFF** | n/a | the only true release; arm goes limp |
| 3 | LIVE | on  | - | NOT a release: 1.10 deg travel, effort 27.85 resisting |
| 4 | LIVE | on  | - | NOT a release: 0.44 deg travel, effort 4.38 |
| 5 | LIVE | on  | **YES** | restores command acceptance (clear DISCONNECT) |
| 6 | LIVE | on  | YES, 100% | brings tracking from 50% to 100% |

**Only code 2 cuts torque, and it freezes 0x052. There is NO state on this
interface that gives torque-off with live encoder reporting.** The earlier note
that "2/3/4 = release" is wrong: 3 and 4 leave both torque and telemetry intact.

Enable is a SEQUENCE: 1 -> 5 -> 6. Code 1 alone leaves an arm holding and
reporting but DEAF to 0x050. This is why the follower received 4871 command
frames and never moved.

## kp is not ours to set

The arm ignores the kp we send and applies its own internal stiffness. Already
implied by kp=0.5 and kp=20 tracking a 3 deg step identically; confirmed by the
operator, who reports --kp 3, --kp 8 and --kp 20 all feel the same. Softening
the leader through gains is not available. The only remaining lever on felt
resistance is reducing the setpoint lag, since resistance = K_internal * v * lag.

## SAFETY INCIDENT — enable with no setpoint causes a full-torque swing

During the FF 4 probe, the re-enable sequence was sent with NO 0x050 streaming.
Measured in the following 3 s: **76.36 deg of movement at effort 50.00**, which
is saturation of the +/-50 scale. The operator was holding the arm.

Cause: the arm retains a stale internal target. Enabling with nothing telling it
where it is makes it drive to that stale target at full torque.

**Rule: never send an enable code without streaming p_des = q around it.**
`teleop2.py` was fixed to pin the setpoint to the measured position before,
during and after every code in the sequence. `release_probe.py` does NOT do this
and should not be re-run as written.

## Where this leaves teleop

WORKING: follower tracks the leader (confirmed by operator and by pose data --
J2/J3/J4 mirrored within 1-2 deg).
NOT WORKING: the leader is heavy to move. It cannot be made free through this
interface -- codes 1-6 are now exhaustively mapped and none provides
torque-off-with-reporting, and kp is ignored.

Remaining options, in order of cost:
1. Reduce setpoint lag (unmeasured -- worth quantifying before anything else).
2. Ask Galaxea question #2 in this report. It is now the sharpest question we
   have and the only one that can unblock a genuinely free leader.
3. The serial path, which the A1 SDK documents as carrying a `mode` byte for MIT
   control -- but no serial device exists on this host (E8).

---

# ADDENDUM 3 — CONTROLLED COMPARISON. Retracts Addendum 2's central claim.

Same arm, same operator, same session, three 15 s phases back to back
(`phase_compare.py`). This is the control that Addendum 2 lacked.

| joint | A: nothing sent | B: float p_des=q | C: float + bias |
|-------|-----------------|------------------|-----------------|
| J1 | 1.71 | 1.45 | 1.46 |
| J2 | 1.05 | 1.11 | 1.08 |
| J3 | 0.02 | 0.02 | 0.11 |
| **J4** | **90.53** | **90.65** | **90.81** |
| J5 | 0.48 | 0.56 | 0.52 |
| J6 | 1.23 | 0.99 | 1.18 |

## RETRACTED: "p_des = q produces a compliant+reporting state"

Addendum 2 claimed the float creates compliance, from a single run in which J1
travelled 29.18 deg. **A vs B shows the float changes backdrivability by nothing.**
The 29 deg was applied force, not control. No uncommanded control was run, so
variation in how hard the operator pushed was attributed to the code.

## RETRACTED: "the gravity bias locks the joints" (operator hypothesis)

B vs C differ by <= 0.1 deg on every joint. The bias is neutral, not harmful.

## CORRECTED: "an uncommanded arm is rigid" (E0)

E0 measured 0.05 deg of hand movement with nothing sent and generalised to the
whole arm. J4 moves 90 deg uncommanded. E0's operator simply never pushed J4.
The accurate statement: **some joints backdrive and some do not, independent of
anything on the CAN bus.**

## What actually holds

- J4 is freely backdrivable, always, commanded or not.
- J1, J2, J3, J5, J6 give about 1 deg at the forces a hand applies, always.
- Backdrivability is a MECHANICAL property of each joint's gearing. No 0x050
  content observed so far alters it.
- The follower mirrors the leader at 98-100% (Addendum 2, still valid -- that
  measurement had its own control, the commanded-step tests).
- The motors can move every joint: J2 96%, J3 102% of a commanded 2 deg step.
  The joints are not jammed; hands cannot backdrive them, motors can drive them.

## Consequence

Hand-guided teleoperation is limited by mechanical backdrivability, and the CAN
interface offers no lever on it -- consistent with kp being ignored and the
`mode` byte never reaching the wire. Two options remain:

1. **Admittance assist** (`--assist`, implemented, UNTESTED): sense the operator's
   force as excess effort over baseline and drive the setpoint that way, so the
   motor moves the joint for the operator. J3 showed a 7x effort signal (2.6 ->
   19.98) under hand pressure, so the signal exists.
2. **Vendor MIT mode**, which makes the motor yield rather than requiring a hand
   to overpower a gearbox. Not reachable over CAN-FD here; the A1 SDK exposes it
   over USB serial, and no serial device exists on this host (E8).

## Method note

Three of this session's wrong conclusions -- "frames ignored", "J2 is gravity",
"the float creates compliance" -- came from measuring a treatment with no
control. The phase-compare pattern (A/B/C, same operator, back to back) caught
all of them in one 50 s run and should be the default for any claim about feel.

---

# ADDENDUM 4 — the interface is POSITION CONTROL ONLY (definitive)

Prompted by Galaxea's A1Z docs, which the operator found:

    tau_motor = kp*(pos_target - pos_actual) + kd*(vel_target - vel_actual) + tau_ff
    "kp=0, kd=small value -- only gravity compensation torque counters gravity;
     the arm can be freely backdriven."
    "Compute gravity compensation torque tau_g(q) via Pinocchio RNEA ...
     tau_motor = (user_torque + tau_g * scale * factor)"
    Default KP [30,30,30,20,5,5]   Default KD [1,1,1,0.5,0.5,0.5]   250 Hz

**Gravity compensation is the HOST's job and is delivered through t_ff.**
We had never put anything in t_ff. That was a real configuration error -- but
fixing it is impossible on this transport, because:

## t_ff is inert. Tested to +/-12 Nm with a passing acceptance control.

| t_ff (Nm) | J1 offset | predicted (t_ff/kp) | effort |
|-----------|-----------|---------------------|--------|
| 0  | -0.02 | 0.00 | 0.18 |
| 2  | -0.02 | 5.73 | 0.19 |
| 4  | -0.02 | 11.46 | 0.16 |
| 6  | -0.02 | 17.19 | 0.16 |
| 8  | -0.02 | 22.92 | 0.15 |
| 12 | -0.02 | 34.38 | 0.14 |
| -12| -0.02 | -34.38| 0.14 |

Acceptance control in the same run: commanded J1 +2.00 deg -> moved 2.01 deg.
The arm was listening. It ignores the torque field.

## kp=0 is rejected -- and it rejects the ENTIRE frame

Tested with an in-frame acceptance probe (J2 commanded +1.5 deg at kp=30 in the
same 60-byte frame): J2 moved 0.00 deg. So kp=0 does not "free J1", it discards
the whole command. The original finding was right; now it has a control.

## Field-by-field verdict

| field | documented | actual over CAN-FD |
|-------|-----------|--------------------|
| p_des | position  | WORKS ~100% |
| t_ff  | feedforward torque | NO EFFECT to +/-12 Nm |
| kp    | stiffness | ignored (0.5 == 20); 0 rejects the frame |
| kd    | damping   | no observable effect |
| v_des | velocity  | no observable effect |
| mode  | 0=MIT     | never reaches the wire (all modes -> identical bytes) |

**The ATC host CAN-FD interface implements POSITION CONTROL ONLY.** The MIT
fields are present in the frame layout and our encoding matches ARM_APP
byte-for-byte, but only p_des has authority. No amount of tuning reaches
compliance, gravity compensation, or MIT mode through this transport.

## Operational hazard found

Streaming kp=0 frames correlated with the arm becoming DEAF to 0x050 (a
known-good step test fell from 96% to 1%) and with J4's controller dropping
(position and effort pinned at exactly 0 while velocity streamed). FF 1/5/6 did
not recover it; a power cycle did. **Do not send kp=0 on this interface.**

## Consequence

Hand-guided teleoperation cannot be built on this transport. What CAN be built,
and works today, is position mirroring: leader pose -> follower, 98-100%.
The compliant leader needs the A1Z / signal_arm path, where t_ff and mode are
live. That path needs a serial connection this host does not have -- and the
operator has noted an UNCONNECTED 4-PIN SOCKET on both arms, which is the first
thing to ask Galaxea about.
