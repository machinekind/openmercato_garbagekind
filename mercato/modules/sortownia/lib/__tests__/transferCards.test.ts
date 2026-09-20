import { applyTransferCards, cardNumberFor } from '../transferCards'
import type { LegacyOrderRow } from '../legacyFiles'

/**
 * Karta przekazania odpadu dokumentuje rzecz, która wyjechała bramą - tak jak
 * faktura dokumentuje pieniądze. Trzy rzeczy muszą się na niej zgadzać i każda
 * ma tu swój test: masa co do dekagrama, kod procesu odzysku i numery
 * rejestrowe obu stron.
 */

const scope = { organizationId: 'org-1', tenantId: 'ten-1' }

function order(overrides: Partial<LegacyOrderRow> = {}): LegacyOrderRow {
  return {
    orderno: 5001,
    debtorno: 'D005',
    dataZamowienia: '2026-08-20',
    dataWydania: '2026-08-22',
    stockid: '20 01 01',
    iloscKg: 3803.73,
    cenaKg: 0.432,
    ...overrides,
  }
}

function makeCtx(options: { shipments?: unknown[]; fulfilled?: number[] } = {}) {
  const calls: Array<{ id: string; input: Record<string, unknown> }> = []
  const find = jest.fn(async (entity: unknown) => {
    const name = (entity as { name?: string })?.name ?? String(entity)
    if (name.includes('Shipment')) return options.shipments ?? []
    return [{ id: 'line-1', order: { id: 'ord-1' } }]
  })
  return {
    calls,
    ctx: {
      em: { find } as never,
      commandBus: {
        execute: jest.fn(async (id: string, payload: { input: Record<string, unknown> }) => {
          calls.push({ id, input: payload.input })
          return { result: { shipmentId: 'shp-1' }, logEntry: null }
        }),
      } as never,
      commandContext: {} as never,
      scope,
      orders: new Map([[5001, 'ord-1']]),
      // Karta powstaje tylko dla wydania, które faktycznie zaszło.
      fulfilled: new Set<number>(options.fulfilled ?? [5001, 9999]),
      bdoByDebtor: new Map([['D005', '000118340']]),
      recoveryByStock: new Map([['20 01 01', 'R3']]),
      ownBdo: '000000001',
    },
  }
}

describe('cardNumberFor', () => {
  it('numer karty odtwarza się z numeru wydania', () => {
    expect(cardNumberFor(5001)).toBe('KPO/5001')
  })
})

describe('applyTransferCards', () => {
  it('wystawia kartę jako wysyłkę na zamówieniu', async () => {
    const { ctx, calls } = makeCtx()
    await applyTransferCards(ctx, [order()])
    expect(calls.map((call) => call.id)).toEqual(['sales.shipments.create'])
    expect(calls[0].input.shipmentNumber).toBe('KPO/5001')
  })

  it('masa idzie z pełną dokładnością - to ona jest treścią karty', async () => {
    const { ctx, calls } = makeCtx()
    await applyTransferCards(ctx, [order()])
    expect(calls[0].input).toMatchObject({ weightValue: 3803.73, weightUnit: 'kg' })
  })

  it('ilość pozycji zaokrągla się W DÓŁ, bo platforma odrzuca wysyłkę ponad zamówienie', async () => {
    const { ctx, calls } = makeCtx()
    await applyTransferCards(ctx, [order()])
    const items = calls[0].input.items as Array<Record<string, unknown>>
    // 3 803,73 zaokrąglone do najbliższej liczby daje 3 804 - o 0,27 kg więcej,
    // niż jest na zamówieniu, i komenda odrzuca taką wysyłkę.
    expect(items[0].quantity).toBe(3803)
    expect(items[0].metadata).toEqual({ masaDokladnaKg: 3803.73 })
  })

  it('niesie kod odpadu i kod procesu odzysku', async () => {
    const { ctx, calls } = makeCtx()
    await applyTransferCards(ctx, [order()])
    expect(calls[0].input.metadata).toMatchObject({ kodOdpadu: '20 01 01', kodProcesu: 'R3' })
  })

  it('wymienia numery rejestrowe obu stron - przekazującego i przejmującego', async () => {
    const { ctx, calls } = makeCtx()
    await applyTransferCards(ctx, [order()])
    expect(calls[0].input.trackingNumbers).toEqual(['000000001', '000118340'])
    expect(calls[0].input.metadata).toMatchObject({
      bdoPrzekazujacego: '000000001',
      bdoPrzejmujacego: '000118340',
    })
  })

  it('brak numeru BDO odbiorcy nie wywraca karty, ale zostaje widoczny', async () => {
    const { ctx, calls } = makeCtx()
    ctx.bdoByDebtor = new Map()
    await applyTransferCards(ctx, [order()])
    expect(calls[0].input.trackingNumbers).toEqual(['000000001'])
    expect((calls[0].input.metadata as Record<string, unknown>).bdoPrzejmujacego).toBeNull()
  })

  it('drugi przebieg nie wystawia drugiej karty za to samo wydanie', async () => {
    const { ctx, calls } = makeCtx({ shipments: [{ shipmentNumber: 'KPO/5001' }] })
    const result = await applyTransferCards(ctx, [order()])
    expect(calls).toHaveLength(0)
    expect(result.outcomes[0].action).toBe('skip')
  })

  it('zamówienie jeszcze niewydane NIE dostaje karty - to byłoby poświadczenie nieprawdy', async () => {
    const { ctx, calls } = makeCtx({ fulfilled: [] })
    const result = await applyTransferCards(ctx, [order()])
    expect(calls).toHaveLength(0)
    expect(result.outcomes).toHaveLength(0)
  })

  it('wydanie bez zamówienia w Mercato nie dostaje karty po cichu', async () => {
    const { ctx, calls } = makeCtx()
    const result = await applyTransferCards(ctx, [order({ orderno: 9999 })])
    expect(calls).toHaveLength(0)
    expect(result.outcomes[0].action).toBe('failed')
  })
})
