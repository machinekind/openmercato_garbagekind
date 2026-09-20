import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveActiveOrganizationId } from '@open-mercato/shared/lib/auth/organizationScope'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { createLogger } from '@open-mercato/shared/lib/logger'

const logger = createLogger('fleet').child({ component: 'robotDetail' })

/**
 * Szczegóły pojedynczego robota.
 *
 * Powód istnienia: do tej wersji rejestr floty był listą, w którą nie dało się
 * kliknąć. Operator widział, że maszyna stoi w kwarantannie, i nie miał jak
 * sprawdzić, **dlaczego** - a przy kwarantannie to jest jedyne pytanie, które
 * ma znaczenie.
 *
 * Księga przejść jest tu całą treścią ekranu. Kolumna „powód" w liście niesie
 * ostatni powód; dopiero ciąg wpisów pokazuje, czy maszyna wpada w kwarantannę
 * raz na kwartał, czy trzeci raz w tym tygodniu - a to są dwie różne maszyny
 * i dwie różne decyzje.
 */

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['fleet.view'] },
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export async function GET(request: Request, ctx?: { params?: Promise<{ id?: string }> | { id?: string } }): Promise<Response> {
  try {
    return await handle(request, ctx)
  } catch (error) {
    /*
     * Bez tego opakowania trasa oddawała pustą pięćsetkę bez typu treści -
     * przeglądarka pokazywała „Internal Server Error" i nic więcej, a w logu
     * serwera nie było ani słowa. Odpowiedź, z której nie da się wyczytać
     * powodu, kosztuje więcej czasu niż jej napisanie.
     */
    logger.error('Szczegóły robota - odczyt nie powiódł się', { err: error })
    return json({ error: error instanceof Error ? error.message : String(error) }, 500)
  }
}

async function handle(request: Request, ctx?: { params?: Promise<{ id?: string }> | { id?: string } }): Promise<Response> {
  const auth = await getAuthFromRequest(request)
  if (!auth?.tenantId) return json({ error: 'Unauthorized' }, 401)

  const rozwiazane = ctx?.params ? await ctx.params : undefined
  // Identyfikator z segmentu ścieżki, a w razie jego braku z zapytania -
  // ta druga droga jest dla wywołań, które nie idą przez router Next.
  const robotId = rozwiazane?.id ?? new URL(request.url).searchParams.get('id') ?? ''
  if (!robotId) return json({ error: 'Brak identyfikatora robota.' }, 400)

  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  const organizationId = resolveActiveOrganizationId(auth)

  const roboty = await em.getConnection().execute<Array<Record<string, unknown>>>(
    `select r.id, r.serial_number, r.name, r.state, r.state_reason, r.state_changed_at,
            r.owner_organization_id, r.operator_organization_id, r.embodiment_revision_id,
            c.code as cell_code, c.risk_class, s.name as site_name,
            e.embodiment_key, e.revision, e.spec_digest, e.required_calibrations
       from fleet_robots r
       left join fleet_cells c on c.id = r.cell_id
       left join fleet_sites s on s.id = c.site_id
       left join fleet_embodiment_revisions e on e.id = r.embodiment_revision_id
      where r.id = ? and r.tenant_id = ? and r.deleted_at is null
      limit 1`,
    [robotId, auth.tenantId],
  )
  if (!roboty?.length) return json({ error: 'Robot nie istnieje.' }, 404)
  const robot = roboty[0]

  /*
   * Księga przejść dopisywana, nigdy nadpisywana - więc porządek malejący
   * po dacie jest tu historią, a nie widokiem „ostatniego stanu".
   */
  const przejscia = await em.getConnection().execute<Array<Record<string, unknown>>>(
    `select from_state, to_state, reason, actor_user_id, occurred_at
       from fleet_robot_transitions
      where robot_id = ? and tenant_id = ?
      order by occurred_at desc
      limit 50`,
    [robotId, auth.tenantId],
  )

  const kalibracje = await em.getConnection().execute<Array<Record<string, unknown>>>(
    `select id, kind, measured_at, valid_until, invalidated_at, expiry_notified_at, uncertainty
       from fleet_calibrations
      where robot_id = ? and tenant_id = ?
      order by measured_at desc
      limit 50`,
    [robotId, auth.tenantId],
  )

  const agenci = await em.getConnection().execute<Array<Record<string, unknown>>>(
    `select a.id, a.status, a.agent_kind, a.agent_version, a.last_seen_at,
            a.heartbeat_interval_seconds, a.liveness_grace_seconds, a.lost_after_seconds
       from edge_agents a
      where a.robot_id = ? and a.tenant_id = ?
      order by a.created_at desc
      limit 1`,
    [robotId, auth.tenantId],
  ).catch(() => [])

  return json(
    {
      generatedAt: new Date().toISOString(),
      organizationId,
      robot: {
        id: String(robot.id),
        serialNumber: String(robot.serial_number),
        name: String(robot.name),
        state: String(robot.state),
        stateReason: (robot.state_reason as string | null) ?? null,
        stateChangedAt: robot.state_changed_at ? String(robot.state_changed_at) : null,
        // Rozdział właściciel/operator jest tu widoczny wprost, bo od niego
        // zależy, kto w ogóle ma prawo tę maszynę zatrzymać.
        ownerOrganizationId: String(robot.owner_organization_id),
        operatorOrganizationId: String(robot.operator_organization_id),
        externallyOperated: String(robot.owner_organization_id) !== String(robot.operator_organization_id),
        cell: (robot.cell_code as string | null) ?? null,
        riskClass: (robot.risk_class as string | null) ?? null,
        site: (robot.site_name as string | null) ?? null,
        embodimentKey: (robot.embodiment_key as string | null) ?? null,
        embodimentRevision: robot.revision === null || robot.revision === undefined ? null : Number(robot.revision),
        specDigest: (robot.spec_digest as string | null) ?? null,
        requiredCalibrations: (robot.required_calibrations as string[] | null) ?? [],
      },
      transitions: przejscia.map((t) => ({
        fromState: (t.from_state as string | null) ?? null,
        toState: String(t.to_state),
        reason: String(t.reason),
        // `null` znaczy system i to jest informacja, nie brak informacji.
        actorUserId: (t.actor_user_id as string | null) ?? null,
        at: String(t.occurred_at),
      })),
      calibrations: kalibracje.map((k) => ({
        id: String(k.id),
        kind: String(k.kind),
        measuredAt: String(k.measured_at),
        validUntil: String(k.valid_until),
        invalidatedAt: k.invalidated_at ? String(k.invalidated_at) : null,
        expiryAnnouncedAt: k.expiry_notified_at ? String(k.expiry_notified_at) : null,
        uncertainty: (k.uncertainty as Record<string, unknown> | null) ?? null,
      })),
      agent: agenci?.length
        ? {
            id: String(agenci[0].id),
            status: String(agenci[0].status),
            kind: String(agenci[0].agent_kind),
            version: (agenci[0].agent_version as string | null) ?? null,
            lastSeenAt: agenci[0].last_seen_at ? String(agenci[0].last_seen_at) : null,
            heartbeatIntervalSeconds: Number(agenci[0].heartbeat_interval_seconds),
            livenessGraceSeconds: Number(agenci[0].liveness_grace_seconds),
            lostAfterSeconds: Number(agenci[0].lost_after_seconds),
          }
        : null,
    },
    200,
  )
}
