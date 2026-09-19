import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { ROBOTICS_PICK_TASK_SERVICE } from '../../../di'
import { finishSchema } from '../../../data/validators'
import type { PickTaskService } from '../../../lib/pickTaskService'
import { errorResponse, requireScope } from '../../../lib/requestScope'
import { serializeTask } from '../route'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['robotics.bridge.report'] },
}

/**
 * Close a task. Idempotent: a bridge that crashes after finishing and retries
 * on restart gets the stored terminal record back, not a second transition.
 */
export async function POST(request: Request) {
  try {
    const scope = await requireScope(request)
    const input = finishSchema.parse(await request.json())
    const { resolve } = await createRequestContainer()
    const service = resolve<PickTaskService>(ROBOTICS_PICK_TASK_SERVICE)

    const payload = {
      ...((input.payload as Record<string, unknown>) ?? {}),
      grasped: input.grasped,
    }
    const task = await service.finish(input.taskId, input.status, input.detail, payload, scope)
    return Response.json(serializeTask(task))
  } catch (err) {
    return errorResponse(err, 'Failed to close pick task')
  }
}
