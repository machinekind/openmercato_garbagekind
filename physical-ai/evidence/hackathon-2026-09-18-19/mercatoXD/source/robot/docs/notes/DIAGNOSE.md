# Task: diagnose the Galaxea A1X leader arm through experiment

You are working in /home/v1/Desktop/GALAXEO on a two-arm Galaxea A1X setup.
Your job is to RUN EXPERIMENTS and REPORT MEASUREMENTS. Do not attempt to
"fix" teleop. Do not refactor. Every claim you make must trace to a
measurement you took in this session.

## Hardware

Two A1X arms, each on its own XCAN USB-CAN-FD adapter:

    can1 = LEADER    (moved by hand; read by our driver, ns=/leader)
    can0 = FOLLOWER  (driven by vendor binary ARM_APP, which hardcodes can0)

The role assignment is forced by ARM_APP and must not be swapped.
Bring buses up with ./can_up.sh — it picks the arm's adapter by traffic,
because both adapters share a serial number and USB enumeration is unstable
across replugs. Links come up DOWN after every replug.

Both arms have NO BRAKES. An e-stop is fitted.

## Verified CAN protocol (already decoded — do not re-derive)

    0x023  host->arm   1 B   heartbeat, vendor sends ~2-4 Hz as CAN-FD (023##400)
    0x050  host->arm  60 B   6 joints x 5 int16: p_des, v_des, kp, kd, t_ff
    0x051  host->arm  10 B   gripper, same 5 fields
    0x052  arm->host  48 B   7 groups x [pos, vel, eff] int16 + 6 B footer
                             (footer observed: 5C2E 0024 A827), 200 Hz
    0x053  host->arm   1 B   function frame; payload = code
    0x054  arm->host  16 B   PURPOSE UNCERTAIN — see E2
    0x055  arm->host  64 B   version/serial, contains "6117", NEVER DECODED

Scales: pos /4700, vel /750, kp /60, kd /150, effort /600. Big-endian int16.
Function codes: 1,5,6 = enable/clear-DISCONNECT/enable; 2,3,4 = release.
Codes 7-16 are UNDOCUMENTED — see safety rules.

In can_io.send_frame, payloads <=8 B are sent as CLASSIC CAN, >8 B as CAN-FD.
The vendor sends the 1-byte 0x023 as CAN-FD. This asymmetry is untested.

## What is already established by measurement

- Follower obeys a direct position command at ~99% (3.00 deg -> 2.97 deg).
- Our encode_command output is BYTE-IDENTICAL to ARM_APP's.
- kp=0 frames are discarded outright by the arm.
- kp=0.5 and kp=20 track a 3 deg step identically (~98%, half-way in ~0.18 s),
  so kp is not behaving as a stiffness term.
- t_ff of +/-1.5 Nm produces 0.00 deg on BOTH arms, motors enabled.
- The `mode` byte never reaches the wire: modes 0/1/2/3/10 all produce
  byte-identical 60-byte 0x050 frames.
- Release codes 2/3/4 free the arm but FREEZE 0x052: measured 2601 frames,
  1 distinct payload, zero varying bytes, while the arm was being moved.
- Adding a vendor-shaped 0x023 heartbeat on can1 did NOT restore impedance.
- Follower reports arm_joint7 = RECEIVE_TIMEOUT persistently (pre-existing).

## The open question

Originally the leader was BOTH compliant and reporting. It no longer is. We
can now only reach two states, neither sufficient for teleop:

    enabled (1/5/6)   -> reports position, rigid
    released (2/3/4)  -> hand-movable, telemetry frozen

Two competing explanations, and NOBODY HAS DISTINGUISHED THEM:

  (A) Something latched. A blind sweep of function codes 1..16 was run at one
      point; codes 7-16 are undocumented and may have written non-volatile
      state. The lock appears to survive power cycles.

  (B) Nothing is latched, and our own tooling re-locks the arm. Our launch
      path sends enable codes 1 and 6 on startup. If the arm powers up
      healthy and compliant, we would re-lock it within a second of every
      check and never observe the difference.

Also never checked: the LEADER'S ERROR STATE. /hdas/feedback_status_arm comes
from ARM_APP, which is bound to can0. Our decode_feedback has no error field.
Every conclusion about the leader was drawn without reading its fault word.
libprotocol_modules.so contains error_analysis::ArmerrorCodeToString and codes
including A/B/C_PHASE_OVERCURRENT, BUS_OVERCURRENT, CURRENT_SENSOR_MALFUNCTION,
RECEIVE_TIMEOUT, DISCONNECT. Code 5 clears DISCONNECT specifically, implying
bits it does not clear.

## Experiments — run in this order, stop and report if any is decisive

E0. THE CONFOUND TEST. Highest priority; run before anything transmits.
    Power-cycle the leader. Bring up can1 with ./can_up.sh. Then run
    `candump can1` and NOTHING ELSE — no driver, no ROS, no scripts, no
    function frames. Confirm with `ss`/`lsof` or a process check that only
    candump is bound. Move the arm by hand for 30 s.
    Report: total 0x052 frames, count of DISTINCT payloads, which byte
    offsets vary, and whether decoded positions track your hand.
    Varying => explanation (B), the arm is fine and we lock it ourselves.
    Frozen  => explanation (A) survives.
    Repeat once to confirm reproducibility.

E1. LEADER ERROR WORD. With only passive reading, capture 0x052's 6-byte
    footer, 0x054, and 0x055 on BOTH buses simultaneously. Cross-reference
    against the follower, whose error state IS visible via
    /hdas/feedback_status_arm. Determine whether any leader-side byte
    correlates with the follower's known RECEIVE_TIMEOUT on joint7.
    Deliverable: a decode of where, if anywhere, the leader reports faults.

E2. WHAT IS 0x054? Observed payload was [16,16,16,16,16,16,16,4] — seven
    identical values plus a trailing 4. Seven-plus-one matches the arm's
    group structure (6 joints + gripper). Real temperatures would not be
    bit-identical. Capture 0x054 across: cold vs warm, enabled vs released,
    e-stop engaged vs clear, and during motion. Report whether it is thermal,
    a per-joint status/flag word, or something else.

E3. FIRMWARE COMPARISON. Decode 0x055 (64 B) on both arms and diff them
    byte-for-byte. Do the two arms run the same firmware revision? If MIT
    mode is firmware-gated this is where the evidence is. Read-only.

E4. E-STOP SIGNATURE. On the FOLLOWER (the known-good arm), engage the
    e-stop and capture 0x052/0x054. Establish the exact frozen-payload
    signature an e-stop produces. Then compare it to the leader's current
    state. A latched or partially-engaged e-stop on the leader would
    reproduce the entire symptom set. Physically inspect the leader's e-stop.

E5. STATE TRANSITION MAP. Using ONLY codes 1,2,3,4,5,6, build a table:
    for each code, does 0x052 vary? is the arm hand-movable? what does the
    error word (from E1) read? Capture raw frames for each transition.
    Include the transition BACK — does 1 after 2 restore reporting?

E6. FRAME ENCODING. Our 1-byte frames (0x023, 0x053) go out as classic CAN;
    the vendor sends 0x023 as CAN-FD. Function frames evidently work as
    classic (the arm energises), so this likely does not matter — but test
    it controlled: send enable as classic vs FD and compare the resulting
    0x052 behaviour. Cheap, and rules out a whole class of doubt.

E7. RE-TEST THE GAIN LAW WITH THE ERROR WORD VISIBLE. Repeat the kp/kd/t_ff
    measurements (kp=0, 0.5, 20; t_ff +/-1.5 Nm) while simultaneously logging
    whatever fault field E1 identified. The question: is t_ff inert because
    the interface lacks MIT, or because a fault bit is suppressing torque?
    This is the one experiment that could overturn the "MIT is not live on
    CAN-FD" conclusion. Keep a hand on the arm.

E8. SERIAL PATH — SURVEY ONLY, DO NOT IMPROVISE. Galaxea's Tabletop
    Teleoperation SDK / A1_SDK drive the arm over USB serial, and their
    command message carries a `mode` byte documented as "Default is 0, MIT
    control". a1xy/a1_driver_sdk/ is staged and leader_serial.sh exists
    (check/driver/limp/stop). Nothing has ever run against the arm;
    /dev/ttyACM0 does not exist. Report: what ports exist, what the
    unconnected 4-pin socket on each arm is, and what cable would be
    required. DO NOT attempt to join two host USB ports.

Additionally, note but do not act on: driver_node._backdrive_loop reads
self._q and commands it with NO staleness check. If feedback stalls, p_des
freezes at the last pose, converting follow mode into a rigid hold at a stale
point. leader_float.py has both a staleness check and frozen_joints(); the
driver loop has neither. Report it as a finding.

## Safety rules — non-negotiable

- NEVER send function frame codes above 6. A blind 7..16 sweep is the
  leading suspect for the current lock. If you believe a higher code is
  needed, STOP and say so; that question goes to support@galaxea.ai.
- NEVER run mcu_ota / ota_test or flash firmware.
- NEVER run automated pose sweeps. One caused J2 to drop off the internal
  bus (recovered on power cycle); another caused a self-collision.
- NEVER use a velocity look-ahead / --lead term. It caused a runaway and has
  been removed.
- Exactly ONE writer per bus. SocketCAN has no writer arbitration: every
  bound socket can transmit and the arm acts on whichever frame arrived last.
  Before any transmit, verify no stale driver/teleop node is running (count
  ROS NODES, not processes — `ros2 run` spawns a child).
- The arms have no brakes. Any test that could make an arm compliant requires
  a hand physically on it. Announce before, not after.
- Stop immediately on any error code you have not seen before, and report.

## Reporting

Produce one report with:
  1. A verdict on E0 stated first, in one sentence: (A) latched, or
     (B) self-inflicted. This is the deliverable that matters most.
  2. A table per experiment: what you sent, what you measured, raw counts.
  3. Every raw candump saved to a file, path listed.
  4. An explicit three-way split of every claim: ESTABLISHED (you measured
     it this session), INFERRED (reasoning from measurement), UNTESTED.
  5. What you recommend asking Galaxea support, phrased as concrete
     questions with the specific frame/code numbers involved.

Do not conclude "teleop works" or "the leader is fixed" from anything short
of: leader compliant by hand AND 0x052 payloads varying AND the follower
mirroring, all three simultaneously, sustained over 30 s.
