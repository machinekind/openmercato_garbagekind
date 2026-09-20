import { buildVersionCommand, completeRunCommand, registerRunCommand } from '../commands/datasets'
import { contentDigest } from '../lib/lineage'

/**
 * Testy wiązania komend zbiorów.
 *
 * Sprawdzamy trzy rzeczy, których czyste funkcje nie widzą: że wersja zbioru
 * powstaje **z księgi**, a nie z listy podanej przez wołającego; że ten sam
 * zestaw epizodów nie rodzi drugiej wersji; i że przebiegu udanego nie da się
 * zamknąć bez wskazania polityki - bo to jest dziura w pętli.
 */

type Row = Record<string, unknown>

const scope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
}
const DATASET_ID = '33333333-3333-4333-8333-333333333333'
const VERSION_ID = '44444444-4444-4444-8444-444444444444'
const POLICY_VERSION_ID = '55555555-5555-4555-8555-555555555555'

const EPISODES = [
  { id: 'ep-1', outcome: 'success', intervention_count: 0, policy_version_id: 'pv', cell_class: 'f' },
  { id: 'ep-2', outcome: 'success', intervention_count: 1, policy_version_id: 'pv', cell_class: 'f' },
  { id: 'ep-3', outcome: 'failure', intervention_count: 0, policy_version_id: 'pv', cell_class: 'f' },
]

function makeCtx(options: {
  dataset?: Row | null
  episodes?: Row[]
  duplicate?: Row | null
  maxVersion?: number | null
  run?: Row | null
  policyExists?: boolean
  datasetVersion?: Row | null
  existingRun?: Row | null
} = {}) {
  const persisted: Row[] = []
  const queries: string[] = []

  const em = {
    fork: () => em,
    findOne: jest.fn(async (entity: unknown) => {
      const name = (entity as { name?: string })?.name ?? String(entity)
      if (name === 'Dataset') {
        return options.dataset === undefined
          ? { id: DATASET_ID, taskKey: 'bin-picking', embodimentKey: 'ur10e-pick' }
          : options.dataset
      }
      if (name === 'DatasetVersion') {
        if (options.datasetVersion !== undefined) return options.datasetVersion
        return options.duplicate ?? null
      }
      if (name === 'TrainingRun') {
        if (options.run !== undefined) return options.run
        return options.existingRun ?? null
      }
      return null
    }),
    getConnection: () => ({
      execute: jest.fn(async (query: string) => {
        queries.push(query)
        if (query.includes('episodes_episodes')) return options.episodes ?? EPISODES
        if (query.includes('max(version)')) {
          return [{ max: options.maxVersion === undefined ? 2 : options.maxVersion }]
        }
        if (query.includes('policy_registry_policy_versions')) {
          return options.policyExists === false ? [] : [{ id: POLICY_VERSION_ID }]
        }
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
    queries,
    ctx: { container: { resolve: () => em }, auth: { sub: 'user-1' } } as never,
  }
}

const buildInput = {
  ...scope,
  datasetId: DATASET_ID,
  criteria: { holdoutRatio: 0 as number },
}

describe('datasets.versions.build', () => {
  it('buduje wersję z księgi epizodów, nie z listy wołającego', async () => {
    const { ctx, queries } = makeCtx()
    await buildVersionCommand.execute(buildInput, ctx)
    // Skład zbioru jest funkcją księgi - dzięki temu da się go odtworzyć.
    expect(queries.some((q) => q.includes('episodes_episodes'))).toBe(true)
  })

  it('ogranicza epizody do rodziny embodimentu zadeklarowanej przy zbiorze', async () => {
    // To nie jest preferencja wołającego, tylko warunek sensowności zbioru:
    // dane z jednego sprzętu nie są danymi dla innego.
    const { ctx, queries } = makeCtx()
    await buildVersionCommand.execute(buildInput, ctx)
    expect(queries.find((q) => q.includes('episodes_episodes'))).toContain('fleet_embodiment_revisions')
  })

  it('przypisuje role zgodnie z regułą: interwencja wygrywa z wynikiem', async () => {
    const { ctx, persisted } = makeCtx()
    await buildVersionCommand.execute(buildInput, ctx)
    const members = persisted.filter((r) => r.__table === 'DatasetMember')
    const roleOf = (id: string) => members.find((m) => m.episodeId === id)!.role
    expect(roleOf('ep-1')).toBe('demo')
    expect(roleOf('ep-2')).toBe('correction')
    expect(roleOf('ep-3')).toBe('failure')
  })

  it('liczy odcisk zawartości tak samo jak czysta funkcja', async () => {
    const { ctx } = makeCtx()
    const result = await buildVersionCommand.execute(buildInput, ctx)
    expect(result.contentDigest).toBe(
      contentDigest([
        { episodeId: 'ep-1', role: 'demo' },
        { episodeId: 'ep-2', role: 'correction' },
        { episodeId: 'ep-3', role: 'failure' },
      ]),
    )
  })

  it('ten sam zestaw epizodów nie rodzi drugiej wersji', async () => {
    const { ctx, persisted } = makeCtx({ duplicate: { id: VERSION_ID, version: 3, episodeCount: 3 } })
    const result = await buildVersionCommand.execute(buildInput, ctx)
    expect(result).toMatchObject({ datasetVersionId: VERSION_ID, version: 3, deduplicated: true })
    expect(persisted).toHaveLength(0)
  })

  it('nadaje numer kolejny jako max+1', async () => {
    const { ctx } = makeCtx({ maxVersion: 2 })
    expect((await buildVersionCommand.execute(buildInput, ctx)).version).toBe(3)
  })

  it('podział na część ewaluacyjną jest deterministyczny', async () => {
    // Losowanie dałoby przy każdym budowaniu inny podział i dwa przebiegi
    // z tych samych kryteriów byłyby dwiema wersjami - co unieważnia
    // deduplikację po odcisku zawartości.
    const first = await buildVersionCommand.execute(
      { ...buildInput, criteria: { holdoutRatio: 0.5 } },
      makeCtx().ctx,
    )
    const second = await buildVersionCommand.execute(
      { ...buildInput, criteria: { holdoutRatio: 0.5 } },
      makeCtx().ctx,
    )
    expect(first.contentDigest).toBe(second.contentDigest)
  })

  it('zapisuje ostrzeżenia o składzie zamiast odmawiać', async () => {
    // Zbiór o niewłaściwym składzie bywa dokładnie tym, czego ktoś potrzebuje;
    // odmowa zmuszałaby do obchodzenia systemu.
    const { ctx, persisted } = makeCtx()
    const result = await buildVersionCommand.execute(buildInput, ctx)
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(persisted.find((r) => r.__table === 'DatasetVersion')!.warnings).not.toBeNull()
  })

  it('odmawia, gdy kryteria nie wybrały ani jednego epizodu', async () => {
    const { ctx } = makeCtx({ episodes: [] })
    await expect(buildVersionCommand.execute(buildInput, ctx)).rejects.toThrow(/ani jednego epizodu/)
  })

  it('odmawia dla nieistniejącego zbioru', async () => {
    const { ctx } = makeCtx({ dataset: null })
    await expect(buildVersionCommand.execute(buildInput, ctx)).rejects.toThrow(/nie istnieje/)
  })

  it('zapisuje kryteria, żeby wersję dało się odtworzyć', async () => {
    const { ctx, persisted } = makeCtx()
    await buildVersionCommand.execute(buildInput, ctx)
    expect(persisted.find((r) => r.__table === 'DatasetVersion')!.criteria).toBeTruthy()
  })
})

describe('datasets.runs.register', () => {
  const runInput = { ...scope, datasetVersionId: VERSION_ID, runRef: 'train-1' }

  it('rejestruje przebieg dla istniejącej wersji zbioru', async () => {
    const { ctx, persisted } = makeCtx({ datasetVersion: { id: VERSION_ID }, existingRun: null })
    const result = await registerRunCommand.execute(runInput, ctx)
    expect(result.duplicate).toBe(false)
    expect(persisted.map((r) => r.__table)).toContain('TrainingRun')
  })

  it('powtórny identyfikator przebiegu zwraca istniejący wpis', async () => {
    const { ctx, persisted } = makeCtx({ datasetVersion: { id: VERSION_ID }, run: { id: 'run-1' } })
    const result = await registerRunCommand.execute(runInput, ctx)
    expect(result).toMatchObject({ trainingRunId: 'run-1', duplicate: true })
    expect(persisted).toHaveLength(0)
  })

  it('odmawia dla nieistniejącej wersji zbioru', async () => {
    const { ctx } = makeCtx({ datasetVersion: null })
    await expect(registerRunCommand.execute(runInput, ctx)).rejects.toThrow(/nie istnieje/)
  })
})

describe('datasets.runs.complete', () => {
  it('zamyka przebieg i wiąże zbiór z wersją polityki', async () => {
    const target: Row = { id: 'run-1', status: 'running' }
    const { ctx } = makeCtx({ run: target })
    const result = await completeRunCommand.execute(
      { ...scope, runRef: 'train-1', status: 'succeeded', policyVersionId: POLICY_VERSION_ID },
      ctx,
    )
    expect(result.policyVersionId).toBe(POLICY_VERSION_ID)
    expect(target.status).toBe('succeeded')
    expect(target.finishedAt).toBeInstanceOf(Date)
  })

  it('ODMAWIA zamknięcia przebiegu udanego bez wskazania polityki', async () => {
    // To jest dziura w pętli: zbiór byłby źródłem czegoś, czego nie da się
    // wskazać, a po regresie nie byłoby wiadomo, na czym uczyła się polityka.
    const { ctx } = makeCtx({ run: { id: 'run-1', status: 'running' } })
    await expect(
      completeRunCommand.execute({ ...scope, runRef: 'train-1', status: 'succeeded' }, ctx),
    ).rejects.toThrow(/musi wskazać wersję polityki/)
  })

  it('przebieg nieudany może zostać zamknięty bez polityki', async () => {
    // Nieudany trening też jest informacją o zbiorze.
    const { ctx } = makeCtx({ run: { id: 'run-1', status: 'running' } })
    const result = await completeRunCommand.execute(
      { ...scope, runRef: 'train-1', status: 'failed' },
      ctx,
    )
    expect(result.status).toBe('failed')
    expect(result.policyVersionId).toBeNull()
  })

  it('odmawia wskazania nieistniejącej wersji polityki', async () => {
    const { ctx } = makeCtx({ run: { id: 'run-1', status: 'running' }, policyExists: false })
    await expect(
      completeRunCommand.execute(
        { ...scope, runRef: 'train-1', status: 'succeeded', policyVersionId: POLICY_VERSION_ID },
        ctx,
      ),
    ).rejects.toThrow(/nie istnieje/)
  })

  it('odmawia powtórnego zamknięcia', async () => {
    const { ctx } = makeCtx({ run: { id: 'run-1', status: 'succeeded' } })
    await expect(
      completeRunCommand.execute(
        { ...scope, runRef: 'train-1', status: 'failed' },
        ctx,
      ),
    ).rejects.toThrow(/już w stanie/)
  })
})
