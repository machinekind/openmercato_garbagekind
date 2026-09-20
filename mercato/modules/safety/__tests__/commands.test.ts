import { approveCaseCommand, draftCaseCommand, recordRunCommand, reportIncidentCommand } from '../commands/safety'

/**
 * Testy wiązania komend warstwy bezpieczeństwa.
 *
 * Reguła dopuszczenia ma własny test jako czysta funkcja. Tutaj sprawdzamy to,
 * czego ona nie widzi: że zatwierdzenie odmawia uzasadnieniu deklarującemu
 * politykę jako funkcję bezpieczeństwa, że nie da się zatwierdzić dokumentu
 * bez wskazania warstwy deterministycznej, i że incydent wstrzymujący
 * wycofuje uzasadnienie dla **klasy** celi.
 */

type Row = Record<string, unknown>

const scope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
}
const VERSION_ID = '33333333-3333-4333-8333-333333333333'
const CASE_ID = '44444444-4444-4444-8444-444444444444'
const ROBOT_ID = '55555555-5555-4555-8555-555555555555'
const CELL_ID = '66666666-6666-4666-8666-666666666666'

function makeCtx(options: { existingCase?: Row | null; suite?: Row | null; cellClass?: string | null } = {}) {
  const persisted: Row[] = []
  const updates: Array<{ sql: string; params: unknown[] }> = []

  const em = {
    fork: () => em,
    findOne: jest.fn(async (entity: unknown) => {
      const name = (entity as { name?: string })?.name ?? String(entity)
      if (name.includes('SafetyCase')) return options.existingCase ?? null
      if (name.includes('EvalSuite')) return options.suite === undefined ? { id: 'suite-1' } : options.suite
      return null
    }),
    getConnection: () => ({
      execute: jest.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.trim().startsWith('update')) {
          updates.push({ sql, params })
          return []
        }
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
    persist: jest.fn((row: Row) => {
      persisted.push(row)
    }),
    flush: jest.fn(async () => {
      for (const row of persisted) if (!row.id) row.id = `id-${persisted.indexOf(row) + 1}`
    }),
  }

  return {
    persisted,
    updates,
    ctx: { container: { resolve: () => em }, auth: { sub: 'user-1' } } as never,
  }
}

const draftInput = {
  ...scope,
  policyVersionId: VERSION_ID,
  cellClass: 'fenced-pick-place',
  riskClass: 'fenced' as const,
  safetyLayer: 'Kurtyna świetlna kat. 3 PL d.',
  safetyLayerKind: 'light_curtain' as const,
}

describe('safety.cases.draft', () => {
  it('zakłada uzasadnienie w wersji roboczej', async () => {
    const { ctx, persisted } = makeCtx()
    const result = await draftCaseCommand.execute(draftInput, ctx)
    expect(result.safetyCaseId).toBeTruthy()
    const row = persisted.find((r) => r.__table === 'SafetyCase')!
    expect(row.status).toBe('draft')
    expect(row.declaredAsSafetyFunction).toBe(false)
  })

  it('domyślnie NIE deklaruje polityki jako funkcji bezpieczeństwa', async () => {
    const { ctx, persisted } = makeCtx()
    await draftCaseCommand.execute(draftInput, ctx)
    expect(persisted.find((r) => r.__table === 'SafetyCase')!.declaredAsSafetyFunction).toBe(false)
  })

  it('odmawia drugiego uzasadnienia dla tej samej pary wersja/klasa', async () => {
    const { ctx } = makeCtx({ existingCase: { id: CASE_ID } })
    await expect(draftCaseCommand.execute(draftInput, ctx)).rejects.toThrow(/już istnieje/)
  })
})

describe('safety.cases.approve', () => {
  const rok = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
  const approveInput = { ...scope, safetyCaseId: CASE_ID, approvedBy: scope.organizationId, validUntil: rok }

  it('zatwierdza uzasadnienie robocze z warstwą bezpieczeństwa', async () => {
    const target: Row = {
      id: CASE_ID,
      status: 'draft',
      safetyLayer: 'Kurtyna świetlna kat. 3 PL d.',
      safetyLayerKind: 'light_curtain',
      declaredAsSafetyFunction: false,
    }
    const { ctx } = makeCtx({ existingCase: target })
    const result = await approveCaseCommand.execute(approveInput, ctx)
    expect(result.safetyCaseId).toBe(CASE_ID)
    expect(target.status).toBe('approved')
    // `toEqual`, nie `toBe`: zod `z.coerce.date()` tworzy nową instancję Date.
    expect(target.validUntil).toEqual(rok)
  })

  it('ODMAWIA uzasadnieniu deklarującemu politykę jako funkcję bezpieczeństwa', async () => {
    // Zatwierdzony dokument z taką deklaracją szkodzi bardziej niż jego brak:
    // w postępowaniu przed organem nadzoru jest dowodem, że wiedziano i mimo
    // to zatwierdzono.
    const { ctx } = makeCtx({
      existingCase: {
        id: CASE_ID,
        status: 'draft',
        safetyLayer: 'Polityka sama pilnuje limitów.',
        declaredAsSafetyFunction: true,
      },
    })
    await expect(approveCaseCommand.execute(approveInput, ctx)).rejects.toThrow(/Annex I część A/)
  })

  it('ODMAWIA ZATWIERDZENIA BEZ RODZAJU WARSTWY - sam opis nie wystarcza', async () => {
    /*
     * Dołożone, gdy do systemu wszedł mocny węzeł obliczeniowy. Wolny tekst
     * przyjmuje zdanie „warstwą bezpieczeństwa jest model nadzorczy na
     * akceleratorze", które brzmi poważnie i nie jest warstwą bezpieczeństwa.
     * Słownik zamknięty odbiera tę możliwość na poziomie typu.
     */
    const { ctx } = makeCtx({
      existingCase: {
        id: CASE_ID,
        status: 'draft',
        safetyLayer: 'Model nadzorczy na węźle obliczeniowym pilnuje, żeby nic się nie stało.',
        safetyLayerKind: null,
        declaredAsSafetyFunction: false,
      },
    })
    await expect(
      approveCaseCommand.execute(
        { ...scope, safetyCaseId: CASE_ID, approvedBy: scope.organizationId, validUntil: rok },
        ctx,
      ),
    ).rejects.toThrow(/safetyLayerKind/)
  })

  it('odmawia uzasadnieniu bez wskazanej warstwy deterministycznej', async () => {
    // Dokument, który nie mówi, CO zatrzyma maszynę, gdy polityka zawiedzie,
    // jest opisem nadziei.
    const { ctx } = makeCtx({
      existingCase: { id: CASE_ID, status: 'draft', safetyLayer: '   ', declaredAsSafetyFunction: false },
    })
    await expect(approveCaseCommand.execute(approveInput, ctx)).rejects.toThrow(/warstwy bezpieczeństwa/)
  })

  it('odmawia daty ważności w przeszłości', async () => {
    const { ctx } = makeCtx({
      existingCase: { id: CASE_ID, status: 'draft', safetyLayer: 'x', safetyLayerKind: 'safety_plc', declaredAsSafetyFunction: false },
    })
    await expect(
      approveCaseCommand.execute({ ...approveInput, validUntil: new Date(Date.now() - 1000) }, ctx),
    ).rejects.toThrow(/w przyszłości/)
  })

  it('odmawia zatwierdzenia uzasadnienia już zatwierdzonego', async () => {
    const { ctx } = makeCtx({
      existingCase: { id: CASE_ID, status: 'approved', safetyLayer: 'x', safetyLayerKind: 'safety_plc', declaredAsSafetyFunction: false },
    })
    await expect(approveCaseCommand.execute(approveInput, ctx)).rejects.toThrow(/wersję roboczą/)
  })
})

describe('safety.runs.record', () => {
  const runInput = {
    ...scope,
    policyVersionId: VERSION_ID,
    suiteKey: 'reach-envelope',
    result: 'pass' as const,
    ranAt: new Date('2026-09-19T10:00:00Z'),
  }

  it('zapisuje przebieg i uzupełnia odcisk kontraktu z wersji polityki', async () => {
    const { ctx, persisted } = makeCtx()
    await recordRunCommand.execute(runInput, ctx)
    const run = persisted.find((r) => r.__table === 'EvalRun')!
    expect(run.embodimentSpecDigest).toBe('demo:ur10e-pick:r1')
  })

  it('nie nadpisuje odcisku podanego przez wołającego', async () => {
    // Wołający, który testował na stanowisku, zna go lepiej - i wtedy rozjazd
    // ma wyjść, a nie zostać zamaskowany wartością z bazy.
    const { ctx, persisted } = makeCtx()
    await recordRunCommand.execute({ ...runInput, embodimentSpecDigest: 'demo:ur10e-pick:r2' }, ctx)
    expect(persisted.find((r) => r.__table === 'EvalRun')!.embodimentSpecDigest).toBe('demo:ur10e-pick:r2')
  })

  it('odmawia przebiegu dla zestawu, którego nie ma w katalogu', async () => {
    const { ctx } = makeCtx({ suite: null })
    await expect(recordRunCommand.execute(runInput, ctx)).rejects.toThrow(/nie jest zdefiniowany/)
  })
})

describe('safety.incidents.report', () => {
  const incidentInput = {
    ...scope,
    robotId: ROBOT_ID,
    cellId: CELL_ID,
    policyVersionId: VERSION_ID,
    harm: 'none' as const,
    safetyLayerEngaged: true,
    policyImplicated: true,
    description: 'Ramię przekroczyło kopertę, zadziałała kurtyna',
    occurredAt: new Date('2026-09-19T11:00:00Z'),
  }

  it('klasyfikuje incydent i zapisuje wynik klasyfikacji', async () => {
    const { ctx, persisted } = makeCtx()
    const result = await reportIncidentCommand.execute(incidentInput, ctx)
    expect(result.haltDeployment).toBe(true)
    expect(persisted.find((r) => r.__table === 'Incident')!.priority).toBe('wstrzymanie_wdrożenia')
  })

  it('incydent wstrzymujący wycofuje uzasadnienie dla KLASY celi', async () => {
    // Skoro dopuszczenie dotyczy klasy celi, to zdarzenie podważające je
    // podważa je dla wszystkich cel tej klasy.
    const { ctx, updates } = makeCtx()
    await reportIncidentCommand.execute(incidentInput, ctx)
    const withdrawal = updates.find((u) => u.sql.includes('safety_cases'))
    expect(withdrawal).toBeTruthy()
    expect(withdrawal!.params).toContain('fenced-pick-place')
  })

  it('incydent informacyjny nie rusza uzasadnień', async () => {
    const { ctx, updates } = makeCtx()
    await reportIncidentCommand.execute(
      { ...incidentInput, safetyLayerEngaged: false, policyImplicated: false },
      ctx,
    )
    expect(updates.find((u) => u.sql.includes('safety_cases'))).toBeUndefined()
  })

  it('zapisuje klasę celi zdjętą z rejestru floty, nie z wejścia', async () => {
    const { ctx, persisted } = makeCtx({ cellClass: 'shared-handover' })
    await reportIncidentCommand.execute(incidentInput, ctx)
    expect(persisted.find((r) => r.__table === 'Incident')!.cellClass).toBe('shared-handover')
  })

  it('incydent bez celi nie wywraca się na braku klasy', async () => {
    const { ctx, persisted } = makeCtx({ cellClass: null })
    const result = await reportIncidentCommand.execute({ ...incidentInput, cellId: null }, ctx)
    expect(result.incidentId).toBeTruthy()
    expect(persisted.find((r) => r.__table === 'Incident')!.cellClass).toBeNull()
  })
})
