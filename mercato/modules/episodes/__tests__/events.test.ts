import { setGlobalEventBus } from '@open-mercato/shared/modules/events'
import { recordEpisodeCommand, recordInterventionCommand } from '../commands/episodes'

/**
 * Testy emisji zdarzeń księgi epizodów.
 *
 * Dwie reguły: dosłany epizod nie emituje (inaczej powtórka po zerwaniu łącza
 * podwajałaby statystyki i odpalała automatyzacje drugi raz), a interwencja
 * awaryjna dostaje własne zdarzenie obok ogólnego - bo odebranie maszynie
 * sprawczości to nie ta sama klasa faktu co korekta chwytu.
 */

type Row = Record<string, unknown>

const scope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
}
const ROBOT_ID = '33333333-3333-4333-8333-333333333333'
const EPISODE_ID = '44444444-4444-4444-8444-444444444444'

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

function makeCtx(options: { existing?: Row | null; episode?: Row | null } = {}) {
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
      execute: jest.fn(async (query: string) =>
        query.includes('max(sequence)') ? [{ max: 7 }] : [],
      ),
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

const epizod = {
  ...scope,
  robotId: ROBOT_ID,
  externalRef: 'run-42',
  taskKey: 'pick-bin',
  startedAt: new Date('2026-09-18T06:00:00Z'),
  endedAt: new Date('2026-09-18T06:00:12Z'),
  outcome: 'success' as const,
}

const interwencja = {
  ...scope,
  robotId: ROBOT_ID,
  reasonCategory: 'grasp_failure',
  reason: 'obiekt wypadł z chwytaka',
  occurredAt: new Date('2026-09-18T06:00:30Z'),
}

describe('emisja zdarzeń księgi epizodów', () => {
  it('nowy epizod ogłasza wynik i czas trwania', async () => {
    const seen = captureEvents()
    await recordEpisodeCommand.execute(epizod, makeCtx())
    expect(seen.map((e) => e.id)).toEqual(['episodes.episode.recorded'])
    expect(seen[0].payload).toMatchObject({ outcome: 'success', durationMs: 12_000 })
  })

  it('dosłany epizod nie emituje niczego', async () => {
    const seen = captureEvents()
    const result = await recordEpisodeCommand.execute(
      epizod,
      makeCtx({ existing: { id: EPISODE_ID, sequence: 7 } }),
    )
    expect(result.duplicate).toBe(true)
    expect(seen).toEqual([])
  })

  it('korekta chwytu to tylko zdarzenie ogólne', async () => {
    const seen = captureEvents()
    await recordInterventionCommand.execute({ ...interwencja, kind: 'adjust' }, makeCtx())
    expect(seen.map((e) => e.id)).toEqual(['episodes.intervention.recorded'])
  })

  it('zatrzymanie awaryjne ogłasza dodatkowo zdarzenie wyróżnione', async () => {
    const seen = captureEvents()
    await recordInterventionCommand.execute({ ...interwencja, kind: 'estop' }, makeCtx())
    expect(seen.map((e) => e.id)).toEqual([
      'episodes.intervention.recorded',
      'episodes.intervention.emergency',
    ])
  })

  it('przejęcie zdalne też jest odebraniem maszynie sprawczości', async () => {
    const seen = captureEvents()
    await recordInterventionCommand.execute({ ...interwencja, kind: 'teleop_takeover' }, makeCtx())
    expect(seen.map((e) => e.id)).toContain('episodes.intervention.emergency')
  })
})
