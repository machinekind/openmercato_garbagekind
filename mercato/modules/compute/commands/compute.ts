import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import { registerCommand, type CommandHandler } from '@open-mercato/shared/lib/commands'
import { ComputeNode, Placement } from '../data/entities'
import { checkNodeRoles, NODE_ROLES } from '../lib/capacity'
import { emitComputeEvent } from '../events'

const scoped = z.object({
  organizationId: z.string().uuid(),
  tenantId: z.string().uuid(),
})

function resolveEm(ctx: { container: { resolve: (key: string) => unknown } }): EntityManager {
  return (ctx.container.resolve('em') as EntityManager).fork()
}

export const registerNodeSchema = scoped.extend({
  code: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(191),
  kind: z.string().trim().min(1).max(64),
  cellId: z.string().uuid().nullable().optional(),
  memoryGb: z.number().int().positive(),
  memoryBandwidthGbs: z.number().int().positive(),
  computeTflops: z.number().positive(),
  /** Bez precyzji liczba TFLOPS nie znaczy nic - patrz komentarz przy encji. */
  computePrecision: z.enum(['fp4', 'fp8', 'int8', 'fp16', 'bf16', 'fp32']),
  roles: z.array(z.string()).min(1),
  sharedGeneralPurpose: z.boolean().default(true),
  realtimeCapable: z.boolean().default(false),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export type RegisterNodeInput = z.infer<typeof registerNodeSchema>

const registerNodeCommand: CommandHandler<RegisterNodeInput, { nodeId: string; roles: string[] }> = {
  id: 'compute.nodes.register',
  async execute(rawInput, ctx) {
    const input = registerNodeSchema.parse(rawInput ?? {})

    // Bramka, dla której ten moduł w ogóle powstał.
    const verdict = checkNodeRoles(input.roles)
    if (!verdict.allowed) throw new Error(verdict.reason)

    const em = resolveEm(ctx)
    const istnieje = await em.findOne(ComputeNode, { tenantId: input.tenantId, code: input.code } as never)
    if (istnieje) throw new Error(`Węzeł o kodzie ${input.code} już istnieje.`)

    const node = em.create(ComputeNode, {
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      code: input.code,
      name: input.name,
      kind: input.kind,
      cellId: input.cellId ?? null,
      memoryGb: input.memoryGb,
      memoryBandwidthGbs: input.memoryBandwidthGbs,
      computeTflops: input.computeTflops,
      computePrecision: input.computePrecision,
      roles: input.roles,
      sharedGeneralPurpose: input.sharedGeneralPurpose,
      realtimeCapable: input.realtimeCapable,
      metadata: input.metadata ?? null,
    } as never)
    em.persist(node)
    await em.flush()

    const nodeId = (node as unknown as { id: string }).id
    await emitComputeEvent('compute.node.registered', {
      id: nodeId,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      code: input.code,
      kind: input.kind,
      cellId: input.cellId ?? null,
      memoryGb: input.memoryGb,
      memoryBandwidthGbs: input.memoryBandwidthGbs,
      roles: input.roles,
      realtimeCapable: input.realtimeCapable,
    })

    return { nodeId, roles: input.roles }
  },
}

export const placeWorkloadSchema = scoped.extend({
  nodeId: z.string().uuid(),
  workloadType: z.enum(['training_run', 'detector_version', 'policy_version', 'simulation']),
  workloadRef: z.string().uuid(),
  requiredRole: z.enum(NODE_ROLES),
  toolchain: z.record(z.string(), z.unknown()).optional(),
  startedAt: z.coerce.date().optional(),
  notes: z.string().trim().max(500).optional(),
})

export type PlaceWorkloadInput = z.infer<typeof placeWorkloadSchema>

const placeWorkloadCommand: CommandHandler<PlaceWorkloadInput, { placementId: string }> = {
  id: 'compute.placements.set',
  async execute(rawInput, ctx) {
    const input = placeWorkloadSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)

    const node = (await em.findOne(ComputeNode, {
      id: input.nodeId,
      tenantId: input.tenantId,
      deletedAt: null,
    } as never)) as unknown as { id: string; organizationId: string; roles: string[]; status: string } | null
    if (!node) throw new Error('Węzeł nie istnieje.')
    if (node.status !== 'active') throw new Error(`Węzeł jest w stanie ${node.status}.`)

    if (!node.roles.includes(input.requiredRole)) {
      /*
       * Rola deklarowana przy rejestracji, nie przy przypisaniu. Odwrotna
       * kolejność pozwalałaby dokładać role po cichu, w miarę jak kolejne
       * zadania „muszą gdzieś stanąć".
       */
      throw new Error(
        `Węzeł nie ma roli ${input.requiredRole} (ma: ${node.roles.join(', ')}). ` +
          'Role deklaruje się przy rejestracji węzła, a nie dokłada przy przypisaniu zadania.',
      )
    }

    const placement = em.create(Placement, {
      organizationId: node.organizationId,
      tenantId: input.tenantId,
      nodeId: input.nodeId,
      workloadType: input.workloadType,
      workloadRef: input.workloadRef,
      toolchain: input.toolchain ?? null,
      startedAt: input.startedAt ?? new Date(),
      notes: input.notes ?? null,
    } as never)
    em.persist(placement)
    await em.flush()

    const placementId = (placement as unknown as { id: string }).id
    await emitComputeEvent('compute.placement.set', {
      id: placementId,
      organizationId: node.organizationId,
      tenantId: input.tenantId,
      nodeId: input.nodeId,
      workloadType: input.workloadType,
      workloadRef: input.workloadRef,
      requiredRole: input.requiredRole,
    })

    return { placementId }
  },
}

registerCommand(registerNodeCommand)
registerCommand(placeWorkloadCommand)

export { registerNodeCommand, placeWorkloadCommand }
