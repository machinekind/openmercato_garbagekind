import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import { registerCommand, type CommandBus, type CommandHandler } from '@open-mercato/shared/lib/commands'
import { AgentSession } from '../data/entities'
import { payloads } from '../lib/crypto'
import { isTimestampFresh } from '../lib/liveness'
import { authenticateAgent } from './agents'

/**
 * Podpisany kanał małych, ustrukturyzowanych wyników z edge/DGX do ERP.
 * Obraz i ciężkie tensory pozostają poza Mercato; tutaj trafiają epizody,
 * interwencje oraz zagregowane okna detekcji potrzebne do zarządzania pracą.
 */

const timestamp = z.string().trim().min(1).refine((value) => !Number.isNaN(Date.parse(value)), 'Nieprawidłowy czas ISO.')

const episodePayloadSchema = z.object({
  externalRef: z.string().trim().min(1).max(191),
  taskKey: z.string().trim().min(1).max(120),
  startedAt: timestamp,
  endedAt: timestamp,
  outcome: z.enum(['success', 'failure', 'aborted', 'timeout']),
  outcomeDetail: z.string().trim().max(500).optional(),
  policyVersionId: z.string().uuid().nullable().optional(),
  cellId: z.string().uuid().nullable().optional(),
  assignmentId: z.string().uuid().nullable().optional(),
  metrics: z.record(z.string(), z.unknown()).optional(),
}).strict()

const interventionPayloadSchema = z.object({
  episodeId: z.string().uuid().nullable().optional(),
  kind: z.enum(['adjust', 'manual_reset', 'teleop_takeover', 'abort', 'estop']),
  stage: z.string().trim().max(120).optional(),
  // Publiczny kontrakt modułu episodes, powtórzony tu bez zależności kodowej
  // między modułami. Aktualizować razem z INTERVENTION_REASON_CATEGORIES.
  reasonCategory: z.enum([
    'grasp_failure',
    'object_not_detected',
    'workspace_obstruction',
    'person_in_safety_zone',
    'policy_stall',
    'unsafe_motion',
    'joint_limit',
    'camera_fault',
    'tracking_loss',
    'material_jam',
    'power_fault',
    'hardware_fault',
    'communications_loss',
    'calibration_error',
    'operator_request',
    'other',
  ]),
  reason: z.string().trim().min(1).max(500),
  occurredAt: timestamp,
  recoverySeconds: z.number().int().nonnegative().optional(),
  notes: z.string().trim().max(2000).optional(),
}).strict()

const detectionWindowPayloadSchema = z.object({
  cameraId: z.string().uuid(),
  detectorVersionId: z.string().uuid(),
  startedAt: timestamp,
  endedAt: timestamp,
  framesAnalyzed: z.number().int().nonnegative(),
  countingMode: z.enum(['tracks', 'detections']),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  meanConfidence: z.record(z.string(), z.number().min(0).max(1)).optional(),
}).strict()

const clipPayloadSchema = z.object({
  cameraId: z.string().uuid(),
  subjectType: z.string().trim().min(1).max(64),
  subjectId: z.string().uuid().nullable().optional(),
  uri: z.string().trim().min(1).max(1000),
  recordedAt: timestamp,
  durationSeconds: z.number().int().positive().max(3600),
}).strict()

const clipDeletionConfirmationPayloadSchema = z.object({
  clipIds: z.array(z.string().uuid()).min(1).max(1000),
}).strict()

const signedEnvelope = z.object({
  sessionId: z.string().uuid(),
  sequence: z.number().int().positive(),
  timestamp,
  signature: z.string().min(1),
})

export const telemetryIngressSchema = z.discriminatedUnion('kind', [
  signedEnvelope.extend({ kind: z.literal('episode'), payload: episodePayloadSchema }).strict(),
  signedEnvelope.extend({ kind: z.literal('intervention'), payload: interventionPayloadSchema }).strict(),
  signedEnvelope.extend({ kind: z.literal('detection_window'), payload: detectionWindowPayloadSchema }).strict(),
  signedEnvelope.extend({ kind: z.literal('clip'), payload: clipPayloadSchema }).strict(),
  signedEnvelope.extend({
    kind: z.literal('clip_deletion_confirmation'),
    payload: clipDeletionConfirmationPayloadSchema,
  }).strict(),
])

export type TelemetryIngressInput = z.infer<typeof telemetryIngressSchema>

type SessionRef = {
  id: string
  agentId: string
  tenantId: string
  organizationId: string
  lastSequence: number
  endedAt?: Date | null
}

function resolveEm(ctx: { container: { resolve: (key: string) => unknown } }): EntityManager {
  return (ctx.container.resolve('em') as EntityManager).fork()
}

function targetFor(kind: TelemetryIngressInput['kind']): string {
  if (kind === 'episode') return 'episodes.episodes.record'
  if (kind === 'intervention') return 'episodes.interventions.record'
  if (kind === 'clip') return 'vision.clips.attach'
  if (kind === 'clip_deletion_confirmation') return 'vision.clips.confirm_deletion'
  return 'vision.windows.record'
}

export const ingestTelemetryCommand: CommandHandler<
  TelemetryIngressInput,
  { kind: TelemetryIngressInput['kind']; sequence: number; result: unknown }
> = {
  id: 'edge.telemetry.ingest',
  async execute(rawInput, ctx) {
    const input = telemetryIngressSchema.parse(rawInput ?? {})
    const sentAt = new Date(input.timestamp)
    if (!isTimestampFresh(sentAt)) {
      throw new Error('Znacznik czasu telemetrii jest poza dopuszczalnym oknem rozjazdu zegarów.')
    }

    const em = resolveEm(ctx)
    const session = (await em.findOne(AgentSession, { id: input.sessionId } as never)) as unknown as SessionRef | null
    if (!session || session.endedAt) throw new Error('Sesja jest zamknięta — wymagane ponowne połączenie.')
    if (input.sequence <= Number(session.lastSequence ?? 0)) {
      throw new Error('Numer kolejny nie jest większy od poprzedniego — powtórka lub klon agenta.')
    }

    const signed = payloads.telemetry(input.sessionId, input.sequence, input.timestamp, input.kind, input.payload)
    const { agent } = await authenticateAgent(em, session.agentId, signed, input.signature)
    if (agent.tenantId !== session.tenantId || agent.organizationId !== session.organizationId) {
      throw new Error('Sesja nie należy do zakresu uwierzytelnionego agenta.')
    }

    const bus = ctx.container.resolve('commandBus') as CommandBus
    const downstreamInput = {
      ...input.payload,
      organizationId: agent.organizationId,
      tenantId: agent.tenantId,
      ...(input.kind === 'episode' || input.kind === 'intervention' ? { robotId: agent.robotId } : {}),
      ...(input.kind === 'clip_deletion_confirmation' ? { confirmedBy: `edge-agent:${agent.id}` } : {}),
    }
    const envelope = await bus.execute(targetFor(input.kind), { input: downstreamInput, ctx })

    // Licznik jest wspólny z heartbeatami. Zapisujemy go dopiero po przyjęciu
    // rekordu domenowego, aby błędny rekord nie robił dziury w strumieniu.
    session.lastSequence = input.sequence
    await em.flush()

    return { kind: input.kind, sequence: input.sequence, result: envelope.result }
  },
}

registerCommand(ingestTelemetryCommand)
