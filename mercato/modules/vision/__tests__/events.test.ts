import { createHash } from 'node:crypto'
import { setGlobalEventBus } from '@open-mercato/shared/modules/events'
import { purgeClipsCommand, recordWindowCommand, registerCameraCommand } from '../commands/vision'

/**
 * Testy emisji zdarzeń wzroku.
 *
 * Sprawdzane są trzy rzeczy, z których każda jest decyzją, a nie przypadkiem:
 *
 * 1. Braki formalne kamery dostają **własne** zdarzenie, bo ich odbiorcą jest
 *    ktoś inny niż odbiorca rejestracji sprzętu.
 * 2. Powtórzone okno detekcji nie emituje niczego - powtórka po zerwaniu łącza
 *    nie jest drugim oknem i nie może podwajać zliczeń.
 * 3. Zaległość w usuwaniu materiału ogłasza się przy **każdym** przebiegu,
 *    wbrew regule wyzwalania zboczem obowiązującej w reszcie wtyczki. To jest
 *    świadomy wyjątek: „dziś nadal przechowujemy nagranie po ustawowym
 *    terminie" jest prawdziwe każdego dnia z osobna i każdego dnia z osobna
 *    jest naruszeniem art. 22² § 3 Kodeksu pracy.
 */

type Row = Record<string, unknown>

const ORG = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const CELL = '33333333-3333-4333-8333-333333333333'
const scope = { organizationId: ORG, tenantId: TENANT }
const digest = createHash('sha256').update('wagi').digest('hex')

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

function makeCtx(
  options: {
    camera?: Row | null
    detector?: Row | null
    window?: Row | null
    clips?: Row[]
    unconfirmed?: { count: string; oldest: string | null }
  } = {},
) {
  const persisted: Row[] = []
  const em = {
    fork: () => em,
    findOne: jest.fn(async (entity: unknown) => {
      const name = (entity as { name?: string })?.name ?? String(entity)
      if (name.includes('DetectorVersion')) return options.detector ?? null
      if (name.includes('DetectionWindow')) return options.window ?? null
      if (name.includes('Camera')) return options.camera ?? null
      return null
    }),
    find: jest.fn(async () => options.clips ?? []),
    create: jest.fn((entity: unknown, data: Row) => ({ __table: (entity as { name?: string })?.name, ...data })),
    persist: jest.fn((row: Row) => persisted.push(row)),
    flush: jest.fn(async () => {
      for (const row of persisted) if (!row.id) row.id = 'nowy-1'
    }),
    getConnection: () => ({
      execute: jest.fn(async () => [options.unconfirmed ?? { count: '0', oldest: null }]),
    }),
  }
  return { container: { resolve: () => em }, auth: { sub: 'user-1' } } as never
}

const kamera = {
  ...scope,
  cellId: CELL,
  code: 'BIN-CAM-1',
  name: 'Kamera nad pojemnikiem',
  viewRole: 'bin_outfeed',
  purpose: 'production_control' as const,
  retentionDays: 14,
  peopleInView: true,
}

describe('emisja zdarzeń wzroku', () => {
  it('kamera bez uprzedzenia załogi ogłasza osobne zdarzenie o brakach', async () => {
    const seen = captureEvents()
    await registerCameraCommand.execute(kamera, makeCtx())
    expect(seen.map((e) => e.id)).toEqual([
      'vision.camera.registered',
      'vision.camera.compliance_warning',
    ])
    expect(Array.isArray(seen[1].payload.warnings)).toBe(true)
    expect((seen[1].payload.warnings as string[]).length).toBeGreaterThan(0)
  })

  it('kamera z dopełnionymi formalnościami nie ogłasza braków', async () => {
    const seen = captureEvents()
    await registerCameraCommand.execute(
      {
        ...kamera,
        workforceNotifiedAt: new Date('2026-08-01T00:00:00Z'),
        areaMarkedAt: new Date('2026-08-01T00:00:00Z'),
      },
      makeCtx(),
    )
    expect(seen.map((e) => e.id)).toEqual(['vision.camera.registered'])
  })

  it('powtórzone okno detekcji nie emituje - powtórka nie jest drugim oknem', async () => {
    const seen = captureEvents()
    const result = await recordWindowCommand.execute(
      {
        ...scope,
        cameraId: '44444444-4444-4444-8444-444444444444',
        detectorVersionId: '55555555-5555-4555-8555-555555555555',
        startedAt: new Date('2026-09-18T06:00:00Z'),
        endedAt: new Date('2026-09-18T06:01:00Z'),
        framesAnalyzed: 600,
        countingMode: 'tracks',
        counts: { pet_bottle: 12 },
      },
      makeCtx({
        camera: { id: '44444444-4444-4444-8444-444444444444', cellId: CELL, organizationId: ORG },
        detector: { id: '55555555-5555-4555-8555-555555555555', classVocabulary: ['pet_bottle'], weightsDigest: digest },
        window: { id: 'istniejace-okno' },
      }),
    )
    expect(result.action).toBe('skipped')
    expect(seen).toEqual([])
  })

  it('zaległość w usuwaniu ogłasza się nawet wtedy, gdy nic nowego nie oznaczono', async () => {
    const seen = captureEvents()
    const result = await purgeClipsCommand.execute(
      { tenantId: TENANT, organizationId: ORG },
      makeCtx({ clips: [], unconfirmed: { count: '7', oldest: '2026-06-01T00:00:00Z' } }),
    )
    expect(result.purged).toEqual([])
    // Nic nowego do oznaczenia, a mimo to zdarzenie pada - bo naruszenie trwa.
    expect(seen.map((e) => e.id)).toEqual(['vision.clips.deletion_overdue'])
    expect(seen[0].payload).toMatchObject({ unconfirmed: 7 })
  })

  it('brak zaległości i brak nowych oznaczeń - cisza', async () => {
    const seen = captureEvents()
    await purgeClipsCommand.execute({ tenantId: TENANT, organizationId: ORG }, makeCtx({ clips: [] }))
    expect(seen).toEqual([])
  })
})
