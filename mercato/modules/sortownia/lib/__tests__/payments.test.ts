import { applyPayments, paymentReferenceFor } from '../payments'
import type { LegacyPaymentRow } from '../legacyFiles'

/**
 * Wpłata bez alokacji na dokument to kwota wisząca w powietrzu: saldo
 * należności jej nie widzi, więc pytanie „ile nam wiszą" zostaje bez
 * odpowiedzi. Te testy pilnują właśnie alokacji, idempotencji i tego, że
 * wpłata bez zamówienia nie wchodzi po cichu.
 */

const scope = { organizationId: 'org-1', tenantId: 'ten-1' }

function payment(overrides: Partial<LegacyPaymentRow> = {}): LegacyPaymentRow {
  return {
    transno: 9001,
    debtorno: 'D005',
    orderno: 5003,
    data: '2026-09-14',
    typ: 'ZAPL',
    kwotaBrutto: 1979.7,
    ...overrides,
  }
}

function makeCtx(options: { payments?: unknown[]; invoices?: unknown[] } = {}) {
  const calls: Array<{ id: string; input: Record<string, unknown> }> = []
  const find = jest.fn(async (entity: unknown) => {
    const name = (entity as { name?: string })?.name ?? String(entity)
    if (name.includes('Invoice')) return options.invoices ?? [{ id: 'inv-1', order: { id: 'ord-3' } }]
    return options.payments ?? []
  })
  return {
    calls,
    ctx: {
      em: { find } as never,
      commandBus: {
        execute: jest.fn(async (id: string, payload: { input: Record<string, unknown> }) => {
          calls.push({ id, input: payload.input })
          return { result: { paymentId: 'pay-1' }, logEntry: null }
        }),
      } as never,
      commandContext: {} as never,
      scope,
      orders: new Map([[5003, 'ord-3']]),
    },
  }
}

describe('paymentReferenceFor', () => {
  it('znaczy wpłatę numerem ze starego systemu', () => {
    expect(paymentReferenceFor(9001)).toBe('ZAPL/9001')
  })
})

describe('applyPayments', () => {
  it('zapisuje wpłatę komendą sprzedaży', async () => {
    const { ctx, calls } = makeCtx()
    await applyPayments(ctx, [payment()])
    expect(calls.map((call) => call.id)).toEqual(['sales.payments.create'])
  })

  it('rozlicza wpłatę na fakturze, a nie zostawia jej bez dokumentu', async () => {
    const { ctx, calls } = makeCtx()
    await applyPayments(ctx, [payment()])
    expect(calls[0].input.allocations).toEqual([
      { invoiceId: 'inv-1', amount: 1979.7, currencyCode: 'PLN' },
    ])
  })

  it('gdy faktury jeszcze nie ma, alokuje na zamówienie zamiast gubić kwotę', async () => {
    const { ctx, calls } = makeCtx({ invoices: [] })
    await applyPayments(ctx, [payment()])
    expect(calls[0].input.allocations).toEqual([
      { orderId: 'ord-3', amount: 1979.7, currencyCode: 'PLN' },
    ])
  })

  it('niesie numer wpłaty ze starego systemu - po nim poznajemy duplikat', async () => {
    const { ctx, calls } = makeCtx()
    await applyPayments(ctx, [payment()])
    expect(calls[0].input.paymentReference).toBe('ZAPL/9001')
  })

  it('drugi przebieg nie księguje tej samej wpłaty dwa razy', async () => {
    const { ctx, calls } = makeCtx({ payments: [{ paymentReference: 'ZAPL/9001', amount: '1979.70' }] })
    const result = await applyPayments(ctx, [payment()])
    expect(calls).toHaveLength(0)
    expect(result.outcomes[0].action).toBe('skip')
  })

  it('zgłasza rozjazd, gdy kwota u źródła zmieniła się po zaksięgowaniu', async () => {
    const { ctx, calls } = makeCtx({ payments: [{ paymentReference: 'ZAPL/9001', amount: '1979.70' }] })
    const result = await applyPayments(ctx, [payment({ kwotaBrutto: 2500 })])
    // Nie nadpisujemy dokumentu księgowego po cichu, ale milczenie byłoby
    // najgorszą odpowiedzią: ktoś ruszył dane u źródła i trzeba to zobaczyć.
    expect(calls).toHaveLength(0)
    expect(result.outcomes[0].action).toBe('mismatch')
    expect(result.outcomes[0].error).toContain('1979.70')
    expect(result.outcomes[0].error).toContain('2500.00')
  })

  it('różnica groszowa nie jest rozjazdem - kwoty jadą przez numeric i float', async () => {
    const { ctx } = makeCtx({ payments: [{ paymentReference: 'ZAPL/9001', amount: '1979.7000' }] })
    const result = await applyPayments(ctx, [payment({ kwotaBrutto: 1979.705 })])
    expect(result.outcomes[0].action).toBe('skip')
  })

  it('wpłata bez zamówienia nie wchodzi po cichu', async () => {
    const { ctx, calls } = makeCtx()
    const result = await applyPayments(ctx, [payment({ orderno: 9999 })])
    expect(calls).toHaveLength(0)
    expect(result.outcomes[0]).toMatchObject({ action: 'failed' })
    expect(result.outcomes[0].error).toContain('9999')
  })

  it('kwota wpłaty jest brutto - należność też jest brutto', async () => {
    const { ctx, calls } = makeCtx()
    await applyPayments(ctx, [payment({ kwotaBrutto: 10398.19 })])
    expect(calls[0].input.amount).toBe(10398.19)
  })

  it('błąd jednej wpłaty nie zatrzymuje pozostałych', async () => {
    const { ctx } = makeCtx()
    ;(ctx.commandBus as unknown as { execute: jest.Mock }).execute.mockRejectedValueOnce(
      new Error('księgowość niedostępna'),
    )
    const result = await applyPayments(ctx, [payment(), payment({ transno: 9002 })])
    expect(result.outcomes[0].action).toBe('failed')
    expect(result.outcomes[1].action).toBe('create')
  })
})
