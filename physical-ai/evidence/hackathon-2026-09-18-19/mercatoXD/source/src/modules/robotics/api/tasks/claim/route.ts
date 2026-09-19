import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { ROBOTICS_PICK_TASK_SERVICE } from '../../../di'
import { claimSchema } from '../../../data/validators'
import type { PickTaskService } from '../../../lib/pickTaskService'
import { errorResponse, requireScope } from '../../../lib/requestScope'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['robotics.bridge.report'] },
}

/**
 * The bridge asks for its next task. Returns `{ task: null }` when idle, which
 * is the normal answer most of the time - the bridge polls on an interval.
 *
 * The claim also doubles as the cell's heartbeat: a cell whose bridge stopped
 * polling greys out in the admin UI instead of silently swallowing work.
 */
export async function POST(request: Request) {
  try {
    const scope = await requireScope(request)
    const input = claimSchema.parse(await request.json())
    const { resolve } = await createRequestContainer()
    const service = resolve<PickTaskService>(ROBOTICS_PICK_TASK_SERVICE)

    await service.touchCell(input.cellId, scope)
    const task = await service.claimNext(input.cellId, input.bridge, scope)
    return Response.json({ task })
  } catch (err) {
    return errorResponse(err, 'Failed to claim pick task')
  }
}
