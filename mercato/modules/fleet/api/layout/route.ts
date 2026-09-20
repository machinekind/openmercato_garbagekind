import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveActiveOrganizationId } from '@open-mercato/shared/lib/auth/organizationScope'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'

/**
 * Rzut hali: obiekty, cele, roboty i ich stan.
 *
 * Endpoint zwraca **wyłącznie to, co należy do rejestru floty** - geometrię
 * i stan maszyn. Łączności agentów, wyniku produkcyjnego ani zliczeń wizji tu
 * nie ma, mimo że rzut je pokazuje: składa je przeglądarka z osobnych
 * endpointów. Ta sama zasada, co przy pulpicie floty i z tego samego powodu -
 * rejestr ma działać na świeżej instalacji, gdzie z całej reszty nie ma nic.
 *
 * Cele bez kompletu współrzędnych wracają w osobnej liście `unplacedCells`,
 * a nie z podstawioną pozycją. Plan hali czyta się po to, żeby wiedzieć,
 * gdzie iść.
 */
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['fleet.view'] },
}

export async function GET(req: Request): Promise<Response> {
  const auth = await getAuthFromRequest(req)
  if (!auth) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  }

  const organizationId = await resolveActiveOrganizationId(auth)
  if (!organizationId) {
    return new Response(JSON.stringify({ error: 'organization_scope_required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }

  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  const tenantId = auth.tenantId as string

  const sites = await em.getConnection().execute<Array<{
    id: string
    code: string
    name: string
    floor_width_m: number | null
    floor_height_m: number | null
  }>>(
    `select id, code, name, floor_width_m, floor_height_m
       from fleet_sites where tenant_id = ? and deleted_at is null order by code`,
    [tenantId],
  )

  const cells = await em.getConnection().execute<Array<{
    id: string
    site_id: string
    code: string
    name: string
    cell_class: string
    risk_class: string
    layout_x_m: number | null
    layout_y_m: number | null
    layout_width_m: number | null
    layout_height_m: number | null
    layout_rotation_deg: number | null
  }>>(
    `select id, site_id, code, name, cell_class, risk_class,
            layout_x_m, layout_y_m, layout_width_m, layout_height_m, layout_rotation_deg
       from fleet_cells where tenant_id = ? and deleted_at is null order by code`,
    [tenantId],
  )

  /**
   * Roboty ze stanem kalibracji policzonym jednym zapytaniem.
   *
   * `distinct on (robot_id, kind)` bierze najnowszy pomiar każdego rodzaju -
   * ta sama konstrukcja, co w pulpicie floty. Wariant z zapytaniem per robot
   * przy flocie liczonej w tysiącach zmieniłby rzut w klepsydrę.
   */
  const robots = await em.getConnection().execute<Array<{
    id: string
    cell_id: string | null
    serial_number: string
    name: string
    state: string
    state_reason: string | null
    embodiment: string | null
    required_calibrations: string[] | null
    soonest_valid_until: string | null
    kinds_present: number
    owner_organization_id: string
    operator_organization_id: string
  }>>(
    `select r.id, r.cell_id, r.serial_number, r.name, r.state, r.state_reason,
            e.name as embodiment, e.required_calibrations,
            k.soonest_valid_until, coalesce(k.kinds_present, 0) as kinds_present,
            r.owner_organization_id, r.operator_organization_id
       from fleet_robots r
       join fleet_embodiment_revisions e on e.id = r.embodiment_revision_id
       left join lateral (
            select min(c.valid_until) as soonest_valid_until, count(*) as kinds_present
              from (select distinct on (kind) kind, valid_until
                      from fleet_calibrations
                     where robot_id = r.id and tenant_id = r.tenant_id and invalidated_at is null
                     order by kind, measured_at desc) c
       ) k on true
      where r.tenant_id = ? and r.deleted_at is null
        and (r.owner_organization_id = ? or r.operator_organization_id = ?)
      order by r.serial_number`,
    [tenantId, organizationId, organizationId],
  )

  const now = Date.now()
  const DAY = 24 * 60 * 60 * 1000

  const robotRows = robots.map((row) => {
    const required = (row.required_calibrations ?? []) as string[]
    let calibration: 'valid' | 'expiring' | 'blocked' | 'unknown' = 'unknown'
    let daysLeft: number | null = null

    if (required.length) {
      if (Number(row.kinds_present) < required.length) {
        calibration = 'blocked'
      } else if (row.soonest_valid_until) {
        daysLeft = Math.floor((new Date(row.soonest_valid_until).getTime() - now) / DAY)
        calibration = daysLeft < 0 ? 'blocked' : daysLeft <= 14 ? 'expiring' : 'valid'
      } else {
        calibration = 'blocked'
      }
    }

    return {
      id: row.id,
      cellId: row.cell_id,
      serialNumber: row.serial_number,
      name: row.name,
      state: row.state,
      stateReason: row.state_reason,
      embodiment: row.embodiment,
      externallyOperated: row.owner_organization_id !== row.operator_organization_id,
      calibrationState: calibration,
      calibrationDaysLeft: daysLeft,
    }
  })

  const placed = cells.filter(
    (c) =>
      typeof c.layout_x_m === 'number' &&
      typeof c.layout_y_m === 'number' &&
      typeof c.layout_width_m === 'number' &&
      typeof c.layout_height_m === 'number',
  )

  const mapCell = (c: (typeof cells)[number]) => ({
    id: c.id,
    siteId: c.site_id,
    code: c.code,
    name: c.name,
    cellClass: c.cell_class,
    riskClass: c.risk_class,
    x: c.layout_x_m,
    y: c.layout_y_m,
    width: c.layout_width_m,
    height: c.layout_height_m,
    rotationDeg: c.layout_rotation_deg,
    robotCount: robotRows.filter((r) => r.cellId === c.id).length,
  })

  return new Response(
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      sites: sites.map((s) => ({
        id: s.id,
        code: s.code,
        name: s.name,
        floorWidthM: s.floor_width_m,
        floorHeightM: s.floor_height_m,
      })),
      cells: placed.map(mapCell),
      // Osobno i jawnie - nie z podstawioną pozycją.
      unplacedCells: cells.filter((c) => !placed.includes(c)).map(mapCell),
      // Roboty bez celi też są prawdą o flocie: stoją gdzieś na hali,
      // a rejestr nie wie gdzie.
      unassignedRobots: robotRows.filter((r) => !r.cellId).length,
      robots: robotRows,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}
