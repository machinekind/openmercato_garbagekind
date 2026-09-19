import { z } from 'zod'

const coordinateSchema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()])
const countSchema = z.number().int().nonnegative()
export const boundsSchema = z.object({ min: coordinateSchema, max: coordinateSchema })
  .refine((bounds) => bounds.min.every((value, index) => value <= bounds.max[index]), 'Invalid bounds')

export const publicAssetNameSchema = z.enum([
  'room.glb', 'viewer.js', 'tracker.js', 'poster.webp', 'detector.model.json',
  'group1-shard1of5', 'group1-shard2of5', 'group1-shard3of5', 'group1-shard4of5', 'group1-shard5of5',
])

const imagePointSchema = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])
const floorPointSchema = z.tuple([z.number().finite(), z.number().finite()])

export const cameraManifestSchema = z.object({
  version: z.literal(1),
  roomId: z.string().min(1).max(128),
  cameras: z.array(z.object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(256),
    location: z.string().min(1).max(256),
    status: z.enum(['ready', 'calibration_required', 'offline']),
    source: z.object({
      kind: z.enum(['local_recording', 'browser_camera', 'rtsp_gateway']),
      width: z.number().int().positive().max(16384),
      height: z.number().int().positive().max(16384),
      fps: z.number().positive().max(240),
      durationSeconds: z.number().nonnegative().max(86400).optional(),
    }),
    calibration: z.object({
      state: z.enum(['estimated', 'verified']),
      cameraPosition: coordinateSchema,
      target: coordinateSchema,
      imageFloorPolygon: z.tuple([imagePointSchema, imagePointSchema, imagePointSchema, imagePointSchema]),
      twinFloorPolygon: z.tuple([floorPointSchema, floorPointSchema, floorPointSchema, floorPointSchema]),
      obstacles: z.array(z.object({
        elementId: z.string().min(1).max(128),
        bounds: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
        clearance: z.number().nonnegative().max(5),
      })).max(100).default([]),
    }),
    privacy: z.object({
      identityRecognition: z.literal(false),
      rawVideoUploaded: z.literal(false),
      trackRetention: z.literal('session'),
    }),
  })).max(500),
}).superRefine((manifest, context) => {
  if (new Set(manifest.cameras.map((camera) => camera.id)).size !== manifest.cameras.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate camera identifiers' })
  }
})

export const roomManifestSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  units: z.literal('m'),
  modelUrl: z.literal('/api/digital_twins/assets/room.glb'),
  posterUrl: z.literal('/api/digital_twins/assets/poster.webp'),
  bounds: boundsSchema,
  stats: z.object({
    sourceBytes: countSchema,
    modelBytes: countSchema,
    sourceObjects: countSchema,
    meshCount: countSchema,
    triangles: countSchema,
    materials: countSchema,
  }),
  provenance: z.object({
    source: z.string().max(256),
    controlPoints: countSchema,
    geometricOnly: z.literal(true),
    scaleVerified: z.boolean(),
  }),
  layers: z.array(z.object({
    id: z.string().min(1).max(128),
    label: z.string().max(256),
    defaultVisible: z.boolean(),
    objectCount: countSchema,
  })).max(100),
  elements: z.array(z.object({
    id: z.string().min(1).max(128),
    label: z.string().max(256),
    layerId: z.string().min(1).max(128),
    nodeName: z.string().min(1).max(256),
    confidence: z.enum(['measured', 'approximate', 'partial']),
    bounds: boundsSchema,
    sourceObjectCount: countSchema,
  })).max(20000),
}).superRefine((manifest, context) => {
  const layerIds = new Set(manifest.layers.map((layer) => layer.id))
  const elementIds = new Set(manifest.elements.map((element) => element.id))
  if (layerIds.size !== manifest.layers.length || elementIds.size !== manifest.elements.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate identifiers' })
  }
  if (manifest.elements.some((element) => !layerIds.has(element.layerId))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unknown layer' })
  }
})

export type RoomManifest = z.infer<typeof roomManifestSchema>
export type CameraManifest = z.infer<typeof cameraManifestSchema>
export type CameraDefinition = CameraManifest['cameras'][number]
