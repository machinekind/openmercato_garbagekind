import type { EntityManager } from '@mikro-orm/postgresql'
import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { estimateDecode, estimateVision, type NodeCapability } from './lib/capacity'

type Scope = { tenantId: string; organizationId: string }

function parseArgs(rest: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {}
  for (let i = 0; i < rest.length; i += 1) {
    const part = rest[i]
    if (!part?.startsWith('--')) continue
    const [key, value] = part.slice(2).split('=')
    if (value !== undefined) args[key] = value
    else if (rest[i + 1] && !rest[i + 1]!.startsWith('--')) {
      args[key] = rest[i + 1]!
      i += 1
    } else args[key] = true
  }
  return args
}

async function resolveScope(em: EntityManager, args: Record<string, string | boolean>): Promise<Scope> {
  const tenantId = typeof args.tenant === 'string' ? args.tenant : ''
  const organizationId = typeof args.org === 'string' ? args.org : ''
  if (tenantId && organizationId) return { tenantId, organizationId }
  const rows = await em.getConnection().execute<Array<{ tenant_id: string; id: string }>>(
    'select tenant_id, id from organizations where deleted_at is null order by created_at asc limit 1',
  )
  if (!rows?.length) throw new Error('Brak organizacji.')
  return { tenantId: rows[0].tenant_id, organizationId: rows[0].id }
}

function buildCommandContext(
  container: Awaited<ReturnType<typeof createRequestContainer>>,
  scope: Scope,
): CommandRuntimeContext {
  return {
    container,
    auth: null,
    organizationScope: {
      selectedId: scope.organizationId,
      filterIds: [scope.organizationId],
      allowedIds: [scope.organizationId],
      tenantId: scope.tenantId,
    },
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
  } as unknown as CommandRuntimeContext
}

const registerCommand: ModuleCli = {
  command: 'register-spark',
  async run(rest) {
    const args = parseArgs(rest)
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const scope = await resolveScope(em, args)
    const bus = container.resolve('commandBus') as CommandBus

    const kod = typeof args.code === 'string' ? args.code : 'DGX-SPARK-1'
    const wynik = (
      await bus.execute('compute.nodes.register', {
        input: {
          ...scope,
          code: kod,
          name: 'NVIDIA DGX Spark (GB10)',
          kind: 'dgx_spark',
          memoryGb: 128,
          memoryBandwidthGbs: 273,
          computeTflops: 1000,
          computePrecision: 'fp4',
          // Role świadomie wąskie: trening, ewaluacja, symulacja, przetwarzanie.
          // Wnioskowanie dla hali dokłada się dopiero po pomiarze, nie z góry.
          roles: ['training', 'evaluation', 'simulation', 'data_processing'],
          sharedGeneralPurpose: true,
          realtimeCapable: false,
          metadata: { arch: 'GB10 Grace Blackwell', os: 'DGX OS', link: '200GbE ConnectX-7' },
        },
        ctx: buildCommandContext(container, scope),
      })
    ).result as { nodeId: string; roles: string[] }

    console.log(`Zarejestrowano ${kod}`)
    console.log(`Role      : ${wynik.roles.join(', ')}`)
    console.log('Czego NIE : funkcja bezpieczeństwa, zatrzymanie awaryjne, zatrzymanie ochronne')
    console.log('            - te wymagają determinizmu i niezależności od polityki.')
  },
}

const planCommand: ModuleCli = {
  command: 'plan',
  async run(rest) {
    const args = parseArgs(rest)
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const scope = await resolveScope(em, args)

    const kod = typeof args.node === 'string' ? args.node : 'DGX-SPARK-1'
    const rows = await em.getConnection().execute<Array<{
      code: string
      name: string
      memory_gb: number
      memory_bandwidth_gbs: number
      compute_tflops: number
      compute_precision: string
      roles: string[]
    }>>(
      `select code, name, memory_gb, memory_bandwidth_gbs, compute_tflops, compute_precision, roles
         from compute_nodes where tenant_id = ? and code = ? and deleted_at is null limit 1`,
      [scope.tenantId, kod],
    )
    if (!rows.length) throw new Error(`Nie ma węzła ${kod}. Uruchom: yarn mercato compute register-spark`)
    const n = rows[0]

    const node: NodeCapability = {
      memoryGb: n.memory_gb,
      memoryBandwidthGbs: n.memory_bandwidth_gbs,
      computeTflops: n.compute_tflops,
    }

    console.log(`${n.name} (${n.code})`)
    console.log(`  ${n.memory_gb} GB · ${n.memory_bandwidth_gbs} GB/s · ${n.compute_tflops} TFLOPS ${n.compute_precision}`)
    console.log(`  role: ${n.roles.join(', ')}\n`)

    console.log('Wnioskowanie autoregresyjne (polityki wizyjno-językowe):')
    const modele = [
      { nazwa: 'VLA 7B, FP16', total: 7, active: 7, bytes: 2 },
      { nazwa: 'VLA 7B, INT8', total: 7, active: 7, bytes: 1 },
      { nazwa: 'model gęsty 70B, FP8', total: 70, active: 70, bytes: 1 },
      { nazwa: 'MoE 120B (5B aktywnych), FP4', total: 120, active: 5.1, bytes: 0.5 },
      { nazwa: 'model gęsty 400B, FP8', total: 400, active: 400, bytes: 1 },
    ]
    for (const m of modele) {
      const w = estimateDecode(node, { totalParamsB: m.total, activeParamsB: m.active, bytesPerParam: m.bytes })
      const rate = w.estimatedRate === null ? 'nie mieści się' : `~${w.estimatedRate} tok/s`
      console.log(`  ${m.nazwa.padEnd(34)}${String(w.requiredMemoryGb.toFixed(0) + ' GB').padEnd(9)}${rate}`)
    }

    console.log('\nWnioskowanie wizyjne (detektor 120 MB, 60 GFLOP/klatkę, 30 kl./s):')
    /*
     * Dla detektora podstawiamy moc w precyzji, w której on faktycznie liczy,
     * a nie nagłówkową liczbę FP4 z arkusza danych. Podstawienie tej drugiej
     * odwraca werdykt o wąskim gardle - sprawdzone na własnym teście.
     */
    const fp16: NodeCapability = { ...node, computeTflops: node.computeTflops / 8 }
    for (const strumienie of [2, 4, 8, 16]) {
      const w = estimateVision(fp16, { weightsMb: 120, gflopsPerFrame: 60, streams: strumienie, targetFps: 30 })
      console.log(
        `  ${String(strumienie + ' strumieni').padEnd(14)}${String('~' + w.estimatedRate + ' kl./s').padEnd(14)}` +
          `${w.fits ? 'wystarcza' : 'ZA MAŁO'}  (ograniczenie: ${w.bound})`,
      )
    }

    console.log('\nUwaga do wszystkich liczb wyżej: to szacunki z pułapu przepustowości')
    console.log('i mocy, nie pomiary. Sprawność przyjęto na 45% (pamięć) i 35% (moc).')
  },
}

const statusCommand: ModuleCli = {
  command: 'status',
  async run(rest) {
    const args = parseArgs(rest)
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const scope = await resolveScope(em, args)

    const rows = await em.getConnection().execute<Array<{
      code: string
      kind: string
      memory_gb: number
      memory_bandwidth_gbs: number
      roles: string[]
      placements: string
    }>>(
      `select n.code, n.kind, n.memory_gb, n.memory_bandwidth_gbs, n.roles,
              (select count(*) from compute_placements p where p.node_id = n.id) as placements
         from compute_nodes n where n.tenant_id = ? and n.deleted_at is null order by n.code`,
      [scope.tenantId],
    )
    if (!rows.length) {
      console.log('Brak zarejestrowanych węzłów.')
      return
    }
    for (const r of rows) {
      console.log(
        `  ${r.code.padEnd(16)}${r.kind.padEnd(12)}${String(r.memory_gb + ' GB').padEnd(8)}` +
          `${String(r.memory_bandwidth_gbs + ' GB/s').padEnd(10)}przypisań: ${String(r.placements).padEnd(4)}${r.roles.join(', ')}`,
      )
    }
  },
}

export default [registerCommand, planCommand, statusCommand] satisfies ModuleCli[]
