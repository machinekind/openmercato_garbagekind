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

type Bucket = { lot: { id: string } | null; quantityOnHand: string; quantityReserved?: string; quantityAllocated?: string }

function bucket(lotId: string | null, onHand: number, reserved = 0): Bucket {
  return { lot: lotId ? { id: lotId } : null, quantityOnHand: String(onHand), quantityReserved: String(reserved), quantityAllocated: '0' }
}

/** Domyślnie w każdej lokalizacji leży jedna partia z zapasem, żeby ruch miał co zdejmować. */
const DEFAULT_BUCKETS: Bucket[] = [bucket('lot-a', 100000)]

function buildContext(
  options: { existingMovement?: boolean; existingQuantity?: number; failOn?: string; buckets?: Bucket[] } = {},
) {
  const commands: RecordedCommand[] = []
  const context = {
    em: {
      find: jest.fn(async (entity: { name?: string }) => {
        if (entity?.name === 'InventoryMovement') {
          if (options.existingMovement) return [{ quantity: String(options.existingQuantity ?? 1000000) }]
          return []
        }
        return options.buckets ?? DEFAULT_BUCKETS
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
      lotId: 'lot-a',
      type: 'transfer',
      reasonCode: 'SORT',
      referenceId: legacyUuid('movement', 100011),
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
      lotId: 'lot-a',
      reasonCode: 'WZ',
      referenceType: 'so',
    })
    expect(String(commands[0].input.reason)).toContain('D005')
  })

  it('PZ zawsze zapisuje partię z indeksu, jeśli została założona', async () => {
    const { context, commands } = buildContext()
    context.lots = new Map([[100001, 'lot-pz-100001']])
    await applyMovementBatch(context, [row({ stkmoveno: 100001 })], { final: true })
    expect(commands[0].input.lotId).toBe('lot-pz-100001')
  })
})

describe('applyMovementBatch — rozkład na partie', () => {
  const pair = [
    row({ stkmoveno: 100010, typ: 'SORT', loccode: 'PRZYJ', iloscKg: -5000, debtorno: '' }),
    row({ stkmoveno: 100011, typ: 'SORT', loccode: 'BOKS1', iloscKg: 5000, debtorno: '' }),
  ]

  it('jedna para SORT schodzi z kilku partii w kolejności przyjęcia — po jednym ruchu na partię', async () => {
    const { context, commands } = buildContext({
      buckets: [bucket('lot-stara', 3000), bucket('lot-nowa', 4000)],
    })
    const { outcomes } = await applyMovementBatch(context, pair, { final: true })

    expect(commands.map((command) => command.id)).toEqual(['wms.inventory.move', 'wms.inventory.move'])
    expect(commands.map((command) => [command.input.lotId, command.input.quantity])).toEqual([
      ['lot-stara', 3000],
      ['lot-nowa', 2000],
    ])
    // Wszystkie kawałki niosą ten sam odcisk legacy — po numerze wraca się do kwitu.
    const referenceIds = new Set(commands.map((command) => command.input.referenceId))
    expect(referenceIds).toEqual(new Set([legacyUuid('movement', 100011)]))
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ action: 'create', externalId: '100010+100011' })
  })

  it('masa zarezerwowana nie schodzi — liczy się dostępne, nie leżące', async () => {
    const { context, commands } = buildContext({
      buckets: [bucket('lot-a', 5000, 4000), bucket('lot-b', 1000)],
    })
    const { outcomes } = await applyMovementBatch(context, pair, { final: true })
    expect(commands).toHaveLength(0)
    expect(outcomes[0].action).toBe('failed')
    expect(outcomes[0].error).toContain('insufficient_stock')
  })

  it('koszyk bez partii też jest źródłem — przyjęcia sprzed partii nie znikają', async () => {
    const { context, commands } = buildContext({ buckets: [bucket(null, 5000)] })
    await applyMovementBatch(context, pair, { final: true })
    expect(commands).toHaveLength(1)
    expect(commands[0].input.lotId).toBeUndefined()
  })

  it('import przerwany w połowie rozkładu dokłada przy powtórce tylko resztę', async () => {
    const { context, commands } = buildContext({
      existingMovement: true,
      existingQuantity: 3000,
      buckets: [bucket('lot-nowa', 4000)],
    })
    const { outcomes } = await applyMovementBatch(context, pair, { final: true })
    expect(commands).toHaveLength(1)
    expect(commands[0].input.quantity).toBe(2000)
    expect(outcomes[0].action).toBe('create')
  })

  it('WZ z boksu schodzi z partii, więc wiadomo, czyj odpad pojechał do odbiorcy', async () => {
    const { context, commands } = buildContext({
      buckets: [bucket('lot-dostawca-1', 6000), bucket('lot-dostawca-2', 6000)],
    })
    await applyMovementBatch(
      context,
      [row({ stkmoveno: 100030, typ: 'WZ', loccode: 'BOKS1', iloscKg: -9000, debtorno: 'D005' })],
      { final: true },
    )
    expect(commands.map((command) => [command.input.lotId, command.input.delta])).toEqual([
      ['lot-dostawca-1', -6000],
      ['lot-dostawca-2', -3000],
    ])
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
