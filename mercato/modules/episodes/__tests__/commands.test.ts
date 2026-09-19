import { recordEpisodeCommand, recordInterventionCommand } from '../commands/episodes'

/**
 * Testy wiązania komend księgi epizodów.
 *
 * Sprawdzamy dwie rzeczy, których czysta funkcja kadencji nie sprawdzi:
 * idempotencję dosyłanych epizodów i to, że interwencja **dopisuje się**
 * do epizodu, zamiast go przepisywać.
 */

type Row = Record<string, unknown>

const scope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
}
const ROBOT_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_ROBOT = '99999999-9999-4999-8999-999999999999'
const EPISODE_ID = '44444444-4444-4444-8444-444444444444'
const CELL_ID = '55555555-5555-4555-8555-555555555555'
const VERSION_ID = '66666666-6666-4666-8666-666666666666'

function makeCtx(options: { existing?: Row | null; episode?: Row | null; maxSequence?: number | null } = {}) {
  const persisted: Row[] = []

  const em = {
    fork: () => em,
    findOne: jest.fn(async (entity: unknown, where: Row) => {
      const name = (entity as { name?: string })?.name ?? String(entity)
      if (name.includes('Episode')) {
        if (where.externalRef !== undefined) return options.existing ?? null
        return options.episode ?? null
      }
      return null
    }),
    getConnection: () => ({
      execute: jest.fn(async (query: string) => {
        if (query.includes('max(sequence)')) {
          return [{ max: options.maxSequence === undefined ? 7 : options.maxSequence }]
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

  return { persisted, ctx: { container: { resolve: () => em }, auth: { sub: 'user-1' } } as never }
}

const episodeInput = {
  ...scope,
  robotId: ROBOT_ID,
  externalRef: 'run-42',
  taskKey: 'bin-picking',
  startedAt: new Date('2026-09-19T10:00:00Z'),
  endedAt: new Date('2026-09-19T10:00:42Z'),
  outcome: 'success' as const,
}

describe('episodes.episodes.record', () => {
  it('zapisuje epizod i liczy czas trwania z obu znaczników', async () => {
    const { ctx, persisted } = makeCtx()
    const result = await recordEpisodeCommand.execute(episodeInput, ctx)
    expect(result.duplicate).toBe(false)
    const episode = persisted.find((r) => r.__table === 'Episode')!
    expect(episode.durationMs).toBe(42_000)
    expect(episode.interventionCount).toBe(0)
  })

  it('nadaje numer kolejny w obrębie robota jako max+1', async () => {
    const { ctx } = makeCtx({ maxSequence: 7 })
    const result = await recordEpisodeCommand.execute(episodeInput, ctx)
    expect(result.sequence).toBe(8)
  })

  it('pierwszy epizod robota dostaje numer 1', async () => {
    const { ctx } = makeCtx({ maxSequence: null })
    expect((await recordEpisodeCommand.execute(episodeInput, ctx)).sequence).toBe(1)
  })

  it('dosłany epizod nie rozmnaża księgi', async () => {
    // Agent po utracie łącza wysyła zaległości ponownie. Drugi wpis
    // przesunąłby kadencję wszystkich raportów bez żadnej pracy w hali.
    const { ctx, persisted } = makeCtx({ existing: { id: EPISODE_ID, sequence: 5 } })
    const result = await recordEpisodeCommand.execute(episodeInput, ctx)
    expect(result).toMatchObject({ episodeId: EPISODE_ID, sequence: 5, duplicate: true })
    expect(persisted).toHaveLength(0)
  })

  it('odmawia epizodowi, który kończy się przed rozpoczęciem', async () => {
    const { ctx } = makeCtx()
    await expect(
      recordEpisodeCommand.execute(
        { ...episodeInput, endedAt: new Date('2026-09-19T09:00:00Z') },
        ctx,
      ),
    ).rejects.toThrow(/przed rozpoczęciem/)
  })

  it('przyjmuje epizod bez wersji polityki', async () => {
    // Praca teleoperacyjna też jest epizodem i musi ciągnąć autonomię w dół.
    const { ctx, persisted } = makeCtx()
    await recordEpisodeCommand.execute({ ...episodeInput, policyVersionId: null }, ctx)
    expect(persisted.find((r) => r.__table === 'Episode')!.policyVersionId).toBeNull()
  })
})

describe('episodes.interventions.record', () => {
  const episode: Row = {
    id: EPISODE_ID,
    robotId: ROBOT_ID,
    cellId: CELL_ID,
    policyVersionId: VERSION_ID,
    interventionCount: 0,
  }

  const interventionInput = {
    ...scope,
    robotId: ROBOT_ID,
    episodeId: EPISODE_ID,
    kind: 'teleop_takeover' as const,
    stage: 'chwyt',
    reasonCategory: 'grasp_failure',
    reason: 'Chwytak zsunął się z detalu',
    occurredAt: new Date('2026-09-19T10:00:20Z'),
  }

  it('dopisuje interwencję i podnosi licznik epizodu', async () => {
    const target = { ...episode }
    const { ctx, persisted } = makeCtx({ episode: target })
    const result = await recordInterventionCommand.execute(interventionInput, ctx)
    expect(result.interventionCount).toBe(1)
    expect(persisted.map((r) => r.__table)).toContain('Intervention')
  })

  it('nie zmienia wyniku epizodu', async () => {
    // Zamiana wyniku na „przerwany" przy każdej interwencji skasowałaby
    // różnicę między „człowiek poprawił coś w locie, zadanie się udało"
    // a „człowiek przerwał, zadanie przepadło".
    const target = { ...episode, outcome: 'success' }
    const { ctx } = makeCtx({ episode: target })
    await recordInterventionCommand.execute(interventionInput, ctx)
    expect(target.outcome).toBe('success')
  })

  it('bierze celę i wersję polityki z epizodu, nie z wejścia', async () => {
    // Interwencja dotyczy tego, co robot wtedy robił, a nie tego, co robi teraz.
    const { ctx, persisted } = makeCtx({ episode: { ...episode } })
    await recordInterventionCommand.execute(interventionInput, ctx)
    const intervention = persisted.find((r) => r.__table === 'Intervention')!
    expect(intervention.cellId).toBe(CELL_ID)
    expect(intervention.policyVersionId).toBe(VERSION_ID)
  })

  it('odmawia interwencji wskazującej epizod innego robota', async () => {
    // Taka interwencja zepsułaby kadencję obu robotów i byłaby niewykrywalna.
    const { ctx } = makeCtx({ episode: { ...episode, robotId: OTHER_ROBOT } })
    await expect(recordInterventionCommand.execute(interventionInput, ctx)).rejects.toThrow(
      /epizod innego robota/,
    )
  })

  it('odmawia, gdy wskazany epizod nie istnieje', async () => {
    const { ctx } = makeCtx({ episode: null })
    await expect(recordInterventionCommand.execute(interventionInput, ctx)).rejects.toThrow(/nie istnieje/)
  })

  it('odrzuca kategorię spoza wspólnego słownika', async () => {
    const { ctx } = makeCtx({ episode: { ...episode } })
    await expect(
      recordInterventionCommand.execute({ ...interventionInput, reasonCategory: 'chwyt' } as never, ctx),
    ).rejects.toThrow()
  })

  it('przyjmuje interwencję bez epizodu — przerwanie między epizodami', async () => {
    // Człowiek, który zatrzymał stanowisko, gdy robot nie wykonywał zadania,
    // też interweniował. Wykluczenie takich przypadków zaniżałoby licznik
    // dokładnie tam, gdzie robot stoi najczęściej.
    const { ctx, persisted } = makeCtx()
    const result = await recordInterventionCommand.execute(
      { ...interventionInput, episodeId: null },
      ctx,
    )
    expect(result.episodeId).toBeNull()
    expect(result.interventionCount).toBeNull()
    expect(persisted.map((r) => r.__table)).toContain('Intervention')
  })

  it('zapisuje sprawcę z sesji, gdy nie podano go wprost', async () => {
    const { ctx, persisted } = makeCtx({ episode: { ...episode } })
    await recordInterventionCommand.execute(interventionInput, ctx)
    expect(persisted.find((r) => r.__table === 'Intervention')!.actorUserId).toBe('user-1')
  })

  it('pusty sprawca oznacza warstwę bezpieczeństwa, a nie brak danych', async () => {
    // Zatrzymanie awaryjne wywołane przez kurtynę świetlną nie ma sprawcy
    // będącego człowiekiem — i `null` jest tu informacją, nie luką.
    const { ctx, persisted } = makeCtx({ episode: { ...episode } })
    const anonymous = {
      container: (ctx as unknown as { container: unknown }).container,
      auth: null,
    } as never
    await recordInterventionCommand.execute(
      { ...interventionInput, kind: 'estop' as const, actorUserId: null },
      anonymous,
    )
    expect(persisted.find((r) => r.__table === 'Intervention')!.actorUserId).toBeNull()
  })
})
