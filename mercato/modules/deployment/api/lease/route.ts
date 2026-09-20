import type { EntityManager } from '@mikro-orm/postgresql'
import { runAgentCommand } from '../../../edge/api/agentRoute'

/**
 * Endpoint dzierżawy - wołany przez agenta na robocie, nie przez człowieka.
 *
 * Bez sesji użytkownika, jak trzy endpointy kanału brzegowego, i z tego samego
 * powodu: agent nie jest człowiekiem i nie ma się jak zalogować. Uwierzytelnia
 * się podpisem kluczem, którego centrala nie posiada, a zakres organizacji
 * ustala serwer z rekordu sesji - nie z treści żądania, bo wtedy byłby
 * parametrem, którym da się sięgnąć poza własnego tenanta.
 *
 * Kanał jest **osobny od heartbeatu** i tak ma zostać. Doklejenie stanu
 * pożądanego do odpowiedzi uderzenia serca zrobiłoby z żywotności warunek
 * wdrożenia: agent, który przestałby bić serce, traciłby mandat natychmiast,
 * niezależnie od klasy ryzyka celi - czyli dokładnie to, czemu dzierżawa
 * w celi ogrodzonej ma zapobiegać.
 */
export const metadata = {
  requireAuth: false,
}

export async function POST(req: Request): Promise<Response> {
  return runAgentCommand(
    req,
    'deployment.leases.issue',
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
      sequence: payload.sequence,
      timestamp: payload.timestamp,
      signature: payload.signature,
    }),
  )
}
