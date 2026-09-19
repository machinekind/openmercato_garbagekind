import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { RobotCell } from './data/entities'
import { ROBOTICS_PICK_TASK_SERVICE } from './di'
import type { PickTaskService } from './lib/pickTaskService'
import { PanelClient } from './lib/panelClient'

function arg(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(`--${name}`)
  return idx >= 0 ? argv[idx + 1] : undefined
}

/** `mercato robotics ping --cell <id>` - is that arm's panel answering? */
const ping: ModuleCli = {
  command: 'ping',
  async run(argv) {
    const cellId = arg(argv, 'cell')
    if (!cellId) throw new Error('usage: mercato robotics ping --cell <cellId>')
    const { resolve } = await createRequestContainer()
    const em = resolve<EntityManager>('em')
    const cell = await em.findOne(RobotCell, { id: cellId, deletedAt: null })
    if (!cell) throw new Error(`robot cell ${cellId} not found`)

    const panel = new PanelClient(cell.panelBaseUrl)
    const state = await panel.state()
    console.log(
      JSON.stringify(
        { cell: cell.name, panel: cell.panelBaseUrl, engaged: state.engaged, via: state.engagedVia, q: state.q },
        null,
        2,
      ),
    )
  },
}

/** `mercato robotics queue --cell <id> --instruction "pick up the can"` */
const queue: ModuleCli = {
  command: 'queue',
  async run(argv) {
    const cellId = arg(argv, 'cell')
    if (!cellId) throw new Error('usage: mercato robotics queue --cell <cellId> [--instruction "..."]')
    const { resolve } = await createRequestContainer()
    const em = resolve<EntityManager>('em')
    const cell = await em.findOne(RobotCell, { id: cellId, deletedAt: null })
    if (!cell) throw new Error(`robot cell ${cellId} not found`)

    const service = resolve<PickTaskService>(ROBOTICS_PICK_TASK_SERVICE)
    const task = await service.queue({
      cellId,
      instruction: arg(argv, 'instruction') ?? 'pick up the can',
      targetLabel: arg(argv, 'target') ?? 'can',
      dropPreset: arg(argv, 'drop') ?? null,
      priority: Number(arg(argv, 'priority') ?? 0),
      maxAttempts: Number(arg(argv, 'attempts') ?? 1),
      sourceRef: arg(argv, 'source') ?? 'cli',
      tenantId: cell.tenantId ?? null,
      organizationId: cell.organizationId ?? null,
    })
    console.log(`queued ${task.id}`)
  },
}

export default [ping, queue]
