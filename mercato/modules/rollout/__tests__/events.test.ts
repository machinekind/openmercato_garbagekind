import { setGlobalEventBus } from '@open-mercato/shared/modules/events'
import { evaluateGateCommand } from '../commands/rollouts'

/**
 * Testy emisji zdarzeń bramy wdrożenia.
 *
 * Werdykt bramy ma trzy zdarzenia zamiast jednego z polem `decision` - i to
 * jest tu sprawdzane. Powód jest praktyczny: odbiorcą „wycofano wdrożenie"
 * bywa kanał alarmowy, a odbiorcą „etap przeszedł dalej" tablica postępu.
 * Jedno zdarzenie ze stringiem kazałoby kanałowi alarmowemu filtrować -
 * i budziłoby dyżurnego przy każdym pomyślnym przejściu, dopóki ktoś tego
 * filtru nie napisze poprawnie.
 *
 * Osobno pilnowane jest `hold`: wstrzymanie nie jest porażką, tylko brakiem
 * dowodów. Zlanie go z wycofaniem popycha ludzi do przepychania wdrożeń przez
 * bramę, która jeszcze nic nie powiedziała.
 */

type Row = Record<string, unknown>

const scope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
}
const VERSION_ID = '33333333-3333-4333-8333-333333333333'
const STAGE_ID = '44444444-4444-4444-8444-444444444444'
const ROLLOUT_ID = '55555555-5555-4555-8555-555555555555'

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

function makeCtx(stats: Row) {
  const persisted: Row[] = []
  const em = {
    fork: () => em,
    findOne: jest.fn(async () => null),
    getConnection: () => ({
      execute: jest.fn(async (query: string) => {
        if (query.startsWith('update')) return []
        if (query.includes('from rollout_stages s') && query.includes('join rollout_rollouts')) {
          return [
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
        }
        if (query.includes('where rollout_id = ? and ordinal <')) return []
        if (query.includes('select id, ordinal, status from rollout_stages')) return []
        if (query.includes('with populacja')) return [stats]
        if (query.includes('rollout_stage_members')) return []
        if (query.includes('deployment_assignments')) return []
        // Po przepuszczeniu etapu komenda pyta, ile etapów zostało - brak tej
        // odpowiedzi wywracał test na ścieżce `advance`, a nie na samej emisji.
        if (query.includes('count(*) as n from rollout_stages')) return [{ n: '1' }]
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
  const commandBus = { execute: jest.fn(async () => ({ result: {} })) }
  return {
    container: { resolve: (key: string) => (key === 'commandBus' ? commandBus : em) },
    auth: { sub: 'user-1' },
  } as never
}

describe('emisja zdarzeń bramy wdrożenia', () => {
  it('etap ze zdrowymi statystykami ogłasza przejście dalej', async () => {
    const seen = captureEvents()
    const result = await evaluateGateCommand.execute(
      { ...scope, stageId: STAGE_ID },
      makeCtx({ episodes: '100', intervened: '2', severe: '0', successes: '95' }),
    )
    expect(result.decision).toBe('advance')
    expect(seen.map((e) => e.id)).toEqual(['rollout.gate.advanced'])
  })

  it('za mało epizodów ogłasza wstrzymanie, a nie porażkę', async () => {
    const seen = captureEvents()
    const result = await evaluateGateCommand.execute(
      { ...scope, stageId: STAGE_ID },
      makeCtx({ episodes: '3', intervened: '0', severe: '0', successes: '3' }),
    )
    expect(result.decision).toBe('hold')
    expect(seen.map((e) => e.id)).toEqual(['rollout.gate.held'])
  })

  it('zdarzenie poważne ogłasza wycofanie z liczbą cofniętych maszyn', async () => {
    const seen = captureEvents()
    const result = await evaluateGateCommand.execute(
      { ...scope, stageId: STAGE_ID },
      makeCtx({ episodes: '100', intervened: '2', severe: '5', successes: '90' }),
    )
    expect(result.decision).toBe('rollback')
    expect(seen.map((e) => e.id)).toEqual(['rollout.gate.rolled_back'])
    expect(seen[0].payload).toHaveProperty('rolledBackRobots')
    expect(seen[0].payload).toHaveProperty('haltedStages')
  })
})
