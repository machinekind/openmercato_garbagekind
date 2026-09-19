import type { EntityManager } from '@mikro-orm/postgresql'
import { runAgentCommand } from '../../../edge/api/agentRoute'

/**
 * Zgłoszenie stanu faktycznego przez agenta.
 *
 * Osobny endpoint od dzierżawy, choć oba wołane przez tego samego agenta.
 * Powód jest dziedzinowy, nie techniczny: żądanie dzierżawy jest pytaniem
 * („co mam robić"), a zgłoszenie stanu twierdzeniem („co robię"). Sklejenie
 * ich w jedno wywołanie uzależniłoby uzgodnienie stanu od tego, czy robot
 * akurat potrzebuje odnowienia mandatu — a rozjazd najczęściej wychodzi
 * właśnie wtedy, gdy nic się nie odnawia.
 */
export const metadata = {
  requireAuth: false,
}

export async function POST(req: Request): Promise<Response> {
  return runAgentCommand(
    req,
    'deployment.reports.record',
    async (em: EntityManager, payload) => {
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null
      if (!sessionId) return null
      const rows = await em.getConnection().execute<Array<{ organization_id: string }>>(
        `select a.organization_id
           from edge_agent_sessions s
           join edge_agents a on a.id = s.agent_id
          where s.id = ? limit 1`,
        [sessionId],
      )
      return rows?.length ? { organizationId: rows[0].organization_id } : null
    },
    (payload, scope) => ({
      organizationId: scope.organizationId,
      agentSessionId: payload.sessionId,
      reportedState: payload.reportedState,
      reportedPolicyVersionId: payload.reportedPolicyVersionId ?? null,
      timestamp: payload.timestamp,
      signature: payload.signature,
    }),
  )
}
