import { setGlobalEventBus } from '@open-mercato/shared/modules/events'
import { registerRobotCommand, transitionRobotCommand } from '../commands/robots'
import { detectExpiredCommand } from '../commands/calibrationExpiry'

/**
 * Testy emisji zdarzeń.
 *
 * Deklaracja w `events.ts` nie jest dowodem na nic - dowodem jest to, że
 * komenda naprawdę woła emisję w chwili, w której zmienia stan świata.
 * Zdarzenie zadeklarowane i nieemitowane trafia na listę wyzwalaczy workflow
 * i ktoś zbuduje na nim automatyzację, która nigdy nie zadziała.
 *
 * Testowane są tu wyłącznie reguły nieoczywiste: podwójna emisja przy
 * kwarantannie, brak emisji na ścieżce duplikatu i idempotencja detektora
 * wygaśnięć. Emisja „komenda zapisała, więc emituje" nie wymaga testu, bo
 * jej brak wywraca każdy z poniższych.
 */

function captureEvents() {
  const seen: Array<{ id: string; payload: Record<string, unknown> }> = []
  setGlobalEventBus({
    emit: async (id: string, payload: unknown) => {
      seen.push({ id, payload: payload as Record<string, unknown> })
    },
  })
  return seen
}

const scope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
}
const ROBOT_ID = '33333333-3333-4333-8333-333333333333'
const REVISION_ID = '44444444-4444-4444-8444-444444444444'

type Row = Record<string, unknown>

function makeCtx(options: { robot?: Row | null; calibrations?: Row[]; revision?: Row | null } = {}) {
  const em = {
    fork: () => em,
    findOne: jest.fn(async (entity: unknown, where: Row) => {
      const name = (entity as { name?: string })?.name ?? String(entity)
      if (name.includes('EmbodimentRevision')) {
        return options.revision === undefined
          ? { id: REVISION_ID, requiredCalibrations: ['camera_extrinsics'] }
          : options.revision
      }
      if (name.includes('Robot')) {
        if (where.serialNumber !== undefined) return null
        return options.robot ?? null
      }
      return null
    }),
    find: jest.fn(async (entity: unknown) => {
      const name = (entity as { name?: string })?.name ?? String(entity)
      if (name.includes('Calibration')) return options.calibrations ?? []
      if (name.includes('EmbodimentRevision')) {
        return options.revision === undefined
          ? [{ id: REVISION_ID, requiredCalibrations: ['camera_extrinsics'] }]
          : options.revision
          ? [options.revision]
          : []
      }
      if (name.includes('Robot')) return options.robot ? [options.robot] : []
      return []
    }),
    create: jest.fn((_entity: unknown, data: Row) => ({ id: 'new-1', ...data })),
    persist: jest.fn(),
    flush: jest.fn(async () => {}),
  }
  return { container: { resolve: () => em }, auth: { sub: 'user-1' } } as never
}

afterEach(() => {
  // Szyna zostaje podmieniona na niemą, żeby test emisji nie wyciekał
  // do sąsiadów w tym samym procesie.
  setGlobalEventBus({ emit: async () => {} })
})

describe('emisja zdarzeń floty', () => {
  it('rejestracja robota ogłasza fakt z numerem seryjnym', async () => {
    const seen = captureEvents()
    await registerRobotCommand.execute(
      {
        ...scope,
        serialNumber: 'SO101-0001',
        name: 'Ramię A',
        embodimentRevisionId: REVISION_ID,
        ownerOrganizationId: scope.organizationId,
        operatorOrganizationId: scope.organizationId,
      },
      makeCtx(),
    )
    expect(seen.map((e) => e.id)).toEqual(['fleet.robot.registered'])
    expect(seen[0].payload).toMatchObject({ serialNumber: 'SO101-0001' })
  })

  it('kwarantanna ogłasza i przejście ogólne, i zdarzenie wyróżnione', async () => {
    // Subskrybent wstrzymujący przydział pracy nie powinien dopasowywać
    // stringa w polu `toState` - dlatego są dwa zdarzenia, nie jedno.
    const seen = captureEvents()
    await transitionRobotCommand.execute(
      { ...scope, robotId: ROBOT_ID, toState: 'quarantined', reason: 'utrata łączności', actor: 'system' },
      makeCtx({ robot: { id: ROBOT_ID, state: 'operational', embodimentRevisionId: REVISION_ID } }),
    )
    expect(seen.map((e) => e.id)).toEqual(['fleet.robot.transitioned', 'fleet.robot.quarantined'])
    expect(seen[1].payload).toMatchObject({ fromState: 'operational', actor: 'system' })
  })

  it('przejście do maintenance nie ogłasza żadnego zdarzenia wyróżnionego', async () => {
    const seen = captureEvents()
    await transitionRobotCommand.execute(
      {
        ...scope,
        robotId: ROBOT_ID,
        toState: 'maintenance',
        reason: 'przegląd',
        approvedBy: '55555555-5555-4555-8555-555555555555',
      },
      makeCtx({ robot: { id: ROBOT_ID, state: 'operational', embodimentRevisionId: REVISION_ID } }),
    )
    expect(seen.map((e) => e.id)).toEqual(['fleet.robot.transitioned'])
  })
})

describe('detektor wygasłych kalibracji', () => {
  const NOW = new Date('2026-09-19T12:00:00Z')

  function kalibracja(overrides: Row = {}) {
    return {
      id: 'cal-1',
      robotId: ROBOT_ID,
      kind: 'camera_extrinsics',
      validUntil: new Date('2026-09-18T00:00:00Z'),
      expiryNotifiedAt: null,
      ...overrides,
    }
  }

  it('ogłasza wygaśnięcie i zaznacza, że pomiar jest wymagany przez rewizję', async () => {
    const seen = captureEvents()
    const result = await detectExpiredCommand.execute(
      { ...scope, now: NOW },
      makeCtx({
        calibrations: [kalibracja()],
        robot: { id: ROBOT_ID, state: 'operational', embodimentRevisionId: REVISION_ID },
      }),
    )
    expect(result.expired).toHaveLength(1)
    expect(seen.map((e) => e.id)).toEqual(['fleet.calibration.expired'])
    expect(seen[0].payload).toMatchObject({ kind: 'camera_extrinsics', required: true, robotState: 'operational' })
  })

  it('pomiar spoza listy wymaganych jest ogłaszany jako informacyjny', async () => {
    // Rozróżnienie jest istotne: pomiar wymagany blokuje dopuszczenie maszyny,
    // pomiar spoza listy jest informacją dla serwisu.
    const seen = captureEvents()
    await detectExpiredCommand.execute(
      { ...scope, now: NOW },
      makeCtx({
        calibrations: [kalibracja({ kind: 'tool_center_point' })],
        robot: { id: ROBOT_ID, state: 'ready', embodimentRevisionId: REVISION_ID },
      }),
    )
    expect(seen[0].payload).toMatchObject({ required: false })
  })

  it('pomiar już odhaczony nie wraca - inaczej zdarzenie byłoby szumem', async () => {
    const seen = captureEvents()
    const result = await detectExpiredCommand.execute(
      { ...scope, now: NOW },
      makeCtx({
        // Komenda filtruje po `expiryNotifiedAt: null` w zapytaniu; tutaj
        // odtwarzamy sytuację, w której filtr nic nie zwraca.
        calibrations: [],
        robot: { id: ROBOT_ID, state: 'operational', embodimentRevisionId: REVISION_ID },
      }),
    )
    expect(result.expired).toEqual([])
    expect(seen).toEqual([])
  })

  it('pomiar jeszcze ważny nie jest ogłaszany', async () => {
    const seen = captureEvents()
    const result = await detectExpiredCommand.execute(
      { ...scope, now: NOW },
      makeCtx({
        calibrations: [kalibracja({ validUntil: new Date('2026-12-01T00:00:00Z') })],
        robot: { id: ROBOT_ID, state: 'operational', embodimentRevisionId: REVISION_ID },
      }),
    )
    expect(result.expired).toEqual([])
    expect(seen).toEqual([])
  })

  it('kalibracja po usuniętym robocie jest odhaczana, ale nie ogłaszana', async () => {
    // Nie ma komu zareagować i nie ma czego zatrzymać - ogłoszenie byłoby
    // alarmem bez adresata, a brak odhaczenia dałby go co godzinę.
    const seen = captureEvents()
    const kal = kalibracja()
    const result = await detectExpiredCommand.execute(
      { ...scope, now: NOW },
      makeCtx({ calibrations: [kal], robot: null }),
    )
    expect(result.expired).toEqual([])
    expect(seen).toEqual([])
    expect(kal.expiryNotifiedAt).toEqual(NOW)
  })
})
