import {
  debtornoFromSource,
  describeRole,
  ensureCustomers,
  legacySource,
  LEGACY_SOURCE_PREFIX,
} from '../customers'
import type { LegacyCustomerRow } from '../legacyFiles'

/**
 * Kontrahent z płaskiej tabeli `debtorsmaster` zostaje firmą w CRM. Sprawdzamy
 * to, co przesądza o poprawności importu: że idzie komendą (a nie zapisem do
 * encji), że drugi przebieg nie dubluje firm i że NIP nie ginie po drodze —
 * bez niego faktura jest bezwartościowa.
 */

const scope = { organizationId: 'org-1', tenantId: 'ten-1' }

function customer(overrides: Partial<LegacyCustomerRow> = {}): LegacyCustomerRow {
  return {
    debtorno: 'D005',
    nazwa: 'RecycleHub Sp. z o.o.',
    typ: 'ODB',
    miasto: 'Ostroleka',
    waluta: 'PLN',
    klientOd: '2012-04-02',
    nip: '7741130017',
    ...overrides,
  }
}

function makeCtx(existing: Array<{ id: string; source: string }> = []) {
  const calls: Array<{ id: string; input: Record<string, unknown> }> = []
  let counter = 0
  return {
    calls,
    ctx: {
      em: {
        find: jest.fn(async () => existing),
      } as never,
      commandBus: {
        execute: jest.fn(async (id: string, options: { input: Record<string, unknown> }) => {
          calls.push({ id, input: options.input })
          counter += 1
          return { result: { entityId: `ent-${counter}`, companyId: `cmp-${counter}` }, logEntry: null }
        }),
      } as never,
      commandContext: {} as never,
      scope,
    },
  }
}

describe('klucz pochodzenia', () => {
  it('składa i rozkłada znacznik źródła', () => {
    expect(legacySource('D005')).toBe(`${LEGACY_SOURCE_PREFIX}:D005`)
    expect(debtornoFromSource(legacySource('D005'))).toBe('D005')
  })

  it('nie bierze za swoje rekordów o innym pochodzeniu', () => {
    expect(debtornoFromSource('import-reczny:D005')).toBeNull()
    expect(debtornoFromSource(null)).toBeNull()
    expect(debtornoFromSource('')).toBeNull()
  })
})

describe('describeRole', () => {
  it('tłumaczy trzyliterowy kod legacy na rolę czytelną dla człowieka', () => {
    expect(describeRole('DOS')).toBe('Dostawca odpadu')
    expect(describeRole('ODB')).toBe('Odbiorca frakcji')
    expect(describeRole('XXX')).toBe('Kontrahent')
  })
})

describe('ensureCustomers', () => {
  it('zakłada firmę komendą CRM, a nie zapisem do encji — inaczej reszta platformy jej nie zobaczy', async () => {
    const { ctx, calls } = makeCtx()
    await ensureCustomers(ctx, [customer()])
    expect(calls).toHaveLength(1)
    expect(calls[0].id).toBe('customers.companies.create')
  })

  it('zapisuje NIP, bo bez niego faktura jest bezwartościowa', async () => {
    const { ctx, calls } = makeCtx()
    await ensureCustomers(ctx, [customer()])
    expect(String(calls[0].input.description)).toContain('NIP 7741130017')
  })

  it('zapisuje rolę kontrahenta słowami', async () => {
    const { ctx, calls } = makeCtx()
    await ensureCustomers(ctx, [customer({ typ: 'DOS' })])
    expect(String(calls[0].input.description)).toContain('Dostawca odpadu')
  })

  it('znaczy pochodzenie numerem ze starego systemu — to jest klucz idempotencji', async () => {
    const { ctx, calls } = makeCtx()
    await ensureCustomers(ctx, [customer()])
    expect(calls[0].input.source).toBe('sortownia-legacy:D005')
  })

  it('zwraca indeks numer legacy → identyfikator encji, bo sprzedaż potrzebuje właśnie jego', async () => {
    const { ctx } = makeCtx()
    const result = await ensureCustomers(ctx, [customer()])
    expect(result.index.get('D005')).toBe('ent-1')
  })

  it('drugi przebieg nie zakłada firmy po raz drugi', async () => {
    const { ctx, calls } = makeCtx([{ id: 'ent-9', source: 'sortownia-legacy:D005' }])
    const result = await ensureCustomers(ctx, [customer()])
    expect(calls).toHaveLength(0)
    expect(result.outcomes[0].action).toBe('skip')
    expect(result.index.get('D005')).toBe('ent-9')
  })

  it('pomija wiersz bez numeru kontrahenta', async () => {
    const { ctx, calls } = makeCtx()
    const result = await ensureCustomers(ctx, [customer({ debtorno: '  ' })])
    expect(calls).toHaveLength(0)
    expect(result.index.size).toBe(0)
  })

  it('raportuje błąd komendy zamiast wywracać cały import', async () => {
    const { ctx } = makeCtx()
    ;(ctx.commandBus as unknown as { execute: jest.Mock }).execute.mockRejectedValueOnce(
      new Error('CRM niedostępny'),
    )
    const result = await ensureCustomers(ctx, [customer(), customer({ debtorno: 'D006' })])
    expect(result.outcomes[0]).toMatchObject({ action: 'failed', error: 'CRM niedostępny' })
    // Drugi kontrahent i tak ma wejść — jeden zły rekord nie zatrzymuje reszty.
    expect(result.outcomes[1].action).toBe('create')
  })

  it('brak identyfikatora w zwrotce to błąd, a nie cicha zgoda', async () => {
    const { ctx } = makeCtx()
    ;(ctx.commandBus as unknown as { execute: jest.Mock }).execute.mockResolvedValueOnce({
      result: {},
      logEntry: null,
    })
    const result = await ensureCustomers(ctx, [customer()])
    expect(result.outcomes[0].action).toBe('failed')
    expect(result.index.has('D005')).toBe(false)
  })
})
