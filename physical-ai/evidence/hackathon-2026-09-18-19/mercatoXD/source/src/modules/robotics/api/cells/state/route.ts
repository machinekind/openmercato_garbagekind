import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { RobotCell } from '../../../data/entities'
import { PanelClient } from '../../../lib/panelClient'
import { errorResponse, requireScope } from '../../../lib/requestScope'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['robotics.cells.view'] },
}

/**
 * Live arm state, proxied from the cell's panel.
 *
 * Read-only by construction: `PanelClient` has no motion method, so this route
 * cannot move an arm however it is called.
 */
export async function GET(request: Request) {
  try {
    const scope = await requireScope(request)
    const cellId = new URL(request.url).searchParams.get('cellId')
    if (!cellId) return Response.json({ error: 'cellId is required' }, { status: 400 })

    const { resolve } = await createRequestContainer()
    const em = resolve<EntityManager>('em')
    const cell = await em.findOne(RobotCell, { id: cellId, tenantId: scope.tenantId, deletedAt: null })
    if (!cell) return Response.json({ error: 'Robot cell not found' }, { status: 404 })

    const panel = new PanelClient(cell.panelBaseUrl)
    try {
      const [state, presets] = await Promise.all([panel.state(), panel.presets()])
      return Response.json({
        cellId: cell.id,
        online: true,
        state,
        presets,
        streamUrl: panel.streamUrl('robot'),
      })
    } catch (panelErr) {
      // A panel that is down is a normal operating condition (the laptop is
      // closed, the cable is out), not a server error.
      return Response.json({
        cellId: cell.id,
        online: false,
        reason: (panelErr as Error).message,
      })
    }
  } catch (err) {
    return errorResponse(err, 'Failed to read arm state')
  }
}
