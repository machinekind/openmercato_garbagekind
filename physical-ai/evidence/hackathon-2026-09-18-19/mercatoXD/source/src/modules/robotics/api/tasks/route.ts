import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { ROBOTICS_PICK_TASK_SERVICE } from '../../di'
import { RobotPickTask } from '../../data/entities'
import { taskCreateSchema, taskListQuerySchema } from '../../data/validators'
import type { PickTaskService } from '../../lib/pickTaskService'
import { errorResponse, requireScope } from '../../lib/requestScope'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['robotics.tasks.view'] },
  POST: { requireAuth: true, requireFeatures: ['robotics.tasks.operate'] },
}

export function serializeTask(task: RobotPickTask) {
  return {
    id: task.id,
    cellId: task.cellId,
    instruction: task.instruction,
    targetLabel: task.targetLabel,
    dropPreset: task.dropPreset ?? null,
    status: task.status,
    stage: task.stage ?? null,
    priority: task.priority,
    attempts: task.attempts,
    maxAttempts: task.maxAttempts,
    detail: task.detail ?? null,
    sourceRef: task.sourceRef ?? null,
    claimedAt: task.claimedAt ? task.claimedAt.toISOString() : null,
    finishedAt: task.finishedAt ? task.finishedAt.toISOString() : null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  }
}

export async function GET(request: Request) {
  try {
    const scope = await requireScope(request)
    const url = new URL(request.url)
    const query = taskListQuerySchema.parse(Object.fromEntries(url.searchParams.entries()))

    const { resolve } = await createRequestContainer()
    const em = resolve<EntityManager>('em')

    const where: Record<string, unknown> = { tenantId: scope.tenantId, deletedAt: null }
    if (query.cellId) where.cellId = query.cellId
    if (query.status) where.status = query.status

    const [items, total] = await em.findAndCount(RobotPickTask, where, {
      orderBy: { createdAt: 'DESC' },
      limit: query.pageSize,
      offset: (query.page - 1) * query.pageSize,
    })
    return Response.json({
      items: items.map(serializeTask),
      total,
      page: query.page,
      pageSize: query.pageSize,
    })
  } catch (err) {
    return errorResponse(err, 'Failed to list pick tasks')
  }
}

/** Queue one pick. This is the whole "make the arm grab the can" entry point. */
export async function POST(request: Request) {
  try {
    const scope = await requireScope(request)
    const input = taskCreateSchema.parse(await request.json())
    const { resolve } = await createRequestContainer()
    const service = resolve<PickTaskService>(ROBOTICS_PICK_TASK_SERVICE)

    const task = await service.queue({ ...input, ...scope })
    return Response.json(serializeTask(task), { status: 201 })
  } catch (err) {
    return errorResponse(err, 'Failed to queue pick task')
  }
}
