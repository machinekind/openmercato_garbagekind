import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveActiveOrganizationId } from '@open-mercato/shared/lib/auth/organizationScope'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { evaluateAuthorization } from '../../lib/lease'

/**
 * Stan pożądany floty dla pulpitu.
 *
 * `getAuthFromRequest`, nie wariant ciastkowy - po ten endpoint sięgają
 * skrypty dowodowe niosące sesję w nagłówku `Authorization`.
 *
 * Ekran odpowiada na jedno pytanie, którego nie da się zadać nigdzie indziej:
 * **czy ta maszyna ma w tej chwili prawo pracować** - i przez ile jeszcze
 * sekund. Liczba sekund jest tu ważniejsza od nazwy stanu: „pracuje" bez niej
 * nie mówi, czy pracuje dlatego, że wszystko gra, czy dlatego, że mandat
 * jeszcze nie zdążył wygasnąć.
 */

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['deployment.view'] },
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export async function GET(req: Request): Promise<Response> {
  const auth = await getAuthFromRequest(req)
  if (!auth) return json({ error: 'Unauthorized' }, 401)

  const organizationId = await resolveActiveOrganizationId(auth)
  if (!organizationId) return json({ error: 'organization_scope_required' }, 400)

  const tenantId = auth.tenantId as string
  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager

  /**
   * `distinct on` po robocie z najnowszą dzierżawą, a nie `join` do wszystkich.
   *
   * Dzierżawa jest odnawiana co jedną trzecią okresu, więc przy celi publicznej
   * robot generuje ponad tysiąc wierszy na dobę. Pulpit ma pokazać ostatnią.
   */
  const rows = await em.getConnection().execute<Array<{
    assignment_id: string
    robot_id: string
    serial_number: string
    robot_state: string
    cell: string | null
    risk_class: string
    lease_seconds: number
    desired_state: string
    reason: string
    assigned_at: string
    policy_key: string
    policy_version: number
    policy_version_id: string
    lease_expires_at: string | null
    lease_revoked_at: string | null
    reported_state: string | null
    reported_at: string | null
    reconciliation: string | null
  }>>(
    `select a.id as assignment_id, a.robot_id, r.serial_number, r.state as robot_state,
            c.name as cell, a.risk_class, a.lease_seconds, a.desired_state, a.reason, a.assigned_at,
            p.policy_key, v.version as policy_version, a.policy_version_id,
            l.expires_at as lease_expires_at, l.revoked_at as lease_revoked_at,
            rep.reported_state, rep.reported_at, rep.reconciliation
       from deployment_assignments a
       join fleet_robots r on r.id = a.robot_id
       left join fleet_cells c on c.id = a.cell_id
       join policy_registry_policy_versions v on v.id = a.policy_version_id
       join policy_registry_policies p on p.id = v.policy_id
       left join lateral (
         select expires_at, revoked_at from deployment_leases
          where assignment_id = a.id order by issued_at desc limit 1
       ) l on true
       left join lateral (
         select reported_state, reported_at, reconciliation from deployment_state_reports
          where robot_id = a.robot_id order by reported_at desc limit 1
       ) rep on true
      where a.tenant_id = ? and a.superseded_at is null and a.revoked_at is null
      order by r.serial_number`,
    [tenantId],
  )

  const now = new Date()

  const assignments = rows.map((row) => {
    const authorization = evaluateAuthorization({
      desiredState: row.desired_state as 'running' | 'stopped',
      lease: row.lease_expires_at
        ? {
            expiresAt: new Date(row.lease_expires_at),
            revokedAt: row.lease_revoked_at ? new Date(row.lease_revoked_at) : null,
          }
        : null,
      now,
    })

    return {
      assignmentId: row.assignment_id,
      robotId: row.robot_id,
      serialNumber: row.serial_number,
      robotState: row.robot_state,
      cell: row.cell,
      riskClass: row.risk_class,
      leaseSeconds: Number(row.lease_seconds),
      desiredState: row.desired_state,
      policy: `${row.policy_key} v${row.policy_version}`,
      policyVersionId: row.policy_version_id,
      reason: row.reason,
      assignedAt: new Date(row.assigned_at).toISOString(),
      leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at).toISOString() : null,
      working: authorization.working,
      authorizationReason: authorization.reason,
      secondsLeft: authorization.secondsLeft,
      reportedState: row.reported_state,
      reportedAt: row.reported_at ? new Date(row.reported_at).toISOString() : null,
      // `unknown` gdy robot nigdy nic nie zgłosił - to nie to samo, co zgodność.
      reconciliation: row.reconciliation ?? 'unknown',
    }
  })

  return json(
    {
      generatedAt: now.toISOString(),
      totals: {
        assignments: assignments.length,
        working: assignments.filter((a) => a.working).length,
        // Robot z przypisaniem, ale bez ważnego mandatu - sam siebie zatrzymał.
        haltedByLease: assignments.filter((a) => !a.working && a.desiredState === 'running').length,
        drift: assignments.filter((a) => a.reconciliation === 'drift').length,
        unknown: assignments.filter((a) => a.reconciliation === 'unknown').length,
      },
      byRiskClass: assignments.reduce<Record<string, number>>((acc, a) => {
        acc[a.riskClass] = (acc[a.riskClass] ?? 0) + 1
        return acc
      }, {}),
      assignments,
    },
    200,
  )
}
