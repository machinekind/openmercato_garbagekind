# om_bridge — Open Mercato ↔ A1X

The process that turns a queued pick task into arm motion and reports what
happened. It is the only thing in this repo that moves a robot.

```
claim a task ─► engage ─► search preset ─► policy-driven approach ─► scripted grasp
                                                       │
                       report every stage ◄────────────┤
                                                       ▼
                                          lift ─► drop/home ─► disengage ─► finish
```

## Run it

```bash
export OM_BASE_URL=https://erp.example
export OM_API_KEY=…                # key holding only robotics.bridge.report
export OM_ROBOT_CELL_ID=…          # uuid from Robotics → Robot cells
export A1X_PANEL_URL=http://10.42.0.1:8080
export A1X_POLICY_URL=ws://127.0.0.1:8765   # only for --policy g05

python -m om_bridge.main --policy g05        # G0.5 VLA (needs the DGX)
python -m om_bridge.main --policy preset     # no model: preset walk + scripted grasp
```

Optional: `OM_POLL_INTERVAL_S` (3.0), `A1X_GOAL_TIMEOUT_S` (12.0),
`A1X_HOME_PRESET` (`home`), `A1X_SEARCH_PRESET` (`table`), `A1X_HEAD_CAM`
(`robot`), `A1X_WRIST_CAM` (`wrist`).

## Where it must run

**In the panel's operator role.** The panel decides role by peer address, and
the agent role (the `10.42.0.0/24` cable by default) may not `engage`, `goal` or
`grip`. `PanelArm.check_role()` refuses to start otherwise, with the fix in the
message. In practice: run the bridge on the laptop that hosts the panel, or
start the panel with an `--agent-net` that excludes the bridge's address.

Requires `aiohttp`; `--policy g05` additionally needs `websockets`, `msgpack`,
`opencv-python` and `numpy` (already present in the DGX inference venv).

```bash
pip install -r requirements.txt
```

## Layout

| Module | Responsibility |
|---|---|
| `types.py` | the vocabulary shared with the module: statuses, stages, `PickTask`, transport protocols |
| `config.py` | environment → `BridgeConfig`; fails loudly on a missing setting |
| `om_client.py` | REST to Open Mercato: claim, report, finish |
| `panel.py` | the arm transport — WS commands, state, MJPEG frames, role check |
| `policy.py` | `G05Policy` (chunk/`need_obs` protocol) and `PresetPolicy` (no model) |
| `vision.py` | panel JPEG → RGB channel-first uint8, keyed for the policy server |
| `safety.py` | the task-level envelope: step/round caps, window clipping, flat-plan rule |
| `pick.py` | one attempt, stage by stage, including the scripted grasp |
| `main.py` | claim → run → finish loop, signal handling |

## Why the grasp is scripted

`g05-base` zero-shot has never emitted a `left_gripper` action — not once across
dozens of trials. Waiting for the model to close the jaws waits forever, so
`pick.py` closes them and reads the force signature to decide whether anything
is held: an empty gripper travels all the way to +0.6, one holding a can stalls
short of it at high effort. See [../docs/PICK-STATE-OF-PLAY.md](../docs/PICK-STATE-OF-PLAY.md).

## Safety the bridge owns

The panel owns the physical envelope (window, 30°/s slew, engage gate, single CAN
writer) and keeps owning it if this process dies. On top of that:

* ≤12° per commanded step, ≤40° drift per round — the caps the live G0.5 runs
  used;
* plans under 6° of motion are treated as "hold still" and resampled, because
  the policy is stochastic and returns those for the same observation;
* targets are clipped into the joint window *before* transmission, and joints
  sitting on a bound are reported (that is how a run stalls);
* non-finite joint values are refused outright;
* `disengage()` runs in a `finally` on every path, including cancellation;
* it warns before engaging when the measured pose sits on a window bound —
  engaging latches `goal = clamp(measured)` and will move the arm there.

## Tests

```bash
python3 -m pytest tests -q                      # 56 tests, no hardware
python3 -m pytest tests -q --cov=om_bridge      # 84% statement coverage
```

The fakes in `tests/fakes.py` record commands and replay scripted state; they
never simulate the hardware's answer, so a test that asserts "the gripper held
something" has to say so explicitly.
