import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { ROBOTICS_PICK_TASK_SERVICE } from '../../../di'
import { reportSchema } from '../../../data/validators'
import type { PickTaskService } from '../../../lib/pickTaskService'
import { errorResponse, requireScope } from '../../../lib/requestScope'
import { serializeTask } from '../route'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['robotics.bridge.report'] },
}

/** One stage transition from inside an attempt: approaching, grasping, ... */
export async function POST(request: Request) {
  try {
    const scope = await requireScope(request)
    const input = reportSchema.parse(await request.json())
    const { resolve } = await createRequestContainer()
    const service = resolve<PickTaskService>(ROBOTICS_PICK_TASK_SERVICE)

    const task = await service.report(
      input.taskId,
      input.stage,
      input.message,
      input.kind,
      (input.payload as Record<string, unknown>) ?? null,
      scope,
    )
    return Response.json(serializeTask(task))
  } catch (err) {
    return errorResponse(err, 'Failed to record pick task progress')
  }
}
