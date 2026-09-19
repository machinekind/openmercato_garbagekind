# Wiring the robotics module into an Open Mercato app

Target: Open Mercato 0.8.x. The module is written to the `from: '@app'`
convention, so it drops into an app's own `src/modules/` without publishing a
package. Publishing it later as `@yourorg/robotics` changes only the `from:`
value.

## 1. Install the module

```bash
# from an app scaffolded with create-mercato-app (or apps/mercato in the monorepo)
cp -r /path/to/mercatoXD/src/modules/robotics src/modules/robotics
```

Register it in `src/modules.ts`:

```ts
export const enabledModules: ModuleEntry[] = [
  // … existing modules …
  { id: 'robotics', from: '@app' },
]
```

Generate registries and the migration, then apply it:

```bash
yarn generate      # discovers api/, backend/, cli.ts, acl.ts, events.ts, subscribers/
yarn db:generate   # writes src/modules/robotics/migrations/Migration<ts>_robotics.ts
yarn db:migrate    # applies it (ask before running against a shared database)
```

`yarn generate` must be re-run after adding or removing any auto-discovered file
in the module — that is how the route and ACL manifests are built.

## 2. Grant the features

| Feature | Who needs it |
|---|---|
| `robotics.cells.view` | anyone who should see the arms |
| `robotics.cells.manage` | whoever registers or retires a cell |
| `robotics.tasks.view` | anyone watching the queue |
| `robotics.tasks.operate` | whoever may queue or abort a pick — this moves a physical arm |
| `robotics.bridge.report` | **the API key the bridge runs under, and nothing else** |

`setup.ts` grants the first four to the usual roles on tenant setup;
`robotics.bridge.report` is deliberately granted to nobody. Create an API key for
the bridge and give it that one feature (Settings → API keys).

## 3. Register a cell

*Robotics → Robot cells → Add cell*, or:

```bash
curl -X POST https://erp.example/api/robotics/cells \
  -H 'x-api-key: …' -H 'content-type: application/json' \
  -d '{"name":"bench A1X","panelBaseUrl":"http://10.42.0.1:8080","homePreset":"home","searchPreset":"table"}'
```

`homePreset`/`searchPreset` must exist in the panel's `presets.json`. The cells
page shows live joint angles and the camera stream pulled straight from the
panel, so a wrong URL is visible immediately.

## 4. Run the bridge

See [../bridge/README.md](../bridge/README.md). It needs `OM_BASE_URL`,
`OM_API_KEY`, `OM_ROBOT_CELL_ID` and reachability to both the panel and (for
`--policy g05`) the policy server.

## API contract

All routes are under `/api/robotics`. Auth is the app's own: session cookie for
humans, `x-api-key` (or `Authorization: Bearer`) for the bridge. Every query is
tenant-scoped; a request without a tenant is 401, never an unscoped read.

### Operator-facing

| Route | Feature | Body / query | Returns |
|---|---|---|---|
| `GET /api/robotics/cells` | `cells.view` | — | `{items, total}` |
| `POST /api/robotics/cells` | `cells.manage` | `{name, panelBaseUrl, homePreset?, searchPreset?, isActive?}` | the cell |
| `GET /api/robotics/cells/state?cellId=…` | `cells.view` | — | `{online, state:{q,engaged,engagedVia,moving}, presets, streamUrl}` |
| `GET /api/robotics/tasks` | `tasks.view` | `page,pageSize,cellId?,status?` | `{items,total,page,pageSize}` |
| `POST /api/robotics/tasks` | `tasks.operate` | `{cellId, instruction, targetLabel?, dropPreset?, priority?, maxAttempts?, sourceRef?}` | the task |
| `POST /api/robotics/tasks/abort` | `tasks.operate` | `{taskId, reason?}` | the task |

`GET /api/robotics/cells/state` answers `{"online": false, "reason": …}` when the
panel is unreachable. A closed laptop is a normal operating condition, not a 500.

### Bridge-facing

| Route | Body | Returns |
|---|---|---|
| `POST /api/robotics/tasks/claim` | `{cellId, bridge}` | `{task}` or `{task: null}` |
| `POST /api/robotics/tasks/report` | `{taskId, stage, message, kind?, payload?}` | the task |
| `POST /api/robotics/tasks/finish` | `{taskId, status, detail?, grasped?, payload?}` | the task |

`claim` is row-locked and single-shot: two bridges pointed at one cell is a
configuration mistake, but it will never become two processes driving one arm.
It also doubles as the cell heartbeat (`lastSeenAt`).

## State machine

```
queued ──claim──► claimed ──report──► running ──finish──► succeeded
   │                  │                   │                 failed
   └───────abort──────┴─────────abort─────┴────────────────► aborted
```

`status` is the queue state the app owns. `stage` is the last thing the arm
reported from inside an attempt (`engaging → searching → approaching → grasping
→ lifting → retreating → done`) and moves independently. Terminal states are
final — a retry is a new task, so the trail of what each attempt did survives.

Aborting marks the record; it does not stop a moving arm. The panel's STOP
button and its auto-disengage do that, and they work with this app switched off.
The bridge stands down when it next sees the aborted status.

## Events

| Event | When |
|---|---|
| `robotics.pick_task.queued` | a task is created |
| `robotics.pick_task.claimed` | a bridge takes it |
| `robotics.pick_task.progress` | every stage report |
| `robotics.pick_task.finished` | terminal status reached |

All four carry `clientBroadcast: true`, so an operator watching the tasks page
sees progress over the admin SSE bridge. Subscribe from another module to close
an order line when a pick succeeds — `subscribers/pick-task-finished.ts` is the
worked example.

## CLI

```bash
mercato robotics ping  --cell <cellId>                              # is the panel answering?
mercato robotics queue --cell <cellId> --instruction "pick up the can"
```

## What this module deliberately does not do

* **Move the arm.** `lib/panelClient.ts` has no motion method at all. Motion goes
  over the panel's WebSocket from the bridge, because the panel auto-disengages
  when its last operator connection drops — a stateless HTTP call from a Next.js
  server cannot be covered by that failsafe.
* **Model the arm's kinematics.** Joint windows, slew and the URDF live in the
  panel; duplicating them here would mean two sources of truth for a physical
  limit.
* **Store camera frames.** The admin UI embeds the panel's MJPEG stream directly.
