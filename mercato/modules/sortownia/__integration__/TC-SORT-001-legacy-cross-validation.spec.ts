import { createReadStream } from 'node:fs'
import { access, constants } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'

export const integrationMeta = {
  dependsOnModules: ['sortownia', 'wms', 'catalog'],
}

/**
 * Cross-walidacja: czy Open Mercato mówi to samo, co system legacy.
 *
 * Obie strony liczą z tej samej księgi, ale zupełnie inaczej: legacy trzyma
 * płaskie wiersze `stockmoves` w kilogramach, Mercato prowadzi salda w WMS
 * i zwija parę `SORT` w jeden `transfer`. Jeżeli mapowanie gdzieś się
 * przekłamie - znak przy wydaniu, zgubiona para, jednostka - salda się
 * rozjadą i ten test to pokaże.
 *
 * Źródłem prawdy jest `out/ruchy.csv` (kanał plikowy legacy), a nie
 * `out/stany.csv`: stany są migawką z chwili eksportu, a księga opisuje
 * wszystko, co Mercato zdążyło zaimportować.
 */

/**
 * Katalog zrzutu legacy. Wyliczany z polozenia tego pliku, a nie wpisany na
 * sztywno: absolutna sciezka z jednej stacji roboczej czyni test
 * nieuruchamialnym u kogokolwiek innego. `SORTOWNIA_LEGACY_OUT` nadpisuje.
 */
const LEGACY_OUT =
  process.env.SORTOWNIA_LEGACY_OUT ?? path.resolve(__dirname, '../../../../out')
const MOVEMENTS_CSV = path.join(LEGACY_OUT, 'ruchy.csv')
const ORDERS_CSV = path.join(LEGACY_OUT, 'zamowienia.csv')
const PAYMENTS_CSV = path.join(LEGACY_OUT, 'zaplaty.csv')
const TOLERANCE_KG = 0.05

type LegacyRow = {
  stkmoveno: number
  stockid: string
  typ: 'PZ' | 'SORT' | 'WZ'
  loccode: string
  iloscKg: number
  iloscMg: number
  /** Numer zamówienia, które realizuje to wydanie; 0 dla PZ i SORT. */
  orderno: number
}

type LegacyOrder = {
  orderno: number
  debtorno: string
  stockid: string
  iloscKg: number
  cenaKg: number
}

type DashboardPayload = {
  totals: { yardKg: number; binsKg: number; movements30d: number; movementRows30d: number }
  locations: Array<{ code: string; type: string; quantityKg: number | null; capacityKg: number | null; utilisation: number | null }>
  fractions: Array<{ sku: string; quantityKg: number }>
  movements: Array<{ type: string; legacyMoveNo: number | string | null }>
  rezerwacje?: { count: number; reservedKg: number }
  bilans?: {
    receivedKg: number
    sortedKg: number
    issuedKg: number
    onHandKg: number
    differenceKg: number
    sortingRate: number | null
    perFraction: Array<{ sku: string; netPln: number; soldKg: number; pricePerKg: number | null }>
  }
  ewidencja?: {
    cards: number
    massKg: number
    withoutProcess: number
    withoutBdo: number
  }
  traceability?: {
    lots: number
    suppliers: Array<{ dostawca: string; lots: number; receivedKg: number }>
  }
  sales?: {
    orders: number
    invoices: number
    netPln: number
    grossPln: number
    billedPln: number
    paidPln: number
    outstandingPln: number
    unpaidDocs: number
    topBuyers: Array<{ nazwa: string; netPln: number; orders: number }>
  }
}

function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          field += '"'
          index += 1
        } else quoted = false
      } else field += char
      continue
    }
    if (char === '"') quoted = true
    else if (char === ',') {
      out.push(field)
      field = ''
    } else field += char
  }
  out.push(field)
  return out
}

async function readLegacyLedger(): Promise<LegacyRow[]> {
  const rows: LegacyRow[] = []
  const stream = createReadStream(MOVEMENTS_CSV, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let header: string[] | null = null
  for await (const rawLine of lines) {
    const line = rawLine.replace(/^﻿/, '')
    if (!line.trim()) continue
    const cells = splitCsvLine(line)
    if (!header) {
      header = cells.map((cell) => cell.trim())
      continue
    }
    const record: Record<string, string> = {}
    header.forEach((name, index) => {
      record[name] = (cells[index] ?? '').trim()
    })
    const stkmoveno = Number.parseInt(record.stkmoveno ?? '', 10)
    const typ = (record.typ ?? '').toUpperCase()
    if (!Number.isFinite(stkmoveno)) continue
    if (typ !== 'PZ' && typ !== 'SORT' && typ !== 'WZ') continue
    rows.push({
      stkmoveno,
      stockid: record.stockid ?? '',
      typ,
      loccode: (record.loccode ?? '').toUpperCase(),
      iloscKg: Number.parseFloat((record.ilosc_kg ?? '0').replace(',', '.')),
      iloscMg: Number.parseFloat((record.ilosc_mg ?? '0').replace(',', '.')),
      orderno: Number.parseInt(record.orderno ?? '', 10) || 0,
    })
  }
  return rows
}

async function readLegacyOrders(): Promise<LegacyOrder[]> {
  const rows: LegacyOrder[] = []
  const stream = createReadStream(ORDERS_CSV, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let header: string[] | null = null
  for await (const rawLine of lines) {
    const line = rawLine.replace(/^﻿/, '')
    if (!line.trim()) continue
    const cells = splitCsvLine(line)
    if (!header) {
      header = cells.map((cell) => cell.trim())
      continue
    }
    const record: Record<string, string> = {}
    header.forEach((name, index) => {
      record[name] = (cells[index] ?? '').trim()
    })
    const orderno = Number.parseInt(record.orderno ?? '', 10)
    if (!Number.isFinite(orderno)) continue
    rows.push({
      orderno,
      debtorno: record.debtorno ?? '',
      stockid: record.stockid ?? '',
      iloscKg: Number.parseFloat((record.ilosc_kg ?? '0').replace(',', '.')),
      cenaKg: Number.parseFloat((record.cena_kg ?? '0').replace(',', '.')),
    })
  }
  return rows
}

/** Saldo liczone wprost z księgi legacy: suma ilości per lokalizacja i per frakcja. */
function ledgerBalances(rows: LegacyRow[]) {
  const perLocation = new Map<string, number>()
  const perFraction = new Map<string, number>()
  for (const row of rows) {
    perLocation.set(row.loccode, (perLocation.get(row.loccode) ?? 0) + row.iloscKg)
    perFraction.set(row.stockid, (perFraction.get(row.stockid) ?? 0) + row.iloscKg)
  }
  return { perLocation, perFraction }
}

/**
 * Ile kwitów legacy powinno wejść do magazynu: para SORT zwija się w jeden
 * `transfer`, reszta idzie jeden do jednego.
 *
 * Uwaga: to NIE jest liczba wierszy w księdze WMS. Masa schodzi z konkretnych
 * partii, a komenda magazynowa rusza jedną partię naraz, więc jeden kwit bywa
 * kilkoma ruchami. Niezmiennikiem jest kwit - jego zgubienie albo zdublowanie
 * rozjeżdża salda, a podział na partie nie.
 */
function expectedMovementCount(rows: LegacyRow[]): number {
  const sortRows = rows.filter((row) => row.typ === 'SORT').length
  const rest = rows.length - sortRows
  return rest + sortRows / 2
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.R_OK)
    return true
  } catch {
    return false
  }
}

async function loadDashboard(request: APIRequestContext): Promise<DashboardPayload> {
  // Pulpit ogląda brygadzista, więc sprawdzamy go kontem pracownika:
  // `setup.ts` nadaje roli `employee` uprawnienie `sortownia.view`.
  const token = await getAuthToken(request, 'employee')
  const response = await apiRequest(request, 'GET', '/api/sortownia/dashboard', { token })
  expect(response.status(), 'pulpit sortowni musi odpowiedzieć').toBe(200)
  return (await response.json()) as DashboardPayload
}

test.describe('TC-SORT-001 - zgodność Open Mercato z księgą systemu legacy', () => {
  test.beforeAll(async () => {
    const present = await fileExists(MOVEMENTS_CSV)
    test.skip(!present, `Brak zrzutu legacy: ${MOVEMENTS_CSV}. Uruchom eksport po stronie starego systemu.`)
  })

  test('stan każdej lokalizacji zgadza się z sumą ruchów w księdze legacy', async ({ request }) => {
    const ledger = await readLegacyLedger()
    const { perLocation } = ledgerBalances(ledger)
    const dashboard = await loadDashboard(request)

    for (const location of dashboard.locations) {
      const expectedKg = perLocation.get(location.code.toUpperCase())
      if (expectedKg === undefined) continue
      expect
        .soft(location.quantityKg ?? 0, `lokalizacja ${location.code}`)
        .toBeCloseTo(expectedKg, 1)
    }

    // Żadna lokalizacja z księgi nie może zniknąć po drodze.
    const codes = new Set(dashboard.locations.map((row) => row.code.toUpperCase()))
    for (const code of perLocation.keys()) {
      expect(codes, `lokalizacja ${code} musi istnieć w Open Mercato`).toContain(code)
    }
  })

  test('stan każdej frakcji zgadza się z sumą ruchów w księdze legacy', async ({ request }) => {
    const ledger = await readLegacyLedger()
    const { perFraction } = ledgerBalances(ledger)
    const dashboard = await loadDashboard(request)

    const bySku = new Map(dashboard.fractions.map((row) => [row.sku, row.quantityKg]))
    for (const [stockid, expectedKg] of perFraction) {
      const actual = bySku.get(stockid)
      expect(actual, `frakcja ${stockid} musi być w katalogu`).toBeDefined()
      expect.soft(actual ?? 0, `frakcja ${stockid}`).toBeCloseTo(expectedKg, 1)
    }
  })

  test('para SORT zwija się w jeden kwit - liczba kwitów musi się zgadzać', async ({ request }) => {
    const ledger = await readLegacyLedger()
    const dashboard = await loadDashboard(request)
    expect(dashboard.totals.movements30d).toBe(expectedMovementCount(ledger))
    // Ruchów magazynowych jest co najmniej tyle, co kwitów: mniej znaczyłoby,
    // że kwit nie wszedł, a dokładnie tyle - że masa nigdy nie schodzi
    // z więcej niż jednej partii, czyli że partie przestały działać.
    expect(dashboard.totals.movementRows30d).toBeGreaterThanOrEqual(dashboard.totals.movements30d)
  })

  test('suma na placu i w boksach odtwarza podział z systemu legacy', async ({ request }) => {
    const ledger = await readLegacyLedger()
    const { perLocation } = ledgerBalances(ledger)
    const dashboard = await loadDashboard(request)

    const yardKg = perLocation.get('PRZYJ') ?? 0
    const binsKg = [...perLocation.entries()]
      .filter(([code]) => code !== 'PRZYJ')
      .reduce((sum, [, value]) => sum + value, 0)

    expect(dashboard.totals.yardKg).toBeCloseTo(yardKg, 1)
    expect(dashboard.totals.binsKg).toBeCloseTo(binsKg, 1)
  })

  test('żaden stan nie schodzi poniżej zera - magazyn nie wydaje więcej, niż przyjął', async ({ request }) => {
    const dashboard = await loadDashboard(request)
    for (const location of dashboard.locations) {
      expect.soft(location.quantityKg ?? 0, `lokalizacja ${location.code}`).toBeGreaterThanOrEqual(-TOLERANCE_KG)
    }
    for (const fraction of dashboard.fractions) {
      expect.soft(fraction.quantityKg, `frakcja ${fraction.sku}`).toBeGreaterThanOrEqual(-TOLERANCE_KG)
    }
  })

  test('zapełnienie liczone jest względem pojemności, a nie zmyślane', async ({ request }) => {
    const dashboard = await loadDashboard(request)
    for (const location of dashboard.locations) {
      if (location.capacityKg === null) {
        expect(location.utilisation, `lokalizacja ${location.code} bez pojemności`).toBeNull()
        continue
      }
      const expected = ((location.quantityKg ?? 0) / location.capacityKg) * 100
      expect.soft(location.utilisation ?? 0, `lokalizacja ${location.code}`).toBeCloseTo(expected, 0)
    }
  })

  test('każdy ruch na pulpicie niesie numer z systemu legacy', async ({ request }) => {
    const dashboard = await loadDashboard(request)
    expect(dashboard.movements.length).toBeGreaterThan(0)

    for (const movement of dashboard.movements) {
      expect(movement.legacyMoveNo, `ruch ${movement.type} bez śladu w legacy`).not.toBeNull()
    }

    // Przesunięcie pochodzi z pary wierszy, więc musi wskazywać oba numery.
    const transfer = dashboard.movements.find((movement) => movement.type === 'transfer')
    if (transfer) {
      expect(String(transfer.legacyMoveNo)).toMatch(/^\d+ \+ \d+$/)
    }
  })

  test('każde wydanie ze starego systemu ma swoje zamówienie sprzedaży', async ({ request }) => {
    const orders = await readLegacyOrders()
    const dashboard = await loadDashboard(request)
    expect(dashboard.sales, 'pulpit musi raportować sprzedaż').toBeDefined()
    expect(dashboard.sales?.orders).toBe(orders.length)
  })

  test('każde zamówienie jest zafakturowane - faktura bez zamówienia jest bezwartościowa', async ({ request }) => {
    const dashboard = await loadDashboard(request)
    expect(dashboard.sales?.invoices).toBe(dashboard.sales?.orders)
  })

  test('przychód zgadza się z cennikiem starego systemu co do grosza', async ({ request }) => {
    const orders = await readLegacyOrders()
    const dashboard = await loadDashboard(request)
    // Każdy wiersz legacy to ilość w kilogramach razy cena za kilogram.
    // Gdyby cena trafiła do dokumentu jako cena za całe wydanie albo ilość
    // poszła w tonach, ta suma rozjechałaby się o rzędy wielkości.
    const expectedNet = orders.reduce((sum, row) => sum + row.iloscKg * row.cenaKg, 0)
    expect(dashboard.sales?.netPln ?? 0).toBeCloseTo(expectedNet, 1)
  })

  test('kwota brutto to netto powiększone o stawkę VAT, a nie liczba wzięta znikąd', async ({ request }) => {
    const dashboard = await loadDashboard(request)
    const net = dashboard.sales?.netPln ?? 0
    const gross = dashboard.sales?.grossPln ?? 0
    expect(gross).toBeCloseTo(net * 1.23, 0)
  })

  test('nazwy odbiorców są czytelne, a nie kryptogramem z bazy', async ({ request }) => {
    const dashboard = await loadDashboard(request)
    const buyers = dashboard.sales?.topBuyers ?? []
    expect(buyers.length).toBeGreaterThan(0)
    for (const buyer of buyers) {
      // Pola tekstowe kontrahenta są szyfrowane w spoczynku. Odczyt surowym
      // SQL-em oddaje ciąg w rodzaju `BZhh3D8l...:v1` i ląduje on na ekranie.
      expect.soft(buyer.nazwa, 'nazwa odbiorcy wygląda na kryptogram').not.toMatch(/:v\d+$/)
      expect.soft(buyer.nazwa.length, `nazwa odbiorcy: ${buyer.nazwa}`).toBeLessThan(80)
    }
  })

  test('wpłaty z systemu legacy zgadzają się co do grosza z rozliczonymi w Mercato', async ({ request }) => {
    const present = await fileExists(PAYMENTS_CSV)
    test.skip(!present, `Brak zrzutu wpłat: ${PAYMENTS_CSV}`)
    const stream = createReadStream(PAYMENTS_CSV, { encoding: 'utf8' })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    let header: string[] | null = null
    let suma = 0
    for await (const rawLine of lines) {
      const line = rawLine.replace(/^﻿/, '')
      if (!line.trim()) continue
      const cells = splitCsvLine(line)
      if (!header) {
        header = cells.map((cell) => cell.trim())
        continue
      }
      const index = header.indexOf('kwota_brutto')
      suma += Number.parseFloat((cells[index] ?? '0').replace(',', '.'))
    }
    const dashboard = await loadDashboard(request)
    expect(dashboard.sales?.paidPln ?? 0).toBeCloseTo(suma, 1)
  })

  test('należność to różnica między wystawionym a wpłaconym - nie osobna liczba', async ({ request }) => {
    const dashboard = await loadDashboard(request)
    const sales = dashboard.sales
    expect(sales).toBeDefined()
    expect(sales!.outstandingPln).toBeCloseTo(sales!.billedPln - sales!.paidPln, 2)
    // Magazyn nie może być winien odbiorcom - ujemna należność oznaczałaby,
    // że wpłaty przewyższyły faktury, czyli błąd alokacji.
    expect(sales!.outstandingPln).toBeGreaterThanOrEqual(0)
  })

  test('wystawiona kwota brutto zgadza się z sumą faktur', async ({ request }) => {
    const dashboard = await loadDashboard(request)
    expect(dashboard.sales?.billedPln ?? 0).toBeCloseTo(dashboard.sales?.grossPln ?? 0, 1)
  })

  test('każde przyjęcie ma swoją partię - bez tego nie wiadomo, czyj odpad leży na placu', async ({ request }) => {
    const ledger = await readLegacyLedger()
    const przyjecia = ledger.filter((row) => row.typ === 'PZ').length
    const dashboard = await loadDashboard(request)
    expect(dashboard.traceability?.lots).toBe(przyjecia)
  })

  test('masa w partiach zgadza się z sumą przyjęć w księdze legacy', async ({ request }) => {
    const ledger = await readLegacyLedger()
    const przyjeteKg = ledger
      .filter((row) => row.typ === 'PZ')
      .reduce((sum, row) => sum + Math.abs(row.iloscKg), 0)
    const dashboard = await loadDashboard(request)
    const wPartiach = (dashboard.traceability?.suppliers ?? []).reduce(
      (sum, row) => sum + row.receivedKg,
      0,
    )
    expect(wPartiach).toBeCloseTo(przyjeteKg, 1)
  })

  test('partia niesie nazwę dostawcy, a nie kod z legacy ani puste pole', async ({ request }) => {
    const dashboard = await loadDashboard(request)
    const suppliers = dashboard.traceability?.suppliers ?? []
    expect(suppliers.length).toBeGreaterThan(0)
    for (const row of suppliers) {
      // `D001` oznaczałoby, że kontrahent nie został odnaleziony w CRM.
      expect.soft(row.dostawca, 'dostawca pokazany kodem legacy').not.toMatch(/^D\d{3}$/)
      expect.soft(row.dostawca, 'dostawca bez nazwy').not.toBe('nieznany')
    }
  })

  test('każde wydanie ma kartę przekazania - przekazanie bez ewidencji jest bezprawne', async ({ request }) => {
    const orders = await readLegacyOrders()
    const ledger = await readLegacyLedger()
    // Kartę dostaje wydanie, które faktycznie zaszło - a nie każde zamówienie.
    // Zamówienie z odbiorem za tydzień karty mieć nie może.
    const wydane = new Set(ledger.filter((row) => row.typ === 'WZ').map((row) => row.orderno))
    const zrealizowane = orders.filter((row) => wydane.has(row.orderno)).length
    const dashboard = await loadDashboard(request)
    expect(dashboard.ewidencja?.cards).toBe(zrealizowane)
  })

  test('zamówienia otwarte mają zarezerwowaną masę, a nie samą obietnicę', async ({ request }) => {
    const orders = await readLegacyOrders()
    const ledger = await readLegacyLedger()
    const wydane = new Set(ledger.filter((row) => row.typ === 'WZ').map((row) => row.orderno))
    const otwarte = orders.filter((row) => !wydane.has(row.orderno))
    const dashboard = await loadDashboard(request)
    expect(otwarte.length, 'dane demo muszą zawierać zamówienia otwarte').toBeGreaterThan(0)
    // Nie każde otwarte zamówienie da się zarezerwować: magazyn odmawia
    // blokady masy, której nie ma. Dlatego sprawdzamy, że rezerwacje istnieją
    // i że żadna nie przekracza liczby zamówień otwartych.
    expect(dashboard.rezerwacje?.count ?? 0).toBeGreaterThan(0)
    expect(dashboard.rezerwacje?.count ?? 0).toBeLessThanOrEqual(otwarte.length)
  })

  test('zarezerwowana masa nie przekracza tego, co leży w boksach', async ({ request }) => {
    const dashboard = await loadDashboard(request)
    const reserved = dashboard.rezerwacje?.reservedKg ?? 0
    // Rezerwacja ponad stan oznaczałaby obietnicę bez pokrycia - dokładnie to,
    // czemu rezerwacje mają zapobiegać.
    expect(reserved).toBeLessThanOrEqual(dashboard.totals.binsKg + dashboard.totals.yardKg)
  })

  test('masa na kartach zgadza się z masą wydań, które faktycznie zaszły', async ({ request }) => {
    const orders = await readLegacyOrders()
    const ledger = await readLegacyLedger()
    const wydane = new Set(ledger.filter((row) => row.typ === 'WZ').map((row) => row.orderno))
    // Tylko zrealizowane: zamówienie otwarte karty nie ma, więc jego masa
    // nie może się w tej sumie pojawić.
    const expectedKg = orders
      .filter((row) => wydane.has(row.orderno))
      .reduce((sum, row) => sum + row.iloscKg, 0)
    const dashboard = await loadDashboard(request)
    expect(dashboard.ewidencja?.massKg ?? 0).toBeCloseTo(expectedKg, 1)
  })

  test('żadna karta nie jest niekompletna - brak kodu procesu albo numeru BDO unieważnia ewidencję', async ({ request }) => {
    const dashboard = await loadDashboard(request)
    expect.soft(dashboard.ewidencja?.withoutProcess ?? 0, 'karty bez kodu procesu odzysku').toBe(0)
    expect.soft(dashboard.ewidencja?.withoutBdo ?? 0, 'karty bez numeru rejestrowego odbiorcy').toBe(0)
  })

  test('bilans masy domyka się: przyjęte minus wydane równa się temu, co leży', async ({ request }) => {
    const dashboard = await loadDashboard(request)
    const bilans = dashboard.bilans
    expect(bilans, 'pulpit musi raportować bilans masy').toBeDefined()
    // To jest najostrzejszy test w całym zestawie. Jeżeli gdziekolwiek zgubi
    // się znak, para SORT albo jednostka, masa przestanie się domykać - i nie
    // ma innego miejsca, w którym taki błąd by się ujawnił.
    expect(bilans!.differenceKg).toBeCloseTo(0, 1)
    expect(bilans!.receivedKg - bilans!.issuedKg).toBeCloseTo(bilans!.onHandKg, 1)
  })

  test('masa przyjęta zgadza się z sumą PZ w księdze legacy', async ({ request }) => {
    const ledger = await readLegacyLedger()
    const przyjeteKg = ledger
      .filter((row) => row.typ === 'PZ')
      .reduce((sum, row) => sum + Math.abs(row.iloscKg), 0)
    const dashboard = await loadDashboard(request)
    expect(dashboard.bilans?.receivedKg ?? 0).toBeCloseTo(przyjeteKg, 1)
  })

  test('sprawność sortowania to wysortowane przez przyjęte, a nie liczba z sufitu', async ({ request }) => {
    const dashboard = await loadDashboard(request)
    const bilans = dashboard.bilans!
    const expected = (bilans.sortedKg / bilans.receivedKg) * 100
    expect(bilans.sortingRate ?? 0).toBeCloseTo(expected, 1)
    // Sortownia, która wysortowuje więcej, niż przyjęła, produkuje masę z niczego.
    expect(bilans.sortingRate ?? 0).toBeLessThanOrEqual(100)
  })

  test('cena za kilogram wynika z przychodu i masy każdej frakcji', async ({ request }) => {
    const dashboard = await loadDashboard(request)
    for (const row of dashboard.bilans?.perFraction ?? []) {
      if (row.soldKg <= 0 || row.pricePerKg === null) continue
      expect.soft(row.pricePerKg, `cena frakcji ${row.sku}`).toBeCloseTo(row.netPln / row.soldKg, 3)
      expect.soft(row.pricePerKg, `cena frakcji ${row.sku} nie może być ujemna`).toBeGreaterThan(0)
    }
  })

  test('konwersja kilogramów na megagramy jest spójna w całej księdze legacy', async () => {
    const ledger = await readLegacyLedger()
    const rozjazdy = ledger.filter((row) => Math.abs(row.iloscKg / 1000 - row.iloscMg) > 0.001)
    expect(rozjazdy.map((row) => row.stkmoveno)).toEqual([])
  })
})
