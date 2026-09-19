import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { cameraManifestSchema } from '../../data/validators'
import { authorizeRoomRequest, errorResponse, privateHeaders } from '../../lib/access'
import { readPackagedAsset } from '../../lib/assets'

export const metadata = { GET: { requireAuth: true, requireFeatures: ['digital_twins.view'] } }

export async function GET(request: Request): Promise<Response> {
  const denied = await authorizeRoomRequest(request)
  if (denied) return denied
  try {
    const bytes = await readPackagedAsset('cameras.manifest.json')
    return Response.json(cameraManifestSchema.parse(JSON.parse(bytes.toString('utf8'))), { headers: privateHeaders })
  } catch {
    return errorResponse('camera_registry_unavailable', 503)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Digital twins',
  summary: 'Read the room camera registry',
  methods: {
    GET: {
      summary: 'Read camera sources, privacy settings and floor calibration',
      responses: [{ status: 200, description: 'Validated camera registry', schema: cameraManifestSchema }],
      errors: [400, 401, 403, 503].map((status) => ({ status, description: 'Registry unavailable or access denied', schema: z.object({ error: z.string() }) })),
    },
  },
}
