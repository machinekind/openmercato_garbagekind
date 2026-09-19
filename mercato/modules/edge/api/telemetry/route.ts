import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { telemetryIngressSchema } from '../../commands/telemetry'
import { runAgentCommand } from '../agentRoute'

export const metadata = { requireAuth: false }

export async function POST(req: Request): Promise<Response> {
  return runAgentCommand(
    req,
    'edge.telemetry.ingest',
    async (em: EntityManager, payload) => {
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null
      if (!sessionId) return null
      const rows = await em.getConnection().execute<Array<{ organization_id: string }>>(
        `select organization_id from edge_agent_sessions where id = ? limit 1`,
        [sessionId],
      )
      return rows?.length ? { organizationId: rows[0].organization_id } : null
    },
    (payload) => payload,
  )
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Edge',
  summary: 'Ingest signed, structured physical-AI telemetry',
  methods: {
    POST: {
      summary: 'Record an episode, intervention or aggregated detection window from an enrolled edge agent',
      requestBody: { schema: telemetryIngressSchema },
      responses: [
        {
          status: 200,
          description: 'Telemetry accepted and recorded in its domain ledger',
          schema: z.object({ kind: z.enum(['episode', 'intervention', 'detection_window']), sequence: z.number().int(), result: z.unknown() }),
        },
      ],
      errors: [400, 401, 404, 422].map((status) => ({
        status,
        description: 'Malformed, unauthenticated, replayed or invalid telemetry',
        schema: z.object({ error: z.string() }),
      })),
    },
  },
}
