# A1X Web Panel + VLA Research — Mined Notes
Sources: session `400ae84c` (2026-09-18, initial webpanel build + camera + networking + gh publish), session `cdcb1331` (2026-09-19, pure research — no code/hardware — on real2sim, actuator nets, VLA fine-tuning landscape), session `d9dfa6a4` (2026-09-19, webpanel rebuild for agent-compat + chat + G0.5 VLA zero-shot investigation).

---

## 1. Hardware facts

| Fact | Value | Provenance |
|---|---|---|
| Arm | Galaxea A1X, 6 DoF + gripper (7-dim action: 6 joint + 1 gripper) | (400ae84c, t=17:41); (d9dfa6a4, t=15:12) |
| Arm bus | CAN via PEAK CAN-USB FD adapter, interface `can0` | (400ae84c, t=17:41) |
| Arm feedback rate | 200 Hz control/feedback loop | (400ae84c, t=17:41); (d9dfa6a4) |
| Arm has no brakes | cutting power drops the arm immediately | (400ae84c, t=17:54) |
| Joint envelope (from URDF, later refined in `presets.json`) | J1 ±165°, J2 20°..90°, J3 −70°..−10°, J4 ±45°, J5 ±60°, J6 ±90° | (d9dfa6a4, t=15:09) |
| `arm_joint5` | never moves under SO-101 teleop — constant column (data quality issue) | (d9dfa6a4, t=15:12) |
| Side/laptop camera | USB webcam, `/dev/video0` on laptop, native MJPG 1280x720 @30fps | (400ae84c, t=17:41) |
| Robot-mounted camera | Logitech C920, on **DGX** at `/dev/video0`, used by monitoring agent for `wrist_left`-style view (agent moves J1/J3 to "look") | (d9dfa6a4, t=15:24) |
| Second (exterior) camera | laptop's "TM Technology" cam, static view of white table, arm visible top-left → mapped to G0.5 `exterior` slot | (d9dfa6a4, t=15:26) |
| Wrist camera ("Generic USB Camera") | at one point disappeared from DGX `/dev/v4l/by-id/` — turned out to be the cam unplugged and moved to laptop | (d9dfa6a4, t=15:29) |
| Laptop NIC (ethernet) | `enp92s0` | (400ae84c, t=18:12) |
| DGX NIC (ethernet) | `enP7s7` | (400ae84c, t=18:12) |
| DGX NIC (WiFi) | `wlP9s9`, PHY 234 Mbit/s (NSS 2), signal −52 dBm — much stronger than laptop's WiFi | (d9dfa6a4, t=15:30) |
| Laptop NIC (WiFi) | `wlp0s20f3`, PHY 87.8 Mbit/s (NSS 1) | (d9dfa6a4, t=15:30) |
| Both on same SSID | `OPENMERCATO` | (d9dfa6a4, t=15:30) |
| Laptop IP (panel host) | `192.168.220.102` (WiFi LAN, used in browser URL) | (400ae84c, t=17:41 / t=18:06) |
| DGX LAN IP (WiFi) | `192.168.223.155` | (400ae84c, t=18:06) — TCP inbound blocked (firewall/AP isolation), ICMP passes |
| Ethernet link (direct cable, no DHCP originally) | laptop → link-local `169.254.231.129`, then laptop set to NM "shared" mode as DHCP server: laptop `10.42.0.1`, DGX auto-leased `10.42.0.217` | (400ae84c, t=18:17) |
| Ethernet cable bandwidth measured | 116 MB/s (full gigabit) | (400ae84c, t=18:17) |
| DGX SSH alias | `machinekind-dgx` (via cloudflared tunnel, also reachable via LAN) | throughout |
| DGX user (no sudo) | ssh user has no sudo on DGX; laptop user has sudo | (400ae84c, t=18:17); (d9dfa6a4, t=15:30) |
| DGX default route | `via 10.42.0.1 dev enP7s7` (metric 100) — i.e. DGX internet goes through the laptop's NAT+WiFi over the ethernet cable; DGX's own WiFi sits at metric 600, unused | (d9dfa6a4, t=15:30) |
| DGX is a **shared** machine | other users' jobs observed on the wire: `mjpeg_server.py :8091` (user `mpogoda`, cams top+wrist), `/app/fast_cam.py` in a container pushing to `192.168.8.117:8096`, `uv sync ... scripts/deployment/spark` (pid 144069, another user installing deps) | (d9dfa6a4, t=15:30) |
| DGX GPU | GB10 (sm_121) — relevant because torch 2.7.1+cu128 (G0.5's pin) has no sm_121 kernels | (d9dfa6a4, t=15:26) |
| DGX disk | had capacity for 55GB G0.5 full checkpoint set; single `g05-base` ≈ 11GB | (d9dfa6a4, t=15:15/15:26) |

---

## 2. Software components built or used

### webpanel v1 (session 400ae84c, in `galaxeo-manipulators/webpanel/`, later replaced)
| File | Purpose | Run command |
|---|---|---|
| `server.py` | aiohttp server: panel `/`, MJPEG `/stream`, WebSocket `/ws`, JSON `/health` | `python3 webpanel/server.py --port 8080` (default port 8080; 8093 used during initial dev) |
| `camera.py` | ffmpeg-based capture of local cam (copies native MJPG, no re-encode), later extended for `ssh://` (gst-launch remote re-encode) and direct-TCP push mode | n/a (imported by server) |
| `arm_ctl.py` | 200 Hz control thread reusing the `A1X` class from `so101_bridge.py`; joint limits pulled from URDF | n/a |
| `static/index.html` | UI: live video tile(s), 6 joint sliders + jog buttons (±1°/±5°), gripper control, engage/STOP/enable buttons | served by server.py |
| `README.md` | usage + CLI flags | — |

Multi-camera CLI example: `python3 webpanel/server.py --cameras "side:/dev/video0,robot:/dev/video2"`.
Remote DGX camera via cable (final v1 state): `sshtcp://` push-mode spec, direct TCP push DGX→laptop on port **8097** (later **8097/18097/18098/18099** used in various tests), auto-reconnect (ServerAliveInterval watchdog + 2s retry loop).

### webpanel v2 (session d9dfa6a4 — full rebuild, agent-compatible)
Old `webpanel/` had been deleted from the repo at some point but exists in git history at commit `cf3279e`. Rebuilt fresh to match the contract expected by `dgx-agent/a1x/` (a monitoring/ReAct agent already in the repo that talks to the panel).

| File | Lines | Purpose |
|---|---|---|
| `server.py` | ~340 | aiohttp: `/`, `/stream/{name}`, `/ws`, `/api/{state,events,event,presets,map}`, `/health` |
| `arm_ctl.py` | ~290 | 200 Hz CAN thread (reuses `A1X` from `so101_bridge.py`); engage/enable/jog/preset/move_joints |
| `camera.py` | ~330 | MJPEG sources: local ffmpeg, `ssh://`, `sshtcp://`, new **`listen://`** mode (agent pushes frames in) |
| `safety.py` | ~130 | joint windows ∩ URDF limits, step caps, preset load/clip, NaN rejection |
| `events.py` | ~70 | sequenced event ring buffer + WS fan-out (used for chat/log) |
| `presets.json` | — | joint window + 4 named poses: `home`, `table_wide`, `door`, `shelf_cans` |
| `static/index.html` | ~250 | big video, chat column, joints + controls |

Run examples:
```
python3 webpanel/server.py                       # robot cam via listen:// (agent pushes frames in)
python3 webpanel/server.py --port 8080            # production run (verified live, t=15:09)
python3 webpanel/server.py --cameras "robot:sshtcp://machinekind-dgx/dev/video0?via=10.42.0.1&pass=1"   # if agent not running
python3 webpanel/server.py --cameras "robot:listen://,pc:/dev/video0"   # robot cam + laptop cam together
python3 webpanel/server.py --port 8081 --iface vcan-none --cameras 'robot:listen://127.0.0.1:18097?peer=127.0.0.0/8'   # test mode, no real CAN
python3 webpanel/server.py --agent-net 127.0.0.0/8 --cameras 'robot:listen://127.0.0.1:18098?peer=10.42.0.0/24'  # role-gating test
```

Lint: `ruff check webpanel/` (clean at ship time).

### Other pre-existing repo components read/relied on
- `galaxeo-manipulators/so101_bridge.py` — the proven `A1X` class (CAN TX encode), `A1X_URDF`, `A1X_JOINTS`, `--home` flag for named home pose.
- `galaxeo-manipulators/kinematics.py` — `Chain` class, used to read URDF joint limits.
- `galaxeo-manipulators/can_up.sh` — brings up CAN bus via the `galaxeo-ros2` docker container, **listen-only** (transmits nothing).
- `galaxeo-manipulators/docs/STEERING.md` — documents safe-abort behavior and the recovery procedure (only fix for a "deaf" arm = power-cycle).
- `galaxeo-manipulators/dgx-agent/a1x/` — a ReAct monitoring/tool-use agent running on the DGX: `main.py`, `tools.py`, `config.py`, `panel_client.py`, `cameras.py`, `patrol.py`. Talks to the panel via WS (`chat` cmd) and REST (`/api/event`, `/api/events?since`), pushes JPEG frames to the panel over TCP (originally port 8097), and can issue `pan_tilt` (J1/J3 jog) tool calls to "look around". Runs as `a1x.track_main` (tracker/agent process, pid seen as 126815 in one session).
- Docker: `docker compose` used to check/manage the `ros2` container (`docker compose ps`, `docker compose exec -T ros2 ...`).

### GitHub publish
- Repo published: **https://github.com/Bukareszt/galaxeo-manipulators** (public), commit `feat: add web control panel (camera streams + A1X joint control)`.
- Upstream: `machinekind/galaxeo-manipulators` (public, no LICENSE file — effectively all-rights-reserved; user's copy is a fresh push of full history + new commit, not a true GitHub fork, because `gh repo fork` was blocked by the permission classifier and the GitHub MCP tool had no auth).
- `.env` in repo checked and confirmed clean (docker UID/base-image config only, no secrets).
- `.gitignore` already covered `__pycache__/`.

---

## 3. Protocol / API details

### webpanel v1/v2 HTTP + WS surface
- `GET /` — panel UI (index.html)
- `GET /health` — JSON status: `{"arm": {...}, "cameras": {...}}`. `arm` fields include `status`, `connected`, `engaged`, `feedback_fresh`, `q` (joint positions array), `tx` counters. `cameras` maps camera name → `{frames, errors, last_error, ...}`.
- `GET /stream` (v1, single cam) / `GET /stream/{name}` (v2, multi-cam and v1-late) — MJPEG stream.
- `WS /ws` — bidirectional: browser/agent sends `{"cmd": ...}` messages (e.g. `{"cmd":"chat", ...}`, jog, engage, stop, preset); server pushes state snapshots and events.
- `GET/POST /api/state` — arm/camera state (v2).
- `GET /api/events?since=<seq>` — polling endpoint for the ring-buffer event log (v2), used by the DGX agent.
- `POST /api/event` — used by the DGX agent to push chat replies / log entries back into the panel's chat stream (images in log events render inline in the chat column).
- `GET /api/presets` — list of named poses.
- `GET /api/map` — presumably joint/topic mapping info.

### Role gating (v2, `--agent-net` flag)
- Peer IP determines role: clients from the configured agent network (e.g. `10.42.0.0/24`, the cable subnet) = role **`agent`** — restricted to `chat` / `preset` / `pantilt` / `move_joints`, and only while the arm is engaged **and** an "agent may move the arm" checkbox is ticked in the UI.
- All other peers = role **`operator`** — full control: engage / enable / jog / grip / STOP.
- REST endpoints carry zero motion by themselves; a REST event that claims `from:"operator"` when the actual peer isn't operator → **403**.
- Tested: forged-operator REST event → 403; frame push accepted from allowed camera peer CIDR, rejected from outside it; NaN in joint commands rejected; unknown preset name rejected.

### Camera source URL scheme (`camera.py`, v2)
- `local path` e.g. `/dev/video0` — local ffmpeg capture, native MJPG passthrough.
- `ssh://host/dev/videoN` — remote capture via ssh + gst-launch re-encode on remote side (used for cloudflared-tunnel path, capped low fps/res for bandwidth).
- `sshtcp://host/dev/videoN?via=<ip>&pass=<n>` — ssh only triggers the remote gst-launch pipeline; actual video pushed directly over **TCP from DGX to laptop** (reverse-direction push, since DGX→laptop TCP works but laptop→DGX TCP is blocked). Used for the direct-LAN/cable connection.
- `listen://[host:port]?peer=<CIDR>` — panel opens a TCP listen socket and accepts pushed MJPEG frames from an allowed peer CIDR (used by the DGX agent's own push client, decoupled from ssh entirely).

### Remote capture pipeline (DGX side, gst-launch — DGX has no ffmpeg)
```
gst-launch-1.0 -q v4l2src device=/dev/video0 ! image/jpeg,width=1280,height=720,framerate=30/1 ! fdsink fd=1
```
Downscaled/re-encoded variant used for the cloudflared-tunnel path:
```
gst-launch-1.0 -q v4l2src device=/dev/video0 ! image/jpeg,width=1280,height=720,framerate=30/1 ! jpegdec ! videorate ! videoscale ! ... (640x360 @10fps target, JPEG q~45-50)
```
Note: `gst`'s `tcpclientsink` cannot use scoped (link-local, `%iface`) IPv6 addresses — workaround was gst → stdout → small custom Python TCP sender script on the DGX.

### CAN / arm control model
- Single-writer rule: only one process may TX on `can0` at a time (panel XOR `so101_bridge.py`/teleop/ROS driver).
- Engage sequence: press Engage → target latches to currently-measured pose (no jump).
- Enable sequence: CAN frame sequence **FF 1→5→6**, sent only via button + confirm dialog; `p_des=q` (position desired = current measured) streamed throughout to avoid sag.
- STOP: ceases all TX immediately; arm holds position (documented safe abort — A1X has no brakes but holds under an uncommanded/undriven bus, per repo docs).
- Auto-disengage triggers: stale feedback >150 ms, or the last connected browser tab closes while engaged.
- Slew-rate cap: 30 deg/s default (`--slew` flag to change), plus URDF joint-limit clamping.
- `--home "0,60,-90,0,0,0"` style flag on `so101_bridge.py` used as a home-pose reference for `presets.json`'s `home` entry (deg): `[0, 60, -40, 0, 0, 0]` — **noted as a guess, not yet validated on hardware**.

### G0.5 (OpenGalaxea) action/data spec — `configs/data/r1lite.yaml`
```yaml
action:
  - key: left_arm      lerobot_key: action.left_arm      raw_shape: 6
  - key: left_gripper  lerobot_key: action.left_gripper  raw_shape: 1
```
6 joints + 1 gripper, joint-space, radians — matches A1X's action vector exactly (R1 Lite arms *are* A1X arms per this finding).
Codec detail: G0.5's 27-dim codec merges `left_control: [left_arm(6), left_ee_pose(9)]`; for single-arm/joint-only deployment it supports `dropout_noop_parts: true` and `absent_key_fill_value: -100.0` for absent groups (e.g. missing right arm/wrist cam).
Inference/control rate: **15 Hz** action chunks from `g05-base`; needs interpolation up to the panel's 200 Hz stream.
Camera keys expected: `exterior`, `wrist_left` (+ `wrist_right`, zero-padded if absent).

---

## 4. Grasping / VLA pipeline — models tried, evaluated, or rejected

No actual grasping/inference run took place in these three sessions — this was research + one interrupted zero-shot attempt (download only). Findings on model landscape for A1X (6-DoF joint-space, 1-2 cams, DGX Spark target):

| Model | Size | Verdict for A1X | Notes / provenance |
|---|---|---|---|
| **OpenGalaxea/G05 (G0.5)**, `g05-base` | ~11GB checkpoint (55GB full set) | **Best zero-shot candidate** — action spec (6 joint + 1 gripper, radians) matches A1X exactly; R1-Lite arms = A1X arms | ships full zero-shot deployment entrypoint (`experiments/r1lite`, server/client over WebSocket, 15Hz); also `g05-so101` (SO-100/101 zero-shot client, good template — zero-pads missing cameras, has proprio OOD guard), `g05-droid`, `g05-libero`, `g05-robotwin20`. License: **non-commercial**. (d9dfa6a4, t=15:15) |
| **X-VLA-0.9B** (`lerobot/xvla-base`) | 0.9B | Best **fine-tune** target if G0.5 zero-shot fails | Native in LeRobot (`policy.type=xvla`), `action_mode=auto` reads action dim from dataset directly — no custom code needed for the 7-dim joint action. Soft-prompt Phase-II adaptation designed for new embodiments. Proof point: `Serbronn/galaxea_r1_lite_real_v3` = X-VLA fine-tuned on Galaxea R1-Lite from **15 episodes / 59.5k frames**; also `fazreyzainal/xvla-galaxea-batch32-jitter-20step-policy`. Training cost: ~20k steps, bf16, fits a GB10. (d9dfa6a4, t=15:12) |
| **GR00T N1.7** | 3B | Viable fine-tune target | Already installed + smoke-tested on the DGX (`~/groot`): **242 ms per 40-step chunk, 12.6 GB** VRAM. `new_embodiment` tag + relative actions; 30-100 demos needed, zero setup left. (d9dfa6a4, t=15:12) |
| **π0.5 / π0.6** (`lerobot/pi05_base`; π0.6 = π0.5+RECAP) | 3.3B | Fine-tune target | Strongest generalization; expert-only FT keeps memory low; 50-150 demos, slowest to train. |
| **SmolVLA-450M** | 0.45B | Cheapest option, fastest to prototype | LeRobot-native; full finetune fits in <2.4GB VRAM; 4k steps = 7-11 min. Used in the AMD ROCm Real2Sim2Real pipeline (cdcb1331). |
| **ACT** | 52M | Baseline / data-quality sanity check | `ngo275/galaxea_act_*` proves ACT works on Galaxea hardware; ~50 demos, hours to train. |
| **openpie-0.6** (`exla-ai/openpie-0.6`) | 7.2B | **Rejected** | 14-dim dual-arm ALOHA action space, trained on `aloha_sim_transfer_cube` — wrong embodiment/action-dim, not a drop-in. (d9dfa6a4, t=15:12) |
| `pengyue-polaron` A1 checkpoints (`pi05-galaxea-a1-fruit-placement-eef`, `LingBot-VA` 5B) | — | **Rejected as drop-in** | Closest *robot* match but **EEF action space** (A1X stack is joint-position over CAN) + ROS1-in-container runtime — needs an IK layer + vendor SDK, real integration work, not zero-shot. (d9dfa6a4, t=15:12) |
| `GSwujiamin/pi05_a1x` | — | **Rejected** | Empty HF repo — only `.gitattributes`, 0 downloads, despite the name. (d9dfa6a4, t=15:15) |
| G0.5 (initial pass, before re-check), OpenVLA-OFT, Cosmos Policy | — | earlier verdicts unchanged / no A1X entrypoint found in first pass | superseded by the G0.5 re-check above |

**Zero-shot attempt status:** Download of `g05-base` checkpoint (~11GB) was started on the DGX via `huggingface_hub.snapshot_download`, then the user said "wait stop it" — **the ssh command had already reached the DGX and kept running in background (pid 145684) despite the tool call showing as rejected locally**. At last check (t=15:40): 777 MB downloaded total, `model_state_dict.pt` (11GB) at 686MB (6%), `action_tokenizer.pt` (484MB) at 64MB, speed ~2 MB/s (16 Mbit/s), ETA ~1.5-2h at that rate — bottlenecked by DGX's route (cable→laptop NAT→laptop's weak WiFi) rather than the DGX's own (2.7x stronger) WiFi. Session ends without a decision recorded on how to proceed (options given: drop cable to let DGX use its own WiFi / kill tracker / leave it / kill download).

**Install reality-check for G0.5 on DGX (GB10/sm_121):** pyproject pins torch 2.7.1+cu128 and Python 3.10 — cu128 has no sm_121 kernels for GB10; several deps (sapien, open3d, mplib, robosuite) have no aarch64 wheels. `flash_attn` imports are guarded with a fallback (attention switchable to eager/sdpa) → a **minimal inference-only environment** is the intended install path, not the full training env.

### Camera-to-slot mapping decided for G0.5 zero-shot attempt
- DGX-mounted C920 (arm-mounted, agent pans it via J1/J3) → `wrist_left`
- Laptop "TM Technology" cam (static, table view) → `exterior`
- `wrist_right` → zero-padded (absent)
- Caveat noted: agent's YOLO detection boxes are burned into the DGX camera stream — VLA needs a clean (unannotated) frame path, which did not yet exist.

### Real2sim / actuator-model research (session cdcb1331 — literature survey, no implementation)
Two established research threads found, with a gap between them:
1. **Video→sim reconstruction (real2sim2real) crowd** — uses 3D Gaussian Splatting + analytic physics param ID (PD gains, friction), e.g. AMD ROCm Real2Sim2Real (arXiv 2607.22997: 3DGS + Genesis + SmolVLA-450M fine-tune, <1h pipeline, <2.4GB VRAM, zero-shot to real Franka), EmbodieDreamer (2507.05198, PhysAligner), TwinAligner (2512.19390), RoboGSim, RL-GSBridge, HyperSim, CMU (Jangir 2026, video→physics-consistent sim for VLA *evaluation*).
2. **Learned actuator networks** — replace analytic servo model with a small NN: **NeuralActuator** (arXiv 2607.11734) is the closest prior art to the user's idea — 1.44M-param Transformer, 9-frame window input `(q, q̇, target, current, temp, voltage, tracking_error)` → torque surrogate + external force + contact gate + motor health; embedded in **MuJoCo MJX**, trained *through* differentiable simulation (no torque-sensor labels needed — pose error backprops through dynamics); tested on OpenManipulator-X, **SO-101**, Panda; runs at 60Hz with >4000Hz throughput; BC pick-place 92.5% vs 80% baseline; force estimation 5.5x better than classical. Code: `Frank-ZY-Dou/Dynamics-Modeling`. Also: GenAN/Generalized Actuator Networks (2604.09487), Actuator Reality Shaping (2607.02205, inverse trick reshaping real servo response to match idealized 2nd-order model — cheaper than learning a full actuator net), Extended friction models (2410.08650, analytic backlash/stiction), lineage from Hwangbo 2019 ANYmal actuator net.
3. **Gap identified**: nobody combines video-reconstructed scene + learned NN actuator + VLA trained inside it. This became the basis for a proposed paper idea (see §8 Decisions).
4. **Competing "skip physics" path**: video world models as simulator (DreamGen, World-VLA-Loop, RoboWorld, Cosmos Policy, Genie Envisioner) — no servo model at all, weak on contact/force.
5. **Sim training of VLAs today (2026 state)**: used for (a) evaluation (LIBERO, SimplerEnv, RoboCasa — dominant), (b) RL post-training (SimpleVLA-RL, ICLR 2026: OpenVLA-OFT → 97.6 LIBERO-Long, real "Stack Bowls" 38%→70% with zero real images in training; RLinf-Co does sim-real co-training), (c) data multiplication (MimicGen/DexMimicGen: ~200 human demos → tens of thousands sim demos), (d) locomotion/humanoids (standard for years, proprioceptive-only). NOT used to fine-tune per-embodiment without teleop demos, mainly due to: visual domain gap (sim renders OOD for VLM backbone), contact/friction/deformable-object modeling gaps, asset-authoring bottleneck, and — the "unstated" reason — economics: 30 teleop episodes (40-60 min human time) is cheaper than building a tuned sim scene (days of engineering) for a single task; sim only wins past ~10k episodes, RL, or when real is dangerous.
6. **Full digital-twin landscape**: **Real-is-Sim** (arXiv 2504.03597, RAI Institute) is closest to a true dynamic digital twin — uses Embodied Gaussians, syncs with real robot at 60Hz; policy always runs on the *simulated* robot, the real robot just follows the simulated joint states, and the sim is continuously corrected by real measurements (so sim2real gap disappears by construction) — but only validated on PushT (single flat pushing task). Table of sim platforms compiled: Isaac Sim/Lab (best render, PhysX, actuator nets only for legs, native GR00T support), Genesis (used in AMD pipeline + SmolVLA, ideal PD only), MuJoCo MJX/Playground (weaker render but differentiable — where NeuralActuator lives, via LeRobot), ManiSkill3/SAPIEN (GPU-parallel, base of SimplerEnv), RoboCasa/robosuite (MimicGen data source for GR00T), RoboVerse/MetaSim (unifying layer). Conclusion drawn: "digital twins are visual, not dynamic" — no existing twin models *why* a servo misbehaves at the joint-dynamics level.
7. **Concrete A1X stack proposed** (not yet built): URDF from `userguide-galaxea/URDF` (has A1, A1X, A1Y, R1); driver = the user's fork `Bukareszt/galaxeo-manipulators`; data collection reference = `pengyue-polaron/galaxea-a1-runtime` (teleop + LeRobot format already implemented); dynamics baseline = A1Z SDK's Pinocchio RNEA gravity compensation (free baseline); simulator = MuJoCo MJX (URDF→MJCF); render = 3DGS composited onto MJX render; VLA = SmolVLA via LeRobot, then π0.5 via openpi. **Warning flagged**: vendor URDFs typically have "garbage inertia tensors" (rounded masses, box-approximated inertias, or zeros) — recommended to validate by comparing Pinocchio RNEA gravity torque on the URDF vs real servo current at static poses, *before* training any actuator net.
8. **Zero-teleop pipeline landscape**: Tier 1 (ready, zero-shot verified on real hardware) = AMD ROCm Real2Sim2Real only (3DGS scene + Genesis scripted grasp trajectories, 100% synthetic-data-gen success, SmolVLA-450M fine-tune 4k steps/7-11min/<2.4GB VRAM, zero-shot on physical Franka, whole pipeline <1h). Tier 2 (build-it-yourself) = ManiSkill3 (`mplib` motion planning for easy tasks, RLPD/RFCL for hard ones — but ManiSkill3's own docs state it supports VLA *evaluation*, not training: "Training VLA models on simulation data is left to future work"). Tier 3 (pure RL, no demos) = SimpleVLA-RL (needs an SFT checkpoint start, so not fully zero) and RL Bootstrapping for Novel Embodiment (arXiv 2608.01013, zero demos, dense geometric rewards from sim state, PPO→GRPO, only 34.25%→53.5% on 4 directional commands, 9.75% object-nav — explicitly proof-of-concept, not solid manipulation). Tier 4 = MimicGen/DexMimicGen (~10 human demos → tens of thousands sim demos, best effort/result ratio when 10 demos are available).

---

## 5. Data recording / datasets

- Target dataset format for A1X fine-tuning: **LeRobot v3** — `record_a1x.py` (pre-existing in repo) already writes this exact format.
- Data issues flagged before any fine-tuning:
  1. Teleop mapping is relative-to-start-pose → actions not task-anchored across episodes; fix by using `--home` or recording deltas.
  2. `arm_joint5` never moves under SO-101 teleop — constant column in recorded data.
  3. Gripper action-dim semantics unverified; force-freeze behavior makes the gripper action non-monotone.
  4. Single-writer CAN rule applies to recording too — the panel (if running) owns `can0`; recording/inference must go through the panel or the panel must stop.
- Proposed actuator-net training data (from research session, not yet executed): "motion babbling" — random smooth trajectories + payload variation, log `(cmd, q, q̇, current, temp, voltage)` at 200Hz, ~90 min to 2h suggested as sufficient. Followed by a DAgger loop (VLA visits states babbling didn't cover → retrain adapter) — called "not optional" since babbling distribution ≠ VLA-visited distribution.
- G0.5 training-data camera convention: `exterior` + `wrist_left` (+ `wrist_right`, zero-padded when absent) — matches what R1-Lite training used, informs how A1X's two available cameras should be assigned.

---

## 6. Safety invariants and limits

- **Single-writer-per-CAN-bus rule**: never run the webpanel simultaneously with `so101_bridge.py`, teleop, or the ROS2 driver's own TX — exactly one process transmits on `can0` at a time. Explicitly re-verified during the "deaf arm" incident (checked for competing writers on host and inside the `ros2` container).
- **A1X has no brakes** — power loss = immediate drop. Before any power-cycle, physically support the arm.
- Panel **starts disengaged** — transmits nothing until Engage is pressed.
- **Engage** latches the commanded target to the currently-measured pose — no jump on engage.
- **STOP** immediately ceases TX; arm holds position (documented safe abort in `docs/STEERING.md`).
- **30 deg/s slew-rate cap** by default (`--slew` flag), plus URDF-limit clamping on all commanded positions.
- **Auto-disengage** conditions: stale feedback for >150ms, or the last connected browser tab closes while still engaged.
- **Enable sequence** (CAN frames FF 1→5→6) gated behind a button + confirm dialog in the UI; always streams `p_des = q_measured` throughout the sequence to avoid any sag/jump.
- v2 role gating: only `operator`-role peers can engage/enable/jog/grip/STOP; `agent`-role peers (identified by source CIDR) are limited to chat/preset/pantilt/move_joints, and only while engaged AND an explicit "agent may move the arm" checkbox is ticked.
- Observed operational habit/warning: large slider drags on joint targets can command long, fast sweeps that put the arm into a "deaf" unresponsive state (see §7) — jog buttons (±1°/±5°) are the safe default; a max-step clamp on slider-driven goals was proposed as a future fix but not implemented in these sessions.
- CAN bus needs to be brought back up (`./can_up.sh`, listen-only) after every arm power-cycle or adapter re-enumeration event.

---

## 7. Gotchas and failure modes

1. **"engaged" substring bug**: `"not engaged"` matched the substring `"engaged"` in a naive status check → wrong `ok` flag returned to client. Fixed by returning explicit `(ok, detail)` tuples instead of substring matching. (400ae84c, t=17:41)
2. **Orphaned ffmpeg holding the camera device** after a server restart/crash — `pkill -f "server.py --port 8093"` didn't always match the running process's exact cmdline (e.g. after restarting on a different port or with `nohup`), leaving a zombie server + ffmpeg holding `/dev/video0`. Root-caused by identifying the ffmpeg's actual parent PID (`ps -o pid,ppid,etime,cmd`) and killing the correct stale server PID directly. Server's own cleanup (kill ffmpeg on task-cancel) is skipped if the server itself is SIGKILLed. (400ae84c, t=17:41 / t=18:00-18:06)
3. **"Deaf arm" incident**: after a slider drag commanded a long fast sweep (goal dragged to J1 ≈ −122° while the arm stood at +61°), the arm continued reporting valid position feedback (200Hz, fresh) but stopped responding to any command — a 1° probe on J1 moved only 0.02°. Diagnostics performed and ruled out: panel/CAN link problem (feedback fine), competing CAN writer (`docker compose exec -T ros2 ... ps aux`, host `pgrep`, none found), TX not leaving the adapter (`ip -s link show can0`: 195 Hz TX, 0 errors — frames reached the wire fine). Ran the documented FF 1→5→6 enable sequence 3x with setpoint pinned to measured pose (arm never sagged, 0.02° shift) — still deaf. **Per `docs/STEERING.md`, only fix is a physical power-cycle** (48V supply off ~5s, back on); after power-cycle, `can_up.sh` must be rerun (adapter re-enumerates) and the panel reconnects automatically within ~2s. Confirmed recovered post-cycle with a fresh 1° probe (moved ~0.96-0.98°). (400ae84c, t=17:54-18:06)
4. **WS drain loop that never terminates**: a naive "drain all queued websocket messages" loop never exits because state messages arrive faster than the timeout — had to be killed via `TaskStop` and rewritten to read fresh state via `/health` instead of draining the WS queue. (400ae84c, t=17:54)
5. **Stale queued WS message misread as real robot state** — led to briefly believing the arm had a "+0.83° residual" after a probe; actually just an old queued WS message being read. Resolved by reading `/health` after the fact instead of trusting live WS stream mid-probe. (400ae84c, t=17:54)
6. **cloudflared tunnel bandwidth**: only ~0.23 MB/s sustained — native 720p30 MJPG needs ~5 MB/s, so remote camera capped initially at 1.3 fps (unusable), improved to ~6-7.8 fps by re-encoding remote-side to 640x360 @6-10fps, JPEG q45-50 (~0.13-0.15 MB/s).
7. **Laptop→DGX TCP is blocked but DGX→laptop TCP works** — cause identified as either DGX-side firewall or AP client isolation (couldn't fully diagnose: no sudo on DGX to check firewall rules there). Confirmed via manual TCP port probes (`/dev/tcp/...`) — port 22 and 8091 both blocked laptop→DGX; DGX→laptop `curl` succeeded. Architecture pivoted: ssh (through cloudflared) only *starts* the gst-launch pipeline remotely; the actual video is *pushed* DGX→laptop over a direct TCP socket the panel listens on.
8. **Direct ethernet cable — no DHCP**: DGX would sit on "getting IP" indefinitely on a point-to-point cable with no DHCP server and no sudo access on DGX to configure a static IP. Fixed by switching the laptop's NM connection profile (`cable-dgx`) to `ipv4.method shared` — laptop becomes the DHCP server (10.42.0.1), DGX auto-leases (10.42.0.217).
9. **NetworkManager on DGX stopped auto-connecting** after repeated failed DHCP attempts on the cable interface. Workaround (no sudo needed on DGX): physically bounce the *laptop* end of the link (`sudo ip link set enp92s0 down` then `up`) — DGX sees carrier down/up and retries autoconnect, which then succeeds once DHCP is actually available.
10. **`gst-launch`'s `tcpclientsink` cannot handle scoped IPv6 link-local addresses** (`fe80::...%iface`) — had to fall back to `gst → stdout → small custom Python TCP sender script` running on the DGX to push frames, until the connection moved to plain IPv4 via DHCP (at which point it worked cleanly).
11. **firewalld `nm-shared` zone rejects everything except DHCP/DNS** — once the laptop's ethernet connection switched to NM "shared" mode, its interface landed in firewalld's `nm-shared` zone, causing "Connection refused" on the video push port (8097) even though WiFi (default Fedora zone, which allows ports >1024) had worked fine before. Fixed with `sudo firewall-cmd --zone=nm-shared --add-port=8097/tcp --permanent && sudo firewall-cmd --reload`.
12. **Camera device path instability**: cameras can enumerate as different `/dev/videoN` nodes across replug events; a camera device typically claims two `/dev/video*` nodes, and the capture-capable one is usually the even/first-numbered one. Missing-device warnings originally spammed every 2s — fixed to be quieter/backoff in `camera.py`.
13. **Interrupted tool call still executed remotely**: when the user hit "wait stop it" on an `snapshot_download` ssh command, the tool call showed as rejected/interrupted locally in the transcript, but the ssh command had *already reached the DGX* and kept running in the background (verified via `ps` showing pid 145684 actively running, minutes later). Lesson: an interrupted remote (ssh) command is not guaranteed to have been cancelled server-side — must verify via a follow-up check, especially for long-running downloads/installs on shared machines.
14. **Duplicated memory line** — a line got duplicated when editing `a1x-webpanel-setup.md` memory file; caught via `grep -c` before continuing, then removed with a small Python dedup script.
15. **YOLO detection boxes burned into the raw camera stream** by the monitoring agent — this pollutes the frames a VLA policy would need for zero-shot inference; a separate clean (unannotated) frame path was identified as necessary but not yet built. (d9dfa6a4, t=15:24)
16. **G0.5 install on GB10/DGX Spark**: `pyproject.toml` pins torch 2.7.1+cu128, which has no sm_121 (GB10) kernels; deps `sapien`, `open3d`, `mplib`, `robosuite` have no aarch64 wheels — full training environment is not installable as-is; only an inference-only, minimal environment (with `flash_attn` disabled / falling back to eager/sdpa attention) is viable. (d9dfa6a4, t=15:26)

---

## 8. Decisions + rationale

- **Chose ffmpeg (not OpenCV/re-encode) for local camera capture** — camera natively outputs MJPG at 720p30, so ffmpeg just copies the stream (`-c:v copy`), avoiding CPU cost of re-encoding. (400ae84c)
- **Chose aiohttp over Flask/FastAPI** — only aiohttp was readily available/installed; used for both HTTP and native WebSocket support in one framework. (400ae84c)
- **Chose direct-TCP push (DGX→laptop) over ssh tunneling or cloudflared for the robot camera**, once LAN/cable connectivity was confirmed — because laptop→DGX TCP is blocked but the reverse direction works, and LAN/cable bandwidth (2.3 MB/s WiFi LAN, 116 MB/s cable) vastly exceeds the cloudflared tunnel (0.23 MB/s). This became the `listen://` camera mode in v2, decoupling video entirely from ssh/tunnel round-trips.
- **Published the modified repo as a fresh public repo rather than a true GitHub fork** — `gh repo fork` was blocked by the local permission classifier, and the GitHub MCP tool had no auth configured; a fresh `gh repo create` + push achieves the same practical outcome (full history + new commit) minus the "forked from" badge. Flagged as reversible: delete + use the web UI Fork button + push again, if the badge matters.
- **Rebuilt webpanel from scratch in session d9dfa6a4** rather than restoring the old `webpanel/` from git history, in order to match the API contract already hard-coded into the pre-existing `dgx-agent/a1x/` monitoring agent (chat via `/api/event`, `/api/events?since`, frame push, WS roles) — an `AskUserQuestion` was used early in that session to resolve build-approach forks (implied: whether to keep the old contract exactly or improve it) before writing files.
- **Research-session reframing of the actuator-net idea** (cdcb1331): the user's original framing ("train a small NN to replace servo simulation for better VLA sim training") was reframed by the assistant, with the user's agreement, from a *sim-fidelity* project (learn accurate actuator dynamics inside a simulator) to an *inverse dynamics adapter* project — a small per-arm network sitting between VLA joint-trajectory output and the servo bus (`VLA → desired traj (30Hz) → [per-arm adapter, 200Hz] → servo commands`), positioned as "LoRA for the body, not the brain": VLA trained once on a canonical/reference embodiment in sim, adapted per real arm via cheap motion-babbling (no task demonstrations) instead of per-arm/per-task teleop data collection. Rationale: existing "adapter" work (GR00T N1 EmbodimentTag, X-VLA soft prompts, HPT stems, CrossFormer, OpenVLA LoRA, etc.) all solves the *semantic/kinematic* mapping problem and still requires task demos on the new arm — the *dynamics* adapter (friction/backlash/lag/gear-ratio compensation, zero task demos) is comparatively unaddressed in the literature as of the search performed.
- **Key required validation step (repeatedly flagged, not yet executed in any session)**: a "week-0" system-ID probe on the real A1X — step response + 0.5-5Hz sinusoid sweep — to measure command-vs-actual lag and steady-state tracking error. Rationale: A1X uses quasi-direct-drive actuators (not hobby-grade STS3215 servos like SO-101), so it may track too well for the friction/backlash/lag gap to be measurable, which would kill the "actuator adapter matters" research claim before any training begins. If the gap turns out small, the recommended pivot is to make cheap arms (SO-101/SO-ARM100) the primary experimental platform instead of A1X.
- **Chose to investigate G0.5 zero-shot over immediately fine-tuning X-VLA** — because G0.5's action spec was confirmed (on re-check) to exactly match A1X's, and it ships a ready client/server deployment path, so it costs "a download plus a client" versus a data-collection + training cycle. X-VLA remains the fallback fine-tune target if zero-shot transfer from the R1-Lite prior fails.
- **Recommended validating the G0.5/AMD-style zero-shot pipeline on a simple rigid object (e.g. a can) before attempting deformable garbage-sorting objects** — rationale: if zero-shot works on a simple case, it gives a working baseline to build on; if it doesn't, it's a measured (not assumed) signal that the dynamic/visual sim2real gap is real, which itself motivates the actuator-adapter research direction. (cdcb1331, final message)

---

## 9. Open problems / next steps

- Panel: `presets.json` poses (`home`, `table_wide`, `door`, `shelf_cans`) are **unvalidated guesses** — must be driven individually with the arm clear before trusting `goto_preset`/`patrol`. The Engage path itself in webpanel v2 was never tested against live hardware in this session (only `--iface vcan-none` simulated testing was done).
- webpanel v2 changes were **not committed** to git as of end of session d9dfa6a4 (old `webpanel/` deletion was still unstaged in the working tree).
- No clean (unannotated, non-YOLO-overlaid) camera frame path exists yet for feeding a VLA policy — the agent's live stream has detection boxes burned in.
- G0.5 `g05-base` checkpoint download was left in an **undetermined state** — running in background on a shared DGX at ~2MB/s (~1.5-2h ETA), with the user asking about network optimization options (drop cable to let DGX use its stronger native WiFi vs. leave over cable vs. kill and restart) but no final decision captured in-transcript.
- No A1X-specific G0.5 client has been built yet (planned as a fork of `experiments/so100/so100_policy_client.py`, talking to the webpanel instead of a serial bus) — offered but not started.
- Actuator-adapter research direction (session cdcb1331) is at the idea/literature-review stage only — no code, no data collected, no week-0 sysID probe run yet. Concrete next step offered (and not yet accepted at time of session end) was to write the step-response/sine-sweep sysID script for A1X.
- Ethernet cable: works at full gigabit when used point-to-point with laptop as DHCP server, but this requires the laptop to stay powered/connected as the DHCP source; no sudo on DGX means DGX-side network config (e.g. static IP, opening its own firewall ports) cannot be done directly and must be worked around from the laptop side (shared-mode DHCP, carrier bouncing) — a lasting friction point for any future DGX-side setup.
- Whether the two currently-available cameras (DGX-mounted C920 as pseudo-wrist, laptop static cam as exterior) are an adequate substitute for G0.5's expected `wrist_left`+`exterior` (+`wrist_right`) setup for real grasping accuracy has not been empirically tested.
