import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { GET as getAsset } from '../api/assets/[name]/route'
import { GET as getCameras } from '../api/cameras/route'
import { GET as getRoom } from '../api/room/route'
import { readPackagedAsset } from '../lib/assets'

jest.mock('@open-mercato/shared/lib/auth/server', () => ({ getAuthFromRequest: jest.fn() }))
jest.mock('@open-mercato/shared/lib/di/container', () => ({ createRequestContainer: jest.fn() }))
jest.mock('../lib/assets', () => ({ readPackagedAsset: jest.fn() }))

const mockAuth = jest.mocked(getAuthFromRequest)
const mockContainer = jest.mocked(createRequestContainer)
const mockReadAsset = jest.mocked(readPackagedAsset)
const mockHasFeatures = jest.fn()
const request = () => new Request('http://localhost/api/digital_twins/room')
const assetContext = (name: string) => ({ params: Promise.resolve({ name }) })

beforeEach(() => {
  jest.resetAllMocks()
  mockAuth.mockResolvedValue({ sub: 'user-1', tenantId: 'tenant-1', orgId: 'org-1' } as Awaited<ReturnType<typeof getAuthFromRequest>>)
  mockContainer.mockResolvedValue({ resolve: () => ({ userHasAllFeatures: mockHasFeatures }) } as unknown as Awaited<ReturnType<typeof createRequestContainer>>)
  mockHasFeatures.mockResolvedValue(true)
})

test.each(['manifest', 'asset'])('%s denies anonymous requests before reading files', async (kind) => {
  mockAuth.mockResolvedValue(null)
  const response = kind === 'manifest' ? await getRoom(request()) : await getAsset(request(), assetContext('room.glb'))
  expect(response.status).toBe(401)
  expect(mockReadAsset).not.toHaveBeenCalled()
})

test.each(['manifest', 'asset'])('%s checks feature permission in authenticated tenant and organization', async (kind) => {
  mockHasFeatures.mockResolvedValue(false)
  const response = kind === 'manifest' ? await getRoom(request()) : await getAsset(request(), assetContext('room.glb'))
  expect(response.status).toBe(403)
  expect(mockHasFeatures).toHaveBeenCalledWith('user-1', ['digital_twins.view'], { tenantId: 'tenant-1', organizationId: 'org-1' })
  expect(mockReadAsset).not.toHaveBeenCalled()
})

test('missing organization cannot access packaged assets', async () => {
  mockAuth.mockResolvedValue({ sub: 'user-1', tenantId: 'tenant-1' } as Awaited<ReturnType<typeof getAuthFromRequest>>)
  expect((await getAsset(request(), assetContext('room.glb'))).status).toBe(400)
  expect(mockReadAsset).not.toHaveBeenCalled()
})

test.each(['../room.glb', '%2e%2e%2froom.glb', 'room.manifest.json', 'source.blend', 'ROOM.GLB', 'room.glb/extra'])('rejects asset name %s without filesystem access', async (name) => {
  expect((await getAsset(request(), assetContext(name))).status).toBe(404)
  expect(mockReadAsset).not.toHaveBeenCalled()
})

test.each([
  ['room.glb', 'model/gltf-binary'],
  ['viewer.js', 'text/javascript; charset=utf-8'],
  ['tracker.js', 'text/javascript; charset=utf-8'],
  ['poster.webp', 'image/webp'],
  ['detector.model.json', 'application/json; charset=utf-8'],
  ['group1-shard1of5', 'application/octet-stream'],
])('serves allowed %s privately with correct MIME type', async (name, contentType) => {
  mockReadAsset.mockResolvedValue(Buffer.from('packaged-content'))
  const response = await getAsset(request(), assetContext(name))
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe(contentType)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(await response.text()).toBe('packaged-content')
})

test('camera registry validates calibration and strips undeclared source details', async () => {
  const registry = {
    version: 1, roomId: 'scene-7', cameras: [{
      id: 'cam-1', name: 'Camera 1', location: 'Room', status: 'calibration_required',
      source: { kind: 'local_recording', width: 1920, height: 1080, fps: 30, durationSeconds: 10, url: 'rtsp://private' },
      calibration: {
        state: 'estimated', cameraPosition: [0, 3, 0], target: [5, 0, -5],
        imageFloorPolygon: [[0, 1], [1, 1], [1, .5], [0, .5]],
        twinFloorPolygon: [[0, 0], [10, 0], [10, -10], [0, -10]],
      },
      privacy: { identityRecognition: false, rawVideoUploaded: false, trackRetention: 'session' },
    }],
  }
  mockReadAsset.mockResolvedValue(Buffer.from(JSON.stringify(registry)))
  const response = await getCameras(request())
  expect(response.status).toBe(200)
  expect((await response.json()).cameras[0].source.url).toBeUndefined()
})

test('unavailable file returns bounded error without filesystem details', async () => {
  mockReadAsset.mockRejectedValue(new Error('C:/private/source.blend'))
  const response = await getAsset(request(), assetContext('room.glb'))
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: 'asset_unavailable' })
})

test('malformed manifest fails closed', async () => {
  mockReadAsset.mockResolvedValue(Buffer.from('{"modelUrl":"https://external.invalid/source"}'))
  const response = await getRoom(request())
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: 'manifest_unavailable' })
})

test('valid manifest preserves provenance and removes undeclared private fields', async () => {
  const bounds = { min: [0, 0, 0], max: [10, 3, 10] }
  const manifest = {
    version: 1, id: 'scene-7', name: 'Scene 7', units: 'm',
    modelUrl: '/api/digital_twins/assets/room.glb', posterUrl: '/api/digital_twins/assets/poster.webp',
    bounds,
    stats: { sourceBytes: 100, modelBytes: 50, sourceObjects: 2, meshCount: 1, triangles: 12, materials: 1 },
    provenance: { source: 'LiDAR + video', controlPoints: 318, geometricOnly: true, scaleVerified: false },
    layers: [{ id: 'walls', label: 'Walls', defaultVisible: true, objectCount: 2 }],
    elements: [{ id: 'wall-1', label: 'Wall', layerId: 'walls', nodeName: 'Wall', confidence: 'approximate', bounds, sourceObjectCount: 2 }],
    privateSourcePath: 'C:/private/source.blend',
  }
  mockReadAsset.mockResolvedValue(Buffer.from(JSON.stringify(manifest)))
  const response = await getRoom(request())
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.provenance).toEqual(manifest.provenance)
  expect(body.privateSourcePath).toBeUndefined()
  expect(response.headers.get('cache-control')).toBe('private, no-store')
})
