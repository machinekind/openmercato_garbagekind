import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, constants } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import path from 'node:path'

/**
 * Kanał plikowy systemu legacy.
 *
 * Powód istnienia: webERP nie wystawia przez XML-RPC ani katalogu frakcji, ani
 * księgi ruchów. W sortowni te dane przychodzą zrzutem — excelem z księgowości
 * albo nocnym eksportem. Moduł czyta je stąd, zamiast udawać, że API je oddaje.
 */

export type LegacyMovementRow = {
  stkmoveno: number
  stockid: string
  typ: 'PZ' | 'SORT' | 'WZ'
  loccode: string
  data: string
  debtorno: string
  iloscKg: number
  iloscMg: number
  /** Numer zamówienia, które to wydanie realizuje; 0 dla PZ i SORT. */
  orderno: number
}

export type LegacyCustomerRow = {
  debtorno: string
  nazwa: string
  /** DOS = dostawca odpadu, ODB = odbiorca frakcji. */
  typ: string
  miasto: string
  waluta: string
  klientOd: string
  nip: string
  /** Numer rejestrowy BDO — na karcie przekazania musi być po obu stronach. */
  bdo: string
}

export type LegacyOrderRow = {
  orderno: number
  debtorno: string
  dataZamowienia: string
  dataWydania: string
  stockid: string
  iloscKg: number
  cenaKg: number
}

export type LegacyPaymentRow = {
  transno: number
  debtorno: string
  orderno: number
  data: string
  typ: string
  kwotaBrutto: number
}

export type LegacyFractionRow = {
  stockid: string
  nazwa: string
  kategoria: string
  jednostka: string
  koszt: number
  /** Kod procesu odzysku (R1, R3, R4, R5) — czym ta frakcja się staje. */
  kodProcesu: string
}

/** Rozdziela wiersz CSV z obsługą cudzysłowów — tyle, ile wymaga eksport legacy. */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === ',') {
      out.push(field)
      field = ''
    } else {
      field += char
    }
  }
  out.push(field)
  return out
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.R_OK)
    return true
  } catch {
    return false
  }
}

/** Czyta CSV strumieniowo: księga ruchów bywa duża, a import ma być wznawialny. */
export async function* readCsvRows(filePath: string): AsyncGenerator<Record<string, string>> {
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let header: string[] | null = null
  try {
    for await (const rawLine of lines) {
      const line = rawLine.replace(/^﻿/, '')
      if (!line.trim()) continue
      const cells = splitCsvLine(line)
      if (!header) {
        header = cells.map((cell) => cell.trim())
        continue
      }
      const row: Record<string, string> = {}
      header.forEach((name, index) => {
        row[name] = (cells[index] ?? '').trim()
      })
      yield row
    }
  } finally {
    lines.close()
    stream.close()
  }
}

function toNumber(value: string | undefined): number {
  const parsed = Number.parseFloat((value ?? '').replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : 0
}

export function legacyOutDir(): string {
  return process.env.SORTOWNIA_LEGACY_OUT ?? path.resolve(process.cwd(), '../../out')
}

function legacyFile(name: string): string {
  const directory = legacyOutDir()
  // Konfiguracja trafia także do kontenera Linux, nawet gdy test lub CLI
  // uruchamiamy na Windows. `path.join` używa separatora hosta i zamieniał
  // poprawne `/dane/...` na `\dane\...`; styl jawnie podanej ścieżki ma
  // pierwszeństwo przed systemem, na którym działa proces sterujący.
  const join = directory.startsWith('/') && !directory.includes('\\') ? path.posix.join : path.join
  return join(directory, name)
}

export function movementsFile(): string {
  return legacyFile('ruchy.csv')
}

export function fractionsFile(): string {
  return legacyFile('frakcje.csv')
}

export function customersFile(): string {
  return legacyFile('kontrahenci.csv')
}

export function ordersFile(): string {
  return legacyFile('zamowienia.csv')
}

export function paymentsFile(): string {
  return legacyFile('zaplaty.csv')
}

export async function* readMovements(filePath: string): AsyncGenerator<LegacyMovementRow> {
  for await (const row of readCsvRows(filePath)) {
    const stkmoveno = Number.parseInt(row.stkmoveno ?? '', 10)
    if (!Number.isFinite(stkmoveno)) continue
    const typ = (row.typ ?? '').toUpperCase()
    if (typ !== 'PZ' && typ !== 'SORT' && typ !== 'WZ') continue
    yield {
      stkmoveno,
      stockid: row.stockid ?? '',
      typ,
      loccode: row.loccode ?? '',
      data: row.data ?? '',
      debtorno: row.debtorno ?? '',
      iloscKg: toNumber(row.ilosc_kg),
      iloscMg: toNumber(row.ilosc_mg),
      // Kolumna bywa pusta (PZ, SORT) — `toNumber` daje wtedy 0, czyli „brak".
      orderno: toNumber(row.orderno),
    }
  }
}

export async function readCustomers(filePath: string): Promise<LegacyCustomerRow[]> {
  const out: LegacyCustomerRow[] = []
  for await (const row of readCsvRows(filePath)) {
    if (!row.debtorno) continue
    out.push({
      debtorno: row.debtorno,
      // Ta sama pułapka co przy frakcjach: pusta komórka nie może zostać pustą
      // nazwą, bo `displayName` kontrahenta jest wymagane.
      nazwa: row.name?.trim() ? row.name.trim() : row.debtorno,
      typ: (row.typ ?? '').toUpperCase(),
      miasto: row.miasto ?? '',
      waluta: (row.waluta ?? 'PLN').toUpperCase(),
      klientOd: row.klient_od ?? '',
      nip: row.nip ?? '',
      bdo: row.bdo ?? '',
    })
  }
  return out
}

export async function readOrders(filePath: string): Promise<LegacyOrderRow[]> {
  const out: LegacyOrderRow[] = []
  for await (const row of readCsvRows(filePath)) {
    const orderno = Number.parseInt(row.orderno ?? '', 10)
    if (!Number.isFinite(orderno)) continue
    if (!row.stockid || !row.debtorno) continue
    out.push({
      orderno,
      debtorno: row.debtorno,
      dataZamowienia: row.data_zamowienia ?? '',
      dataWydania: row.data_wydania ?? '',
      stockid: row.stockid,
      iloscKg: toNumber(row.ilosc_kg),
      cenaKg: toNumber(row.cena_kg),
    })
  }
  return out
}

export async function readPayments(filePath: string): Promise<LegacyPaymentRow[]> {
  const out: LegacyPaymentRow[] = []
  for await (const row of readCsvRows(filePath)) {
    const transno = Number.parseInt(row.transno ?? '', 10)
    const orderno = Number.parseInt(row.orderno ?? '', 10)
    if (!Number.isFinite(transno) || !Number.isFinite(orderno)) continue
    const kwotaBrutto = toNumber(row.kwota_brutto)
    // Wpłata zerowa albo ujemna to nie wpłata — zwrot ma własny dokument.
    if (kwotaBrutto <= 0) continue
    out.push({
      transno,
      debtorno: row.debtorno ?? '',
      orderno,
      data: row.data ?? '',
      typ: (row.typ ?? '').toUpperCase(),
      kwotaBrutto,
    })
  }
  return out
}

export async function readFractions(filePath: string): Promise<LegacyFractionRow[]> {
  const out: LegacyFractionRow[] = []
  for await (const row of readCsvRows(filePath)) {
    if (!row.stockid) continue
    out.push({
      stockid: row.stockid,
      // Pusta komórka to nie brak kolumny: `??` przepuściłby '' i katalog
      // dostałby pozycję bez nazwy, a `title` produktu jest wymagane.
      nazwa: row.nazwa?.trim() ? row.nazwa.trim() : row.stockid,
      kategoria: row.kategoria ?? '',
      jednostka: row.jednostka ?? 'kg',
      koszt: toNumber(row.koszt),
      kodProcesu: (row.kod_procesu ?? '').toUpperCase(),
    })
  }
  return out
}

/**
 * Deterministyczny UUID z dowolnego klucza legacy.
 *
 * WMS wymaga `referenceId` w formacie UUID, a system legacy numeruje ruchy
 * liczbą (`stkmoveno`). Ten sam numer musi dawać ten sam UUID przy każdym
 * przebiegu — inaczej idempotencja WMS-u nie miałaby na czym się oprzeć
 * i ponowny import zdublowałby ruchy.
 */
export function legacyUuid(namespace: string, key: string | number): string {
  const digest = createHash('sha1').update(`sortownia:${namespace}:${key}`).digest()
  const bytes = Buffer.from(digest.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50 // wersja 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // wariant RFC 4122
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
