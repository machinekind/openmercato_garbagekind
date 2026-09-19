import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { authorizeRoomRequest, errorResponse, privateHeaders } from '../../../lib/access'
import { readPackagedAsset } from '../../../lib/assets'
import { publicAssetNameSchema } from '../../../data/validators'

export const metadata = { GET: { requireAuth: true, requireFeatures: ['digital_twins.view'] } }

export async function GET(request: Request, context: { params: Promise<{ name: string }> }): Promise<Response> {
  const denied = await authorizeRoomRequest(request)
  if (denied) return denied
  const { name } = await context.params
  const parsed = publicAssetNameSchema.safeParse(name)
  if (!parsed.success) return errorResponse('asset_not_found', 404)
  const mimeTypes = {
    'room.glb': 'model/gltf-binary', 'viewer.js': 'text/javascript; charset=utf-8', 'tracker.js': 'text/javascript; charset=utf-8',
    'poster.webp': 'image/webp', 'detector.model.json': 'application/json; charset=utf-8',
    'group1-shard1of5': 'application/octet-stream', 'group1-shard2of5': 'application/octet-stream', 'group1-shard3of5': 'application/octet-stream',
    'group1-shard4of5': 'application/octet-stream', 'group1-shard5of5': 'application/octet-stream',
  }
  try {
    const asset = await readPackagedAsset(parsed.data)
    return new Response(new Uint8Array(asset), {
      headers: {
        ...privateHeaders,
        'Content-Type': mimeTypes[parsed.data],
        'Content-Length': String(asset.byteLength),
        'Content-Disposition': `inline; filename="${parsed.data}"`,
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return errorResponse('asset_unavailable', 503)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Digital twins',
  summary: 'Read a packaged viewer asset',
  pathParams: z.object({ name: publicAssetNameSchema }),
  methods: {
    GET: {
      summary: 'Read an authenticated room model, renderer or preview',
      description: 'Content-Type follows the allowlisted asset: room model, application script, detector model or preview.',
      responses: [{ status: 200, description: 'Packaged asset bytes', mediaType: 'application/octet-stream' }],
      errors: [400, 401, 403, 404, 503].map((status) => ({ status, description: 'Asset unavailable or access denied', schema: z.object({ error: z.string() }) })),
    },
  },
}
