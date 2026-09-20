import {
  closeBatchCommand,
  closeOrderCommand,
  openBatchCommand,
  openOrderCommand,
} from '../commands/workOrders'

/**
 * Testy wiązania komend mostu.
 *
 * Reguła uzgodnienia ma własne testy jako czysta funkcja. Tutaj sprawdzamy
 * rzeczy, których czysta funkcja nie obejmuje, a które przesądzają o tym,
 * czy most jest uczciwy: **co trafia do magazynu** i **czego komenda odmawia**.
 */

type Row = Record<string, unknown>

const ORG = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const scope = { organizationId: ORG, tenantId: TENANT }

function makeCtx(options: {
  order?: Row | null
  batch?: Row | null
  openBatch?: Row | null
  closedBatches?: Row[]
  claimedPieces?: number
  existingOrder?: Row | null
} = {}) {
  const persisted: Row[] = []
  const busCalls: Array<{ id: string; input: Row }> = []

  const em = {
    fork: () => em,
    findOne: jest.fn(async (entity: unknown, where: Row) => {
      const name = (entity as { name?: string })?.name ?? String(entity)
      if (name.includes('WorkOrder')) {
        if (where.orderNumber !== undefined) return options.existingOrder ?? null
        return options.order === undefined ? null : options.order
      }
      if (name.includes('WorkBatch')) {
        if (where.status === 'filling' && where.id === undefined) return options.openBatch ?? null
        return options.batch === undefined ? null : options.batch
      }
      return null
    }),
    find: jest.fn(async () => options.closedBatches ?? []),
    create: jest.fn((entity: unknown, data: Row) => ({
      __table: (entity as { name?: string })?.name,
      ...data,
    })),
    persist: jest.fn((row: Row) => persisted.push(row)),
    flush: jest.fn(async () => {
      for (const row of persisted) if (!row.id) row.id = 'nowy-1'
    }),
    getConnection: () => ({
      execute: jest.fn(async () => [{ claimed: String(options.claimedPieces ?? 0) }]),
    }),
  }

  const bus = {
    execute: jest.fn(async (id: string, payload: { input: Row }) => {
      busCalls.push({ id, input: payload.input })
      if (id === 'wms.lots.create') return { result: { lotId: 'lot-1' } }
      return { result: {} }
    }),
  }

  return {
    persisted,
    busCalls,
    ctx: {
      container: { resolve: (key: string) => (key === 'commandBus' ? bus : em) },
      auth: { sub: '33333333-3333-4333-8333-333333333333' },
    } as never,
  }
}

const ORDER = {
  id: '44444444-4444-4444-8444-444444444444',
  organizationId: ORG,
  orderNumber: 'ZR/2026/001',
  cellId: '55555555-5555-4555-8555-555555555555',
  policyVersionId: null,
  catalogVariantId: '66666666-6666-4666-8666-666666666666',
  sku: '20 01 01',
  warehouseId: '77777777-7777-4777-8777-777777777777',
  locationId: '88888888-8888-4888-8888-888888888888',
  nominalPieceGrams: 30,
  status: 'open',
}

function batchFilling(): Row {
  return {
    id: '99999999-9999-4999-8999-999999999999',
    workOrderId: ORDER.id,
    containerCode: 'BIN-A',
    openedAt: new Date('2026-09-18T06:00:00Z'),
    status: 'filling',
  }
}

describe('work_orders.batches.open', () => {
  it('odmawia drugiej otwartej partii na zleceniu', async () => {
    // Epizody wiąże z partią okno czasowe, więc dwie otwarte partie
    // przypisałyby ten sam chwyt do dwóch pojemników.
    const { ctx } = makeCtx({ order: ORDER, openBatch: batchFilling() })
    await expect(
      openBatchCommand.execute({ ...scope, workOrderId: ORDER.id, containerCode: 'BIN-B' }, ctx),
    ).rejects.toThrow(/już otwartą partię/)
  })

  it('odmawia partii na zleceniu zamkniętym', async () => {
    const { ctx } = makeCtx({ order: { ...ORDER, status: 'completed' } })
    await expect(
      openBatchCommand.execute({ ...scope, workOrderId: ORDER.id, containerCode: 'BIN-B' }, ctx),
    ).rejects.toThrow(/nie przyjmuje partii/)
  })
})

describe('work_orders.batches.close', () => {
  const zamkniecie = {
    ...scope,
    batchId: '99999999-9999-4999-8999-999999999999',
    closedAt: new Date('2026-09-18T08:00:00Z'),
  }

  it('DO MAGAZYNU IDZIE MASA Z WAGI, NIE DEKLARACJA ROBOTA', async () => {
    // Robot zgłosił 1000 chwytów po 30 g = 30 kg. Waga pokazała 24 kg.
    // Do przyjęcia magazynowego musi pójść 24, nigdy 30.
    const { ctx, busCalls } = makeCtx({ order: ORDER, batch: batchFilling(), claimedPieces: 1000 })
    const result = await closeBatchCommand.execute({ ...zamkniecie, weighedGrams: 24_000 }, ctx)

    const receive = busCalls.find((call) => call.id === 'wms.inventory.receive')
    expect(receive).toBeDefined()
    expect(receive!.input.quantity).toBe(24)
    expect(result.verdict).toBe('overclaim')
  })

  it('rozjazd nie wstrzymuje przyjęcia - materiał fizycznie leży w pojemniku', async () => {
    const { ctx, busCalls } = makeCtx({ order: ORDER, batch: batchFilling(), claimedPieces: 1000 })
    const result = await closeBatchCommand.execute({ ...zamkniecie, weighedGrams: 10_000 }, ctx)

    expect(result.requiresReview).toBe(true)
    // Flaga dotyczy maszyny, nie materiału: przyjęcie i tak poszło.
    expect(busCalls.some((call) => call.id === 'wms.inventory.receive')).toBe(true)
  })

  it('pusty pojemnik nie tworzy partii magazynowej ani ruchu', async () => {
    const { ctx, busCalls } = makeCtx({ order: ORDER, batch: batchFilling(), claimedPieces: 0 })
    const result = await closeBatchCommand.execute({ ...zamkniecie, weighedGrams: 0 }, ctx)

    expect(result.lotId).toBeNull()
    expect(busCalls).toHaveLength(0)
  })

  it('dopisuje uzgodnienie jako osobny wpis, nie jako pole partii', async () => {
    const { ctx, persisted } = makeCtx({ order: ORDER, batch: batchFilling(), claimedPieces: 1000 })
    await closeBatchCommand.execute({ ...zamkniecie, weighedGrams: 29_400 }, ctx)

    const uzgodnienie = persisted.find((row) => String(row.__table).includes('Reconciliation'))
    expect(uzgodnienie).toMatchObject({ claimedPieces: 1000, weighedGrams: 29_400, verdict: 'ok' })
  })

  it('odmawia zamknięcia niezerowej masy bez wykonawcy', async () => {
    // Ruch magazynowy bez wykonawcy to masa, która pojawiła się sama.
    const { ctx } = makeCtx({ order: ORDER, batch: batchFilling(), claimedPieces: 10 })
    const bezSesji = { ...(ctx as unknown as Record<string, unknown>), auth: null } as never
    await expect(
      closeBatchCommand.execute({ ...zamkniecie, weighedGrams: 5_000 }, bezSesji),
    ).rejects.toThrow(/wymaga wykonawcy/)
  })

  it('odmawia zamknięcia przed otwarciem', async () => {
    const { ctx } = makeCtx({ order: ORDER, batch: batchFilling(), claimedPieces: 1 })
    await expect(
      closeBatchCommand.execute(
        { ...scope, batchId: zamkniecie.batchId, weighedGrams: 100, closedAt: new Date('2026-09-18T05:00:00Z') },
        ctx,
      ),
    ).rejects.toThrow(/późniejszy niż jej otwarcie/)
  })

  it('nie zamyka partii już zamkniętej', async () => {
    const { ctx } = makeCtx({
      order: ORDER,
      batch: { ...batchFilling(), status: 'closed' },
      claimedPieces: 1,
    })
    await expect(closeBatchCommand.execute({ ...zamkniecie, weighedGrams: 100 }, ctx)).rejects.toThrow(
      /nie da się jej zamknąć/,
    )
  })
})

describe('work_orders.orders.open', () => {
  it('numer zlecenia jest tożsamością', async () => {
    const { ctx } = makeCtx({ existingOrder: { id: 'istnieje' } })
    await expect(
      openOrderCommand.execute(
        {
          ...scope,
          orderNumber: 'ZR/2026/001',
          cellId: ORDER.cellId,
          catalogVariantId: ORDER.catalogVariantId,
          sku: ORDER.sku,
          warehouseId: ORDER.warehouseId,
          locationId: ORDER.locationId,
          targetGrams: 60_000,
        },
        ctx,
      ),
    ).rejects.toThrow(/już istnieje/)
  })
})

describe('work_orders.orders.close', () => {
  it('NIE ZAMYKA ZLECENIA NAD OTWARTYM POJEMNIKIEM', async () => {
    // Pojemnik w trakcie napełniania niesie masę, której nikt nie zważył.
    // Zamknięcie ponad nim zgubiłoby ją bez śladu.
    const { ctx } = makeCtx({ order: ORDER, openBatch: batchFilling() })
    await expect(
      closeOrderCommand.execute({ ...scope, workOrderId: ORDER.id, status: 'completed' }, ctx),
    ).rejects.toThrow(/zamknij ją \(zważ\)/)
  })

  it('sumuje masę z zamkniętych partii', async () => {
    const { ctx } = makeCtx({
      order: ORDER,
      openBatch: null,
      closedBatches: [{ weighedGrams: 29_400 }, { weighedGrams: 24_000 }],
    })
    const result = await closeOrderCommand.execute({ ...scope, workOrderId: ORDER.id }, ctx)
    expect(result.producedGrams).toBe(53_400)
    expect(result.batches).toBe(2)
  })
})
