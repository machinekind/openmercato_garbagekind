import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import type { TenantScope } from './pickTaskService'

export type RequestScope = TenantScope & { isApiKey: boolean; subject: string }

export class UnauthorizedError extends Error {}

/**
 * Tenant scope for a robotics request.
 *
 * Every query in this module is filtered by what this returns, so a missing
 * tenant is a 401 rather than an unscoped read: one arm belongs to one tenant,
 * and a cross-tenant pick task is a physical mistake, not just a data leak.
 */
export async function requireScope(request: Request): Promise<RequestScope> {
  const auth = await getAuthFromRequest(request)
  if (!auth?.tenantId) throw new UnauthorizedError('Unauthorized')
  return {
    tenantId: auth.tenantId,
    organizationId: auth.orgId ?? null,
    isApiKey: Boolean(auth.isApiKey),
    subject: String(auth.keyName || auth.email || auth.sub || 'unknown'),
  }
}

/** Uniform JSON error body; never echoes internals back to the caller. */
export function errorResponse(err: unknown, fallback = 'Request failed'): Response {
  if (err instanceof UnauthorizedError) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const message = err instanceof Error ? err.message : fallback
  return Response.json({ error: message }, { status: 400 })
}
