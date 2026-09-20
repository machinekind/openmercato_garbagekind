import { setGlobalEventBus } from '@open-mercato/shared/modules/events'
import { completeRunCommand } from '../commands/datasets'

/**
 * Testy emisji zdarzeń pętli uczenia.
 *
 * Domknięcie przebiegu jest jedynym miejscem, w którym powstaje wiązanie
 * wersja zbioru ↔ wersja polityki, więc ładunek musi nieść oba identyfikatory.
 * Bez nich zdarzenie mówiłoby „coś się skończyło" i nie dałoby się z niego
 * odtworzyć, co z czego powstało - a to jest cały sens tego modułu.
 */

type Row = Record<string, unknown>

const scope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
}
const VERSION_ID = '33333333-3333-4333-8333-333333333333'
const DATASET_VERSION_ID = '44444444-4444-4444-8444-444444444444'

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

function makeCtx(run: Row | null, policyExists = true) {
  const em = {
    fork: () => em,
    findOne: jest.fn(async () => run),
    find: jest.fn(async () => []),
    getConnection: () => ({
      execute: jest.fn(async () => (policyExists ? [{ id: VERSION_ID }] : [])),
    }),
    create: jest.fn((_entity: unknown, data: Row) => ({ id: 'new-1', ...data })),
    persist: jest.fn(),
    flush: jest.fn(async () => {}),
  }
  return { container: { resolve: () => em }, auth: { sub: 'user-1' } } as never
}

describe('emisja zdarzeń pętli uczenia', () => {
  it('domknięcie udanego przebiegu niesie obie strony wiązania', async () => {
    const seen = captureEvents()
    await completeRunCommand.execute(
      { ...scope, runRef: 'run-7', status: 'succeeded', policyVersionId: VERSION_ID },
      makeCtx({
        id: 'training-1',
        status: 'running',
        datasetVersionId: DATASET_VERSION_ID,
        policyVersionId: null,
      }),
    )
    expect(seen.map((e) => e.id)).toEqual(['datasets.run.completed'])
    expect(seen[0].payload).toMatchObject({
      status: 'succeeded',
      datasetVersionId: DATASET_VERSION_ID,
      policyVersionId: VERSION_ID,
    })
  })

  it('przebieg nieudany też jest ogłaszany - z pustą stroną polityki', async () => {
    // Milczenie przy porażce dawałoby obraz, w którym trenowanie zawsze się udaje.
    const seen = captureEvents()
    await completeRunCommand.execute(
      { ...scope, runRef: 'run-8', status: 'failed' },
      makeCtx({
        id: 'training-2',
        status: 'running',
        datasetVersionId: DATASET_VERSION_ID,
        policyVersionId: null,
      }),
    )
    expect(seen[0].payload).toMatchObject({ status: 'failed', policyVersionId: null })
  })

  it('odmowa domknięcia nie emituje niczego', async () => {
    // Przebieg udany bez wskazanej wersji polityki jest dziurą w pętli -
    // komenda odmawia, a nieudana próba nie zmieniła stanu świata.
    const seen = captureEvents()
    await expect(
      completeRunCommand.execute(
        { ...scope, runRef: 'run-9', status: 'succeeded' },
        makeCtx({
          id: 'training-3',
          status: 'running',
          datasetVersionId: DATASET_VERSION_ID,
          policyVersionId: null,
        }),
      ),
    ).rejects.toThrow(/musi wskazać wersję polityki/)
    expect(seen).toEqual([])
  })
})
