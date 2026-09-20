import { applyReservations } from '../reservations'
import type { LegacyOrderRow } from '../legacyFiles'

/**
 * Rezerwacja odpowiada na pytanie, którego `locstock` nie umiał nawet
 * sformułować: ile z tego, co leży, jest jeszcze wolne. Bez niej magazynier
 * obiecuje ten sam boks dwóm odbiorcom, a brak wychodzi przy załadunku.
 */

const scope = { organizationId: 'org-1', tenantId: 'ten-1' }

function order(overrides: Partial<LegacyOrderRow> = {}): LegacyOrderRow {
  return {
    orderno: 5041,
    debtorno: 'D005',
    dataZamowienia: '2026-09-16',
    dataWydania: '2026-09-26',
    stockid: '20 01 01',
    iloscKg: 7200,
    cenaKg: 0.432,
    ...overrides,
  }
}

function makeCtx(options: { reservations?: unknown[]; fulfilled?: number[] } = {}) {
  const calls: Array<{ id: string; input: Record<string, unknown> }> = []
  return {
    calls,
    ctx: {
      em: { find: jest.fn(async () => options.reservations ?? []) } as never,
      commandBus: {
        execute: jest.fn(async (id: string, payload: { input: Record<string, unknown> }) => {
          calls.push({ id, input: payload.input })
          return { result: { reservationId: 'res-1' }, logEntry: null }
        }),
      } as never,
      commandContext: {} as never,
      scope,
      warehouseId: 'wh-1',
      fractions: new Map([['20 01 01', { productId: 'p-1', variantId: 'v-1' }]]),
      orders: new Map([[5041, 'ord-41']]),
      fulfilled: new Set<number>(options.fulfilled ?? []),
    },
  }
}

describe('applyReservations', () => {
  it('blokuje masę komendą magazynu, wskazując zamówienie jako źródło', async () => {
    const { ctx, calls } = makeCtx()
    await applyReservations(ctx, [order()])
    expect(calls.map((call) => call.id)).toEqual(['wms.inventory.reserve'])
    expect(calls[0].input).toMatchObject({ sourceType: 'order', sourceId: 'ord-41', quantity: 7200 })
  })

  it('zamówienie już wydane nie dostaje rezerwacji - nie ma czego blokować', async () => {
    const { ctx, calls } = makeCtx({ fulfilled: [5041] })
    const result = await applyReservations(ctx, [order()])
    expect(calls).toHaveLength(0)
    expect(result.outcomes).toHaveLength(0)
  })

  it('rezerwacja wygasa w dniu odbioru, żeby magazyn nie zamarzł na niezabranym zapasie', async () => {
    const { ctx, calls } = makeCtx()
    await applyReservations(ctx, [order()])
    expect((calls[0].input.expiresAt as Date).toISOString()).toBe(
      new Date('2026-09-26').toISOString(),
    )
  })

  it('drugi przebieg nie blokuje tej samej masy dwa razy', async () => {
    const { ctx, calls } = makeCtx({ reservations: [{ sourceId: 'ord-41' }] })
    const result = await applyReservations(ctx, [order()])
    expect(calls).toHaveLength(0)
    expect(result.outcomes[0].action).toBe('skip')
  })

  it('brak pokrycia w magazynie to sygnał biznesowy, a nie awaria importu', async () => {
    const { ctx } = makeCtx()
    ;(ctx.commandBus as unknown as { execute: jest.Mock }).execute.mockRejectedValueOnce(
      new Error('insufficient_stock'),
    )
    const result = await applyReservations(ctx, [order()])
    // Stary system przyjąłby takie zamówienie bez słowa, a brak wyszedłby
    // dopiero przy załadunku. Tutaj odmowa jest widoczna od razu i nazwana.
    expect(result.outcomes[0].action).toBe('insufficient')
  })

  it('awaria techniczna nadal jest awarią, a nie brakiem towaru', async () => {
    const { ctx } = makeCtx()
    ;(ctx.commandBus as unknown as { execute: jest.Mock }).execute.mockRejectedValueOnce(
      new Error('połączenie z bazą zerwane'),
    )
    const result = await applyReservations(ctx, [order()])
    expect(result.outcomes[0].action).toBe('failed')
  })

  it('zamówienie spoza Mercato nie blokuje niczego po cichu', async () => {
    const { ctx, calls } = makeCtx()
    const result = await applyReservations(ctx, [order({ orderno: 9999 })])
    expect(calls).toHaveLength(0)
    expect(result.outcomes[0].action).toBe('failed')
  })
})
