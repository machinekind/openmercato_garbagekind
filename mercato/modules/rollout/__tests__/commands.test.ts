import { evaluateGateCommand, planCommand, startStageCommand } from '../commands/rollouts'

/**
 * Testy wiązania komend wdrożenia.
 *
 * Reguła bramy ma własny test jako czysta funkcja. Tutaj sprawdzamy trzy
 * rzeczy, których ona nie sprawdzi: czy wycofanie naprawdę idzie **komendą
 * stanu pożądanego**, czy zatrzymywane są wszystkie etapy następne, i czy
 * etapowości nie da się obejść ręcznym startem.
 */

type Row = Record<string, unknown>

const scope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
}
const VERSION_ID = '33333333-3333-4333-8333-333333333333'
const PREVIOUS_VERSION_ID = '88888888-8888-4888-8888-888888888888'
const STAGE_ID = '44444444-4444-4444-8444-444444444444'
const ROLLOUT_ID = '55555555-5555-4555-8555-555555555555'
const ROBOT_A = '66666666-6666-4666-8666-666666666666'
const ROBOT_B = '77777777-7777-4777-8777-777777777777'

type Options = {
  stage?: Row | null
  previousStages?: Row[]
  members?: Row[]
  allStages?: Row[]
  stats?: Row
  currentAssignment?: Row[]
  assignThrows?: string
}

function makeCtx(options: Options = {}) {
  const persisted: Row[] = []
  const commands: Array<{ id: string; input: Row }> = []
  const updates: string[] = []

  const em = {
    fork: () => em,
    findOne: jest.fn(async () => null),
    getConnection: () => ({
      execute: jest.fn(async (query: string) => {
        if (query.startsWith('update')) {
          updates.push(query)
          return []
        }
        if (query.includes('policy_registry_policy_versions') && query.includes('select id, status')) {
          return [{ id: VERSION_ID, status: 'released' }]
        }
        if (query.includes('from rollout_stages s') && query.includes('join rollout_rollouts')) {
          return options.stage === undefined
            ? [
                {
                  id: STAGE_ID,
                  rollout_id: ROLLOUT_ID,
                  ordinal: 1,
                  status: 'running',
                  min_episodes: 10,
                  max_intervention_rate: '0.1',
                  max_severe_rate: '0.02',
                  min_success_rate: '0.8',
                  policy_version_id: VERSION_ID,
                  rollout_status: 'running',
                  mode: 'active',
                },
              ]
            : options.stage
              ? [options.stage]
              : []
        }
        if (query.includes('where rollout_id = ? and ordinal <')) return options.previousStages ?? []
        if (query.includes('select id, ordinal, status from rollout_stages')) return options.allStages ?? []
        // Kolejność ma znaczenie: zapytanie bramy też zawiera
        // `rollout_stage_members` (w podzapytaniu populacji), więc musi być
        // rozpoznane wcześniej. Odwrotna kolejność dawała bramie listę
        // składu etapu zamiast statystyk i każdy werdykt wychodził `hold`.
        if (query.includes('with populacja')) {
          return [options.stats ?? { episodes: '100', intervened: '2', severe: '0', successes: '95' }]
        }
        if (query.includes('rollout_stage_members')) return options.members ?? []
        if (query.includes('deployment_assignments')) return options.currentAssignment ?? []
        if (query.includes('count(*) as n from rollout_stages')) return [{ n: '1' }]
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

  const commandBus = {
    execute: jest.fn(async (id: string, payload: { input: Row }) => {
      commands.push({ id, input: payload.input })
      if (options.assignThrows && id === 'deployment.assignments.assign') {
        throw new Error(options.assignThrows)
      }
      return { result: {} }
    }),
  }

  return {
    persisted,
    commands,
    updates,
    ctx: {
      container: { resolve: (key: string) => (key === 'commandBus' ? commandBus : em) },
      auth: { sub: 'user-1' },
    } as never,
  }
}

describe('rollout.rollouts.plan', () => {
  const input = {
    ...scope,
    name: 'Wdrożenie v2',
    policyVersionId: VERSION_ID,
    stages: [
      { name: 'Etap 1', robotIds: [ROBOT_A] },
      { name: 'Etap 2', robotIds: [ROBOT_B] },
    ],
  }

  it('zakłada wdrożenie z etapami i składem', async () => {
    const { ctx, persisted } = makeCtx()
    const result = await planCommand.execute(input, ctx)
    expect(result.stageIds).toHaveLength(2)
    expect(persisted.filter((r) => r.__table === 'RolloutStage')).toHaveLength(2)
    expect(persisted.filter((r) => r.__table === 'StageMember')).toHaveLength(2)
  })

  it('odmawia, gdy ten sam robot jest w dwóch etapach', async () => {
    // Robot w etapie 1 i 3 sprawiłby, że wycofanie etapu 1 zdejmuje politykę
    // maszynie zbierającej dane dla etapu 3.
    const { ctx } = makeCtx()
    await expect(
      planCommand.execute(
        { ...input, stages: [{ name: 'A', robotIds: [ROBOT_A] }, { name: 'B', robotIds: [ROBOT_A] }] },
        ctx,
      ),
    ).rejects.toThrow(/w więcej niż jednym etapie/)
  })

  it('zapisuje poprzednią wersję polityki już przy planowaniu', async () => {
    // Nie w chwili wycofania: wycofanie dzieje się, gdy coś się pali,
    // i nie może zależeć od zapytania, które akurat wtedy zwróci co innego.
    const { ctx, persisted } = makeCtx({ currentAssignment: [{ policy_version_id: PREVIOUS_VERSION_ID }] })
    await planCommand.execute(input, ctx)
    const member = persisted.find((r) => r.__table === 'StageMember')!
    expect(member.previousPolicyVersionId).toBe(PREVIOUS_VERSION_ID)
  })

  it('robot bez wcześniejszej polityki dostaje null, a nie wymyśloną wersję', async () => {
    const { ctx, persisted } = makeCtx({ currentAssignment: [] })
    await planCommand.execute(input, ctx)
    expect(persisted.find((r) => r.__table === 'StageMember')!.previousPolicyVersionId).toBeNull()
  })

  it('nadaje etapom kolejne numery porządkowe', async () => {
    const { ctx, persisted } = makeCtx()
    await planCommand.execute(input, ctx)
    expect(persisted.filter((r) => r.__table === 'RolloutStage').map((r) => r.ordinal)).toEqual([1, 2])
  })
})

describe('rollout.stages.start', () => {
  const pendingStage = {
    id: STAGE_ID,
    rollout_id: ROLLOUT_ID,
    ordinal: 2,
    status: 'pending',
    min_episodes: 10,
    max_intervention_rate: '0.1',
    max_severe_rate: '0.02',
    min_success_rate: '0.8',
    policy_version_id: VERSION_ID,
    rollout_status: 'running',
    mode: 'active',
  }

  it('przypisuje politykę całej populacji etapu komendą stanu pożądanego', async () => {
    const { ctx, commands } = makeCtx({
      stage: { ...pendingStage, ordinal: 1 },
      members: [
        { id: 'm1', robot_id: ROBOT_A },
        { id: 'm2', robot_id: ROBOT_B },
      ],
    })
    const result = await startStageCommand.execute({ ...scope, stageId: STAGE_ID }, ctx)
    expect(result.applied).toBe(2)
    expect(commands.filter((c) => c.id === 'deployment.assignments.assign')).toHaveLength(2)
  })

  it('nie da się uruchomić etapu 2, gdy etap 1 nie przeszedł', async () => {
    // To jest druga połowa zdania „przekroczenie progu zatrzymuje etap 2".
    const { ctx } = makeCtx({
      stage: pendingStage,
      previousStages: [{ ordinal: 1, status: 'rolled_back', name: 'Etap 1' }],
    })
    await expect(startStageCommand.execute({ ...scope, stageId: STAGE_ID }, ctx)).rejects.toThrow(
      /etapowość nie jest opcjonalna/,
    )
  })

  it('nie da się uruchomić etapu we wdrożeniu wycofanym', async () => {
    const { ctx } = makeCtx({ stage: { ...pendingStage, rollout_status: 'rolled_back' } })
    await expect(startStageCommand.execute({ ...scope, stageId: STAGE_ID }, ctx)).rejects.toThrow(
      /nie da się uruchomić/,
    )
  })

  it('robot, którego nie da się objąć etapem, nie zatrzymuje etapu, ale trafia do wyniku', async () => {
    // Maszyna w serwisie to normalny stan floty; wdrożenie wywracające się
    // na pierwszym takim robocie nie ruszy nigdy.
    const { ctx } = makeCtx({
      stage: { ...pendingStage, ordinal: 1 },
      members: [{ id: 'm1', robot_id: ROBOT_A }],
      assignThrows: 'Robot UR10E-0003 jest w stanie maintenance',
    })
    const result = await startStageCommand.execute({ ...scope, stageId: STAGE_ID }, ctx)
    expect(result.applied).toBe(0)
    expect(result.skipped[0].reason).toContain('maintenance')
  })
})

describe('rollout.gates.evaluate', () => {
  it('przepuszcza etap z czystymi liczbami i zapisuje wpis do dziennika', async () => {
    const { ctx, persisted } = makeCtx({ stats: { episodes: '100', intervened: '2', severe: '0', successes: '95' } })
    const result = await evaluateGateCommand.execute({ ...scope, stageId: STAGE_ID }, ctx)
    expect(result.decision).toBe('advance')
    expect(result.rolledBackRobots).toBe(0)
    expect(persisted.map((r) => r.__table)).toContain('GateEvaluation')
  })

  it('po przekroczeniu progu zatrzymuje wszystkie etapy następne', async () => {
    const { ctx } = makeCtx({
      stats: { episodes: '100', intervened: '30', severe: '0', successes: '70' },
      allStages: [
        { id: 's1', ordinal: 1, status: 'running' },
        { id: 's2', ordinal: 2, status: 'pending' },
        { id: 's3', ordinal: 3, status: 'pending' },
      ],
    })
    const result = await evaluateGateCommand.execute({ ...scope, stageId: STAGE_ID }, ctx)
    expect(result.decision).toBe('rollback')
    expect(result.haltedStages).toBe(2)
  })

  it('wycofanie idzie komendą stanu pożądanego, a nie zapisem do tabeli wdrożeń', async () => {
    // Zapis do własnej tabeli rozjechałby stan pożądany w hali ze stanem
    // wdrożenia w panelu - dokładnie tam, gdzie takiego rozjazdu być nie może.
    const { ctx, commands } = makeCtx({
      stats: { episodes: '100', intervened: '30', severe: '0', successes: '70' },
      members: [{ id: 'm1', robot_id: ROBOT_A, previous_policy_version_id: PREVIOUS_VERSION_ID }],
    })
    await evaluateGateCommand.execute({ ...scope, stageId: STAGE_ID }, ctx)
    const assign = commands.find((c) => c.id === 'deployment.assignments.assign')
    expect(assign).toBeTruthy()
    expect(assign!.input.policyVersionId).toBe(PREVIOUS_VERSION_ID)
  })

  it('robot bez poprzedniej polityki wraca do stanu bez polityki, nie do wymyślonej', async () => {
    const { ctx, commands } = makeCtx({
      stats: { episodes: '100', intervened: '30', severe: '0', successes: '70' },
      members: [{ id: 'm1', robot_id: ROBOT_A, previous_policy_version_id: null }],
      currentAssignment: [{ id: 'assign-1' }],
    })
    await evaluateGateCommand.execute({ ...scope, stageId: STAGE_ID }, ctx)
    expect(commands.some((c) => c.id === 'deployment.assignments.revoke')).toBe(true)
    expect(commands.some((c) => c.id === 'deployment.assignments.assign')).toBe(false)
  })

  it('wstrzymanie przy braku danych nic nie wycofuje', async () => {
    const { ctx, commands } = makeCtx({ stats: { episodes: '3', intervened: '0', severe: '0', successes: '3' } })
    const result = await evaluateGateCommand.execute({ ...scope, stageId: STAGE_ID }, ctx)
    expect(result.decision).toBe('hold')
    expect(commands).toHaveLength(0)
  })

  it('brama ocenia tylko etapy w biegu', async () => {
    const { ctx } = makeCtx({
      stage: {
        id: STAGE_ID,
        rollout_id: ROLLOUT_ID,
        ordinal: 1,
        status: 'pending',
        min_episodes: 10,
        max_intervention_rate: '0.1',
        max_severe_rate: '0.02',
        min_success_rate: '0.8',
        policy_version_id: VERSION_ID,
        rollout_status: 'planned',
        mode: 'active',
      },
    })
    await expect(evaluateGateCommand.execute({ ...scope, stageId: STAGE_ID }, ctx)).rejects.toThrow(
      /tylko etapy w biegu/,
    )
  })

  it('brak podpisu człowieka w dzienniku oznacza decyzję automatu', async () => {
    const { ctx, persisted } = makeCtx({ stats: { episodes: '100', intervened: '30', severe: '0', successes: '70' } })
    await evaluateGateCommand.execute({ ...scope, stageId: STAGE_ID }, ctx)
    expect(persisted.find((r) => r.__table === 'GateEvaluation')!.actorUserId).toBeNull()
  })
})
