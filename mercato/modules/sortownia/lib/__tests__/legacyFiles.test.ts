import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  fileExists,
  fractionsFile,
  legacyOutDir,
  legacyUuid,
  movementsFile,
  readCsvRows,
  readFractions,
  readMovements,
} from '../legacyFiles'

/**
 * Zrzut plikowy przychodzi z systemu, którego nikt nie kontroluje: raz jest to
 * eksport nocny, raz arkusz od księgowości zapisany „jakoś". Parser ma być
 * odporny na kształt pliku, a `legacyUuid` musi być stabilny, bo na nim stoi
 * cała idempotencja importu.
 */

async function tempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sortownia-'))
  const file = path.join(dir, name)
  await writeFile(file, content, 'utf8')
  return file
}

describe('readCsvRows', () => {
  it('czyta nagłówek i wiersze, ucinając BOM z eksportu Excela', async () => {
    const file = await tempFile('x.csv', '﻿a,b\n1,2\n')
    const rows = []
    for await (const row of readCsvRows(file)) rows.push(row)
    expect(rows).toEqual([{ a: '1', b: '2' }])
  })

  it('respektuje cudzysłowy: przecinek w nazwie nie rozbija wiersza', async () => {
    const file = await tempFile('x.csv', 'kod,nazwa\n"20 01 01","Papier, tektura i karton"\n')
    const rows = []
    for await (const row of readCsvRows(file)) rows.push(row)
    expect(rows[0].nazwa).toBe('Papier, tektura i karton')
  })

  it('rozumie podwojony cudzysłów w środku pola', async () => {
    const file = await tempFile('x.csv', 'kod,nazwa\nA,"frakcja ""czysta"""\n')
    const rows = []
    for await (const row of readCsvRows(file)) rows.push(row)
    expect(rows[0].nazwa).toBe('frakcja "czysta"')
  })

  it('pomija puste linie zamiast produkować puste rekordy', async () => {
    const file = await tempFile('x.csv', 'a\n1\n\n2\n')
    const rows = []
    for await (const row of readCsvRows(file)) rows.push(row)
    expect(rows).toHaveLength(2)
  })
})

describe('readMovements', () => {
  const header = 'stkmoveno,stockid,typ,loccode,data,debtorno,ilosc_kg,ilosc_mg\n'

  it('mapuje wiersz księgi na rekord z liczbami', async () => {
    const file = await tempFile(
      'ruchy.csv',
      header + '100001,20 01 01,PZ,PRZYJ,2026-09-18T07:15:00,D001,6412.80,6.413\n',
    )
    const rows = []
    for await (const row of readMovements(file)) rows.push(row)

    expect(rows).toEqual([
      {
        stkmoveno: 100001,
        stockid: '20 01 01',
        typ: 'PZ',
        loccode: 'PRZYJ',
        data: '2026-09-18T07:15:00',
        debtorno: 'D001',
        iloscKg: 6412.8,
        iloscMg: 6.413,
        // PZ nie realizuje zamówienia — pusta kolumna daje 0, czyli „brak".
        orderno: 0,
      },
    ])
  })

  it('zachowuje znak ujemny przy wydaniach — bez tego magazyn by rósł zamiast maleć', async () => {
    const file = await tempFile(
      'ruchy.csv',
      header + '100002,15 01 02,WZ,BOKS2,2026-09-18T10:00:00,D006,-9004.10,-9.004\n',
    )
    const rows = []
    for await (const row of readMovements(file)) rows.push(row)
    expect(rows[0].iloscKg).toBeCloseTo(-9004.1, 2)
  })

  it('odrzuca wiersze bez numeru ruchu i o nieznanym typie zamiast wpuszczać je dalej', async () => {
    const file = await tempFile(
      'ruchy.csv',
      header +
        ',20 01 01,PZ,PRZYJ,2026-09-18T07:15:00,D001,100,0.1\n' +
        '100003,20 01 01,XYZ,PRZYJ,2026-09-18T07:15:00,D001,100,0.1\n' +
        '100004,20 01 01,SORT,BOKS1,2026-09-18T07:15:00,,100,0.1\n',
    )
    const rows = []
    for await (const row of readMovements(file)) rows.push(row)
    expect(rows.map((row) => row.stkmoveno)).toEqual([100004])
  })

  it('przyjmuje przecinek dziesiętny, bo tak zapisuje polski Excel', async () => {
    const file = await tempFile(
      'ruchy.csv',
      header + '100005,20 01 01,PZ,PRZYJ,2026-09-18T07:15:00,D001,"1234,56","1,235"\n',
    )
    const rows = []
    for await (const row of readMovements(file)) rows.push(row)
    expect(rows[0].iloscKg).toBeCloseTo(1234.56, 2)
  })
})

describe('readFractions', () => {
  it('czyta katalog frakcji i uzupełnia brakującą nazwę kodem odpadu', async () => {
    const file = await tempFile(
      'frakcje.csv',
      'stockid,nazwa,kategoria,jednostka,koszt\n20 01 01,Papier i tektura,SUR,kg,0.32\n19 12 10,,PAL,kg,0.05\n',
    )
    const rows = await readFractions(file)
    expect(rows[0]).toMatchObject({ stockid: '20 01 01', nazwa: 'Papier i tektura', koszt: 0.32 })
    expect(rows[1].nazwa).toBe('19 12 10')
  })
})

describe('legacyUuid', () => {
  it('jest deterministyczny — na tym stoi idempotencja importu', () => {
    expect(legacyUuid('movement', 100001)).toBe(legacyUuid('movement', 100001))
  })

  it('rozdziela przestrzenie nazw i kolejne numery ruchów', () => {
    expect(legacyUuid('movement', 100001)).not.toBe(legacyUuid('movement', 100002))
    expect(legacyUuid('movement', 100001)).not.toBe(legacyUuid('order', 100001))
  })

  it('ma kształt UUID w wersji 5 z wariantem RFC 4122 — WMS wymaga poprawnego uuid', () => {
    const value = legacyUuid('movement', 100001)
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('traktuje numer i jego tekstową postać tak samo', () => {
    expect(legacyUuid('movement', 100001)).toBe(legacyUuid('movement', '100001'))
  })
})

describe('ścieżki zrzutu', () => {
  const previous = process.env.SORTOWNIA_LEGACY_OUT

  afterEach(() => {
    if (previous === undefined) delete process.env.SORTOWNIA_LEGACY_OUT
    else process.env.SORTOWNIA_LEGACY_OUT = previous
  })

  it('bierze katalog z konfiguracji środowiska', () => {
    process.env.SORTOWNIA_LEGACY_OUT = '/dane/legacy/out'
    expect(legacyOutDir()).toBe('/dane/legacy/out')
    // `path.join` składa ścieżkę separatorem platformy — test ma przejść i na Windows.
    expect(movementsFile()).toBe(path.join('/dane/legacy/out', 'ruchy.csv'))
    expect(fractionsFile()).toBe(path.join('/dane/legacy/out', 'frakcje.csv'))
  })

  it('rozpoznaje brak pliku zamiast wywracać się na odczycie', async () => {
    await expect(fileExists('/nie/ma/takiego/pliku.csv')).resolves.toBe(false)
  })
})
