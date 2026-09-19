import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { ROBOTICS_PICK_TASK_SERVICE } from '../../../di'
import { abortSchema } from '../../../data/validators'
import type { PickTaskService } from '../../../lib/pickTaskService'
import { errorResponse, requireScope } from '../../../lib/requestScope'
import { serializeTask } from '../route'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['robotics.tasks.operate'] },
}

/**
 * Mark a task aborted.
 *
 * This does not stop a moving arm - the panel's Stop button and its
 * auto-disengage do that, and they are reachable without this app being up.
 * The bridge polls task status between stages and stands down when it sees
 * `aborted`.
 */
export async function POST(request: Request) {
  try {
    const scope = await requireScope(request)
    const input = abortSchema.parse(await request.json())
    const { resolve } = await createRequestContainer()
    const service = resolve<PickTaskService>(ROBOTICS_PICK_TASK_SERVICE)
    const task = await service.abort(input.taskId, input.reason, scope)
    return Response.json(serializeTask(task))
  } catch (err) {
    return errorResponse(err, 'Failed to abort pick task')
  }
}
