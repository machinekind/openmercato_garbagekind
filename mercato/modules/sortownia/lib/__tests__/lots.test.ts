import { ensureLots, lotNumberFor } from '../lots'
import type { LegacyMovementRow } from '../legacyFiles'

/**
 * Partia odpowiada na pytanie, którego stary system nie umiał nawet zadać:
 * czyj odpad leży na placu i od kiedy. Te testy pilnują, żeby partia
 * powstawała wyłącznie przy wjeździe, niosła dostawcę i nie dublowała się.
 */

const scope = { organizationId: 'org-1', tenantId: 'ten-1' }

function move(overrides: Partial<LegacyMovementRow> = {}): LegacyMovementRow {
  return {
    stkmoveno: 100001,
    stockid: '20 01 01',
    typ: 'PZ',
    loccode: 'PRZYJ',
    data: '2026-08-21T01:21:47',
    debtorno: 'D001',
    iloscKg: 6412.8,
    iloscMg: 6.413,
    orderno: 0,
    ...overrides,
  }
}

function makeCtx(existing: Array<{ id: string; lotNumber: string }> = []) {
  const calls: Array<{ id: string; input: Record<string, unknown> }> = []
  let counter = 0
  return {
    calls,
    ctx: {
      em: { find: jest.fn(async () => existing) } as never,
      commandBus: {
        execute: jest.fn(async (id: string, payload: { input: Record<string, unknown> }) => {
          calls.push({ id, input: payload.input })
          counter += 1
          return { result: { lotId: `lot-${counter}` }, logEntry: null }
        }),
      } as never,
      commandContext: {} as never,
      scope,
      fractions: new Map([['20 01 01', { productId: 'p-1', variantId: 'v-1' }]]),
      supplierNames: new Map([['D001', 'Gmina Wierzbowo']]),
    },
  }
}

describe('lotNumberFor', () => {
  it('numer partii odtwarza się z numeru przyjęcia', () => {
    expect(lotNumberFor(100001)).toBe('PZ/100001')
  })
})

describe('ensureLots', () => {
  it('zakłada partię komendą magazynu', async () => {
    const { ctx, calls } = makeCtx()
    await ensureLots(ctx, [move()])
    expect(calls.map((call) => call.id)).toEqual(['wms.lots.create'])
  })

  it('partia powstaje tylko przy wjeździe - sortowanie i wydanie jej nie tworzą', async () => {
    const { ctx, calls } = makeCtx()
    const result = await ensureLots(ctx, [
      move({ typ: 'SORT', stkmoveno: 100002 }),
      move({ typ: 'WZ', stkmoveno: 100003 }),
    ])
    expect(calls).toHaveLength(0)
    expect(result.outcomes).toHaveLength(0)
  })

  it('niesie nazwę dostawcy, a nie sam kod z legacy', async () => {
    const { ctx, calls } = makeCtx()
    await ensureLots(ctx, [move()])
    const metadata = calls[0].input.metadata as Record<string, unknown>
    expect(metadata.dostawca).toBe('Gmina Wierzbowo')
  })

  it('gdy kontrahent nie jest znany, zostaje kod - lepszy niż puste pole', async () => {
    const { ctx, calls } = makeCtx()
    await ensureLots(ctx, [move({ debtorno: 'D999' })])
    expect((calls[0].input.metadata as Record<string, unknown>).dostawca).toBe('D999')
  })

  it('zapisuje kod odpadu i masę przyjęcia', async () => {
    const { ctx, calls } = makeCtx()
    await ensureLots(ctx, [move()])
    const metadata = calls[0].input.metadata as Record<string, unknown>
    expect(metadata).toMatchObject({ kodOdpadu: '20 01 01', masaPrzyjeciaKg: 6412.8 })
  })

  it('datą partii jest moment przyjęcia odpadu na plac', async () => {
    const { ctx, calls } = makeCtx()
    await ensureLots(ctx, [move()])
    expect((calls[0].input.manufacturedAt as Date).toISOString()).toBe(
      new Date('2026-08-21T01:21:47').toISOString(),
    )
  })

  it('partia wskazuje wariant katalogowy frakcji', async () => {
    const { ctx, calls } = makeCtx()
    await ensureLots(ctx, [move()])
    expect(calls[0].input).toMatchObject({ catalogVariantId: 'v-1', sku: '20 01 01' })
  })

  it('drugi przebieg nie zakłada tej samej partii', async () => {
    const { ctx, calls } = makeCtx([{ id: 'lot-9', lotNumber: 'PZ/100001' }])
    const result = await ensureLots(ctx, [move()])
    expect(calls).toHaveLength(0)
    expect(result.outcomes[0]).toMatchObject({ action: 'skip', lotId: 'lot-9' })
  })

  it('zwraca indeks, po którym ruch przyjęcia odnajduje swoją partię', async () => {
    const { ctx } = makeCtx()
    const result = await ensureLots(ctx, [move()])
    expect(result.index.get(100001)).toBe('lot-1')
  })

  it('frakcja spoza katalogu zatrzymuje partię z czytelnym powodem', async () => {
    const { ctx, calls } = makeCtx()
    const result = await ensureLots(ctx, [move({ stockid: '99 99 99' })])
    expect(calls).toHaveLength(0)
    expect(result.outcomes[0].action).toBe('failed')
  })

  it('błąd jednej partii nie zatrzymuje pozostałych', async () => {
    const { ctx } = makeCtx()
    ;(ctx.commandBus as unknown as { execute: jest.Mock }).execute.mockRejectedValueOnce(
      new Error('magazyn niedostępny'),
    )
    const result = await ensureLots(ctx, [move(), move({ stkmoveno: 100004 })])
    expect(result.outcomes[0].action).toBe('failed')
    expect(result.outcomes[1].action).toBe('create')
  })
})
