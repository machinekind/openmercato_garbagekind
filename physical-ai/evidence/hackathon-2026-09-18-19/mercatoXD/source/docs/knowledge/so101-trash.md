# SO-101 / Trash-Sorting Robot — Mined Engineering Notes

Sources (all 2026-09-18, same evening, three separate local project dirs):
- `so101-traschlike__0b069768` — build of `/home/bukareszt/so101-traschlike/` web panel (Claude-VLM based)
- `so101-traschlike__ffc6fe44` — research session (RL on SO-101, datasets, VLA planning) + start of DGX-VLM plan (abandoned)
- `so101-traschlike__34b271a7` — empty/cleared session, no content
- `so101-traschlike__4e9bf138` — unrelated sysadmin task (SSH user provisioning on `machinekind-dgx`); only the DGX host facts below are relevant
- `traschlikeee__4d7bb7cb` — full rebuild as `/home/bukareszt/traschlikeee/` (local Qwen3-VL + YOLO detector + mock-arm agentic loop), deployed to DGX

Two DIFFERENT, UNRELATED codebases exist for the same physical hardware: `~/so101-traschlike` (Claude-vision panel, direct lerobot control) and `~/traschlikeee` (Qwen3-VL/YOLO agentic system with a *mocked* arm, meant to be swapped for real lerobot control later). Do not conflate them.

## 1. Hardware facts

**SO-101 arm**
- Connects as `/dev/ttyACM0` (USB serial), local machine.
- 6 servos, Feetech STS3215, IDs read via `lerobot.motors.feetech.FeetechMotorsBus`. Joint names: `shoulder_pan`, `shoulder_lift`, `elbow_flex`, `wrist_flex`, `wrist_roll`, `gripper`. Gripper = motor id `6`.
- Encoder range 0–4095 ticks (12-bit), uncalibrated arm reads raw ticks; after `lerobot-calibrate` it would report degrees.
- Example raw readout (uncalibrated, session 0b069768): `shoulder_pan 1936, shoulder_lift 1149, elbow_flex 3606, wrist_flex 2833, wrist_roll 2006, gripper 2047`.
- Gripper position limits: `2044–3499` ticks. `elbow_flex` stored soft max limit `3609` (observed once at `3615` from manual push while torque off — harmless, self-corrects).
- **Power spec**: STS3215 servos normally run at **7.4V** (some kits 12V). Bus was measured at only **4.8V** — servo logic (from USB adapter's 5V rail) works, but motor power rail was not delivering; this caused every joint to read 0 ticks moved under commanded motion despite encoders/comms being healthy. Root cause = PSU/barrel-jack not plugged in or dead, not a servo fault.
- Jog control (added in panel): ~4.4°/100-tick steps, goal always relative to current position, clamped to 0–4095 and to each servo's own limit range, refuses with an error message instead of ramming a limit.
- `lerobot` robot class: use `SO101Follower` / `SO101FollowerConfig` (NOT the base `SOFollower`/`SOFollowerConfig`, which rejects the `id` kwarg even though downstream code reads `.id`). Both live under `lerobot.robots.so_follower` / `lerobot.robots.so101_follower`.

**Cameras (local machine)**
- Two physical USB cameras: a "TM USB Camera" at `/dev/video2` (its `/dev/video3` is just the metadata/control node of the SAME device, not a second camera) and a Logitech C920 that appeared at `/dev/video0`.
- Both cameras support MJPG at 1280x720 (`cv2.VideoCapture` + `cv2.VideoWriter_fourcc(*"MJPG")`, `CAP_V4L2` backend recommended for reliable capture).
- TM cam (`/dev/video2`) produced all-black frames throughout the session — confirmed as a physically blocked/capped lens, not a driver issue (see Gotchas #5).
- C920 intermittently disappeared from the USB bus entirely (`lsusb` showed nothing) mid-session, needing physical replug.
- Cameras identifiable via `v4l2-ctl --list-devices`, `lsusb | grep -i cam`, `/dev/v4l/by-id/` and `/dev/v4l/by-path/`.

**Host machines**
- Local dev machine: has a CUDA GPU (`torch.cuda.is_available() == True`), Python 3, `lerobot==0.5.2` — one copy pip-installed, another **editable install at `~/Downloads/robbo/src/lerobot`** used for deeper API inspection (record/rollout scripts).
- Remote inference machine: SSH alias **`machinekind-dgx`** (only correct alias; user repeatedly mistyped `machinekind-dxc`, `dgx-machinekind`, plain `dgx`). It is a **DGX Spark**: GB10 chip (Grace-Blackwell), **aarch64**, **~121–128GB unified memory**, CUDA 13, ~392–404GB free disk on `/` and `/home`. Reached only via `ProxyCommand cloudflared access ssh --hostname %h` (Cloudflare Access gate) — real hostname `ssh-dgx.machinekind.ai`; internal hostname reports as `gx10-e0c0`. Shared box, ~9 users. Has its own camera at `/dev/video0` (used by `traschlikeee`'s remote-camera mode), accessible via `video` group perms. Already had a container called `so101-fastcam` running before this work started (implies prior robot-related use). Docker + tmux preinstalled; no ollama; no vLLM/model server running at session start.
- SSH config block used for a newly provisioned collaborator account (from unrelated ssh-provisioning session):
  ```
  Host machinekind-dgx
      HostName ssh-dgx.machinekind.ai
      User <username>
      IdentityFile ~/.ssh/id_ed25519
      ProxyCommand cloudflared access ssh --hostname %h
  ```
  New users need cloudflared installed locally AND must be allow-listed in the Cloudflare Zero Trust Access policy for `ssh-dgx.machinekind.ai` (server-side key alone is not sufficient).

## 2. Software components

### Project A: `/home/bukareszt/so101-traschlike/` (Claude-vision panel, direct arm control)
| File | Purpose | Run |
|---|---|---|
| `server.py` | FastAPI app: MJPEG camera streams, snapshot, VLM scan, arm endpoints | `cd ~/so101-traschlike && uvicorn server:app --host 0.0.0.0 --port 8000` |
| `panel/cameras.py` | Auto-detects `/dev/video*`, threaded frame grab, 1280x720 MJPG; per-camera exclusion list; auto-rescans every 5s when zero cameras present |
| `panel/vlm.py` | Sends frozen frame to **Claude vision** (default model `claude-sonnet-5`, override via `VLM_MODEL`), returns strict JSON detections |
| `panel/arm.py` | SO-101 follower via lerobot; originally read-only (no motion) for safety; later extended with torque enable/disable + per-joint jog |
| `static/index.html`, `style.css`, `app.js` | Dark-theme dashboard UI: live streams, "Scan for cans" freeze+draw-boxes, detections sidebar, arm card with joint-test panel |
| `tests/test_vlm_parsing.py` | 8 unit tests for VLM JSON parsing, all passing |
| `README.md` | Usage docs |

Verified endpoints: `GET /api/state`, `POST /api/arm/connect`, `GET /api/arm/status`, `POST /api/arm/disconnect`, `POST /api/scan/{camera_id}`, `POST /api/cameras/rescan`, `GET /snapshot/{cam}`, plus MJPEG stream route and torque/jog endpoints added later.

### Project B: `/home/bukareszt/traschlikeee/` (local Qwen3-VL + YOLO + agentic loop, mock arm → real arm later)
Built via an 8-agent automated "Workflow" (5 parallel builders + 2 reviewers + fixer), all confirmed compiling and passing tests.

| Path | Purpose |
|---|---|
| `shared/config.py`, `shared/schemas.py` | Cross-service config/contracts (Pydantic) |
| `services/detector/` | FastAPI YOLO detector service on **:8001**; wraps a pretrained trash-YOLO from HF (see §3); `model_loader.py` handles HF cache download; thread-locked inference (`app.state.model_lock`); binds `127.0.0.1` by default (`DETECTOR_BIND`) |
| `services/vlm/` | `serve.sh` launches **vLLM** serving Qwen3-VL locally on DGX with hermes tool parser; `client.py` OpenAI-compatible client with retry list `RETRYABLE_ERRORS`; `wait_ready.py` readiness probe |
| `services/agent/` | Agentic loop: `camera.py` (mock via `AGENT_MOCK_CAMERA=1`, later extended with a `RemoteCamera` class reading from DGX-hosted `camera_stream` service), `tools/robot_arm.py` (mock arm, `ARM_SUCCESS_RATE` env simulates grasp failure), `loop.py` (`AgentLoop`, `ToolGuard` enforces `pick_up`→`trash_out` ordering + retry cap), `events.py`, `annotate.py`, `main.py` |
| `services/panel/` | WebSocket dashboard on **:8080**; `main.py`, `static/{index.html,app.js,style.css}`; `WebSocketHub` refactored to per-client bounded `asyncio.Queue(maxsize=100)` + dedicated writer task so a slow client can't stall broadcasts |
| `services/camera_stream/` | Added mid-session: frame-grabber service on DGX **:8002** for when no camera is present locally |
| `deploy/deploy.sh` | rsync project to DGX (must exclude `.venv*` — initial version only excluded `.venv`, missed `.venv-test`, causing a very slow first sync) |
| `deploy/setup_dgx.sh` | Creates venvs, downloads models on DGX |
| `deploy/start_all.sh` | tmux-based orchestrated start: vlm → detector → panel → agent, **health-gated** (60×5s curl loop against `detector:8001/health` before starting dependents; `wait_ready.py` failure exits cleanly instead of silently aborting under `set -e`) |
| `deploy/stop_all.sh`, `deploy/start_dgx_inference.sh`, `deploy/start_local.sh` | Split-topology variants (DGX-only inference vs local panel+agent+tunnel) |

Run sequence:
```bash
DGX_HOST=<alias> deploy/deploy.sh
ssh <alias> '~/traschlikeee/deploy/setup_dgx.sh'
ssh <alias> '~/traschlikeee/deploy/start_all.sh'
ssh -L 8080:localhost:8080 <alias>   # then open http://localhost:8080
```
Test suite: 48 tests passing across `services/agent`, `services/detector`, `services/panel`, `services/vlm` (heavy deps like `ultralytics`/`huggingface_hub` are lazily imported and mocked in tests, so the suite runs without GPU/model weights).

## 3. Pick-and-place / sorting pipeline

Architecture (Project B, final form):
```
camera (DGX) ──▶ agent loop ──▶ detector :8001 (YOLOv8, TACO-pretrained)
                    │
                    ├──▶ Qwen3-VL-30B-A3B(-FP8) :8000 (vLLM local, hermes tool calling)
                    │        │ tool_calls
                    ├──▶ pick_up() ──valid──▶ trash_out()   (MOCK robo-arm)
                    │
                    └──▶ panel :8080 ──WebSocket──▶ browser dashboard
```
- **Detector model (chosen)**: `turhancan97/yolov8-segment-trash-detection` (HF), trained on **TACO** dataset. Alternative considered: `BowerApp/bowie-yolov8-multihead-trash-detection`.
- **Classes/categories** (Project A's Claude-based detector, `panel/vlm.py`): per-detection JSON with `label`, `category` (`can` / `other_garbage`), normalized bbox `[x,y,w,h]` (0–1), `confidence`, `graspable` boolean, `grasp_note` free-text — explicitly designed so the bbox contract is ready for a future pick pipeline.
- **Decision/ordering logic** (Project B, `services/agent/loop.py`): `pick_up`→`trash_out` order enforced **twice** — once via the VLM system prompt instruction, once in code via `ToolGuard`, which rejects `trash_out` with no prior valid `pick_up`, and rejects a second `pick_up` while already holding an object (`ToolResult(valid=False, message='Already holding <id>; call trash_out first', ...)`).
- **Retry logic**: `ARM_SUCCESS_RATE` env var simulates grasp failure in the mock arm; `MAX_PICKUP_RETRIES` caps total attempts per object; system prompt rule reworded to "attempt each item at most {MAX_PICKUP_RETRIES} times in total" to match the code's total-attempt cap (not per-retry).
- **No real pick was ever executed** — the arm's power-supply fault (§1, §7) meant zero joint motion was achieved this session; no success-rate numbers exist for real hardware. The mock arm's `ARM_SUCCESS_RATE` is a placeholder, not a measured value.
- `robot_arm.py`'s `ToolResult` contract (valid: bool, message: str, data: dict) is the stable interface meant to survive the swap from mock to real hardware — "reimplement `services/agent/tools/robot_arm.py` against your controller, keep `ToolResult` contract — nothing else changes."
- Panel state machine (dashboard): `idle → detecting → reasoning → picking → trashing`, shown live with VLM feed + tool-call log (green/red results).

## 4. Policy/model training or inference (research + decisions)

### RL on SO-101 (web research, no local experiments)
- **HIL-SERL** (human-in-loop RL) is the only *practical* real-hardware RL route found: [ggando blog](https://ggando.com/blog/so101-hil-serl/) reports **~70% grasp success after ~3 weeks** of implementation work. Companion sim work: [ggando SO-101 MuJoCo RL lift](https://ggando.com/blog/so101-rl-lift/) (SAC via Stable-Baselines3, 3cm cube, sim only).
- LeRobot has HIL-SERL built in officially; leader arm serves as the human-intervention interface during training.
- Pure RL, sim-only (no demos): `mmporong/so101-pick-rl` (state-based PPO, Isaac Lab, cross-eval in MuJoCo, no real deploy); `MuammerBay/isaac_so_arm101` (Isaac Lab reach/lift, RSL-RL/PPO; checkpoints on HF: `PathOn-AI/so-arm101-reach-isaaclab`, `PathOn-AI/so-arm101-lift-isaaclab`); Brax PPO in MJX (`Ripito/pickplace-mjx-day11-weld`, cube pick-to-air-target).
- Pure RL **with real-arm deployment (sim-to-real)**: only one credible source — **Squint** (arXiv 2602.21203): visual RL in ManiSkill3, 8 tasks incl. lift-cube, ~15 min training, domain randomization (camera pose/FOV, lighting, color jitter), transferred to real SO-101, **no demonstrations used**.
- **Correction made mid-session**: the "NVIDIA Isaac sim-to-real SO-101 course" was initially miscited as RL/PPO; after `WebFetch` verification it is actually **GR00T N1.5 (VLA) + imitation learning**, not RL — data via teleop + Isaac Sim synthetic + Cosmos augmentation, deployed via `lerobot-eval`. No pure-RL-direct-on-real-hardware-without-sim-or-human-help work was found anywhere.
- Pattern/lesson: RL is fine for reach/lift-in-sim; real contact-rich grasping needs either sim-to-real with heavy domain randomization (Squint) or human-in-the-loop (HIL-SERL). Both are harder for irregular/deformable trash objects than the rigid cubes used in all cited benchmarks.

### Datasets researched (no ready-made SO-101 trash manipulation dataset found)
Robot-manipulation (LeRobot-format teleop episodes):
| Dataset | Robot | Size | Note |
|---|---|---|---|
| `RobotisSW/Task_000645_PickPlace_Trash_KJM_WJW_lerobot` | Robotis (not SO-101) | ~412 rows, ~1.2GB, RGB head cam | task-design reference only, joint space differs |
| `pepijn223/mobile_so100_clean_trash_1` | mobile **SO-100** (≈SO-101 kinematics) | 50 episodes, 29,288 frames | closest usable match, potential co-training |
| `embracethesock/table_trash` | — | small | LeRobot format |
| `lerobot/svla_so101_pickplace` | **SO-101** (canonical) | — | official format reference, cube not trash |

Vision datasets (for a standalone trash detector):
| Dataset | Size | Annotation | Env |
|---|---|---|---|
| TACO | ~1,500 img / 60 cats | segmentation | litter in the wild |
| ZeroWaste | 4,503 img / 4 materials | instance seg | conveyor, cluttered, deformable — most realistic match |
| TrashNet | 2,527 img / 6 classes | classification | clean indoor, "toy-grade" |
| TrashBox | 17,785 img / 7 cats | classif/detect | web-scraped |
| Garbage Dataset (GD, 2025) | 19,762 img / 10 classes | classification | benchmark |
| SortWaste | dense boxes | detection | industrial sorting |
| Open Litter Map | 100k+ img | multilabel | outdoor crowdsourced |
| `keremberke/garbage-object-detection` | Roboflow | detection | ready on HF |
Catalog of ~30 more: [AgaMiko/waste-datasets-review](https://github.com/AgaMiko/waste-datasets-review).
**Conclusion**: no ready SO-101 trash-pick dataset exists; standard move is to teleop-record 50–100 own episodes (~1–2h), following the `pepijn223` example as proof of feasibility.

### VLA model selection for SO-101 (final recommendation, researched via workflow, Sept 2026)
Benchmark used: **arXiv 2606.08881** — the only independent head-to-head on physical SO-101, 4 tasks, 100 demos/task, unified protocol.
| Rank | Model | SO-101 measured success | Notes |
|---|---|---|---|
| 1 | **π0.5** (Physical Intelligence, LeRobot port `--policy.type=pi05`, `lerobot/pi05_base`) | **56.25%** avg, **30.77%** failure-recovery (best) | chosen target policy |
| 2 | GR00T N1.7 (NVIDIA, 3B, Cosmos-Reason2-2B backbone) | none published | best DGX Spark tooling (vendor-verified GB10 fine-tune in 5h47m), official `groot` LeRobot policy type, license shifting commercial — verify |
| 2 | Wall-X / WALL-OSS-0.5 | 51.25% (Wall-X predecessor) | Apache-2.0, thin ecosystem, no numbers yet for 0.5 |
| 4 | SmolVLA | 32.5% (≈ plain ACT 33.75%) | weakest generalizer, novel colors drop to ~1/3 |
| — | MolmoAct2 | unverified | open (AI2), claims zero-shot SO-101 — cheap smoke-test candidate |
Excluded: OpenVLA (no SO-101 LeRobot path), ACT/Diffusion Policy (no generalization by design, baselines only), π0.6 (weights unreleased), GR00T N2 (preview/unreleased, rumored #1 on RoboArena).

**π0.5 fine-tuning practicals**: LoRA fits a single 24GB GPU; full fine-tune needs ~70–80GB (fits the 128GB DGX Spark). Community minimum ~39 episodes for a single task; practical guidance ≥50 episodes minimum, "a few hundred" for whole-workspace robustness; benchmark itself used 100 demos/task. Plan **~100–300 episodes** varying objects/positions/lighting (~13–30k training steps). Inference ~485ms/action chunk — needs LeRobot's **Real-Time Chunking** (v0.6.0) to hide latency; this is called out as the slowest of the shortlisted candidates and "the main thing to validate early" on GB10. Community-reported training speed on GB10: ~9s/step native PyTorch (~13x faster than JAX on same box).

**Gemini Robotics family (state as of Sept 2026)**: action VLAs (`Gemini Robotics 2`, `On-Device 2`) are trusted-tester-only, no open weights, can't run locally. `On-Device 2` scores **53.3%** on SO101 per Google's own internal (non-comparable) eval — still below π0.5's 56.25%, and its model card admits weak out-of-distribution generalization; it adapts to new embodiments with <200 examples. `ER 1.5`/`ER 2` are reasoning-only (no actions) but public via API — pointing, plan decomposition, success/progress detection (91.3% moment-finding), tool calling; viable as an **A/B alternative to the Qwen3-VL reasoning layer**, not a replacement for the arm's action policy — tradeoff is cloud round-trip latency + API cost vs the fully local Qwen3-VL loop.

**VLA vs VLM disambiguation** (explicit user question, answered):
- VLA (outputs robot actions): π0.5, π0/π0.6, GR00T N1.7/N2, Wall-X/WALL-OSS, SmolVLA, MolmoAct2, OpenVLA, RDT-2, ACT, Diffusion Policy, Gemini Robotics/On-Device action models.
- VLM (perception/reasoning only, no actions): Gemini Robotics-ER 1.5/ER 2, Qwen3-VL, Cosmos-Reason2 (the VLM backbone *inside* GR00T N1.7).
- Stack mapping decided: VLM (Qwen3-VL, or ER 2 as an alternative) decides *what* to do → calls `pick_up` tool → VLA (π0.5, once integrated) executes the actual motion.

### Qwen3-VL serving (DGX, Project B)
- Model id evolved during the session: started `Qwen/Qwen3-VL-32B-Instruct` (dense) → corrected by user to **`Qwen/Qwen3-VL-30B-A3B-Instruct`** (MoE: 30B total params, only **3B active** per token, much faster) → later switched again to **`Qwen/Qwen3-VL-30B-A3B-Instruct-FP8`** to reduce download size/time.
- Served via **vLLM ≥0.11.0** with **hermes tool parser** for tool-calling. `TP_SIZE=2` env var provided as a tensor-parallel fallback.
- **vLLM successfully pip-installed on aarch64 DGX Spark**: `vllm==0.29.0` with `torch==2.13`, imports clean — no NGC container fallback needed in the end (originally planned as `nvcr.io/nvidia/vllm:26.08-py3`, tag `26.08-py3` was the latest found on NGC at the time, but abandoned once pip worked).
- Model size: ~60GB bf16 download (dominant cost of deployment); FP8 variant chosen to shrink this.
- Full model download to DGX was **not completed within the session** — see Gotchas/Open problems.

### Earlier abandoned plan (session ffc6fe44, before Project B existed)
- Original DGX-VLM plan used **`Qwen/Qwen2.5-VL-7B-Instruct`** via vLLM NGC container, paired with **SmolVLA** for the VLA. This entire plan was superseded once the user started the `traschlikeee` project fresh with Qwen3-VL-30B-A3B + a dedicated YOLO detector + mock-arm agentic loop; not built.
- SmolVLA API notes gathered (lerobot 0.5.2 editable checkout at `~/Downloads/robbo/src/lerobot`): expects observation image keys `observation.images.camera1/2/3` — camera must be literally named `camera1` in rollout config; the real-robot inference loop lives in **`lerobot_rollout.py`** (NOT `lerobot_record.py`, which is teleop-only); core inference call is `predict_action()`.

## 5. Protocol / API details and env vars (exact strings)

- `ANTHROPIC_API_KEY` — required by Project A's `panel/vlm.py` for Claude vision scan; scan endpoint fails cleanly with `"ANTHROPIC_API_KEY not set"` if absent.
- `VLM_MODEL` — override for the vision model. Project A default: `claude-sonnet-5`. Project B: holds the Qwen model id (see §4).
- `CAM_EXCLUDE` — camera index(es) to exclude in Project A's panel (e.g. `CAM_EXCLUDE=2`; empty string re-enables all).
- `AGENT_MOCK_CAMERA=1` — Project B agent uses a mock camera instead of a real device.
- `ARM_SUCCESS_RATE` — probability the mock arm's grasp "succeeds" (drives retry-path testing/demo).
- `MAX_PICKUP_RETRIES` — cap on total `pick_up` attempts per detected object.
- `DGX_HOST` — SSH alias consumed by `deploy/deploy.sh`, e.g. `DGX_HOST=machinekind-dgx bash deploy/deploy.sh`.
- `DETECTOR_PORT` (default `8001`), `DETECTOR_BIND` (default `127.0.0.1`), `PANEL_BIND` (default `0.0.0.0`).
- `HF_HOME` — redirected to `~/.cache/hf` on DGX (see Gotchas — default `~/.cache/huggingface` was root-owned).
- `HF_HUB_ENABLE_HF_TRANSFER=1` — enables the `hf_transfer` fast-download backend (`pip install hf_transfer`).
- SSH host: **`machinekind-dgx`** → `HostName ssh-dgx.machinekind.ai`, `ProxyCommand cloudflared access ssh --hostname %h` (Cloudflare Access gated).
- Project A endpoints: `GET /api/state`, `POST /api/arm/connect`, `GET /api/arm/status`, `POST /api/arm/disconnect`, `POST /api/scan/{camera}`, `POST /api/cameras/rescan`, `GET /snapshot/{cam}`.
- Project B panel: `GET /api/state` (used by `app.js` `hydrate()` on WS reconnect), `/api/events` — **flagged as having no auth**.
- vLLM launch pattern: `vllm serve Qwen/Qwen3-VL-30B-A3B-Instruct-FP8 --port 8000 ...` with hermes tool parser flag (exact CLI not captured verbatim in transcript, only the model id and parser choice).
- lerobot object model used: `SO101Follower(SO101FollowerConfig(port="/dev/ttyACM0", id=...))`, `.connect()`, `.get_observation()`; low-level motor access via `FeetechMotorsBus(port, {"gripper": Motor(6, "sts3215", MotorNormMode...), ...})`, `.read()`, `.sync_write()`, `.enable_torque()`/`.disable_torque()`.
- HF weight cache path used by the detector: `~/.cache/trash-yolo` (Project B `model_loader.CACHE_DIR`), populated via `hf_hub_download(cache_dir=...)`.

## 6. Safety invariants and limits

- Project A's `panel/arm.py` was **deliberately read-only** (no motion commands at all) until the user explicitly asked for joint-test controls — rationale given: "uncalibrated arm stays safe."
- Jog moves capped: ~4.4°/100-tick step size, goal always computed relative to current position, hard-clamped to `0–4095`, and further clamped to each servo's stored position limits (e.g., gripper `2044–3499`) with margin — refuses the move with an explicit error message rather than driving into a limit.
- Disconnecting the arm automatically drops torque (lerobot default behavior) — arm goes physically limp on exit.
- Project B enforces `pick_up`→`trash_out` ordering **in two independent places** (VLM prompt + code-level `ToolGuard`) as defense-in-depth against a tool-calling model choosing the wrong order.
- Double-`pick_up` (attempting to pick while already holding something) is explicitly rejected in code (`ToolResult(valid=False, ...)`), with an added regression test (`test_pick_up_while_already_holding_is_rejected`).
- `MAX_PICKUP_RETRIES` bounds total attempts per object to avoid infinite retry loops.
- Detector service uses a `threading.Lock` (`app.state.model_lock`) around every inference call to prevent concurrent-request model corruption.
- Request size limit: `DetectRequest.image_b64` capped at `max_length=20_000_000` chars in the shared Pydantic schema.
- `deploy/start_all.sh` health-gates startup order: detector `/health` must return healthy (60×5s poll) before panel/agent windows start; vLLM readiness failures now `exit 1` with a clear message instead of silently proceeding under `set -e`.
- **Known, accepted gap**: Project B panel's `/api/events` endpoint has no authentication — anyone on the network can inject events. Explicitly deferred: "fine for lab, add token before exposing."

## 7. Gotchas / failure modes (exact error text where captured)

1. `error: Failed to read 'Min_Position_Limit' on id_=6 after 1 tries. [RxPacketError] Overload error!` — gripper (motor id 6) overload trip. Diagnosis process: `Present_Load = -332` (≈33% stall force) while position frozen at `2047` for 1.5s → looked mechanical at first, but a full 6-joint move-and-return test showed **all 6 joints** moved **0 ticks** despite healthy encoders/comms → real cause was **bus voltage only 4.8V** instead of required ~7.4V (PSU/barrel-jack not delivering motor power). Lesson: a single-servo symptom (one overload error) can actually be a power-delivery problem — confirm by testing ALL joints, not just the one that errored.
2. `API Error: Can't reach the API server — check your internet or DNS (EAI_AGAIN)` — appeared twice across sessions during long-running work, transient, unrelated to the robot itself.
3. `/dev/video3` looked like a second camera but was just the metadata/control node of the same physical device as `/dev/video2` — always cross-check with `lsusb`/`v4l2-ctl --list-devices`, not just `/dev/video*` count.
4. Camera appeared busy/unopenable: `fuser -v /dev/video0` revealed a stray `ffmpeg` test-grab process (45s old, piping to stdout) holding the device exclusively — had to `kill <pid>` before the panel could acquire it.
5. Diagnosing "black frame is software vs. physical": forcing `v4l2-ctl -c auto_exposure=1 -c exposure_time_absolute=10000 -c gain=128 -c brightness=64` (max exposure+gain) produced **uniform gray** instead of black → sensor and driver both healthy, lens physically blocked (cap/film) or camera face-down. Reusable diagnostic technique.
6. Logitech C920 dropped off the USB bus entirely mid-session more than once (`lsusb` empty) — required physical replug; panel mitigated by auto-rescanning every 5s whenever it has zero cameras.
7. `pkill -f "uvicorn server:app"` matched the agent's own shell process and killed the entire session/job, not just the target uvicorn — had to switch to targeted `pgrep`+`kill <pid>` or `exec` the server directly.
8. `pkill -f "hf download Qwen"` (and similar) self-matched the *calling* ssh/pkill command line itself and killed the SSH tunnel/session carrying the download — fixed with a non-self-matching regex trick: `pkill -f "hf downloa[d]"` (bracket around one character prevents the pkill invocation's own argv from matching the pattern).
9. `sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper` — happens when running `ssh -t host "sudo ..."` non-interactively (Claude Code's `!`-prefixed bash runs without a TTY); no workaround from the agent side — user must run the sudo command in their own interactive terminal.
10. `SOFollowerConfig` (base class) rejects an `id` kwarg even though other code paths read `.id` off it — must use the `SO101Follower`/`SO101FollowerConfig` subclasses, which correctly inherit `RobotConfig`'s `id` field.
11. `~/.cache/huggingface` on DGX was **root-owned** (leftover from an earlier `docker run`), and the account had no passwordless sudo → HF/xet downloads failed with a permission error. Fix: redirect via `HF_HOME=~/.cache/hf` (fresh user-owned directory) rather than trying to chown the default cache.
12. Qwen 30B-A3B bf16 download (~60GB) crawled at 2MB total then stalled; switching to the FP8 variant + `hf_transfer` (`pip install hf_transfer`, `HF_HUB_ENABLE_HF_TRANSFER=1`) was attempted as the fix, but even that stalled at 0MB/s at least once — **session ended before this was resolved** (see Open problems).
13. Initial `deploy/deploy.sh` rsync exclude pattern only matched `.venv`, not `.venv-test`, so the first deploy shipped an entire test virtualenv to DGX and was very slow — fixed by broadening the exclude and by explicitly `rm -rf`-ing the shipped `.venv-test` on the remote.
14. `elbow_flex` observed at raw tick `3615`, past its own stored soft max limit of `3609` — traced to someone manually pushing the joint past the limit while torque was off; harmless (torque off), and would self-correct once the arm can move under power again.

## 8. Decisions + rationale

- Project A kept `panel/arm.py` strictly read-only until explicitly asked for motion controls — safety-first default for an uncalibrated arm.
- Project A used Claude vision (`claude-sonnet-5`) for detection; Project B was explicitly built to avoid any Claude-hosted VLM per the user's requirement ("we shouldn't use the vlm from claude") and instead run Qwen3-VL fully locally on the DGX.
- Qwen3-VL variant chosen: MoE **30B-A3B** (3B active) over dense 32B, per explicit user correction — much faster inference for similar footprint, fits the 128GB unified memory easily; later narrowed further to the **FP8** checkpoint purely to cut download size/time.
- `pick_up`→`trash_out` ordering enforced at both the prompt level and the code level (defense-in-depth against a tool-calling LLM choosing wrong order).
- `robot_arm.py` deliberately kept as a mock behind a stable `ToolResult` interface specifically so the real hardware backend can be swapped in later "without touching agent loop code."
- vLLM installed via plain pip on aarch64 DGX Spark once proven to work (`vllm==0.29.0`, `torch==2.13`) — simpler than the originally planned NGC container route, so the container plan was dropped.
- π0.5 selected as the target real-arm VLA policy specifically because it is the **only model with a measured, independent, head-to-head benchmark on physical SO-101** (arXiv 2606.08881) — deliberately preferred over newer/larger but unbenchmarked options (GR00T N1.7, Gemini Robotics family).
- Gemini Robotics' `ER 2` was scoped as an optional **A/B for the reasoning layer only**, not a wholesale replacement — its cloud dependency conflicts with the project's local-inference requirement.

## 9. Open problems / next steps

- **Real picking has never been demonstrated.** The local SO-101 arm cannot move at all right now — bus voltage stuck at 4.8V instead of ~7.4V; user needs to check the barrel-jack PSU connection/health before any grasp testing is possible.
- TM camera (`/dev/video2`) lens is physically blocked — needs a manual fix (remove cap/film, reposition) before it produces usable frames.
- Logitech C920 needs a stable USB connection (keeps dropping off the bus).
- Qwen3-VL-30B-A3B(-FP8) download to DGX was still stalling intermittently at session end — download reliability over the cloudflared tunnel is unresolved.
- No SO-101 trash-manipulation dataset exists; plan is to teleop-record **50–300 own episodes** varying objects/positions/lighting to fine-tune π0.5 (LoRA fits 24GB GPU; full FT fits the 128GB DGX Spark; ~9s/step reported on GB10 native PyTorch).
- π0.5/VLA integration into the real pick pipeline (`panel/vla.py`, `panel/pipeline.py`, endpoints `/api/pick/{camera}`, `/api/pick/stop`, `/api/pick/status`) was **planned but never implemented** — session was interrupted before this code was written.
- `services/panel/api/events` has no auth — add a token before exposing beyond the lab network.
- Re-run the VLA comparison once GR00T N2 or π0.6 weights are actually released (both unreleased/preview as of Sept 2026).
- Cheap follow-up experiment suggested: zero-shot smoke test of MolmoAct2 on the real SO-101 (claims zero-shot generalization, unverified).

## 10. Reusable for a business-system (ERP/CRM) integration

- **`ToolResult` contract** (`valid: bool`, `message: str`, `data: dict`) is the seam between the reasoning/orchestration layer and physical actuation in Project B. An ERP/CRM/queue system could hook into exactly this interface to log each `pick_up`/`trash_out` call as a task record (object id/category, confidence, timestamp, success/fail, retry count) without touching the agent loop's code — this is the natural integration point for "queue a pick task" / "report task result."
- **Panel state machine** (`idle → detecting → reasoning → picking → trashing`) is already computed server-side and broadcast over WebSocket — this maps directly onto ticket/work-order status fields; each transition is already a discrete, loggable event.
- **Detection schema** (`label`, `category`, normalized bbox, `confidence`, `graspable` flag, `grasp_note`) is a ready-made "item record" — maps to inventory/lot fields (item type, location, confidence score, pickable status) for a tracking system.
- **Retry/failure fields already modeled**: `MAX_PICKUP_RETRIES` + `ARM_SUCCESS_RATE` (mock) demonstrate the minimum fields a real task-tracking table needs — attempt count, failure reason, retry cap — for reporting SLA/success-rate metrics per pick task.
- **Health-gated multi-service startup** (`deploy/start_all.sh` polling `/health` before dependent services start) is a reusable pattern for orchestrating a business pipeline with hard service dependencies (e.g., don't open a queue consumer until the inference backend is confirmed healthy).
- **Gap to flag for any real integration**: neither project has a persistent database — all state (scan events, pick attempts, outcomes) lives only in-memory / on the live WebSocket feed and disappears on restart. A business-system integration would need to add durable logging of scan/pick/outcome events; nothing in either codebase currently persists this.
