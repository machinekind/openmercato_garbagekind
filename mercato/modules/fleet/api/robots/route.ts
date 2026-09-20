import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveActiveOrganizationId } from '@open-mercato/shared/lib/auth/organizationScope'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'

/**
 * Dane rejestru floty.
 *
 * Czytamy przez `getAuthFromRequest`, a nie wariant „z ciastek": po ten
 * endpoint sięgają też skrypty i testy integracyjne niosące sesję w nagłówku
 * `Authorization`. Wariant ciastkowy odprawiłby je z 401 - nauczka
 * z poprzedniego modułu.
 */

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['fleet.view'] },
}

type RobotRow = {
  id: string
  serialNumber: string
  name: string
  state: string
  stateReason: string | null
  stateChangedAt: string | null
  embodiment: string | null
  cell: string | null
  site: string | null
  riskClass: string | null
  /** Czy właściciel i operator to ten sam podmiot - rozstrzyga o etykiecie na liście. */
  externallyOperated: boolean
  calibrationState: 'valid' | 'expiring' | 'blocked' | 'unknown'
  calibrationDaysLeft: number | null
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  })
}

export async function GET(req: Request): Promise<Response> {
  const auth = await getAuthFromRequest(req)
  if (!auth) return unauthorized()

  const organizationId = await resolveActiveOrganizationId(auth)
  if (!organizationId) {
    return new Response(JSON.stringify({ error: 'organization_scope_required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }

  const scope = { organizationId, tenantId: auth.tenantId as string }
  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager

  /**
   * Robot widoczny jest wtedy, gdy bieżąca organizacja jest jego właścicielem
   * ALBO operatorem. To jest cała treść decyzji o rozdziale tych pól: integrator
   * widzi maszyny, które serwisuje, mimo że nie jest ich właścicielem, a
   * właściciel widzi swoje, mimo że obsługuje je ktoś inny.
   */
  const rows = await em.getConnection().execute<Array<{
    id: string
    serial_number: string
    name: string
    state: string
    state_reason: string | null
    state_changed_at: string | null
    embodiment: string | null
    cell: string | null
    site: string | null
    risk_class: string | null
    owner_organization_id: string
    operator_organization_id: string
    required_calibrations: string[] | null
  }>>(
    `select r.id, r.serial_number, r.name, r.state, r.state_reason, r.state_changed_at,
            e.name as embodiment, c.name as cell, s.name as site, c.risk_class,
            r.owner_organization_id, r.operator_organization_id,
            e.required_calibrations
       from fleet_robots r
       join fleet_embodiment_revisions e on e.id = r.embodiment_revision_id
       left join fleet_cells c on c.id = r.cell_id
       left join fleet_sites s on s.id = c.site_id
      where r.tenant_id = ?
        and r.deleted_at is null
        and (r.owner_organization_id = ? or r.operator_organization_id = ?)
      order by r.state, r.serial_number`,
    [scope.tenantId, scope.organizationId, scope.organizationId],
  )

  // Kalibracje jednym zapytaniem, nie N+1: przy flocie liczonej w tysiącach
  // zapytanie per robot jest różnicą między pulpitem a klepsydrą.
  const calibrations = await em.getConnection().execute<Array<{
    robot_id: string
    kind: string
    valid_until: string
  }>>(
    `select distinct on (robot_id, kind) robot_id, kind, valid_until
       from fleet_calibrations
      where tenant_id = ?
        and invalidated_at is null
      order by robot_id, kind, measured_at desc`,
    [scope.tenantId],
  )

  const byRobot = new Map<string, Array<{ kind: string; validUntil: Date }>>()
  for (const row of calibrations) {
    const list = byRobot.get(row.robot_id) ?? []
    list.push({ kind: row.kind, validUntil: new Date(row.valid_until) })
    byRobot.set(row.robot_id, list)
  }

  const now = Date.now()
  const DAY = 24 * 60 * 60 * 1000

  const robots: RobotRow[] = rows.map((row) => {
    const required = (row.required_calibrations ?? []) as string[]
    const have = byRobot.get(row.id) ?? []

    let state: RobotRow['calibrationState'] = 'unknown'
    let daysLeft: number | null = null

    if (required.length) {
      const present = required.map((kind) => have.find((c) => c.kind === kind) ?? null)
      if (present.some((c) => c === null)) {
        state = 'blocked'
      } else {
        const soonest = Math.min(...present.map((c) => (c as { validUntil: Date }).validUntil.getTime()))
        daysLeft = Math.floor((soonest - now) / DAY)
        state = daysLeft < 0 ? 'blocked' : daysLeft <= 14 ? 'expiring' : 'valid'
      }
    }

    return {
      id: row.id,
      serialNumber: row.serial_number,
      name: row.name,
      state: row.state,
      stateReason: row.state_reason,
      stateChangedAt: row.state_changed_at ? new Date(row.state_changed_at).toISOString() : null,
      embodiment: row.embodiment,
      cell: row.cell,
      site: row.site,
      riskClass: row.risk_class,
      externallyOperated: row.owner_organization_id !== row.operator_organization_id,
      calibrationState: state,
      calibrationDaysLeft: daysLeft,
    }
  })

  const byState = robots.reduce<Record<string, number>>((acc, robot) => {
    acc[robot.state] = (acc[robot.state] ?? 0) + 1
    return acc
  }, {})

  return new Response(
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      totals: {
        robots: robots.length,
        // „Czynne" to gotowe plus w ruchu. Kwarantanna liczona osobno celowo:
        // maszyna sprawna, ale niedopuszczona, to inny problem niż rozebrana.
        active: robots.filter((r) => r.state === 'ready' || r.state === 'operational').length,
        quarantined: robots.filter((r) => r.state === 'quarantined').length,
        calibrationBlocked: robots.filter((r) => r.calibrationState === 'blocked').length,
        calibrationExpiring: robots.filter((r) => r.calibrationState === 'expiring').length,
        externallyOperated: robots.filter((r) => r.externallyOperated).length,
      },
      byState,
      robots,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}
