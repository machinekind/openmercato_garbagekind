# The robot stack this module integrates

Distilled from two days of build sessions (18–19 Sep 2026) on the physical
hardware. The raw mined notes are in [knowledge/](knowledge/); this file is what
an integrator needs to know before wiring anything to it.

## Hardware

| Thing | Detail |
|---|---|
| Arm | Galaxea A1X, 6 DoF (J1…J6) + gripper, joint-position control over CAN |
| CAN | PEAK USB-CAN adapter, `can0`, brought up by `robot/can_up.sh` (inside the `galaxeo-ros2` container). Arm frames on `0x050`/`0x052`, **gripper on `0x051` — a separate channel** |
| Second arm | A second PEAK adapter appears as `can1`; both report the same USB serial, so `can_up.sh`'s traffic-based picker misidentifies them when two arms are live |
| Compute | Laptop owns CAN and the panel; a DGX Spark (`machinekind-dgx`, GB10 / sm_121 / aarch64, unified memory, shared box) runs inference |
| Link | Direct cable laptop `enp92s0` ↔ DGX `enP7s7`, `10.42.0.0/24` (laptop `.1`, DGX `.217`); ~116 MB/s. The DGX's default route otherwise goes *through* the laptop's weaker WiFi |
| Cameras | USB; at least one **must be wrist-mounted** looking down the grasp axis, the other fixed on the workspace. 640×480 MJPG is enough — the policy downsamples to 256 |
| Leader arm | SO-101 (Feetech STS3215, `/dev/ttyACM0`) for teleop recording; needs its own 7.4 V rail — a 4.8 V bus reads encoders fine while no joint moves |

## Web panel — the integration surface

`robot/webpanel/server.py`, aiohttp, port 8080. It is the **only** transmitter on
the CAN bus: running `so101_bridge.py`, the teleop scripts or the ROS 2 driver
with TX enabled at the same time makes two writers interleave on `0x050` and the
arm sees garbage.

| Route | Purpose |
|---|---|
| `GET /ws` | arm state @15 Hz, event broadcasts, command results; **commands go up this socket** |
| `GET /api/state` | the same snapshot over REST (read-only) |
| `GET /api/events?since=SEQ` | event ring buffer (poll fallback) |
| `POST /api/event` | `{from, kind: chat\|status\|alert\|log, text, image?}` → `{ok, seq}` |
| `GET /api/presets` | `{presets: {name: {desc, q_deg}}}` |
| `GET /stream/{name}` | multipart MJPEG |
| `GET /health` | camera + arm diagnostics, **and your role** |

WS commands: `engage`, `disengage`, `stop`, `enable`, `grip_probe`,
`agent_control`, `preset {name}`, `move_joints {deltas}`, `pantilt {dpan,dtilt}`,
`goal {joints}`, `jog {joint, delta_deg}`, `grip {value}`, `chat {text}`.

State fields worth reading: `q` (7 values, radians), `engaged`, `engaged_via`
(`operator`/`agent`/`none`), `goal_reached`, `moving`, `grip.measured`,
`grip.alive`.

### Roles are decided by peer IP

Anything inside `--agent-net` (default `10.42.0.0/24`, the direct cable) is the
**agent**; everything else is the **operator**.

| | operator | agent |
|---|---|---|
| `chat` | yes | yes |
| `preset`, `pantilt`, `move_joints` | yes | only while engaged **and** "agent may move the arm" is ticked |
| `engage`, `disengage`, `stop`, `enable`, `goal`, `jog`, `grip` | yes | refused |

REST carries no motion at all, and a REST event may not claim to come from
`operator` (403). **The bridge must therefore run in the operator role** — it
calls `engage`, `goal` and `grip`. `PanelArm.check_role()` fails fast on this
instead of discovering it mid-task.

### Camera sources

`--cameras "name:spec,…"`, where spec is a local `/dev/videoN`, `ssh://`,
`sshtcp://host/dev/videoN?via=…`, or `listen://HOST:PORT?peer=CIDR` (the panel
listens, the DGX pushes JPEGs in; the CIDR restricts who may push). Only one
process may own a given `/dev/video*` — the DGX agent and a `sshtcp://` pull
fight over the same device.

## Safety invariants

These are the panel's, and they hold whether or not Open Mercato is running:

* Starts **disengaged**; nothing is transmitted until an operator engages.
  Engaging latches `goal = clamp(measured pose)` — so engaging while a joint
  sits outside the window causes a real move to the window edge at 30°/s. Check
  the pose first; the bridge reports it as a warning stage.
* Every target passes `presets.json`: the per-joint window is intersected with
  the URDF limits (a config typo can only narrow it), relative moves are capped
  per command, non-finite values are rejected.
* Operational window after the one approved widening:
  `J1 ±165° · J2 [0, 90]° · J3 [−70, 0]° · J4 ±45° · J5 ±60° · J6 ±90°`.
  The URDF allows more (e.g. J2 to 180°); the window is the stricter operational
  envelope, and widening it is a privileged change.
* Slew-limited to 30°/s.
* Stale CAN feedback, a lost link, or the last operator tab closing all
  auto-disengage. **Ceasing TX is the safe failure mode**: an uncommanded arm
  holds position.
* One CAN writer at a time. Concurrent engage-holders caused a real race; the
  fix was one process per attempt, which is why `bridge/` runs the whole attempt
  from a single connection.
* `FF 1→5→6` (enable) runs only on the explicit Enable button, streaming
  `p_des = q` throughout.

The bridge adds a task-level envelope on top: ≤12° per step, ≤40° per round,
flat plans (<6° of motion) resampled rather than executed, and `disengage()` in
a `finally` so it runs on every path including cancellation.

## Gripper

`0x051` is a separate channel that can independently go deaf: it keeps reporting
position with effort pinned at exactly 0.00 while ignoring commands. Recovery is
a probe (nudge, then the FF 1→5→6 sequence), exposed as the `grip_probe` WS
command and run inside the single control thread so nothing else transmits
meanwhile.

Travel: −1.8 is fully open, +0.6 is a full close **on an empty gripper**. Closing
on an object stalls short of that under force limit (measured: position +0.007,
effort +6.45 on a can). That is exactly how the bridge decides whether it is
holding anything — see `bridge/om_bridge/pick.py:_grasp`.

`set_grip` silently requires the arm to be engaged.

## Policy server (G0.5)

`ws://127.0.0.1:8765` on the DGX, `mode=chunk(16)`, `device=cuda`.

```python
obs = {
  "images": {"head_rgb": u8[C,H,W], "left_wrist_rgb": …, "right_wrist_rgb": …},  # RGB, channel-first
  "state":  {"left_arm": f32[6], "left_gripper": f32[1],
             "right_arm": f32[6], "right_gripper": f32[1]},   # absent on this robot; send zeros anyway
  "task": "pick up the can",
  "embodiment_type": "galaxea_r1lite",
}
# reply: {"action": {key: [horizon, dim]}, "need_obs": bool}
```

Two traps, both paid for in lost hours:

1. The runtime keys above are **not** the ones in `configs/data/r1lite.yaml`
   (`exterior`/`wrist_left`). The docs' names fail validation.
2. The server computes a 16-step chunk, then serves it from cache at ~58 ms a
   step and only sets `need_obs` when it is exhausted (cold recompute ~2.4 s
   synthetic, 1.05–1.9 s with real cameras). Sending a fresh observation every
   cycle restarts the chunk forever, so you only ever see step 0 — which sits on
   the current pose and looks like the model doing nothing.

Frames from the panel are BGR (cv2/ffmpeg) and must be converted to RGB;
`bridge/om_bridge/vision.py` does it.

## Files in `robot/` worth knowing

| Path | What it is |
|---|---|
| `webpanel/` | the panel: `server.py`, `arm_ctl.py` (200 Hz CAN thread), `camera.py`, `safety.py`, `events.py`, `presets.json` |
| `so101_bridge.py` | despite the name, holds the real A1X CAN driver class the panel reuses — load-bearing |
| `dgx-agent/a1x/` | the DGX-side LLM agent (chat, tools, patrol) and the deterministic YOLO tracker |
| `dgx-agent/g05_client.py`, `g05_approach.py`, `g05_grab_test.py` | the G0.5 experiments this bridge is the successor to |
| `record_a1x.py` | teleop recording in LeRobot v3 format — the path to fine-tuning |
| `kinematics.py` | URDF chain + FK, used to check where the end-effector actually went |
| `can_up.sh` | brings up `can0` (1 Mbit nominal / 5 Mbit data, CAN-FD) |
