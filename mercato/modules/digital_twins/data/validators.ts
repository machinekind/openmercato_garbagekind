import { z } from 'zod'

const coordinateSchema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()])
const countSchema = z.number().int().nonnegative()
export const boundsSchema = z.object({ min: coordinateSchema, max: coordinateSchema })
  .refine((bounds) => bounds.min.every((value, index) => value <= bounds.max[index]), 'Invalid bounds')

export const publicAssetNameSchema = z.enum(['room.glb', 'viewer.js', 'poster.webp'])

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
