import type { EntityManager } from '@mikro-orm/postgresql'
import { hashEnrollmentToken } from '../../lib/crypto'
import { runAgentCommand } from '../agentRoute'

/**
 * Wpis agenta przez sieć - pierwszy kontakt robota z centralą.
 *
 * Bez tego endpointu kanał brzegowy byłby niekompletny w sposób trudny do
 * zauważenia: uderzenia serca dałoby się przyjmować, ale nie dałoby się
 * dojść do stanu, w którym jest co przyjmować.
 */
export const metadata = {
  // Uwierzytelnienie jest kryptograficzne i dzieje się w komendzie: bilet
  // wpisowy plus podpis złożony kluczem, którego centrala nie posiada.
  requireAuth: false,
}

export async function POST(req: Request): Promise<Response> {
  return runAgentCommand(
    req,
    'edge.agents.enroll',
    async (em: EntityManager, payload) => {
      const token = typeof payload.token === 'string' ? payload.token : null
      if (!token) return null
      // Szukamy po skrócie, nigdy po jawnej postaci - w bazie jawnej nie ma.
      const rows = await em.getConnection().execute<Array<{ organization_id: string }>>(
        'select organization_id from edge_enrollment_tokens where token_hash = ? limit 1',
        [hashEnrollmentToken(token)],
      )
      return rows?.length ? { organizationId: rows[0].organization_id } : null
    },
    (payload) => ({
      token: payload.token,
      publicKey: payload.publicKey,
      signature: payload.signature,
      agentKind: payload.agentKind,
      agentVersion: payload.agentVersion,
      heartbeatIntervalSeconds: payload.heartbeatIntervalSeconds,
      livenessGraceSeconds: payload.livenessGraceSeconds,
      lostAfterSeconds: payload.lostAfterSeconds,
    }),
  )
}
