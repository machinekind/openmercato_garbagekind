import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveActiveOrganizationId } from '@open-mercato/shared/lib/auth/organizationScope'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { RbacService } from '@open-mercato/core/modules/auth/services/rbacService'

export const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization' }

export function errorResponse(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: privateHeaders })
}

export async function authorizeRoomRequest(request: Request): Promise<Response | null> {
  const auth = await getAuthFromRequest(request)
  if (!auth) return errorResponse('unauthorized', 401)
  const organizationId = resolveActiveOrganizationId(auth)
  if (!auth.tenantId || !organizationId) return errorResponse('organization_scope_required', 400)
  const container = await createRequestContainer()
  const rbac = container.resolve('rbacService') as RbacService
  const allowed = await rbac.userHasAllFeatures(auth.sub, ['digital_twins.view'], {
    tenantId: auth.tenantId,
    organizationId,
  })
  return allowed ? null : errorResponse('forbidden', 403)
}
