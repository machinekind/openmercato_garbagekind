/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import SortowniaDashboard from '../SortowniaDashboard'

/**
 * Pulpit ogląda brygadzista, nie programista. Sprawdzamy to, co widzi:
 * masy w tonach, ostrzeżenie o zapełnieniu, kierunek ruchu po ludzku
 * i numer z systemu legacy, po którym wraca się do kwitu wagowego.
 */

const apiFetchMock = jest.fn()

jest.mock('@open-mercato/ui/backend/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

// Wykresy mają własne testy w pakiecie ui; tutaj interesuje nas treść pulpitu.
jest.mock('@open-mercato/ui/backend/charts', () => ({
  KpiCard: ({ title, value, suffix, footer }: { title: string; value: number | null; suffix?: string; footer?: React.ReactNode }) => (
    <div data-testid="kpi">
      <span>{title}</span>
      <strong>{value === null ? '—' : `${value}${suffix ?? ''}`}</strong>
      <div>{footer}</div>
    </div>
  ),
  BarChart: ({ title, data }: { title: string; data: Array<Record<string, unknown>> }) => (
    <div data-testid="chart" data-rows={data.length}>
      {title}
    </div>
  ),
}))

const payload = {
  generatedAt: '2026-09-19T00:16:00.000Z',
  totals: {
    yardKg: 117664.5,
    binsKg: 102813.24,
    receipts30dKg: 385384,
    issues30dKg: 164910,
    sorted30dKg: 235890,
    movements30d: 176,
    lastMovementAt: '2026-09-18T22:14:50.000Z',
  },
  locations: [
    { code: 'PRZYJ', type: 'staging', capacityKg: 150000, quantityKg: 117664.5, utilisation: 78.4, legacyName: 'Plac przyjec' },
    { code: 'BOKS1', type: 'bin', capacityKg: 60000, quantityKg: 4685.98, utilisation: 7.8, legacyName: 'Boks 1 - papier' },
  ],
  fractions: [
    { sku: '20 01 01', name: 'Papier i tektura', quantityKg: 4000, reorderPointKg: 8000, belowReorderPoint: true },
    { sku: '20 01 02', name: 'Szklo opakowaniowe', quantityKg: 77218, reorderPointKg: 10000, belowReorderPoint: false },
  ],
  flow: [{ sku: '20 01 01', receivedKg: 63000, sortedKg: 50300, issuedKg: 45700 }],
  sales: {
    orders: 40,
    invoices: 40,
    netPln: 48250.75,
    grossPln: 59348.42,
    billedPln: 59348.42,
    paidPln: 21000,
    outstandingPln: 38348.42,
    unpaidDocs: 31,
    oldestUnpaidDays: 28,
    topBuyers: [
      { nazwa: 'RecycleHub Sp. z o.o.', netPln: 21340.5, orders: 12 },
      { nazwa: 'PlastMet Sp. z o.o.', netPln: 15002.25, orders: 9 },
    ],
  },
  bilans: {
    receivedKg: 437131.25,
    sortedKg: 296998.37,
    issuedKg: 236353.44,
    onHandKg: 200777.81,
    differenceKg: 0,
    sortingRate: 67.9,
    perFraction: [
      { sku: 'Frakcja 15 01 02', netPln: 79147.27, soldKg: 50980.5, pricePerKg: 1.5525 },
      { sku: 'Frakcja 20 01 01', netPln: 29069.34, soldKg: 67290.1, pricePerKg: 0.432 },
    ],
  },
  rezerwacje: { count: 5, reservedKg: 24500 },
  ewidencja: { cards: 40, massKg: 164910, withoutProcess: 0, withoutBdo: 0 },
  traceability: {
    lots: 95,
    suppliers: [
      { dostawca: 'Gmina Wieliszew', lots: 31, receivedKg: 142300 },
      { dostawca: 'PPHU Transbud', lots: 22, receivedKg: 98150 },
    ],
  },
  movements: [
    {
      id: 'm1',
      type: 'transfer',
      performedAt: '2026-09-18T22:14:44.000Z',
      quantityKg: 4685.98,
      fractionSku: '20 01 01',
      fractionName: 'Papier i tektura',
      fromCode: 'PRZYJ',
      toCode: 'BOKS1',
      reason: 'Wysortowanie frakcji',
      legacyMoveNo: '100240 + 100241',
    },
    {
      id: 'm2',
      type: 'adjust',
      performedAt: '2026-09-18T07:44:00.000Z',
      quantityKg: -4548,
      fractionSku: '20 01 01',
      fractionName: 'Papier i tektura',
      fromCode: null,
      toCode: 'BOKS1',
      reason: 'Wydanie do odbiorcy D005',
      legacyMoveNo: 100237,
    },
  ],
}

function respondWith(body: unknown, ok = true, status = 200) {
  apiFetchMock.mockResolvedValue({
    ok,
    status,
    json: async () => body,
  })
}

beforeEach(() => {
  apiFetchMock.mockReset()
  respondWith(payload)
})

describe('SortowniaDashboard', () => {
  it('pobiera dane z punktu końcowego pulpitu', async () => {
    render(<SortowniaDashboard />)
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/api/sortownia/dashboard'))
  })

  it('pokazuje masy w tonach (1 t = 1 Mg), bo tak mówi operator', async () => {
    render(<SortowniaDashboard />)
    await screen.findByText('Na placu przyjęć')
    expect(screen.getByText('117.665 t')).toBeInTheDocument()
  })

  it('pokazuje zapełnienie lokalizacji obok jej pojemności', async () => {
    render(<SortowniaDashboard />)
    await screen.findByText('PRZYJ')
    expect(screen.getByText('78.4%')).toBeInTheDocument()
    // 150 000 kg pojemności to 150,000 t — trzy miejsca po przecinku,
    // a nie sto pięćdziesiąt tysięcy. Ta pomyłka jest łatwa i kosztowna,
    // więc wiersz sprawdzamy w całości.
    const wiersz = screen.getByText('PRZYJ').closest('div')?.parentElement
    const tresc = (wiersz?.textContent ?? '').replace(/\s+/g, ' ')
    expect(tresc).toContain('117,665 t')
    expect(tresc).toContain('150,000 t')
  })

  it('ostrzega o frakcji poniżej progu wysyłki', async () => {
    render(<SortowniaDashboard />)
    expect(await screen.findByText('Frakcje poniżej progu wysyłki')).toBeInTheDocument()
    expect(screen.getByText(/Papier i tektura \(4,000 t/)).toBeInTheDocument()
  })

  it('nie wyświetla ostrzeżenia, gdy wszystkie frakcje są nad progiem', async () => {
    respondWith({
      ...payload,
      fractions: payload.fractions.map((row) => ({ ...row, belowReorderPoint: false })),
    })
    render(<SortowniaDashboard />)
    await screen.findByText('Na placu przyjęć')
    expect(screen.queryByText('Frakcje poniżej progu wysyłki')).not.toBeInTheDocument()
  })

  it('tłumaczy kierunek ruchu na język operatora zamiast pokazywać konwencję WMS', async () => {
    render(<SortowniaDashboard />)
    await screen.findByText('Ostatnie ruchy')
    // Korekta wydania trzyma lokalizację w polu „do", ale towar z boksu wyjechał.
    expect(screen.getByText('BOKS1 → odbiorca')).toBeInTheDocument()
    expect(screen.getByText('PRZYJ → BOKS1')).toBeInTheDocument()
  })

  it('niesie numer z systemu legacy — para SORT pokazuje oba', async () => {
    render(<SortowniaDashboard />)
    await screen.findByText('Ostatnie ruchy')
    expect(screen.getByText('#100240 + 100241')).toBeInTheDocument()
    expect(screen.getByText('#100237')).toBeInTheDocument()
  })

  it('nazywa operacje po polsku i dokłada skrót dokumentu z legacy', async () => {
    render(<SortowniaDashboard />)
    await screen.findByText('Ostatnie ruchy')
    expect(screen.getByText('Sortowanie')).toBeInTheDocument()
    expect(screen.getByText('SORT')).toBeInTheDocument()
    expect(screen.getByText('WZ')).toBeInTheDocument()
  })

  it('pokazuje przychód ze sprzedaży frakcji — stary system nie umiał tego powiedzieć', async () => {
    render(<SortowniaDashboard />)
    expect(await screen.findByText('Sprzedaż frakcji')).toBeInTheDocument()
    expect(screen.getByText('Przychód netto')).toBeInTheDocument()
    expect(screen.getByText('48251 zł')).toBeInTheDocument()
  })

  it('mówi wprost, że każde wydanie zostało zafakturowane', async () => {
    render(<SortowniaDashboard />)
    await screen.findByText('Sprzedaż frakcji')
    expect(screen.getByText('każde wydanie zafakturowane')).toBeInTheDocument()
  })

  it('wskazuje lukę, gdy część wydań nie ma faktury', async () => {
    respondWith({ ...payload, sales: { ...payload.sales, invoices: 37 } })
    render(<SortowniaDashboard />)
    await screen.findByText('Sprzedaż frakcji')
    expect(screen.getByText('3 bez faktury')).toBeInTheDocument()
  })

  it('wymienia największych odbiorców z kwotą', async () => {
    render(<SortowniaDashboard />)
    await screen.findByText('Najwięksi odbiorcy')
    expect(screen.getByText('RecycleHub Sp. z o.o.')).toBeInTheDocument()
    expect(screen.getByText('12 wydań')).toBeInTheDocument()
  })

  it('nie pokazuje sekcji sprzedaży, gdy import jej nie objął', async () => {
    respondWith({ ...payload, sales: { orders: 0, invoices: 0, netPln: 0, grossPln: 0, topBuyers: [] } })
    render(<SortowniaDashboard />)
    await screen.findByText('Na placu przyjęć')
    expect(screen.queryByText('Sprzedaż frakcji')).not.toBeInTheDocument()
  })

  it('pokazuje należności, bo to pytanie zadawane w sortowni najczęściej', async () => {
    render(<SortowniaDashboard />)
    await screen.findByText('Sprzedaż frakcji')
    expect(screen.getByText('Do zapłaty')).toBeInTheDocument()
    expect(screen.getByText('38348 zł')).toBeInTheDocument()
    expect(screen.getByText('31 dokumentów, najstarszy 28 dni')).toBeInTheDocument()
  })

  it('mówi, że rozliczone, gdy nic nie wisi', async () => {
    respondWith({ ...payload, sales: { ...payload.sales, unpaidDocs: 0, outstandingPln: 0, oldestUnpaidDays: null } })
    render(<SortowniaDashboard />)
    await screen.findByText('Sprzedaż frakcji')
    expect(screen.getByText('wszystko rozliczone')).toBeInTheDocument()
  })

  it('pokazuje, czyj odpad przyjechał — tego stary system nie wiedział wcale', async () => {
    render(<SortowniaDashboard />)
    expect(await screen.findByText('Pochodzenie odpadu')).toBeInTheDocument()
    expect(screen.getByText('Gmina Wieliszew')).toBeInTheDocument()
    expect(screen.getByText('95 partii')).toBeInTheDocument()
    expect(screen.getByText('142,300 t')).toBeInTheDocument()
  })

  it('nie pokazuje pochodzenia, gdy partii jeszcze nie ma', async () => {
    respondWith({ ...payload, traceability: { lots: 0, suppliers: [] } })
    render(<SortowniaDashboard />)
    await screen.findByText('Na placu przyjęć')
    expect(screen.queryByText('Pochodzenie odpadu')).not.toBeInTheDocument()
  })

  it('odróżnia masę zarezerwowaną od wolnej — stary system znał tylko jedną liczbę', async () => {
    render(<SortowniaDashboard />)
    await screen.findByText('W boksach')
    expect(screen.getByText('w tym 24,500 t zarezerwowane (5 zamówień)')).toBeInTheDocument()
  })

  it('bez rezerwacji mówi po prostu, że towar jest gotowy do wydania', async () => {
    respondWith({ ...payload, rezerwacje: { count: 0, reservedKg: 0 } })
    render(<SortowniaDashboard />)
    await screen.findByText('W boksach')
    expect(screen.getByText('Gotowe do wydania odbiorcom')).toBeInTheDocument()
  })

  it('pokazuje bilans masy i mówi wprost, że się domyka', async () => {
    render(<SortowniaDashboard />)
    expect(await screen.findByText('Bilans masy i sprawność sortowania')).toBeInTheDocument()
    expect(screen.getByText('bilans domyka się')).toBeInTheDocument()
    expect(screen.getByText('67.9%')).toBeInTheDocument()
  })

  it('alarmuje, gdy bilans się nie domyka — ubytek masy to nie drobiazg', async () => {
    respondWith({ ...payload, bilans: { ...payload.bilans, differenceKg: 1240.5 } })
    render(<SortowniaDashboard />)
    await screen.findByText('Bilans masy i sprawność sortowania')
    expect(screen.getByText(/różnica 1,241 t — sprawdź ewidencję/)).toBeInTheDocument()
  })

  it('pokazuje przychód per frakcja z ceną za kilogram', async () => {
    render(<SortowniaDashboard />)
    await screen.findByText('Przychód per frakcja')
    expect(screen.getByText(/1\.55 zł\/kg/)).toBeInTheDocument()
  })

  it('pokazuje ewidencję przekazań odpadu', async () => {
    render(<SortowniaDashboard />)
    expect(await screen.findByText('Ewidencja przekazań odpadu')).toBeInTheDocument()
    expect(screen.getByText('Karty przekazania')).toBeInTheDocument()
    expect(screen.getByText('komplet danych na każdej karcie')).toBeInTheDocument()
  })

  it('wytyka niekompletne karty zamiast je przemilczeć', async () => {
    respondWith({ ...payload, ewidencja: { cards: 40, massKg: 164910, withoutProcess: 2, withoutBdo: 3 } })
    render(<SortowniaDashboard />)
    await screen.findByText('Ewidencja przekazań odpadu')
    expect(screen.getByText('bez procesu 2, bez numeru BDO 3')).toBeInTheDocument()
  })

  it('nie udaje, że to dokument z BDO', async () => {
    render(<SortowniaDashboard />)
    await screen.findByText('Ewidencja przekazań odpadu')
    expect(screen.getByText(/nie dokument z systemu BDO/)).toBeInTheDocument()
  })

  it('pokazuje przepływ frakcji jako wykres', async () => {
    render(<SortowniaDashboard />)
    // Wykres istnieje w drzewie od pierwszego renderu, jeszcze pusty, więc samo
    // `findByTestId` rozwiązuje się przed dojściem danych i asercja łapie zero
    // wierszy. Czekamy na liczbę wierszy, a nie na obecność elementu.
    await waitFor(() => expect(screen.getByTestId('chart')).toHaveAttribute('data-rows', '1'))
  })

  it('mówi wprost, gdy dane się nie pobrały — pusty ekran niczego nie tłumaczy', async () => {
    apiFetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'Forbidden' }) })
    render(<SortowniaDashboard />)
    expect(await screen.findByText('Forbidden')).toBeInTheDocument()
  })

  it('podpowiada import, gdy księga jest pusta', async () => {
    respondWith({ ...payload, movements: [], locations: [], fractions: [], flow: [] })
    render(<SortowniaDashboard />)
    expect(await screen.findByText(/Księga jest pusta/)).toBeInTheDocument()
    expect(screen.getByText(/Brak lokalizacji/)).toBeInTheDocument()
  })
})
