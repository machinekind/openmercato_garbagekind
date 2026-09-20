import { registerRobotCommand, transitionRobotCommand, recordCalibrationCommand } from '../commands/robots'

/**
 * Testy wiązania komend.
 *
 * Reguły cyklu życia i kalibracji mają własne testy jako czyste funkcje. Tutaj
 * sprawdzamy rzecz osobną i równie ważną: czy komenda naprawdę ich **używa**.
 * Reguła, której nikt nie woła, nie chroni niczego.
 */

type Row = Record<string, unknown>

function makeCtx(options: {
  robot?: Row | null
  revision?: Row | null
  calibrations?: Row[]
  existingSerial?: Row | null
} = {}) {
  const persisted: Row[] = []
  const flushes: number[] = []

  const em = {
    fork: () => em,
    findOne: jest.fn(async (entity: unknown, where: Row) => {
      const name = (entity as { name?: string })?.name ?? String(entity)
      if (name.includes('EmbodimentRevision')) {
        return options.revision === undefined
          ? { id: 'rev-1', requiredCalibrations: ['camera_extrinsics'] }
          : options.revision
      }
      if (name.includes('Robot')) {
        if (where.serialNumber !== undefined) return options.existingSerial ?? null
        return options.robot ?? null
      }
      return null
    }),
    find: jest.fn(async () => options.calibrations ?? []),
    create: jest.fn((_entity: unknown, data: Row) => ({ id: `new-${persisted.length + 1}`, ...data })),
    persist: jest.fn((row: Row) => {
      persisted.push(row)
    }),
    flush: jest.fn(async () => {
      flushes.push(persisted.length)
    }),
  }

  return {
    persisted,
    flushes,
    ctx: {
      container: { resolve: () => em },
      auth: { sub: 'user-1' },
    } as never,
  }
}

const scope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
}

const ROBOT_ID = '33333333-3333-4333-8333-333333333333'
const REVISION_ID = '44444444-4444-4444-8444-444444444444'

describe('fleet.robots.register', () => {
  it('rejestruje robota i od razu dopisuje wpis do księgi przejść', async () => {
    const { ctx, persisted } = makeCtx()
    const result = await registerRobotCommand.execute(
      {
        ...scope,
        serialNumber: 'UR10E-0001',
        name: 'Odkładanie A',
        embodimentRevisionId: REVISION_ID,
        ownerOrganizationId: scope.organizationId,
        operatorOrganizationId: scope.organizationId,
      },
      ctx,
    )
    expect(result.robotId).toBeTruthy()
    // Robot plus wpis do księgi - rejestracja bez śladu w księdze byłaby
    // rekordem, którego pochodzenia nikt później nie odtworzy.
    expect(persisted).toHaveLength(2)
    expect(persisted[1]).toMatchObject({ toState: 'registered', fromState: null })
  })

  it('zapisuje właściciela i operatora osobno', async () => {
    const { ctx, persisted } = makeCtx()
    await registerRobotCommand.execute(
      {
        ...scope,
        serialNumber: 'FR3-0001',
        name: 'Montaż 1',
        embodimentRevisionId: REVISION_ID,
        ownerOrganizationId: scope.organizationId,
        operatorOrganizationId: '55555555-5555-4555-8555-555555555555',
      },
      ctx,
    )
    expect(persisted[0]).toMatchObject({
      ownerOrganizationId: scope.organizationId,
      operatorOrganizationId: '55555555-5555-4555-8555-555555555555',
    })
  })

  it('odmawia rejestracji bez istniejącej rewizji embodimentu', async () => {
    const { ctx } = makeCtx({ revision: null })
    await expect(
      registerRobotCommand.execute(
        {
          ...scope,
          serialNumber: 'X-1',
          name: 'X',
          embodimentRevisionId: REVISION_ID,
          ownerOrganizationId: scope.organizationId,
          operatorOrganizationId: scope.organizationId,
        },
        ctx,
      ),
    ).rejects.toThrow(/Rewizja embodimentu/)
  })

  it('numer seryjny jest tożsamością - drugi import tej samej floty odbija się', async () => {
    const { ctx } = makeCtx({ existingSerial: { id: 'istnieje' } })
    await expect(
      registerRobotCommand.execute(
        {
          ...scope,
          serialNumber: 'UR10E-0001',
          name: 'Duplikat',
          embodimentRevisionId: REVISION_ID,
          ownerOrganizationId: scope.organizationId,
          operatorOrganizationId: scope.organizationId,
        },
        ctx,
      ),
    ).rejects.toThrow(/już istnieje/)
  })
})

describe('fleet.robots.transition', () => {
  const wazna = {
    kind: 'camera_extrinsics',
    measuredAt: new Date(Date.now() - 86_400_000),
    validUntil: new Date(Date.now() + 86_400_000 * 30),
  }

  it('przepuszcza dozwolone przejście i dopisuje je do księgi', async () => {
    const { ctx, persisted } = makeCtx({ robot: { id: ROBOT_ID, state: 'ready', embodimentRevisionId: REVISION_ID } })
    const result = await transitionRobotCommand.execute(
      { ...scope, robotId: ROBOT_ID, toState: 'operational', reason: 'Wprowadzenie do ruchu', actor: 'human' },
      ctx,
    )
    expect(result).toMatchObject({ fromState: 'ready', toState: 'operational' })
    expect(persisted[0]).toMatchObject({ fromState: 'ready', toState: 'operational' })
  })

  it('odmawia przejścia spoza grafu', async () => {
    const { ctx } = makeCtx({ robot: { id: ROBOT_ID, state: 'registered', embodimentRevisionId: REVISION_ID } })
    await expect(
      transitionRobotCommand.execute(
        { ...scope, robotId: ROBOT_ID, toState: 'operational', reason: 'na skróty', actor: 'human' },
        ctx,
      ),
    ).rejects.toThrow(/nie da się przejść/)
  })

  it('bramka wymaga podpisu - bez niego przejście nie przechodzi', async () => {
    const { ctx } = makeCtx({
      robot: { id: ROBOT_ID, state: 'quarantined', embodimentRevisionId: REVISION_ID },
      calibrations: [wazna],
    })
    await expect(
      transitionRobotCommand.execute(
        { ...scope, robotId: ROBOT_ID, toState: 'ready', reason: 'objaw ustąpił', actor: 'human' },
        ctx,
      ),
    ).rejects.toThrow(/wymaga podpisu człowieka/)
  })

  it('system nie dopuszcza robota do pracy, choćby miał komplet kalibracji', async () => {
    const { ctx } = makeCtx({
      robot: { id: ROBOT_ID, state: 'quarantined', embodimentRevisionId: REVISION_ID },
      calibrations: [wazna],
    })
    await expect(
      transitionRobotCommand.execute(
        {
          ...scope,
          robotId: ROBOT_ID,
          toState: 'ready',
          reason: 'automat uznał, że jest dobrze',
          actor: 'system',
          approvedBy: scope.organizationId,
        },
        ctx,
      ),
    ).rejects.toThrow(/wyłącznie kwarantannować/)
  })

  it('BRAMKA KALIBRACYJNA: nie da się dopuścić robota bez ważnego pomiaru', async () => {
    // To jest sedno fazy 0. Robot z przeterminowaną kalibracją wygląda
    // w każdym zestawieniu identycznie jak sprawny - i to jest moment,
    // w którym ta różnica musi wyjść.
    const { ctx } = makeCtx({
      robot: { id: ROBOT_ID, state: 'commissioning', embodimentRevisionId: REVISION_ID },
      calibrations: [],
    })
    await expect(
      transitionRobotCommand.execute(
        {
          ...scope,
          robotId: ROBOT_ID,
          toState: 'ready',
          reason: 'Testy odbiorcze zaliczone',
          actor: 'human',
          approvedBy: scope.organizationId,
        },
        ctx,
      ),
    ).rejects.toThrow(/brak ważnej kalibracji/)
  })

  it('z ważną kalibracją i podpisem to samo przejście przechodzi', async () => {
    const { ctx } = makeCtx({
      robot: { id: ROBOT_ID, state: 'commissioning', embodimentRevisionId: REVISION_ID },
      calibrations: [wazna],
    })
    const result = await transitionRobotCommand.execute(
      {
        ...scope,
        robotId: ROBOT_ID,
        toState: 'ready',
        reason: 'Testy odbiorcze zaliczone',
        actor: 'human',
        approvedBy: scope.organizationId,
      },
      ctx,
    )
    expect(result.toState).toBe('ready')
  })

  it('kwarantanna przez system zapisuje się bez aktora - i to jest informacja', async () => {
    const { ctx, persisted } = makeCtx({ robot: { id: ROBOT_ID, state: 'operational', embodimentRevisionId: REVISION_ID } })
    await transitionRobotCommand.execute(
      { ...scope, robotId: ROBOT_ID, toState: 'quarantined', reason: 'Wygaśnięcie kalibracji', actor: 'system' },
      ctx,
    )
    expect(persisted[0]).toMatchObject({ toState: 'quarantined', actorUserId: null })
  })
})

describe('fleet.calibrations.record', () => {
  it('odrzuca pomiar, którego ważność kończy się przed pomiarem', async () => {
    const { ctx } = makeCtx({ robot: { id: ROBOT_ID } })
    await expect(
      recordCalibrationCommand.execute(
        {
          ...scope,
          robotId: ROBOT_ID,
          kind: 'camera_extrinsics',
          measuredAt: new Date('2026-09-10'),
          validUntil: new Date('2026-09-01'),
        },
        ctx,
      ),
    ).rejects.toThrow(/późniejsza niż data pomiaru/)
  })

  it('nie rejestruje kalibracji dla nieistniejącego robota', async () => {
    const { ctx } = makeCtx({ robot: null })
    await expect(
      recordCalibrationCommand.execute(
        {
          ...scope,
          robotId: ROBOT_ID,
          kind: 'camera_extrinsics',
          measuredAt: new Date('2026-09-01'),
          validUntil: new Date('2026-12-01'),
        },
        ctx,
      ),
    ).rejects.toThrow(/nie istnieje/)
  })
})
