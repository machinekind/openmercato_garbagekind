# mercatoXD — robot arms as an Open Mercato module

Business systems queue work. Robot arms do work. This repo is the seam: an
[Open Mercato](https://www.openmercato.com/) module that lets an ERP/CRM queue
*"grab the can"* against a physical robot cell, plus everything needed to make a
Galaxea A1X actually carry that order out.

```
mercatoXD/
  src/modules/robotics/   the Open Mercato module (TypeScript): entities, REST API,
                          admin pages, DI service, CLI, RBAC features
  bridge/                 the robot-side process (Python): claims tasks, drives the
                          arm through the web panel, reports every stage back
  robot/                  the arm stack itself: web panel, CAN driver, DGX agent,
                          teleop, recording, ROS 2 workspace, sim
  docs/                   how it fits together, what the hardware actually does, and
                          the mined notes behind both
```

## The one idea

Open Mercato never touches CAN, never holds a joint target, and never decides
whether an arm may move. It owns the *queue* and the *record*. The web panel in
`robot/webpanel/` owns the physical envelope — joint window, slew limit, engage
gate, single CAN writer — and it keeps owning it whether this app is up or not.
The bridge in `bridge/` is the only process that connects the two, and it is the
only one that moves anything.

```
operator / order line
        │  POST /api/robotics/tasks      {"instruction": "pick up the can"}
        ▼
┌───────────────────────┐   claim / report / finish   ┌──────────────┐
│ Open Mercato          │◄────────────────────────────│ bridge       │
│ robotics module       │                             │ (DGX/laptop) │
└───────────────────────┘                             └──────┬───────┘
        ▲ read-only state                       WS motion    │  ws://…:8765
        │ GET /api/state, /stream/robot                      ▼
┌───────┴────────────────────────────┐              ┌──────────────────┐
│ web panel (robot/webpanel)         │              │ G0.5 VLA policy  │
│ engage gate · clamp · 30°/s slew   │              └──────────────────┘
│ single CAN writer                  │
└───────────────┬────────────────────┘
                │ CAN 0x050 / 0x051
                ▼
        Galaxea A1X arm + gripper
```

## Quickstart

1. **Module** → copy `src/modules/robotics/` into an Open Mercato app at
   `src/modules/robotics/`, add `{ id: 'robotics', from: '@app' }` to
   `src/modules.ts`, then `yarn generate && yarn db:generate && yarn db:migrate`.
   Full steps and the API contract: [docs/INTEGRATION.md](docs/INTEGRATION.md).
2. **Cell** → register the arm in the admin UI under *Robotics → Robot cells*
   with its panel URL (e.g. `http://10.42.0.1:8080`).
3. **Panel** → on the machine holding the CAN adapter:
   `./can_up.sh && python3 robot/webpanel/server.py`.
4. **Bridge** → `OM_BASE_URL=… OM_API_KEY=… OM_ROBOT_CELL_ID=… python -m om_bridge.main --policy g05`
   (see [bridge/README.md](bridge/README.md)).
5. Press **Grab the can** in *Robotics → Pick tasks*, or `POST /api/robotics/tasks`.

## What actually works today

The plumbing works end to end; the grasp does not yet, and the reason is
documented rather than hidden: zero-shot G0.5 plans a plausible reach but has
never once emitted a gripper action, so the bridge scripts the close itself.
Read [docs/PICK-STATE-OF-PLAY.md](docs/PICK-STATE-OF-PLAY.md) before trusting a
demo to it.

## Safety, in one paragraph

The arm starts disengaged and nothing is transmitted until an operator engages
it. Every target is clamped to the per-joint window in `presets.json`
(intersected with URDF limits), slew-limited to 30°/s, and refused outright if
non-finite. Stale CAN feedback, a lost link or the last operator tab closing all
auto-disengage — ceasing to transmit is the safe failure mode, because an
uncommanded arm holds position. The bridge adds a task-level envelope on top
(≤12° per step, ≤40° per round) and refuses to run in the panel's *agent* role,
which may not engage or grip. None of this is optional; see
[docs/ROBOT-STACK.md](docs/ROBOT-STACK.md#safety-invariants).

## Tests

```bash
cd bridge && python3 -m pytest tests -q          # 56 tests, no hardware needed
```

Licence: MIT for this repo's own code. `robot/` carries the upstream
`galaxeo-manipulators` licence and does **not** redistribute Galaxea's vendor
SDK; G0.5 checkpoints are non-commercial.
