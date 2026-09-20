import { ensureFractions, loadFractionIndex } from '../fractions'
import type { LegacyFractionRow } from '../legacyFiles'

/**
 * Frakcja odpadu zostaje pozycją katalogu, bo dopiero wtedy WMS może prowadzić
 * dla niej stany, a sprzedaż wystawić wydanie. Profil zapasu dokłada próg
 * wysyłki - wiedzę, której `stockmaster` nie miał gdzie trzymać.
 */

type FakeRow = Record<string, unknown> & { id?: string }

function fakeEm(existing: FakeRow[] = []) {
  const store = [...existing]
  const created: FakeRow[] = []
  return {
    created,
    em: {
      findOne: jest.fn(async (_entity: unknown, where: Record<string, unknown>) =>
        store.find((row) =>
          Object.entries(where).every(([key, value]) => row[key] === value),
        ) ?? null,
      ),
      find: jest.fn(async () => store),
      create: jest.fn((_entity: unknown, data: FakeRow) => {
        const row = { id: `id-${created.length + 1}`, ...data }
        created.push(row)
        store.push(row)
        return row
      }),
      persist: jest.fn(),
      flush: jest.fn(async () => undefined),
    },
  }
}

const scope = { organizationId: 'org-1', tenantId: 'ten-1' }

function fraction(overrides: Partial<LegacyFractionRow> = {}): LegacyFractionRow {
  return {
    stockid: '20 01 01',
    nazwa: 'Papier i tektura',
    kategoria: 'SUR',
    jednostka: 'kg',
    koszt: 0.32,
    ...overrides,
  }
}

describe('ensureFractions', () => {
  it('zakłada produkt, wariant i profil zapasu dla nowej frakcji', async () => {
    const { em, created } = fakeEm()
    const result = await ensureFractions(em as never, scope, [fraction()])

    expect(created).toHaveLength(3)
    expect(result.index.get('20 01 01')).toBeDefined()
  })

  it('kod odpadu staje się SKU wariantu - po nim odnajdzie się go w każdym module', async () => {
    const { em, created } = fakeEm()
    await ensureFractions(em as never, scope, [fraction()])

    const variant = created.find((row) => row.sku === '20 01 01' && row.isDefault === true)
    expect(variant).toBeDefined()
    expect(variant?.name).toBe('Papier i tektura')
  })

  it('magazyn prowadzi frakcję w kilogramach, bo w takich jednostkach waży się odpad', async () => {
    const { em, created } = fakeEm()
    await ensureFractions(em as never, scope, [fraction()])

    const profile = created.find((row) => row.defaultUom !== undefined)
    expect(profile).toMatchObject({ defaultUom: 'kg', defaultStrategy: 'fifo', trackLot: false })
  })

  it('zapisuje próg wysyłki dla znanych frakcji, a dla nieznanej zostawia go pustym', async () => {
    const { em, created } = fakeEm()
    await ensureFractions(em as never, scope, [fraction(), fraction({ stockid: '99 99 99', nazwa: 'Nowa' })])

    const profiles = created.filter((row) => row.defaultUom !== undefined)
    expect(profiles[0].reorderPoint).toBe('8000')
    expect(profiles[1].reorderPoint).toBeNull()
  })

  it('pamięta w metadanych, że pozycja przyszła z systemu legacy', async () => {
    const { em, created } = fakeEm()
    await ensureFractions(em as never, scope, [fraction()])

    const profile = created.find((row) => row.defaultUom !== undefined)
    expect(profile?.metadata).toMatchObject({ legacyStockid: '20 01 01', kategoria: 'SUR' })
  })

  it('drugi import nie tworzy drugiego wariantu o tym samym SKU', async () => {
    const product = { id: 'p-1', title: 'Papier', organizationId: 'org-1', tenantId: 'ten-1' }
    const variant = {
      id: 'v-1',
      sku: '20 01 01',
      product,
      organizationId: 'org-1',
      tenantId: 'ten-1',
    }
    const profile = {
      id: 'pr-1',
      catalogVariantId: 'v-1',
      organizationId: 'org-1',
      tenantId: 'ten-1',
      reorderPoint: '1',
    }
    const { em, created } = fakeEm([product, variant, profile])

    const result = await ensureFractions(em as never, scope, [fraction({ nazwa: 'Papier i tektura (nowa nazwa)' })])

    expect(created).toHaveLength(0)
    expect(variant.name).toBe('Papier i tektura (nowa nazwa)')
    expect(profile.reorderPoint).toBe('8000')
    expect(result.index.get('20 01 01')).toEqual({ productId: 'p-1', variantId: 'v-1' })
  })

  it('pomija wiersz bez kodu odpadu', async () => {
    const { em, created } = fakeEm()
    const result = await ensureFractions(em as never, scope, [fraction({ stockid: '  ' })])
    expect(created).toHaveLength(0)
    expect(result.index.size).toBe(0)
  })
})

describe('loadFractionIndex', () => {
  it('buduje indeks SKU → wariant, pomijając pozycje bez SKU', async () => {
    const { em } = fakeEm([
      { id: 'v-1', sku: '20 01 01', product: { id: 'p-1' } },
      { id: 'v-2', sku: null, product: { id: 'p-2' } },
    ])
    const index = await loadFractionIndex(em as never, scope)
    expect(index.size).toBe(1)
    expect(index.get('20 01 01')).toEqual({ productId: 'p-1', variantId: 'v-1' })
  })
})
