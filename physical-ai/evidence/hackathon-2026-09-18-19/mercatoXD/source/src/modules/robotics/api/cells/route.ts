import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { RobotCell } from '../../data/entities'
import { cellCreateSchema } from '../../data/validators'
import { errorResponse, requireScope } from '../../lib/requestScope'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['robotics.cells.view'] },
  POST: { requireAuth: true, requireFeatures: ['robotics.cells.manage'] },
}

function serialize(cell: RobotCell) {
  return {
    id: cell.id,
    name: cell.name,
    panelBaseUrl: cell.panelBaseUrl,
    homePreset: cell.homePreset,
    searchPreset: cell.searchPreset,
    isActive: cell.isActive,
    lastSeenAt: cell.lastSeenAt ? cell.lastSeenAt.toISOString() : null,
  }
}

export async function GET(request: Request) {
  try {
    const scope = await requireScope(request)
    const { resolve } = await createRequestContainer()
    const em = resolve<EntityManager>('em')
    const cells = await em.find(
      RobotCell,
      { tenantId: scope.tenantId, deletedAt: null },
      { orderBy: { name: 'ASC' } },
    )
    return Response.json({ items: cells.map(serialize), total: cells.length })
  } catch (err) {
    return errorResponse(err, 'Failed to list robot cells')
  }
}

export async function POST(request: Request) {
  try {
    const scope = await requireScope(request)
    const input = cellCreateSchema.parse(await request.json())
    const { resolve } = await createRequestContainer()
    const em = resolve<EntityManager>('em')

    const cell = em.create(RobotCell, {
      ...input,
      panelBaseUrl: input.panelBaseUrl.replace(/\/$/, ''),
      tenantId: scope.tenantId ?? null,
      organizationId: scope.organizationId ?? null,
    })
    await em.persistAndFlush(cell)
    return Response.json(serialize(cell), { status: 201 })
  } catch (err) {
    return errorResponse(err, 'Failed to create robot cell')
  }
}
