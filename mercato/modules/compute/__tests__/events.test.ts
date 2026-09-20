import { setGlobalEventBus } from '@open-mercato/shared/modules/events'
import { placeWorkloadCommand, registerNodeCommand } from '../commands/compute'

/**
 * Testy emisji zdarzeń ewidencji obliczeń.
 *
 * Najważniejsza jest tu nieobecność: **odmowa nadania roli bezpieczeństwa
 * nie emituje zdarzenia**. Próba, która się nie powiodła, nie zmieniła stanu
 * świata; zapisuje ją dziennik audytu szyny komend razem z aktorem i tam jest
 * jej miejsce. Zdarzenie na nieudaną próbę dałoby odbiorcy powód, by sądzić,
 * że coś się stało.
 *
 * Poza tym sprawdzamy, że przepustowość pamięci jedzie w ładunku rejestracji
 * węzła - bo to ona, a nie liczba operacji zmiennoprzecinkowych z materiałów
 * producenta, rozstrzyga o przepustowości dekodowania.
 */

const scope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
}
const NODE_ID = '33333333-3333-4333-8333-333333333333'

function captureEvents() {
  const seen: Array<{ id: string; payload: Record<string, unknown> }> = []
  setGlobalEventBus({
    emit: async (id: string, payload: unknown) => {
      seen.push({ id, payload: payload as Record<string, unknown> })
    },
  })
  return seen
}

afterEach(() => {
  setGlobalEventBus({ emit: async () => {} })
})

function makeCtx(node: Record<string, unknown> | null = null) {
  const em = {
    fork: () => em,
    findOne: jest.fn(async () => node),
    create: jest.fn((_entity: unknown, data: Record<string, unknown>) => ({ id: 'new-1', ...data })),
    persist: jest.fn(),
    flush: jest.fn(async () => {}),
  }
  return { container: { resolve: () => em }, auth: { sub: 'user-1' } } as never
}

const wezel = {
  ...scope,
  code: 'SPARK-1',
  name: 'DGX Spark',
  kind: 'workstation',
  memoryGb: 128,
  // Liczba rozstrzygająca: 273 GB/s, a nie petaflop z materiałów producenta.
  memoryBandwidthGbs: 273,
  computeTflops: 1000,
  computePrecision: 'fp4' as const,
  roles: ['training', 'evaluation'],
}

describe('emisja zdarzeń ewidencji obliczeń', () => {
  it('rejestracja węzła niesie przepustowość pamięci', async () => {
    const seen = captureEvents()
    await registerNodeCommand.execute(wezel, makeCtx())
    expect(seen.map((e) => e.id)).toEqual(['compute.node.registered'])
    expect(seen[0].payload).toMatchObject({ memoryBandwidthGbs: 273, code: 'SPARK-1' })
  })

  it('ODMOWA ROLI BEZPIECZEŃSTWA NIE EMITUJE NICZEGO', async () => {
    const seen = captureEvents()
    await expect(
      registerNodeCommand.execute({ ...wezel, roles: ['emergency_stop'] }, makeCtx()),
    ).rejects.toThrow()
    expect(seen).toEqual([])
  })

  it('przypisanie zadania do węzła bez wymaganej roli też milczy', async () => {
    const seen = captureEvents()
    await expect(
      placeWorkloadCommand.execute(
        {
          ...scope,
          nodeId: NODE_ID,
          workloadType: 'training_run',
          workloadRef: '44444444-4444-4444-8444-444444444444',
          requiredRole: 'vision_inference',
        },
        makeCtx({ id: NODE_ID, organizationId: scope.organizationId, roles: ['training'], status: 'active' }),
      ),
    ).rejects.toThrow(/nie ma roli/)
    expect(seen).toEqual([])
  })

  it('poprawne przypisanie ogłasza fakt z wymaganą rolą', async () => {
    const seen = captureEvents()
    await placeWorkloadCommand.execute(
      {
        ...scope,
        nodeId: NODE_ID,
        workloadType: 'training_run',
        workloadRef: '44444444-4444-4444-8444-444444444444',
        requiredRole: 'training',
      },
      makeCtx({ id: NODE_ID, organizationId: scope.organizationId, roles: ['training'], status: 'active' }),
    )
    expect(seen.map((e) => e.id)).toEqual(['compute.placement.set'])
    expect(seen[0].payload).toMatchObject({ requiredRole: 'training' })
  })
})
