import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { roomManifestSchema } from '../../data/validators'
import { authorizeRoomRequest, errorResponse, privateHeaders } from '../../lib/access'
import { readPackagedAsset } from '../../lib/assets'

export const metadata = { GET: { requireAuth: true, requireFeatures: ['digital_twins.view'] } }

export async function GET(request: Request): Promise<Response> {
  const denied = await authorizeRoomRequest(request)
  if (denied) return denied
  try {
    const bytes = await readPackagedAsset('room.manifest.json')
    const manifest = roomManifestSchema.parse(JSON.parse(bytes.toString('utf8')))
    return Response.json(manifest, { headers: privateHeaders })
  } catch {
    return errorResponse('manifest_unavailable', 503)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Digital twins',
  summary: 'Read the packaged room manifest',
  methods: {
    GET: {
      summary: 'Read room geometry, layers, provenance and uncertainty',
      responses: [{ status: 200, description: 'Packaged geometric twin manifest', schema: roomManifestSchema }],
      errors: [400, 401, 403, 503].map((status) => ({ status, description: 'Model unavailable or access denied', schema: z.object({ error: z.string() }) })),
    },
  },
}
