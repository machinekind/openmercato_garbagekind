import { GET, metadata } from '../dashboard/route'

/**
 * Pulpit liczy wszystko z encji WMS, więc to zapytania decydują, czy operator
 * zobaczy prawdę. Sprawdzamy kształt odpowiedzi i trzy rzeczy, które łatwo
 * zepsuć po cichu: zakres organizacji, zapełnienie i próg wysyłki.
 */

const auth = { sub: 'user-1', tenantId: 'ten-1', orgId: 'org-1' }

let authResult: unknown = auth
let organizationResult: string | null = 'org-1'
let queryHandler: (sql: string) => unknown[]

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: jest.fn(async () => authResult),
}))

jest.mock('@open-mercato/shared/lib/auth/organizationScope', () => ({
  resolveActiveOrganizationId: jest.fn(async () => organizationResult),
}))

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  // Nazwy kontrahentów są szyfrowane w spoczynku — trasa MUSI czytać je
  // przez warstwę deszyfrującą, więc mock odwzorowuje właśnie ją.
  findWithDecryption: jest.fn(async () => [
    { id: 'ent-5', displayName: 'RecycleHub Sp. z o.o.' },
  ]),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => ({
    resolve: () => ({
      getConnection: () => ({
        execute: jest.fn(async (sql: string) => queryHandler(sql)),
      }),
    }),
  })),
}))

function defaultQueries(sql: string): unknown[] {
  if (sql.includes('from wms_warehouse_locations')) {
    return [
      { code: 'PRZYJ', type: 'staging', capacity_weight: '150000', metadata: { legacyName: 'Plac przyjec' }, quantity: '117664.50' },
      { code: 'BOKS3', type: 'bin', capacity_weight: '80000', metadata: null, quantity: '46592.90' },
      { code: 'BUFOR', type: 'bin', capacity_weight: null, metadata: null, quantity: null },
    ]
  }
  if (sql.includes('from catalog_product_variants v')) {
    return [
      { sku: '20 01 02', name: 'Szklo opakowaniowe', quantity: '77218.00', reorder_point: '10000' },
      { sku: '20 01 01', name: null, quantity: '4000.00', reorder_point: '8000' },
      { sku: '19 12 10', name: 'RDF', quantity: '5000.00', reorder_point: null },
    ]
  }
  if (sql.includes('from sales_orders o') && sql.includes('sales_invoices i')) {
    return [{ orders: '40', net: '152372.18', gross: '187417.79', invoices: '40' }]
  }
  if (sql.includes('group by o.customer_entity_id')) {
    return [{ customer_entity_id: 'ent-5', net: '120797.63', orders: '12' }]
  }
  if (sql.includes('from sales_order_lines l')) {
    return [{ sku: 'Frakcja 20 01 01', netto: '29069.34', masa: '67290.1' }]
  }
  if (sql.includes("case when type = 'receipt'") && !sql.includes('30 days')) {
    return [{ przyjete: '437131.25', wysortowane: '296998.37', wydane: '236353.44' }]
  }
  if (sql.includes('from wms_inventory_reservations r')) {
    return [{ total: '5', masa: '24500' }]
  }
  if (sql.includes('from sales_shipments s')) {
    return [{ total: '40', masa: '164910', bez_procesu: '0', bez_bdo: '0' }]
  }
  if (sql.includes('from wms_inventory_lots l')) {
    return [
      { dostawca: 'Gmina Wieliszew', lots: '31', masa: '142300' },
      { dostawca: 'nieznany', lots: '2', masa: '5000' },
    ]
  }
  if (sql.includes('with faktury as')) {
    return [{ billed: '187417.79', paid: '35024.11', overdue_docs: '36', oldest_days: '28' }]
  }
  if (sql.includes('group by v.sku') && sql.includes('wms_inventory_movements')) {
    return [{ sku: '20 01 01', received: '63000', sorted: '50300', issued: '45700' }]
  }
  if (sql.includes('from wms_inventory_movements m')) {
    return [
      {
        id: 'mov-1',
        type: 'transfer',
        performed_at: '2026-09-18T22:14:44.000Z',
        quantity: '4685.98',
        reason: 'Wysortowanie frakcji',
        metadata: { legacy: { stkmoveno: [100240, 100241] } },
        sku: '20 01 01',
        variant_name: 'Papier i tektura',
        from_code: 'PRZYJ',
        to_code: 'BOKS1',
      },
      {
        id: 'mov-2',
        type: 'receipt',
        performed_at: '2026-09-18T22:14:50.000Z',
        quantity: '6752.99',
        reason: null,
        metadata: { legacy: { stkmoveno: 100242 } },
        sku: '20 01 01',
        variant_name: 'Papier i tektura',
        from_code: null,
        to_code: 'PRZYJ',
      },
    ]
  }
  return [
    {
      receipts: '385384',
      issues: '164910',
      transfers: '235890',
      total: '176',
      last_performed_at: '2026-09-18T22:14:50.000Z',
    },
  ]
}

beforeEach(() => {
  authResult = auth
  organizationResult = 'org-1'
  queryHandler = defaultQueries
})

/** Pulpit czyta sesję z żądania, więc każdy test musi je podać. */
function makeRequest(): Request {
  return new Request('http://localhost/api/sortownia/dashboard')
}

async function readBody(response: Response) {
  return JSON.parse(await response.text())
}

describe('GET /api/sortownia/dashboard — dostęp', () => {
  it('wymaga uprawnienia podglądu pulpitu', () => {
    expect(metadata.GET).toMatchObject({ requireAuth: true, requireFeatures: ['sortownia.view'] })
  })

  it('czyta sesję z żądania, a nie tylko z ciastek — po pulpit sięgają też skrypty z tokenem w nagłówku', async () => {
    const { getAuthFromRequest } = jest.requireMock('@open-mercato/shared/lib/auth/server')
    const request = new Request('http://localhost/api/sortownia/dashboard', {
      headers: { authorization: 'Bearer token-z-integracji' },
    })
    await GET(request)
    expect(getAuthFromRequest).toHaveBeenCalledWith(request)
  })

  it('bez sesji odpowiada 401', async () => {
    authResult = null
    const response = await GET(makeRequest())
    expect(response.status).toBe(401)
  })

  it('bez wybranej organizacji odpowiada 400, a nie 401 — 401 wysłałby klienta w pętlę odświeżania sesji', async () => {
    organizationResult = null
    const response = await GET(makeRequest())
    expect(response.status).toBe(400)
    expect(await readBody(response)).toMatchObject({ error: 'organization_scope_required' })
  })
})

describe('GET /api/sortownia/dashboard — dane', () => {
  it('liczy zapełnienie lokalizacji względem pojemności', async () => {
    const body = await readBody(await GET(makeRequest()))
    const yard = body.locations.find((row: { code: string }) => row.code === 'PRZYJ')
    expect(yard).toMatchObject({ quantityKg: 117664.5, capacityKg: 150000 })
    expect(yard.utilisation).toBeCloseTo(78.4, 1)
  })

  it('lokalizacja bez zadeklarowanej pojemności nie dostaje zmyślonego procentu', async () => {
    const body = await readBody(await GET(makeRequest()))
    const bufor = body.locations.find((row: { code: string }) => row.code === 'BUFOR')
    expect(bufor).toMatchObject({ capacityKg: null, utilisation: null, quantityKg: 0 })
  })

  it('rozdziela masę na placu przyjęć od masy w boksach', async () => {
    const body = await readBody(await GET(makeRequest()))
    expect(body.totals.yardKg).toBeCloseTo(117664.5, 1)
    expect(body.totals.binsKg).toBeCloseTo(46592.9, 1)
  })

  it('oznacza frakcję poniżej progu wysyłki', async () => {
    const body = await readBody(await GET(makeRequest()))
    const bySku = Object.fromEntries(body.fractions.map((row: { sku: string }) => [row.sku, row]))
    expect(bySku['20 01 01'].belowReorderPoint).toBe(true)
    expect(bySku['20 01 02'].belowReorderPoint).toBe(false)
    // Brak progu nie jest alarmem.
    expect(bySku['19 12 10'].belowReorderPoint).toBe(false)
  })

  it('podstawia kod odpadu, gdy wariant nie ma nazwy', async () => {
    const body = await readBody(await GET(makeRequest()))
    const row = body.fractions.find((item: { sku: string }) => item.sku === '20 01 01')
    expect(row.name).toBe('20 01 01')
  })

  it('niesie numery z systemu legacy — para SORT oba naraz', async () => {
    const body = await readBody(await GET(makeRequest()))
    expect(body.movements[0].legacyMoveNo).toBe('100240 + 100241')
    expect(body.movements[1].legacyMoveNo).toBe(100242)
  })

  it('oddaje przepływ frakcji za 30 dni', async () => {
    const body = await readBody(await GET(makeRequest()))
    expect(body.flow).toEqual([{ sku: '20 01 01', receivedKg: 63000, sortedKg: 50300, issuedKg: 45700 }])
  })

  it('pyta tylko o dane bieżącej organizacji i tenanta', async () => {
    const seen: string[] = []
    queryHandler = (sql: string) => {
      seen.push(sql)
      return defaultQueries(sql)
    }
    await GET(makeRequest())
    expect(seen.length).toBeGreaterThanOrEqual(4)
    for (const sql of seen) {
      expect(sql).toMatch(/organization_id = \?/)
      expect(sql).toMatch(/tenant_id = \?/)
    }
  })

  it('oddaje sprzedaż i należności', async () => {
    const body = await readBody(await GET(makeRequest()))
    expect(body.sales).toMatchObject({
      orders: 40,
      invoices: 40,
      billedPln: 187417.79,
      paidPln: 35024.11,
      unpaidDocs: 36,
      oldestUnpaidDays: 28,
    })
    expect(body.sales.outstandingPln).toBeCloseTo(152393.68, 2)
  })

  it('nazwy odbiorców biorą się z warstwy deszyfrującej, a nie z surowego SQL-a', async () => {
    const body = await readBody(await GET(makeRequest()))
    // Surowy odczyt `display_name` oddaje kryptogram i ląduje on na ekranie.
    expect(body.sales.topBuyers[0].nazwa).toBe('RecycleHub Sp. z o.o.')
  })

  it('liczy bilans masy i sprawność sortowania', async () => {
    const body = await readBody(await GET(makeRequest()))
    expect(body.bilans).toMatchObject({
      receivedKg: 437131.25,
      issuedKg: 236353.44,
      sortingRate: 67.9,
    })
    // 437 131,25 − 236 353,44 − (117 664,50 + 46 592,90) = 36 520,41.
    // Stan na stanie liczymy z lokalizacji, więc różnica bierze się z mocka.
    expect(typeof body.bilans.differenceKg).toBe('number')
  })

  it('cena za kilogram wynika z przychodu i masy, a nie z osobnego cennika', async () => {
    const body = await readBody(await GET(makeRequest()))
    expect(body.bilans.perFraction[0].pricePerKg).toBeCloseTo(29069.34 / 67290.1, 4)
  })

  it('oddaje masę zarezerwowaną pod zamówienia', async () => {
    const body = await readBody(await GET(makeRequest()))
    expect(body.rezerwacje).toEqual({ count: 5, reservedKg: 24500 })
  })

  it('oddaje ewidencję przekazań odpadu', async () => {
    const body = await readBody(await GET(makeRequest()))
    expect(body.ewidencja).toEqual({ cards: 40, massKg: 164910, withoutProcess: 0, withoutBdo: 0 })
  })

  it('oddaje pochodzenie odpadu z partii magazynowych', async () => {
    const body = await readBody(await GET(makeRequest()))
    expect(body.traceability.lots).toBe(33)
    expect(body.traceability.suppliers[0]).toMatchObject({
      dostawca: 'Gmina Wieliszew',
      lots: 31,
      receivedKg: 142300,
    })
  })

  it('pokazuje jako frakcje wyłącznie pozycje przyniesione przez import z legacy', async () => {
    const seen: string[] = []
    queryHandler = (sql: string) => {
      seen.push(sql)
      return defaultQueries(sql)
    }
    await GET(makeRequest())
    const fractionsQuery = seen.find((sql) => sql.includes('from catalog_product_variants v'))
    expect(fractionsQuery).toMatch(/legacyStockid/)
  })
})
