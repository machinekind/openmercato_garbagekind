import { ensureTopology, loadLocationIndex, planFor, WAREHOUSE_CODE } from '../topology'

/**
 * Topologia decyduje, czym w WMS jest plac przyjęć, a czym boks — i ile się
 * w nich mieści. Legacy zna tylko płaską listę kodów, więc jeśli ten plan się
 * rozjedzie, pulpit pokaże zapełnienie liczone względem złej pojemności.
 */

type FakeRow = Record<string, unknown> & { id?: string }

function fakeEm(existing: FakeRow[] = []) {
  const store = [...existing]
  const created: FakeRow[] = []
  return {
    store,
    created,
    em: {
      findOne: jest.fn(async (_entity: unknown, where: Record<string, unknown>) => {
        return (
          store.find((row) =>
            Object.entries(where).every(([key, value]) => {
              if (key === 'warehouse') return true
              return row[key] === value
            }),
          ) ?? null
        )
      }),
      find: jest.fn(async () => store),
      create: jest.fn((_entity: unknown, data: FakeRow) => {
        const row = { id: `id-${created.length + 1}`, ...data }
        created.push(row)
        return row
      }),
      persist: jest.fn(),
      flush: jest.fn(async () => undefined),
    },
  }
}

const scope = { organizationId: 'org-1', tenantId: 'ten-1' }

describe('planFor', () => {
  it('plac przyjęć jest strefą odkładczą, a boks pojemnikiem', () => {
    expect(planFor('PRZYJ')).toMatchObject({ type: 'staging', zoneCode: 'PRZYJECIA' })
    expect(planFor('BOKS1')).toMatchObject({ type: 'bin', zoneCode: 'BOKSY' })
    expect(planFor('MAGRDF')).toMatchObject({ type: 'bin', zoneCode: 'PALIWO' })
  })

  it('każda znana lokalizacja ma pojemność — to informacja, której legacy nie ma', () => {
    for (const code of ['PRZYJ', 'BOKS1', 'BOKS2', 'BOKS3', 'BOKS4', 'MAGRDF']) {
      expect(planFor(code).capacityKg).toBeGreaterThan(0)
    }
  })

  it('nieznany kod dostaje bezpieczny domyślny plan bez zmyślonej pojemności', () => {
    expect(planFor('NOWY-BOKS')).toEqual({ zoneCode: 'BOKSY', type: 'bin', capacityKg: null })
  })

  it('nie rozróżnia wielkości liter — legacy bywa niekonsekwentny', () => {
    expect(planFor('boks1')).toEqual(planFor('BOKS1'))
  })
})

describe('ensureTopology', () => {
  it('zakłada magazyn, strefy i lokalizacje z pojemnością przy pierwszym imporcie', async () => {
    const { em, created } = fakeEm()
    const result = await ensureTopology(em as never, scope, [
      { loccode: 'PRZYJ', locationname: 'Plac przyjec', deladd1: 'ul. Skladowa 2' },
      { loccode: 'BOKS3', locationname: 'Boks 3 - szklo', deladd1: 'ul. Skladowa 2' },
    ])

    const warehouse = created.find((row) => row.code === WAREHOUSE_CODE)
    expect(warehouse).toBeDefined()
    expect(created.filter((row) => row.priority !== undefined)).toHaveLength(3) // trzy strefy

    const boks = created.find((row) => row.code === 'BOKS3')
    expect(boks).toMatchObject({ type: 'bin', capacityWeight: '80000' })
    expect(result.locations.get('BOKS3')).toBeDefined()
    expect(result.created).toBeGreaterThan(0)
  })

  it('zapisuje nazwę i adres z legacy w metadanych, żeby ślad pochodzenia nie zginął', async () => {
    const { em, created } = fakeEm()
    await ensureTopology(em as never, scope, [
      { loccode: 'PRZYJ', locationname: 'Plac przyjec', deladd1: 'ul. Skladowa 2, Wierzbowo' },
    ])

    const location = created.find((row) => row.code === 'PRZYJ')
    expect(location?.metadata).toMatchObject({
      legacyLoccode: 'PRZYJ',
      legacyName: 'Plac przyjec',
      legacyAddress: 'ul. Skladowa 2, Wierzbowo',
    })
  })

  it('drugi import aktualizuje lokalizację zamiast tworzyć drugą o tym samym kodzie', async () => {
    const istniejaca = { id: 'loc-1', code: 'BOKS1', organizationId: 'org-1', tenantId: 'ten-1' }
    const { em, created } = fakeEm([
      { id: 'wh-1', code: WAREHOUSE_CODE, organizationId: 'org-1', tenantId: 'ten-1' },
      { id: 'zone-1', code: 'PRZYJECIA', organizationId: 'org-1', tenantId: 'ten-1' },
      { id: 'zone-2', code: 'BOKSY', organizationId: 'org-1', tenantId: 'ten-1' },
      { id: 'zone-3', code: 'PALIWO', organizationId: 'org-1', tenantId: 'ten-1' },
      istniejaca,
    ])

    const result = await ensureTopology(em as never, scope, [
      { loccode: 'BOKS1', locationname: 'Boks 1 - papier' },
    ])

    expect(created).toHaveLength(0)
    expect(result.updated).toBe(1)
    expect(istniejaca).toMatchObject({ type: 'bin', capacityWeight: '60000' })
  })

  it('pomija puste kody zamiast zakładać lokalizację bez nazwy', async () => {
    const { em, created } = fakeEm()
    const result = await ensureTopology(em as never, scope, [
      { loccode: '   ', locationname: 'nic' },
      { loccode: 'BOKS2', locationname: 'Boks 2' },
    ])
    expect(result.locations.size).toBe(1)
    expect(created.some((row) => row.code === 'BOKS2')).toBe(true)
  })
})

describe('loadLocationIndex', () => {
  it('oddaje pusty indeks, gdy magazynu jeszcze nie ma — import ruchów ma się zatrzymać, nie zgadywać', async () => {
    const { em } = fakeEm()
    const result = await loadLocationIndex(em as never, scope)
    expect(result.warehouse).toBeNull()
    expect(result.byCode.size).toBe(0)
  })

  it('indeksuje lokalizacje po kodzie w wersji wielkimi literami', async () => {
    const { em } = fakeEm([
      { id: 'wh-1', code: WAREHOUSE_CODE, organizationId: 'org-1', tenantId: 'ten-1' },
      { id: 'loc-1', code: 'boks1', organizationId: 'org-1', tenantId: 'ten-1' },
    ])
    const result = await loadLocationIndex(em as never, scope)
    expect(result.byCode.has('BOKS1')).toBe(true)
  })
})
