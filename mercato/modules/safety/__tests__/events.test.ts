import { setGlobalEventBus } from '@open-mercato/shared/modules/events'
import { approveCaseCommand, recordRunCommand, reportIncidentCommand } from '../commands/safety'

/**
 * Testy emisji zdarzeń warstwy bezpieczeństwa.
 *
 * Dwie reguły, które łatwo zepsuć w dobrej wierze:
 *
 * 1. `error` w przebiegu ewaluacyjnym idzie razem z `fail` do zdarzenia
 *    „nie wykazał zgodności". Rozdzielenie ich zachęca do traktowania awarii
 *    potoku jako „jeszcze nie porażki" — a to jest nawyk, który kończy się
 *    polityką dopuszczoną bez dowodu.
 * 2. Zdarzenie o wycofaniu dopuszczenia pada pod tym samym warunkiem, co samo
 *    wycofanie — nie pod samą flagą `haltDeployment`. Incydent bez wskazanej
 *    wersji polityki niczego nie wycofał i ogłaszanie, że wycofał, byłoby
 *    nieprawdą zapisaną w szynie zdarzeń.
 */

type Row = Record<string, unknown>

const scope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
}
const VERSION_ID = '33333333-3333-4333-8333-333333333333'
const CASE_ID = '44444444-4444-4444-8444-444444444444'
const CELL_ID = '66666666-6666-4666-8666-666666666666'

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

function makeCtx(options: { existingCase?: Row | null; cellClass?: string | null } = {}) {
  const persisted: Row[] = []
  const em = {
    fork: () => em,
    findOne: jest.fn(async (entity: unknown) => {
      const name = (entity as { name?: string })?.name ?? String(entity)
      if (name.includes('SafetyCase')) return options.existingCase ?? null
      if (name.includes('EvalSuite')) return { id: 'suite-1' }
      return null
    }),
    getConnection: () => ({
      execute: jest.fn(async (sql: string) => {
        if (sql.trim().startsWith('update')) return []
        if (sql.includes('fleet_cells')) {
          return options.cellClass === undefined
            ? [{ cell_class: 'fenced-pick-place' }]
            : options.cellClass
              ? [{ cell_class: options.cellClass }]
              : []
        }
        if (sql.includes('embodiment_spec_digest')) return [{ embodiment_spec_digest: 'demo:ur10e-pick:r1' }]
        return []
      }),
    }),
    create: jest.fn((entity: unknown, data: Row) => ({
      __table: (entity as { name?: string })?.name,
      ...data,
    })),
    persist: jest.fn((row: Row) => persisted.push(row)),
    flush: jest.fn(async () => {
      for (const row of persisted) if (!row.id) row.id = `id-${persisted.indexOf(row) + 1}`
    }),
  }
  return { container: { resolve: () => em }, auth: { sub: 'user-1' } } as never
}

const przebieg = {
  ...scope,
  policyVersionId: VERSION_ID,
  suiteKey: 'collision-avoidance',
  ranAt: new Date('2026-09-18T10:00:00Z'),
}

describe('emisja zdarzeń warstwy bezpieczeństwa', () => {
  it('przebieg zdany ogłasza tylko zapis, bez zdarzenia o braku zgodności', async () => {
    const seen = captureEvents()
    await recordRunCommand.execute({ ...przebieg, result: 'pass' }, makeCtx())
    expect(seen.map((e) => e.id)).toEqual(['safety.run.recorded'])
  })

  it('przebieg oblany ogłasza brak zgodności', async () => {
    const seen = captureEvents()
    await recordRunCommand.execute({ ...przebieg, result: 'fail' }, makeCtx())
    expect(seen.map((e) => e.id)).toEqual(['safety.run.recorded', 'safety.run.failed'])
  })

  it('AWARIA POTOKU JEST TRAKTOWANA JAK PORAŻKA — dowodu nie ma tak samo', async () => {
    const seen = captureEvents()
    await recordRunCommand.execute({ ...przebieg, result: 'error' }, makeCtx())
    expect(seen.map((e) => e.id)).toEqual(['safety.run.recorded', 'safety.run.failed'])
    expect(seen[1].payload).toMatchObject({ result: 'error' })
  })

  it('zatwierdzenie uzasadnienia niesie rodzaj warstwy deterministycznej', async () => {
    // Bez tego pola odbiorca nie odróżnia dopuszczenia od dokumentu
    // opisującego nadzieję — a to jest cała różnica.
    const seen = captureEvents()
    await approveCaseCommand.execute(
      {
        ...scope,
        safetyCaseId: CASE_ID,
        approvedBy: '77777777-7777-4777-8777-777777777777',
        validUntil: new Date(Date.now() + 86_400_000),
      },
      makeCtx({
        existingCase: {
          id: CASE_ID,
          status: 'draft',
          safetyLayer: 'kurtyna świetlna kategorii 3',
          safetyLayerKind: 'light_curtain',
          declaredAsSafetyFunction: false,
        },
      }),
    )
    expect(seen.map((e) => e.id)).toEqual(['safety.case.approved'])
    expect(seen[0].payload).toMatchObject({ safetyLayerKind: 'light_curtain' })
  })

  it('incydent wstrzymujący ogłasza zgłoszenie i wycofanie dopuszczenia', async () => {
    const seen = captureEvents()
    await reportIncidentCommand.execute(
      {
        ...scope,
        cellId: CELL_ID,
        policyVersionId: VERSION_ID,
        harm: 'lost_time',
        description: 'przygniecenie dłoni operatora',
        occurredAt: new Date('2026-09-18T11:00:00Z'),
      },
      makeCtx(),
    )
    expect(seen.map((e) => e.id)).toEqual([
      'safety.incident.reported',
      'safety.incident.halted_deployment',
    ])
    expect(seen[1].payload).toMatchObject({ cellClass: 'fenced-pick-place', policyVersionId: VERSION_ID })
  })

  it('incydent bez wskazanej wersji polityki niczego nie wycofał — i tak to ogłasza', async () => {
    const seen = captureEvents()
    const result = await reportIncidentCommand.execute(
      {
        ...scope,
        cellId: CELL_ID,
        harm: 'lost_time',
        description: 'potknięcie o przewód',
        occurredAt: new Date('2026-09-18T11:00:00Z'),
      },
      makeCtx(),
    )
    // Werdykt nadal każe wstrzymać, ale nie ma czego wycofać — i zdarzenie
    // o wycofaniu nie może paść, bo byłoby nieprawdą.
    expect(result.haltDeployment).toBe(true)
    expect(seen.map((e) => e.id)).toEqual(['safety.incident.reported'])
  })
})
