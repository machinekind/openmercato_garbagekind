import {
  ENTITY_CUSTOMERS,
  ENTITY_FRACTIONS,
  ENTITY_PAYMENTS,
  ENTITY_SALES_ORDERS,
  ENTITY_MOVEMENTS,
  ENTITY_TOPOLOGY,
  PROVIDER_KEY,
  parseMovementCursor,
  resolveCredentials,
  sortowniaLegacyAdapter,
} from '../adapter'

/**
 * Adapter jest kontraktem z hubem Data Sync: to on decyduje, co operator może
 * uruchomić, od czego wznowi się przerwany przebieg i czym moduł łączy się
 * ze starym systemem. Kontrakt sprawdzamy tu, a nie klikaniem po panelu.
 */

describe('resolveCredentials', () => {
  const keys = ['SORTOWNIA_RPC_URL', 'SORTOWNIA_RPC_USER', 'SORTOWNIA_RPC_PASSWORD', 'SORTOWNIA_RPC_COMPANY']
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of keys) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key] as string
    }
  })

  it('ma domyślne ustawienia demo, żeby świeża instalacja działała bez klikania', () => {
    expect(resolveCredentials(undefined)).toEqual({
      endpoint: 'http://127.0.0.1:8088/api/api_xml-rpc.php',
      user: 'demo',
      password: 'demo',
      company: 'weberpdemo',
    })
  })

  it('czyta preconfigurację ze środowiska wdrożenia', () => {
    process.env.SORTOWNIA_RPC_URL = 'https://weberp.example/api/api_xml-rpc.php'
    process.env.SORTOWNIA_RPC_COMPANY = 'produkcja'
    const credentials = resolveCredentials(undefined)
    expect(credentials.endpoint).toBe('https://weberp.example/api/api_xml-rpc.php')
    expect(credentials.company).toBe('produkcja')
  })

  it('wartości z integracji wygrywają ze środowiskiem - panel jest ważniejszy niż .env', () => {
    process.env.SORTOWNIA_RPC_URL = 'https://ze-srodowiska.example/api'
    const credentials = resolveCredentials({ endpoint: 'https://z-panelu.example/api', user: 'operator' })
    expect(credentials.endpoint).toBe('https://z-panelu.example/api')
    expect(credentials.user).toBe('operator')
  })

  it('pusty string z panelu nie kasuje konfiguracji', () => {
    process.env.SORTOWNIA_RPC_USER = 'ze-srodowiska'
    expect(resolveCredentials({ user: '   ' }).user).toBe('ze-srodowiska')
  })
})

describe('parseMovementCursor', () => {
  it('czyta zapisany kursor', () => {
    expect(parseMovementCursor('{"lastMoveNo":100242}')).toEqual({ lastMoveNo: 100242 })
  })

  it('pierwszy przebieg startuje od zera', () => {
    expect(parseMovementCursor(null)).toEqual({ lastMoveNo: 0 })
    expect(parseMovementCursor('')).toEqual({ lastMoveNo: 0 })
  })

  it('przyjmuje gołą liczbę, bo starsze przebiegi zapisywały kursor tak', () => {
    expect(parseMovementCursor('100100')).toEqual({ lastMoveNo: 100100 })
  })

  it('uszkodzony kursor cofa import do początku zamiast go wywracać - duplikaty i tak odpadną', () => {
    expect(parseMovementCursor('{zepsute')).toEqual({ lastMoveNo: 0 })
    expect(parseMovementCursor('{"lastMoveNo":"nie-liczba"}')).toEqual({ lastMoveNo: 0 })
  })
})

describe('kontrakt adaptera', () => {
  it('przedstawia się hubowi jako import z sześcioma zbiorami danych', () => {
    expect(sortowniaLegacyAdapter.providerKey).toBe(PROVIDER_KEY)
    expect(sortowniaLegacyAdapter.direction).toBe('import')
    expect(sortowniaLegacyAdapter.supportedEntities).toEqual([
      ENTITY_TOPOLOGY,
      ENTITY_FRACTIONS,
      ENTITY_CUSTOMERS,
      ENTITY_SALES_ORDERS,
      ENTITY_PAYMENTS,
      ENTITY_MOVEMENTS,
    ])
  })

  it('kolejność zbiorów nie jest kosmetyczna - zamówienie wymaga kontrahenta i frakcji, ruch WZ wymaga zamówienia', () => {
    const order = sortowniaLegacyAdapter.supportedEntities
    expect(order.indexOf(ENTITY_CUSTOMERS)).toBeLessThan(order.indexOf(ENTITY_SALES_ORDERS))
    expect(order.indexOf(ENTITY_FRACTIONS)).toBeLessThan(order.indexOf(ENTITY_SALES_ORDERS))
    expect(order.indexOf(ENTITY_SALES_ORDERS)).toBeLessThan(order.indexOf(ENTITY_MOVEMENTS))
    // Wpłata nie ma czego rozliczyć, dopóki nie ma faktury z zamówienia.
    expect(order.indexOf(ENTITY_SALES_ORDERS)).toBeLessThan(order.indexOf(ENTITY_PAYMENTS))
  })

  it('daje operatorowi przebieg próbny i nie wystawia żadnego parametru z sekretem', () => {
    const parameters = sortowniaLegacyAdapter.runParameters ?? []
    expect(parameters.map((parameter) => parameter.key)).toEqual(['dryRun'])
    expect(parameters[0]).toMatchObject({ type: 'boolean', defaultValue: false })
    // Parametry przebiegu są widoczne dla operatora i zapisywane jawnie.
    expect(JSON.stringify(parameters)).not.toMatch(/password|secret|token/i)
  })

  it('parametr ma klucz tłumaczenia, bo panel bywa po angielsku', () => {
    expect(sortowniaLegacyAdapter.runParameters?.[0]).toHaveProperty('labelKey')
  })

  it('pozwala wymusić pełną synchronizację i rozmiar partii', () => {
    expect(sortowniaLegacyAdapter.supportsStartControl?.('fullSync', ENTITY_MOVEMENTS)).toBe(true)
    expect(sortowniaLegacyAdapter.supportsStartControl?.('batchSize', ENTITY_MOVEMENTS)).toBe(true)
  })

  it('każdy zbiór danych ma mapowanie z kluczem deduplikacji', async () => {
    for (const entityType of sortowniaLegacyAdapter.supportedEntities) {
      const mapping = await sortowniaLegacyAdapter.getMapping({
        entityType,
        scope: { organizationId: 'org-1', tenantId: 'ten-1' },
      })
      expect(mapping.entityType).toBe(entityType)
      expect(mapping.fields.some((field) => field.dedupeRole === 'primary')).toBe(true)
    }
  })

  it('ruchy dedupikują się po numerze ze starego systemu', async () => {
    const mapping = await sortowniaLegacyAdapter.getMapping({
      entityType: ENTITY_MOVEMENTS,
      scope: { organizationId: 'org-1', tenantId: 'ten-1' },
    })
    const primary = mapping.fields.find((field) => field.dedupeRole === 'primary')
    expect(primary).toMatchObject({ externalField: 'stkmoveno', mappingKind: 'external_id' })
  })

  it('pierwszy przebieg nie dostaje kursora - ma przejść całą księgę', async () => {
    await expect(
      sortowniaLegacyAdapter.getInitialCursor?.({
        entityType: ENTITY_MOVEMENTS,
        scope: { organizationId: 'org-1', tenantId: 'ten-1' },
      }),
    ).resolves.toBeNull()
  })
})
