# `robotics` — Open Mercato module

Queue a pick against a physical robot cell, watch it happen, keep the record.

```
robotics/
  index.ts          module metadata
  acl.ts            5 RBAC features (cells.view/manage, tasks.view/operate, bridge.report)
  setup.ts          default role grants — bridge.report goes to nobody on purpose
  di.ts             registers roboticsPickTaskService (scoped: it closes over the request em)
  events.ts         4 broadcast events for the task lifecycle
  data/
    entities.ts     RobotCell, RobotPickTask, RobotTaskEvent
    validators.ts   zod schemas + the status/stage vocabularies
  lib/
    pickTaskService.ts  queue / claimNext / report / finish / abort / touchCell
    panelClient.ts      read-only client for an arm's web panel
    requestScope.ts     tenant scope + uniform errors
  api/
    cells/route.ts           GET list, POST create
    cells/state/route.ts     GET live arm state (proxied, read-only)
    tasks/route.ts           GET list, POST queue
    tasks/{claim,report,finish}/route.ts   the bridge's three calls
    tasks/abort/route.ts     operator stop
  backend/robotics/          admin pages: pick tasks, robot cells
  components/                the two client panels those pages render
  subscribers/pick-task-finished.ts   worked example of closing the loop
  cli.ts            mercato robotics ping|queue
```

Install and API contract: [../../../docs/INTEGRATION.md](../../../docs/INTEGRATION.md).

## Design notes

**The module cannot move an arm.** `panelClient.ts` exposes `state()`,
`presets()`, `health()`, `streamUrl()` and `say()` — no motion method exists, so
no route can grow one by accident. Motion lives in `bridge/`, over the panel's
WebSocket, because the panel auto-disengages when its last operator connection
drops and a stateless HTTP call cannot be covered by that failsafe.

**`status` and `stage` are different things.** `status` is the queue state this
app owns (`queued → claimed → running → succeeded|failed|aborted`). `stage` is
the last thing the arm reported from inside an attempt (`engaging → searching →
approaching → grasping → lifting → retreating → done`). They move independently:
a task stays `running` while the stage walks forward.

**Claiming is row-locked.** `claimNext` runs in a transaction with
`LockMode.PESSIMISTIC_WRITE`. Two bridges on one cell is a configuration
mistake, but it must never become two processes driving one arm.

**Terminal statuses are final.** A retry is a new task, so each attempt keeps its
own trace in `RobotTaskEvent`. The panel's own event feed is a ring buffer that
dies with the process; this is the part an operator still needs tomorrow when
asked why a pick failed.

**Aborting marks the record, it does not stop the arm.** The panel's STOP button
and its auto-disengage do that, and they work with this app switched off.

**Preset names are validated to `[a-z0-9_-]`** — they are looked up in the
panel's `presets.json`, and a name should never be readable as a path.

## Upgrade paths left open

* The hand-written routes can move to `makeCrudRoute` from
  `@open-mercato/shared/lib/crud/factory` once the module has command handlers;
  the list/serialize shapes already match what the factory expects.
* `components/` uses plain fetch + tables so the module has no hard dependency on
  a particular `@open-mercato/ui` version; swapping in `DataTable`/`CrudForm` is
  a component-level change.
