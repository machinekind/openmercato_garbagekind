import type { EntityManager } from '@mikro-orm/postgresql'
import { RobotPickTask } from '../data/entities'

export const metadata = {
  event: 'robotics.pick_task.finished',
  persistent: true,
  id: 'robotics:pick-task-finished',
}

type FinishedPayload = {
  id?: string
  status?: string
  detail?: string
}

/**
 * Worked example of closing the loop back into the business system.
 *
 * A pick task carries `sourceRef` - whatever queued it: an order line, a WMS
 * move, a chat message. This subscriber is where that reference turns back into
 * a domain action. It deliberately does nothing but log by default, because
 * what "the can was picked" *means* is the host app's decision, not this
 * module's.
 *
 * `persistent: true` puts it on the durable queue: a pick outcome is worth
 * retrying if the handler was down when it fired.
 */
export default async function onPickTaskFinished(
  payload: FinishedPayload,
  ctx: { resolve: <T>(name: string) => T },
): Promise<void> {
  if (!payload?.id) return

  const em = ctx.resolve<EntityManager>('em')
  const task = await em.findOne(RobotPickTask, { id: payload.id })
  if (!task?.sourceRef) return

  // Replace with the real domain action, e.g.:
  //   const orders = ctx.resolve<OrderService>('orderService')
  //   await orders.markLinePicked(task.sourceRef, task.status === 'succeeded')
  console.info(
    `[robotics] pick task ${task.id} for ${task.sourceRef} finished: ${task.status} (${task.detail ?? 'no detail'})`,
  )
}
