import type { EntityManager } from '@mikro-orm/postgresql'
import { runAgentCommand } from '../agentRoute'

/**
 * Endpoint uderzeń serca.
 *
 * Wpuszcza wywołującego bez sesji użytkownika - świadome odstępstwo, które
 * trzeba nazwać: agent na robocie nie jest człowiekiem i nie ma się jak
 * zalogować. Zamiast tego **każde** wywołanie niesie podpis kluczem, którego
 * centrala nie posiada. Odstępstwo dotyczy więc mechanizmu, nie rygoru.
 *
 * Czego ten endpoint **nie** robi i robić nie będzie: nie zwraca robotowi
 * żadnej treści pracy. Odpowiedź zawiera stan łączności i następny termin -
 * i tyle. Stan pożądany oprogramowania jest osobnym kanałem, z osobną
 * dzierżawą; sklejenie tych dwóch rzeczy tutaj zrobiłoby z żywotności
 * warunku wdrożenia, a z wdrożenia - warunku żywotności.
 */
export const metadata = {
  requireAuth: false,
}

export async function POST(req: Request): Promise<Response> {
  return runAgentCommand(
    req,
    'edge.agents.heartbeat',
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
    (payload) => ({
      sessionId: payload.sessionId,
      sequence: payload.sequence,
      timestamp: payload.timestamp,
      signature: payload.signature,
    }),
  )
}
