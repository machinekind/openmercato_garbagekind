import { setGlobalEventBus } from '@open-mercato/shared/modules/events'
import { closeBatchCommand } from '../commands/workOrders'

/**
 * Testy emisji zdarzeń mostu.
 *
 * Sprawdzana jest tu jedna rzecz nieoczywista: zdarzenie o rozjeździe jest
 * wyzwalane **werdyktem**, a nie flagą `requiresReview`. Te dwie rzeczy łatwo
 * pomylić, bo zwykle chodzą razem — ale `requiresReview` jest decyzją
 * o skierowaniu maszyny do przeglądu i może być wyciszona progiem, a werdykt
 * jest tym, co zmierzono. Odbiorca budujący statystykę dryfu potrzebuje
 * pomiaru, nie cudzej decyzji o progu.
 *
 * Druga rzecz: `batch.closed` pada **zawsze**, także przy werdykcie `ok`.
 * Bez tego statystyka dryfu miałaby licznik bez mianownika.
 */

type Row = Record<string, unknown>

const ORG = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const scope = { organizationId: ORG, tenantId: TENANT }

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

function makeCtx(claimedPieces: number) {
  const persisted: Row[] = []
  const em = {
    fork: () => em,
    findOne: jest.fn(async (entity: unknown, where: Row) => {
      const name = (entity as { name?: string })?.name ?? String(entity)
      if (name.includes('WorkOrder')) return ORDER
      if (name.includes('WorkBatch')) {
        if (where.status === 'filling' && where.id === undefined) return null
        return {
          id: '99999999-9999-4999-8999-999999999999',
          workOrderId: ORDER.id,
          containerCode: 'BIN-A',
          openedAt: new Date('2026-09-18T06:00:00Z'),
          status: 'filling',
        }
      }
      return null
    }),
    find: jest.fn(async () => []),
    create: jest.fn((entity: unknown, data: Row) => ({
      __table: (entity as { name?: string })?.name,
      ...data,
    })),
    persist: jest.fn((row: Row) => persisted.push(row)),
    flush: jest.fn(async () => {
      for (const row of persisted) if (!row.id) row.id = 'nowy-1'
    }),
    getConnection: () => ({ execute: jest.fn(async () => [{ claimed: String(claimedPieces) }]) }),
  }
  const bus = {
    execute: jest.fn(async (id: string) =>
      id === 'wms.lots.create' ? { result: { lotId: 'lot-1' } } : { result: {} },
    ),
  }
  return {
    container: { resolve: (key: string) => (key === 'commandBus' ? bus : em) },
    auth: { sub: '33333333-3333-4333-8333-333333333333' },
  } as never
}

const zamkniecie = {
  ...scope,
  batchId: '99999999-9999-4999-8999-999999999999',
  closedAt: new Date('2026-09-18T08:00:00Z'),
}

describe('emisja zdarzeń mostu', () => {
  it('zgodna partia ogłasza zamknięcie, ale nie rozjazd', async () => {
    const seen = captureEvents()
    // 1000 chwytów × 30 g = 30 kg nominalnie; waga 29,4 kg mieści się w tolerancji.
    const result = await closeBatchCommand.execute({ ...zamkniecie, weighedGrams: 29_400 }, makeCtx(1000))
    expect(result.verdict).toBe('ok')
    expect(seen.map((e) => e.id)).toEqual(['work_orders.batch.closed'])
    // Werdykt jedzie także przy zgodności — statystyka dryfu potrzebuje mianownika.
    expect(seen[0].payload).toMatchObject({ verdict: 'ok', weighedGrams: 29_400 })
  })

  it('rozjazd ogłasza oba zdarzenia, a masa w ładunku pochodzi z wagi', async () => {
    const seen = captureEvents()
    const result = await closeBatchCommand.execute({ ...zamkniecie, weighedGrams: 24_000 }, makeCtx(1000))
    expect(result.verdict).toBe('overclaim')
    expect(seen.map((e) => e.id)).toEqual([
      'work_orders.batch.closed',
      'work_orders.batch.drift_detected',
    ])
    const drift = seen[1].payload
    // Nigdy masa wyliczona ze zgłoszeń robota — waga jest jedynym przyrządem
    // pomiarowym w tym łańcuchu.
    expect(drift).toMatchObject({ weighedGrams: 24_000, expectedGrams: 30_000, verdict: 'overclaim' })
  })

  it('brak odniesienia też jest rozjazdem, choć nie jest winą maszyny', async () => {
    // Zlecenie bez masy nominalnej: nie da się powiedzieć, ile powinno wyjść.
    // Werdykt `no_reference` musi wyjść na zewnątrz, bo inaczej wygląda jak zgodność.
    const seen = captureEvents()
    const ctx = makeCtx(1000)
    const em = (ctx as unknown as { container: { resolve: (k: string) => Record<string, unknown> } }).container.resolve('em')
    ;(em.findOne as jest.Mock).mockImplementation(async (entity: unknown, where: Row) => {
      const name = (entity as { name?: string })?.name ?? String(entity)
      if (name.includes('WorkOrder')) return { ...ORDER, nominalPieceGrams: null }
      if (name.includes('WorkBatch')) {
        if (where.status === 'filling' && where.id === undefined) return null
        return {
          id: '99999999-9999-4999-8999-999999999999',
          workOrderId: ORDER.id,
          containerCode: 'BIN-A',
          openedAt: new Date('2026-09-18T06:00:00Z'),
          status: 'filling',
        }
      }
      return null
    })
    const result = await closeBatchCommand.execute({ ...zamkniecie, weighedGrams: 24_000 }, ctx)
    expect(result.verdict).toBe('no_reference')
    expect(seen.map((e) => e.id)).toContain('work_orders.batch.drift_detected')
  })
})
