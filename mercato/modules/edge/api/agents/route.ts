import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveActiveOrganizationId } from '@open-mercato/shared/lib/auth/organizationScope'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { evaluateLiveness, type LivenessState } from '../../lib/liveness'

/**
 * Stan łączności agentów, indeksowany po robocie.
 *
 * Kształt odpowiedzi (`byRobot`) jest podyktowany tym, kto ją czyta: pulpit
 * floty, który ma już listę robotów i potrzebuje ją tylko wzbogacić. Dzięki
 * temu `fleet` nie musi wiedzieć nic o `edge` - składanie dzieje się
 * w przeglądarce, a rejestr działa również wtedy, gdy kanału brzegowego nie ma.
 */
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['edge.view'] },
}

type AgentRow = {
  agentId: string
  robotId: string
  agentKind: string
  agentVersion: string | null
  status: 'enrolled' | 'revoked'
  state: LivenessState
  silenceSeconds: number | null
  lastSeenAt: string | null
  fingerprint: string | null
  /** Liczba sesji w ostatniej dobie - miara migotania łącza, nie jego stanu. */
  sessionsLastDay: number
  reason: string
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

  const rows = await em.getConnection().execute<Array<{
    agent_id: string
    robot_id: string
    agent_kind: string
    agent_version: string | null
    status: 'enrolled' | 'revoked'
    last_seen_at: string | null
    heartbeat_interval_seconds: number
    liveness_grace_seconds: number
    lost_after_seconds: number
    fingerprint: string | null
    sessions_last_day: string
  }>>(
    `select a.id as agent_id, a.robot_id, a.agent_kind, a.agent_version, a.status,
            a.last_seen_at, a.heartbeat_interval_seconds, a.liveness_grace_seconds,
            a.lost_after_seconds,
            k.fingerprint,
            (select count(*) from edge_agent_sessions s
              where s.agent_id = a.id and s.started_at > now() - interval '1 day') as sessions_last_day
       from edge_agents a
       left join lateral (
            select fingerprint from edge_agent_keys k
             where k.agent_id = a.id and k.revoked_at is null
             order by k.active_from desc limit 1
       ) k on true
      where a.tenant_id = ?
      order by a.robot_id`,
    [tenantId],
  )

  const now = new Date()
  const agents: AgentRow[] = rows.map((row) => {
    const verdict = evaluateLiveness(
      {
        lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at) : null,
        heartbeatIntervalSeconds: row.heartbeat_interval_seconds,
        livenessGraceSeconds: row.liveness_grace_seconds,
        lostAfterSeconds: row.lost_after_seconds,
        status: row.status,
      },
      now,
    )
    return {
      agentId: row.agent_id,
      robotId: row.robot_id,
      agentKind: row.agent_kind,
      agentVersion: row.agent_version,
      status: row.status,
      state: verdict.state,
      silenceSeconds: verdict.silenceSeconds,
      lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
      fingerprint: row.fingerprint,
      sessionsLastDay: Number(row.sessions_last_day ?? 0),
      reason: verdict.reason,
    }
  })

  const byRobot = agents.reduce<Record<string, AgentRow>>((acc, agent) => {
    // Agent odwołany nie przykrywa wpisanego: przy podmianie komputera
    // pokładowego w tabeli zostają oba, a pulpit ma pokazać ten żywy.
    const current = acc[agent.robotId]
    if (!current || (current.status === 'revoked' && agent.status === 'enrolled')) {
      acc[agent.robotId] = agent
    }
    return acc
  }, {})

  return new Response(
    JSON.stringify({
      generatedAt: now.toISOString(),
      totals: {
        agents: agents.length,
        online: agents.filter((a) => a.state === 'online').length,
        late: agents.filter((a) => a.state === 'late').length,
        lost: agents.filter((a) => a.state === 'lost' && a.status === 'enrolled').length,
        neverSeen: agents.filter((a) => a.state === 'never_seen').length,
        revoked: agents.filter((a) => a.status === 'revoked').length,
      },
      byRobot,
      agents,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}
