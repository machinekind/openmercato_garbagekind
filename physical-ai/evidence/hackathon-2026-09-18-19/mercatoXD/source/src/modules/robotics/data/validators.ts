import { z } from 'zod'

/** Statuses the app owns. Kept in sync with bridge/om_bridge/types.py:TaskStatus. */
export const TASK_STATUSES = ['queued', 'claimed', 'running', 'succeeded', 'failed', 'aborted'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** Stages reported from inside one attempt. Mirrors om_bridge/types.py:PickStage. */
export const PICK_STAGES = [
  'engaging',
  'searching',
  'approaching',
  'grasping',
  'lifting',
  'retreating',
  'done',
] as const
export type PickStage = (typeof PICK_STAGES)[number]

export const TERMINAL_STATUSES: readonly TaskStatus[] = ['succeeded', 'failed', 'aborted']

const presetName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  // Preset names are looked up in the panel's presets.json; keep them boring so
  // a name can never be read as a path or a command.
  .regex(/^[a-z0-9_-]+$/i, 'preset names are letters, digits, dash and underscore')

export const cellCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  panelBaseUrl: z
    .string()
    .trim()
    .url()
    .refine((u) => u.startsWith('http://') || u.startsWith('https://'), 'panel URL must be http(s)'),
  homePreset: presetName.default('home'),
  searchPreset: presetName.default('table'),
  isActive: z.boolean().default(true),
})

export const cellUpdateSchema = cellCreateSchema.partial().extend({ id: z.string().uuid() })

export const taskCreateSchema = z.object({
  cellId: z.string().uuid(),
  instruction: z.string().trim().min(1).max(500),
  targetLabel: z.string().trim().min(1).max(64).default('can'),
  dropPreset: presetName.nullish(),
  priority: z.coerce.number().int().min(-100).max(100).default(0),
  maxAttempts: z.coerce.number().int().min(1).max(5).default(1),
  sourceRef: z.string().trim().max(200).nullish(),
})

export const taskListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
    cellId: z.string().uuid().optional(),
    status: z.enum(TASK_STATUSES).optional(),
  })
  .passthrough()

export const claimSchema = z.object({
  cellId: z.string().uuid(),
  /** Bridge identity, for the audit trail: which process took the task. */
  bridge: z.string().trim().min(1).max(120).default('bridge'),
})

export const reportSchema = z.object({
  taskId: z.string().uuid(),
  stage: z.enum(PICK_STAGES),
  message: z.string().trim().min(1).max(1000),
  kind: z.enum(['stage', 'status', 'alert', 'log']).default('stage'),
  payload: z.record(z.unknown()).nullish(),
})

export const finishSchema = z.object({
  taskId: z.string().uuid(),
  status: z.enum(['succeeded', 'failed', 'aborted']),
  detail: z.string().trim().max(1000).default(''),
  grasped: z.boolean().default(false),
  payload: z.record(z.unknown()).nullish(),
})

export const abortSchema = z.object({
  taskId: z.string().uuid(),
  reason: z.string().trim().max(500).default('aborted by operator'),
})
