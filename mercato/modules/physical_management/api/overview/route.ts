import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveActiveOrganizationId } from '@open-mercato/shared/lib/auth/organizationScope'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['physical_management.view'] },
}

type CameraRow = {
  id: string
  code: string
  name: string
  status: string
  view_role: string
  purpose: string
  people_in_view: boolean
  retention_days: number
  cell_id: string | null
  cell_name: string | null
  last_window_at: string | null
  counting_mode: string | null
  people_count: string | number | null
  frames_analyzed: string | number | null
}

type ActivityRow = {
  id: string
  camera_code: string
  camera_name: string
  cell_id: string | null
  cell_name: string | null
  started_at: string
  ended_at: string
  counting_mode: string
  people_count: string | number
  mean_confidence: string | number | null
  frames_analyzed: string | number
}

/**
 * Warstwa odczytowa digital twin.
 *
 * Nie przyjmuje klatek ani identyfikatorów osób. Ruch jest sygnałem z brzegu:
 * kamera raportuje zagregowaną liczbę anonimowych ścieżek w oknie czasu.
 * Pozwala to widzieć wykorzystanie przestrzeni bez budowania w ERP bazy
 * wizerunków albo historii konkretnego pracownika.
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await getAuthFromRequest(req)
  if (!auth) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const organizationId = await resolveActiveOrganizationId(auth)
  if (!organizationId) {
    return Response.json({ error: 'organization_scope_required' }, { status: 400 })
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
       from fleet_sites
      where tenant_id = ? and organization_id = ? and deleted_at is null
      order by code`,
    [tenantId, organizationId],
  )

  const cells = await em.getConnection().execute<Array<{
    id: string
    site_id: string
    code: string
    name: string
    risk_class: string
    layout_x_m: number | null
    layout_y_m: number | null
    layout_width_m: number | null
    layout_height_m: number | null
    robot_count: string | number
  }>>(
    `select c.id, c.site_id, c.code, c.name, c.risk_class,
            c.layout_x_m, c.layout_y_m, c.layout_width_m, c.layout_height_m,
            count(r.id) as robot_count
       from fleet_cells c
       left join fleet_robots r on r.cell_id = c.id and r.deleted_at is null
      where c.tenant_id = ? and c.organization_id = ? and c.deleted_at is null
      group by c.id
      order by c.code`,
    [tenantId, organizationId],
  )

  const cameras = await em.getConnection().execute<CameraRow[]>(
    `select c.id, c.code, c.name, c.status, c.view_role, c.purpose,
            c.people_in_view, c.retention_days, c.cell_id, fc.name as cell_name,
            latest.ended_at as last_window_at, latest.counting_mode,
            coalesce(latest.counts->>'person', '0') as people_count,
            latest.frames_analyzed
       from vision_cameras c
       left join fleet_cells fc on fc.id = c.cell_id
       left join lateral (
         select w.ended_at, w.counting_mode, w.counts, w.frames_analyzed
           from vision_detection_windows w
          where w.tenant_id = c.tenant_id and w.camera_id = c.id
          order by w.ended_at desc
          limit 1
       ) latest on true
      where c.tenant_id = ? and c.organization_id = ? and c.deleted_at is null
      order by c.code`,
    [tenantId, organizationId],
  )

  const activity = await em.getConnection().execute<ActivityRow[]>(
    `select w.id, c.code as camera_code, c.name as camera_name,
            w.cell_id, fc.name as cell_name, w.started_at, w.ended_at,
            w.counting_mode, coalesce(w.counts->>'person', '0') as people_count,
            w.mean_confidence->>'person' as mean_confidence, w.frames_analyzed
       from vision_detection_windows w
       join vision_cameras c on c.id = w.camera_id
       left join fleet_cells fc on fc.id = w.cell_id
      where w.tenant_id = ? and w.organization_id = ?
        and jsonb_exists(w.counts, 'person')
      order by w.ended_at desc
      limit 24`,
    [tenantId, organizationId],
  )

  const robots = await em.getConnection().execute<Array<{ total: string; operational: string }>>(
    `select count(*) as total,
            count(*) filter (where state = 'operational') as operational
       from fleet_robots
      where tenant_id = ? and deleted_at is null
        and (owner_organization_id = ? or operator_organization_id = ?)`,
    [tenantId, organizationId, organizationId],
  )

  const now = Date.now()
  const sources = cameras.map((camera) => {
    const lastSeenAt = camera.last_window_at ? new Date(camera.last_window_at).toISOString() : null
    const ageMs = lastSeenAt ? now - new Date(lastSeenAt).getTime() : null
    return {
      id: camera.id,
      code: camera.code,
      name: camera.name,
      kind: camera.people_in_view ? 'video_and_people_tracking' : 'video',
      state: camera.status !== 'active' ? 'disabled' : ageMs === null ? 'waiting' : ageMs > 60 * 60 * 1000 ? 'stale' : 'online',
      cellId: camera.cell_id,
      cellName: camera.cell_name,
      viewRole: camera.view_role,
      purpose: camera.purpose,
      retentionDays: camera.retention_days,
      lastSeenAt,
      countingMode: camera.counting_mode,
      latestPeopleCount: Number(camera.people_count ?? 0),
      latestFramesAnalyzed: Number(camera.frames_analyzed ?? 0),
    }
  })

  return Response.json({
    generatedAt: new Date().toISOString(),
    privacy: {
      mode: 'anonymous_aggregate_tracks',
      rawVideoStoredInErp: false,
      biometricIdentityStored: false,
    },
    totals: {
      sites: sites.length,
      cells: cells.length,
      videoSources: sources.length,
      trackingSources: sources.filter((source) => source.kind === 'video_and_people_tracking').length,
      onlineSources: sources.filter((source) => source.state === 'online').length,
      peopleTrackWindows: activity.filter((row) => row.counting_mode === 'tracks').length,
      latestPeopleSignals: sources.reduce((sum, source) => sum + source.latestPeopleCount, 0),
      robots: Number(robots[0]?.total ?? 0),
      operationalRobots: Number(robots[0]?.operational ?? 0),
    },
    sites: sites.map((site) => ({
      id: site.id,
      code: site.code,
      name: site.name,
      floorWidthM: site.floor_width_m,
      floorHeightM: site.floor_height_m,
    })),
    cells: cells.map((cell) => ({
      id: cell.id,
      siteId: cell.site_id,
      code: cell.code,
      name: cell.name,
      riskClass: cell.risk_class,
      x: cell.layout_x_m,
      y: cell.layout_y_m,
      width: cell.layout_width_m,
      height: cell.layout_height_m,
      robotCount: Number(cell.robot_count ?? 0),
    })),
    sources,
    activity: activity.map((row) => ({
      id: row.id,
      cameraCode: row.camera_code,
      cameraName: row.camera_name,
      cellId: row.cell_id,
      cellName: row.cell_name,
      startedAt: new Date(row.started_at).toISOString(),
      endedAt: new Date(row.ended_at).toISOString(),
      countingMode: row.counting_mode,
      peopleCount: Number(row.people_count ?? 0),
      meanConfidence: row.mean_confidence == null ? null : Number(row.mean_confidence),
      framesAnalyzed: Number(row.frames_analyzed ?? 0),
    })),
  })
}
