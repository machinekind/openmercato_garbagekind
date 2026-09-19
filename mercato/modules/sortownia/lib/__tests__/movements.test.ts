import { legacyUuid, type LegacyMovementRow } from '../legacyFiles'
import { applyMovementBatch, pairSortRows, type MovementContext } from '../movements'

/**
 * Tu mieszka cała wiedza o tym, czym różni się księga legacy od księgi WMS:
 * para wierszy SORT kontra jeden ruch `transfer`, ujemna korekta zamiast
 * wydania i klucz idempotencji zbudowany z numeru ze starego systemu.
 * Każda z tych rzeczy zepsuta po cichu daje magazyn, który się nie zgadza.
 */

type RecordedCommand = { id: string; input: Record<string, unknown> }

function row(overrides: Partial<LegacyMovementRow> & { stkmoveno: number }): LegacyMovementRow {
  return {
    stockid: '20 01 01',
    typ: 'PZ',
    loccode: 'PRZYJ',
    data: '2026-09-18T07:15:00',
    debtorno: 'D001',
    iloscKg: 1000,
    iloscMg: 1,
    ...overrides,
  }
}

/** Partia leżąca w lokalizacji źródłowej — tyle, ile potrzebuje FIFO. */
type Partia = { id: string; lotNumber: string; manufacturedAt: Date; dostepne: number }

const PARTIA_BEZ_LIMITU: Partia[] = [
  { id: 'lot-1', lotNumber: 'PZ/100001', manufacturedAt: new Date('2026-09-01T06:00:00'), dostepne: 1_000_000 },
]

function buildContext(
  options: {
    existingMovement?: boolean
    failOn?: string
    /** Co leży w lokalizacji źródłowej. Kolejność podania celowo bywa inna niż FIFO. */
    partie?: Partia[]
    /** Ile masy z tego wiersza legacy siedzi już w księdze — wznowienie po przerwaniu. */
    juzWKsiedze?: number
  } = {},
) {
  const commands: RecordedCommand[] = []
  const partie = options.partie ?? PARTIA_BEZ_LIMITU
  const context = {
    em: {
      // Jedno `find` obsługuje dwa pytania. Rozróżniamy je po kształcie filtra:
      // księga jest pytana o `referenceId`, salda o lokalizację.
      find: jest.fn(async (_entity: unknown, where: Record<string, unknown>) => {
        if ('referenceId' in where) {
          if (options.existingMovement) return [{ quantity: '999999' }]
          if (options.juzWKsiedze) return [{ quantity: String(options.juzWKsiedze) }]
          return []
        }
        return partie.map((partia) => ({
          lot: { id: partia.id, lotNumber: partia.lotNumber, manufacturedAt: partia.manufacturedAt },
          quantityAvailable: String(partia.dostepne),
        }))
      }),
    },
    commandBus: {
      execute: jest.fn(async (id: string, payload: { input: Record<string, unknown> }) => {
        commands.push({ id, input: payload.input })
        if (options.failOn && id === options.failOn) throw new Error('insufficient_stock')
        return { result: { movementId: 'm-1' }, logEntry: null }
      }),
    },
    commandContext: {} as never,
    scope: { organizationId: 'org-1', tenantId: 'ten-1' },
    warehouseId: 'wh-1',
    locations: new Map([
      ['PRZYJ', { id: 'loc-przyj', code: 'PRZYJ' }],
      ['BOKS1', { id: 'loc-boks1', code: 'BOKS1' }],
    ]),
    fractions: new Map([['20 01 01', { productId: 'p-1', variantId: 'v-1' }]]),
    performedBy: 'user-1',
  } as unknown as MovementContext

  return { context, commands }
}

describe('pairSortRows', () => {
  const out = row({ stkmoveno: 100010, typ: 'SORT', loccode: 'PRZYJ', iloscKg: -4685.98, debtorno: '' })
  const into = row({ stkmoveno: 100011, typ: 'SORT', loccode: 'BOKS1', iloscKg: 4685.98, debtorno: '' })

  it('łączy zejście z placu z przyjęciem na boks w jedną parę', () => {
    const { pairs, orphans } = pairSortRows([out, into])
    expect(orphans).toHaveLength(0)
    expect(pairs).toHaveLength(1)
    expect(pairs[0].out.loccode).toBe('PRZYJ')
    expect(pairs[0].in.loccode).toBe('BOKS1')
  })

  it('łączy niezależnie od kolejności wierszy w eksporcie', () => {
    const { pairs } = pairSortRows([into, out])
    expect(pairs[0].out.stkmoveno).toBe(100010)
    expect(pairs[0].in.stkmoveno).toBe(100011)
  })

  it('nie skleja wierszy o różnej frakcji, czasie ani masie', () => {
    const inny = row({ ...into, stkmoveno: 100012, stockid: '15 01 02' })
    const { pairs, orphans } = pairSortRows([out, inny])
    expect(pairs).toHaveLength(0)
    expect(orphans).toHaveLength(2)
  })

  it('zwraca wiersz bez pary jako sierotę zamiast zgadywać drugą połowę', () => {
    const { pairs, orphans } = pairSortRows([out])
    expect(pairs).toHaveLength(0)
    expect(orphans.map((item) => item.stkmoveno)).toEqual([100010])
  })

  it('paruje wiele przesunięć tej samej frakcji w różnych sekundach', () => {
    const drugaPara = [
      row({ ...out, stkmoveno: 100020, data: '2026-09-18T09:00:00', iloscKg: -1000 }),
      row({ ...into, stkmoveno: 100021, data: '2026-09-18T09:00:00', iloscKg: 1000 }),
    ]
    const { pairs, orphans } = pairSortRows([out, into, ...drugaPara])
    expect(pairs).toHaveLength(2)
    expect(orphans).toHaveLength(0)
  })
})

describe('applyMovementBatch — mapowanie na komendy WMS', () => {
  it('PZ staje się przyjęciem z referencją zamówienia zakupu', async () => {
    const { context, commands } = buildContext()
    const { outcomes } = await applyMovementBatch(context, [row({ stkmoveno: 100001, iloscKg: 6412.8 })], {
      final: true,
    })

    expect(commands).toHaveLength(1)
    expect(commands[0].id).toBe('wms.inventory.receive')
    expect(commands[0].input).toMatchObject({
      warehouseId: 'wh-1',
      locationId: 'loc-przyj',
      catalogVariantId: 'v-1',
      quantity: 6412.8,
      referenceType: 'po',
      referenceId: legacyUuid('movement', 100001),
      performedBy: 'user-1',
    })
    expect(outcomes[0]).toMatchObject({ action: 'create', stkmoveno: 100001 })
  })

  it('para SORT staje się JEDNYM przesunięciem z lokalizacją źródłową i docelową', async () => {
    const { context, commands } = buildContext()
    const rows = [
      row({ stkmoveno: 100010, typ: 'SORT', loccode: 'PRZYJ', iloscKg: -4685.98, debtorno: '' }),
      row({ stkmoveno: 100011, typ: 'SORT', loccode: 'BOKS1', iloscKg: 4685.98, debtorno: '' }),
    ]
    const { outcomes } = await applyMovementBatch(context, rows, { final: true })

    expect(commands).toHaveLength(1)
    expect(commands[0].id).toBe('wms.inventory.move')
    expect(commands[0].input).toMatchObject({
      fromLocationId: 'loc-przyj',
      toLocationId: 'loc-boks1',
      quantity: 4685.98,
      type: 'transfer',
      reasonCode: 'SORT',
      referenceId: legacyUuid('movement', 100011),
      // Bez partii WMS szuka salda bezpartyjnego, które jest zerowe.
      lotId: 'lot-1',
    })
    // Oba numery legacy zostają w metadanych: po nich wraca się do kwitu.
    expect((commands[0].input.metadata as { legacy: { stkmoveno: number[] } }).legacy.stkmoveno).toEqual([
      100010, 100011,
    ])
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0].externalId).toBe('100010+100011')
  })

  it('WZ staje się ujemną korektą z powodem i odbiorcą', async () => {
    const { context, commands } = buildContext()
    await applyMovementBatch(
      context,
      [row({ stkmoveno: 100030, typ: 'WZ', loccode: 'BOKS1', iloscKg: -9004.1, debtorno: 'D005' })],
      { final: true },
    )

    expect(commands[0].id).toBe('wms.inventory.adjust')
    expect(commands[0].input).toMatchObject({
      locationId: 'loc-boks1',
      delta: -9004.1,
      reasonCode: 'WZ',
      referenceType: 'so',
      lotId: 'lot-1',
    })
    expect(String(commands[0].input.reason)).toContain('D005')
  })

  it('masy jadą w kilogramach — megagramy są jednostką raportową, nie magazynową', async () => {
    const { context, commands } = buildContext()
    await applyMovementBatch(context, [row({ stkmoveno: 100001, iloscKg: 6412.8, iloscMg: 6.413 })], {
      final: true,
    })
    expect(commands[0].input.quantity).toBe(6412.8)
  })
})

describe('applyMovementBatch — idempotencja i błędy', () => {
  it('nie wysyła komendy dla ruchu, który już jest w księdze', async () => {
    const { context, commands } = buildContext({ existingMovement: true })
    const { outcomes } = await applyMovementBatch(context, [row({ stkmoveno: 100001 })], { final: true })

    expect(commands).toHaveLength(0)
    expect(outcomes[0].action).toBe('skip')
  })

  it('zgłasza odrzucenie komendy jako błąd pozycji, nie wywraca całej partii', async () => {
    const { context } = buildContext({ failOn: 'wms.inventory.adjust' })
    const { outcomes } = await applyMovementBatch(
      context,
      [
        row({ stkmoveno: 100001 }),
        row({ stkmoveno: 100030, typ: 'WZ', loccode: 'BOKS1', iloscKg: -100, debtorno: 'D005' }),
      ],
      { final: true },
    )

    expect(outcomes.find((item) => item.stkmoveno === 100001)?.action).toBe('create')
    const failed = outcomes.find((item) => item.stkmoveno === 100030)
    expect(failed?.action).toBe('failed')
    expect(failed?.error).toContain('insufficient_stock')
  })

  it('nieznana lokalizacja albo frakcja to błąd pozycji z czytelnym komunikatem', async () => {
    const { context } = buildContext()
    const { outcomes } = await applyMovementBatch(
      context,
      [row({ stkmoveno: 100002, loccode: 'NIEMA' }), row({ stkmoveno: 100003, stockid: '99 99 99' })],
      { final: true },
    )

    expect(outcomes.map((item) => item.action)).toEqual(['failed', 'failed'])
    expect(outcomes[0].error).toContain('NIEMA')
    expect(outcomes[1].error).toContain('99 99 99')
  })
})

describe('applyMovementBatch — para rozcięta granicą partii', () => {
  const first = row({ stkmoveno: 100010, typ: 'SORT', loccode: 'PRZYJ', iloscKg: -4685.98, debtorno: '' })
  const second = row({ stkmoveno: 100011, typ: 'SORT', loccode: 'BOKS1', iloscKg: 4685.98, debtorno: '' })

  it('przenosi niesparowany wiersz do następnej partii zamiast zgłaszać błąd', async () => {
    const { context, commands } = buildContext()

    const batch1 = await applyMovementBatch(context, [first], { final: false })
    expect(batch1.outcomes).toHaveLength(0)
    expect(batch1.carry.map((item) => item.stkmoveno)).toEqual([100010])
    expect(commands).toHaveLength(0)

    const batch2 = await applyMovementBatch(context, [second], { carry: batch1.carry, final: true })
    expect(commands).toHaveLength(1)
    expect(batch2.outcomes[0].externalId).toBe('100010+100011')
    expect(batch2.carry).toHaveLength(0)
  })

  it('dopiero ostatnia partia zgłasza wiersz, który nigdy nie dostał pary', async () => {
    const { context } = buildContext()
    const result = await applyMovementBatch(context, [first], { final: true })
    expect(result.outcomes[0]).toMatchObject({ action: 'failed', stkmoveno: 100010 })
    expect(result.outcomes[0].error).toContain('bez pary')
  })
})

describe('applyMovementBatch — masa rozłożona na partie (FIFO)', () => {
  /**
   * Odkąd przyjęcie zakłada partię, WMS prowadzi saldo osobno dla każdej z nich
   * i rozwiązuje je DOKŁADNIE. Ruch bez `lotId` trafia w saldo bezpartyjne —
   * zerowe — i wraca z `insufficient_stock`, choć odpad leży na placu. Dlatego
   * jeden kwit legacy bywa kilkoma ruchami magazynowymi.
   *
   * Partie podajemy w kolejności innej niż chronologiczna, żeby test sprawdzał
   * sortowanie, a nie kolejność zwróconą przez bazę.
   */
  const partie = [
    { id: 'lot-c', lotNumber: 'PZ/100005', manufacturedAt: new Date('2026-09-03T06:00:00'), dostepne: 400 },
    { id: 'lot-a', lotNumber: 'PZ/100001', manufacturedAt: new Date('2026-09-01T06:00:00'), dostepne: 500 },
    { id: 'lot-b', lotNumber: 'PZ/100003', manufacturedAt: new Date('2026-09-02T06:00:00'), dostepne: 300 },
  ]

  const paraSort = (kg: number) => [
    row({ stkmoveno: 100010, typ: 'SORT', loccode: 'PRZYJ', iloscKg: -kg, debtorno: '' }),
    row({ stkmoveno: 100011, typ: 'SORT', loccode: 'BOKS1', iloscKg: kg, debtorno: '' }),
  ]

  it('wysortowanie schodzi z partii od najstarszej, aż zbierze swoją masę', async () => {
    const { context, commands } = buildContext({ partie })
    const { outcomes } = await applyMovementBatch(context, paraSort(900), { final: true })

    expect(commands.map((command) => [command.input.lotId, command.input.quantity])).toEqual([
      ['lot-a', 500],
      ['lot-b', 300],
      ['lot-c', 100],
    ])
    // Rozbicie na partie nie rozbija kwitu: wynik pozycji jest nadal jeden.
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ action: 'create', externalId: '100010+100011' })
  })

  it('podzielony ruch niesie licznik części — inaczej wygląda jak trzy wysortowania', async () => {
    const { context, commands } = buildContext({ partie })
    await applyMovementBatch(context, paraSort(900), { final: true })

    expect(commands.map((command) => (command.input.metadata as { czescRuchu?: unknown }).czescRuchu)).toEqual([
      { nr: 1, z: 3 },
      { nr: 2, z: 3 },
      { nr: 3, z: 3 },
    ])
    // Numery z legacy zostają na każdej części — po nich wraca się do kwitu.
    for (const command of commands) {
      expect((command.input.metadata as { legacy: { stkmoveno: number[] } }).legacy.stkmoveno).toEqual([100010, 100011])
    }
  })

  it('ruch mieszczący się w jednej partii nie dostaje licznika części', async () => {
    const { context, commands } = buildContext({ partie })
    await applyMovementBatch(context, paraSort(400), { final: true })

    expect(commands).toHaveLength(1)
    expect((commands[0].input.metadata as { czescRuchu?: unknown }).czescRuchu).toBeUndefined()
  })

  it('wydanie też schodzi po partiach, ujemną korektą na każdej', async () => {
    const { context, commands } = buildContext({ partie })
    await applyMovementBatch(
      context,
      [row({ stkmoveno: 100030, typ: 'WZ', loccode: 'BOKS1', iloscKg: -700, debtorno: 'D005' })],
      { final: true },
    )

    expect(commands.map((command) => [command.input.lotId, command.input.delta])).toEqual([
      ['lot-a', -500],
      ['lot-b', -200],
    ])
  })

  it('brak pokrycia w partiach mówi, ile brakuje — zamiast gołego insufficient_stock', async () => {
    const { context, commands } = buildContext({ partie })
    const { outcomes } = await applyMovementBatch(context, paraSort(5000), { final: true })

    // Nic nie idzie do magazynu: brak pokrycia rozstrzyga się przed pierwszą komendą.
    expect(commands).toHaveLength(0)
    expect(outcomes[0].action).toBe('failed')
    expect(outcomes[0].error).toContain('insufficient_stock')
    expect(outcomes[0].error).toContain('5000.00')
    expect(outcomes[0].error).toContain('1200.00')
  })

  it('przerwany import dokłada brakującą resztę, nie powtarza całości', async () => {
    const { context, commands } = buildContext({ partie, juzWKsiedze: 500 })
    await applyMovementBatch(context, paraSort(900), { final: true })

    // 500 kg już weszło, więc zostaje 400 — a nie 900 po raz drugi.
    expect(commands.map((command) => command.input.quantity)).toEqual([400])
  })

  it('wiersz w całości zapisany zostaje pominięty przy powtórce', async () => {
    const { context, commands } = buildContext({ partie, juzWKsiedze: 900 })
    const { outcomes } = await applyMovementBatch(context, paraSort(900), { final: true })

    expect(commands).toHaveLength(0)
    expect(outcomes[0].action).toBe('skip')
  })
})
