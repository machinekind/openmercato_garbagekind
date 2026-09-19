'use client'

import * as React from 'react'
import { BarChart, KpiCard } from '@open-mercato/ui/backend/charts'
import { apiFetch } from '@open-mercato/ui/backend/utils/api'

/**
 * Pulpit sortowni.
 *
 * Pokazuje to, czego stary system nie umiał powiedzieć: ile miejsca zostało
 * w boksie, która frakcja zeszła poniżej progu i skąd dokąd poszedł każdy ruch.
 * Dane liczone są z encji WMS, więc pulpit i magazyn zawsze mówią to samo.
 */

type LocationRow = {
  code: string
  type: string
  capacityKg: number | null
  quantityKg: number | null
  utilisation: number | null
  legacyName: string | null
}

type FractionRow = {
  sku: string
  name: string
  quantityKg: number
  reorderPointKg: number | null
  belowReorderPoint: boolean
}

type MovementRow = {
  id: string
  type: string
  performedAt: string
  quantityKg: number
  fractionSku: string | null
  fractionName: string | null
  fromCode: string | null
  toCode: string | null
  reason: string | null
  legacyMoveNo: number | string | null
}

type FlowRow = {
  sku: string
  receivedKg: number
  sortedKg: number
  issuedKg: number
}

type DashboardData = {
  generatedAt: string
  totals: {
    yardKg: number
    binsKg: number
    receipts30dKg: number
    issues30dKg: number
    sorted30dKg: number
    movements30d: number
    lastMovementAt: string | null
  }
  locations: LocationRow[]
  fractions: FractionRow[]
  flow: FlowRow[]
  movements: MovementRow[]
  sales?: SalesSummary
  traceability?: Traceability
  ewidencja?: Ewidencja
  rezerwacje?: { count: number; reservedKg: number }
  bilans?: Bilans
}

type Bilans = {
  receivedKg: number
  sortedKg: number
  issuedKg: number
  onHandKg: number
  differenceKg: number
  sortingRate: number | null
  perFraction: Array<{ sku: string; netPln: number; soldKg: number; pricePerKg: number | null }>
}

type Ewidencja = {
  cards: number
  massKg: number
  withoutProcess: number
  withoutBdo: number
}

type Traceability = {
  lots: number
  suppliers: Array<{ dostawca: string; lots: number; receivedKg: number }>
}

type SalesSummary = {
  orders: number
  invoices: number
  netPln: number
  grossPln: number
  billedPln: number
  paidPln: number
  outstandingPln: number
  unpaidDocs: number
  oldestUnpaidDays: number | null
  topBuyers: Array<{ nazwa: string; netPln: number; orders: number }>
}

/** Magazyn liczy w kilogramach, ekran pokazuje tony (1 t = 1 Mg = 1000 kg). */
function toTons(kg: number): number {
  return Math.round((kg / 1000) * 1000) / 1000
}

function formatTons(kg: number): string {
  return `${toTons(kg).toLocaleString('pl-PL', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} t`
}

function formatPln(amount: number): string {
  return amount.toLocaleString('pl-PL', {
    style: 'currency',
    currency: 'PLN',
    maximumFractionDigits: 0,
  })
}

function formatMoment(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('pl-PL', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const MOVEMENT_LABEL: Record<string, string> = {
  receipt: 'Przyjęcie',
  transfer: 'Sortowanie',
  adjust: 'Wydanie',
  pick: 'Pobranie',
  ship: 'Wysyłka',
}

const LEGACY_TYPE: Record<string, string> = {
  receipt: 'PZ',
  transfer: 'SORT',
  adjust: 'WZ',
}

/**
 * Skąd dokąd poszedł towar.
 *
 * Korekta wydania zapisuje lokalizację jako `locationTo`, więc surowe pola
 * pokazałyby „→ BOKS1" dla czegoś, co z boksu wyjechało. Operator ma zobaczyć
 * kierunek, a nie wewnętrzną konwencję WMS.
 */
function describeRoute(row: MovementRow): string {
  if (row.type === 'adjust' && row.quantityKg < 0) {
    return `${row.toCode ?? row.fromCode ?? '—'} → odbiorca`
  }
  if (row.type === 'receipt') return `dostawca → ${row.toCode ?? '—'}`
  return `${row.fromCode ?? '—'} → ${row.toCode ?? '—'}`
}

function utilisationTone(utilisation: number | null): string {
  if (utilisation === null) return 'bg-muted'
  if (utilisation >= 90) return 'bg-destructive'
  if (utilisation >= 70) return 'bg-amber-500'
  return 'bg-emerald-600'
}

export default function SortowniaDashboard() {
  const [data, setData] = React.useState<DashboardData | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    try {
      const response = await apiFetch('/api/sortownia/dashboard')
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? `Serwer odpowiedział ${response.status}`)
      }
      setData((await response.json()) as DashboardData)
      setError(null)
    } catch (caught) {
      setError((caught as Error)?.message ?? 'Nie udało się pobrać danych pulpitu.')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
    // Ruchy dochodzą w trakcie zmiany, więc pulpit odświeża się sam.
    const timer = setInterval(() => void load(), 30_000)
    return () => clearInterval(timer)
  }, [load])

  const totals = data?.totals
  const sales = data?.sales
  const trace = data?.traceability
  const ewidencja = data?.ewidencja
  const rezerwacje = data?.rezerwacje
  const bilans = data?.bilans
  const bins = (data?.locations ?? []).filter((row) => row.capacityKg !== null)
  // Zapełnienie widać na liście lokalizacji, więc wykres pokazuje co innego:
  // ile każdej frakcji przeszło przez zakład w ostatnim miesiącu.
  const chartData = (data?.flow ?? []).map((row) => ({
    frakcja: row.sku,
    Przyjęte: toTons(row.receivedKg),
    Wysortowane: toTons(row.sortedKg),
    Wydane: toTons(row.issuedKg),
  }))
  const alerts = (data?.fractions ?? []).filter((row) => row.belowReorderPoint)

  return (
    <div className="flex flex-col gap-6">
      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          title="Na placu przyjęć"
          value={totals ? toTons(totals.yardKg) : null}
          suffix=" t"
          loading={loading}
          footer={<span className="text-xs text-muted-foreground">Czeka na wysortowanie</span>}
        />
        <KpiCard
          title="W boksach"
          value={totals ? toTons(totals.binsKg) : null}
          suffix=" t"
          loading={loading}
          footer={
            <span className="text-xs text-muted-foreground">
              {rezerwacje && rezerwacje.count > 0
                ? `w tym ${formatTons(rezerwacje.reservedKg)} zarezerwowane (${rezerwacje.count} zamówień)`
                : 'Gotowe do wydania odbiorcom'}
            </span>
          }
        />
        <KpiCard
          title="Wysortowane (30 dni)"
          value={totals ? toTons(totals.sorted30dKg) : null}
          suffix=" t"
          loading={loading}
          footer={<span className="text-xs text-muted-foreground">Przesunięcia plac → boks</span>}
        />
        <KpiCard
          title="Wydane (30 dni)"
          value={totals ? toTons(totals.issues30dKg) : null}
          suffix=" t"
          loading={loading}
          footer={
            <span className="text-xs text-muted-foreground">
              {totals ? `${totals.movements30d} ruchów, ostatni ${formatMoment(totals.lastMovementAt)}` : '—'}
            </span>
          }
        />
      </div>

      {sales && sales.orders > 0 ? (
        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">Sprzedaż frakcji</h2>
            <p className="text-sm text-muted-foreground">
              Wydania z magazynu jako dokumenty sprzedaży — z ceną, odbiorcą i fakturą.
              Stary system kończył się na ujemnej liczbie w księdze ruchów.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              title="Przychód netto"
              value={Math.round(sales.netPln)}
              suffix=" zł"
              loading={loading}
              footer={<span className="text-xs text-muted-foreground">{formatPln(sales.grossPln)} brutto</span>}
            />
            <KpiCard
              title="Zamówienia sprzedaży"
              value={sales.orders}
              loading={loading}
              footer={<span className="text-xs text-muted-foreground">z wydań WZ systemu legacy</span>}
            />
            <KpiCard
              title="Wystawione faktury"
              value={sales.invoices}
              loading={loading}
              footer={
                <span className="text-xs text-muted-foreground">
                  {sales.invoices === sales.orders
                    ? 'każde wydanie zafakturowane'
                    : `${sales.orders - sales.invoices} bez faktury`}
                </span>
              }
            />
            <KpiCard
              title="Do zapłaty"
              value={Math.round(sales.outstandingPln ?? 0)}
              suffix=" zł"
              loading={loading}
              footer={
                <span className="text-xs text-muted-foreground">
                  {sales.unpaidDocs
                    ? `${sales.unpaidDocs} dokumentów${
                        sales.oldestUnpaidDays !== null ? `, najstarszy ${sales.oldestUnpaidDays} dni` : ''
                      }`
                    : 'wszystko rozliczone'}
                </span>
              }
            />
          </div>

          <div className="rounded-lg border px-4 py-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-muted-foreground">Rozrachunki z odbiorcami</span>
              <span className="tabular-nums">
                wystawione {formatPln(sales.billedPln ?? 0)} · wpłacone {formatPln(sales.paidPln ?? 0)} ·{' '}
                <strong>zaległe {formatPln(sales.outstandingPln ?? 0)}</strong>
              </span>
            </div>
          </div>

          {sales.topBuyers.length ? (
            <div className="rounded-lg border">
              <div className="border-b px-4 py-2 text-sm font-medium">Najwięksi odbiorcy</div>
              <div className="divide-y">
                {sales.topBuyers.map((buyer) => (
                  <div key={buyer.nazwa} className="flex items-center justify-between gap-4 px-4 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm">{buyer.nazwa}</div>
                      <div className="text-xs text-muted-foreground">{buyer.orders} wydań</div>
                    </div>
                    <div className="text-sm tabular-nums">{formatPln(buyer.netPln)}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {bilans && bilans.receivedKg > 0 ? (
        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">Bilans masy i sprawność sortowania</h2>
            <p className="text-sm text-muted-foreground">
              Przyjęte minus wydane musi równać się temu, co leży. Sortowanie jest
              przesunięciem wewnętrznym i masy nie zmienia, więc do bilansu nie wchodzi.
            </p>
          </div>

          <div
            className={`rounded-lg border px-4 py-3 ${
              Math.abs(bilans.differenceKg) > 1 ? 'border-amber-500/50 bg-amber-500/10' : ''
            }`}
          >
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm tabular-nums">
              <span>{formatTons(bilans.receivedKg)} przyjęte</span>
              <span className="text-muted-foreground">−</span>
              <span>{formatTons(bilans.issuedKg)} wydane</span>
              <span className="text-muted-foreground">=</span>
              <span>{formatTons(bilans.onHandKg)} na stanie</span>
              <span className="ml-auto font-medium">
                {Math.abs(bilans.differenceKg) <= 1
                  ? 'bilans domyka się'
                  : `różnica ${formatTons(bilans.differenceKg)} — sprawdź ewidencję`}
              </span>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <KpiCard
              title="Sprawność sortowania"
              value={bilans.sortingRate}
              suffix="%"
              loading={loading}
              footer={
                <span className="text-xs text-muted-foreground">
                  {formatTons(bilans.sortedKg)} wysortowane z {formatTons(bilans.receivedKg)} przyjętych
                </span>
              }
            />
            <KpiCard
              title="Średnia cena sprzedaży"
              value={
                bilans.perFraction.length
                  ? Number(
                      (
                        bilans.perFraction.reduce((sum, row) => sum + row.netPln, 0) /
                        Math.max(
                          bilans.perFraction.reduce((sum, row) => sum + row.soldKg, 0),
                          1,
                        )
                      ).toFixed(2),
                    )
                  : 0
              }
              suffix=" zł/kg"
              loading={loading}
              footer={<span className="text-xs text-muted-foreground">ważona masą wszystkich frakcji</span>}
            />
          </div>

          {bilans.perFraction.length ? (
            <div className="rounded-lg border">
              <div className="border-b px-4 py-2 text-sm font-medium">Przychód per frakcja</div>
              <div className="divide-y">
                {bilans.perFraction.map((row) => (
                  <div key={row.sku} className="flex items-center justify-between gap-4 px-4 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm">{row.sku}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatTons(row.soldKg)}
                        {row.pricePerKg !== null ? ` · ${row.pricePerKg.toFixed(2)} zł/kg` : ''}
                      </div>
                    </div>
                    <div className="text-sm tabular-nums">{formatPln(row.netPln)}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {ewidencja && ewidencja.cards > 0 ? (
        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">Ewidencja przekazań odpadu</h2>
            <p className="text-sm text-muted-foreground">
              Każde wydanie ma kartę przekazania z masą, kodem odpadu, procesem odzysku
              i numerami rejestrowymi obu stron. To odpowiednik karty przekazania odpadu —
              nie dokument z systemu BDO, bo integracji z BDO tu nie ma.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <KpiCard
              title="Karty przekazania"
              value={ewidencja.cards}
              loading={loading}
              footer={<span className="text-xs text-muted-foreground">wystawione z wydań WZ</span>}
            />
            <KpiCard
              title="Masa przekazana"
              value={toTons(ewidencja.massKg)}
              suffix=" t"
              loading={loading}
              footer={<span className="text-xs text-muted-foreground">suma z kart przekazania</span>}
            />
            <KpiCard
              title="Karty niekompletne"
              value={ewidencja.withoutProcess + ewidencja.withoutBdo}
              loading={loading}
              footer={
                <span className="text-xs text-muted-foreground">
                  {ewidencja.withoutProcess + ewidencja.withoutBdo === 0
                    ? 'komplet danych na każdej karcie'
                    : `bez procesu ${ewidencja.withoutProcess}, bez numeru BDO ${ewidencja.withoutBdo}`}
                </span>
              }
            />
          </div>
        </section>
      ) : null}

      {trace && trace.lots > 0 ? (
        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">Pochodzenie odpadu</h2>
            <p className="text-sm text-muted-foreground">
              Każde przyjęcie zakłada partię z dostawcą i datą. Stary system wiedział tylko,
              że przyjechało 6 412 kg papieru — nie czyjego.
            </p>
          </div>
          <div className="rounded-lg border">
            <div className="flex items-center justify-between border-b px-4 py-2 text-sm font-medium">
              <span>Dostawcy</span>
              <span className="text-xs font-normal text-muted-foreground">{trace.lots} partii</span>
            </div>
            <div className="divide-y">
              {trace.suppliers.map((row) => (
                <div key={row.dostawca} className="flex items-center justify-between gap-4 px-4 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm">{row.dostawca}</div>
                    <div className="text-xs text-muted-foreground">{row.lots} partii</div>
                  </div>
                  <div className="text-sm tabular-nums">{formatTons(row.receivedKg)}</div>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {alerts.length > 0 ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <div className="text-sm font-medium">Frakcje poniżej progu wysyłki</div>
          <div className="mt-1 text-sm text-muted-foreground">
            {alerts
              .map((row) => `${row.name} (${formatTons(row.quantityKg)} z ${formatTons(row.reorderPointKg ?? 0)})`)
              .join(' · ')}
          </div>
        </div>
      ) : null}

      <BarChart
        title="Przepływ frakcji przez zakład (30 dni)"
        data={chartData}
        index="frakcja"
        categories={['Przyjęte', 'Wysortowane', 'Wydane']}
        loading={loading}
        layout="horizontal"
        showLegend
        valueFormatter={(value) => `${value.toLocaleString('pl-PL', { maximumFractionDigits: 1 })} t`}
        emptyMessage="Brak ruchów w ostatnich 30 dniach."
      />

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="rounded-lg border bg-card">
          <header className="border-b px-4 py-3">
            <h2 className="text-sm font-semibold">Lokalizacje</h2>
            <p className="text-xs text-muted-foreground">Pojemność boksu jest wiedzą, której stary system nie miał gdzie zapisać.</p>
          </header>
          <div className="divide-y">
            {bins.map((row) => (
              <div key={row.code} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <div>
                    <span className="font-mono text-sm font-medium">{row.code}</span>
                    {row.legacyName ? (
                      <span className="ml-2 text-xs text-muted-foreground">{row.legacyName}</span>
                    ) : null}
                  </div>
                  <div className="text-sm tabular-nums">
                    {formatTons(row.quantityKg ?? 0)}
                    <span className="text-muted-foreground"> / {formatTons(row.capacityKg ?? 0)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full ${utilisationTone(row.utilisation)}`}
                      style={{ width: `${Math.min(100, row.utilisation ?? 0)}%` }}
                    />
                  </div>
                  <span className="w-14 text-right text-xs tabular-nums text-muted-foreground">
                    {row.utilisation === null ? '—' : `${row.utilisation.toFixed(1)}%`}
                  </span>
                </div>
              </div>
            ))}
            {!loading && bins.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">
                Brak lokalizacji. Uruchom import z systemu legacy.
              </div>
            ) : null}
          </div>
        </section>

        <section className="rounded-lg border bg-card">
          <header className="border-b px-4 py-3">
            <h2 className="text-sm font-semibold">Frakcje</h2>
            <p className="text-xs text-muted-foreground">Kod odpadu jest SKU pozycji katalogowej.</p>
          </header>
          <div className="divide-y">
            {(data?.fractions ?? []).map((row) => (
              <div key={row.sku} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{row.name}</div>
                  <div className="font-mono text-xs text-muted-foreground">{row.sku}</div>
                </div>
                <div className="text-right">
                  <div className="text-sm tabular-nums">{formatTons(row.quantityKg)}</div>
                  <div className="text-xs text-muted-foreground">
                    {row.reorderPointKg === null ? (
                      'bez progu'
                    ) : row.belowReorderPoint ? (
                      <span className="text-amber-600">poniżej progu {formatTons(row.reorderPointKg)}</span>
                    ) : (
                      `próg ${formatTons(row.reorderPointKg)}`
                    )}
                  </div>
                </div>
              </div>
            ))}
            {!loading && (data?.fractions ?? []).length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">Brak frakcji w katalogu.</div>
            ) : null}
          </div>
        </section>
      </div>

      <section className="rounded-lg border bg-card">
        <header className="flex items-baseline justify-between border-b px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Ostatnie ruchy</h2>
            <p className="text-xs text-muted-foreground">
              Każdy wiersz niesie swój numer z systemu legacy — ślad, po którym da się wrócić do kwitu.
            </p>
          </div>
          {data ? (
            <span className="text-xs text-muted-foreground">Odświeżono {formatMoment(data.generatedAt)}</span>
          ) : null}
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Czas</th>
                <th className="px-4 py-2 text-left font-medium">Operacja</th>
                <th className="px-4 py-2 text-left font-medium">Frakcja</th>
                <th className="px-4 py-2 text-left font-medium">Skąd → dokąd</th>
                <th className="px-4 py-2 text-right font-medium">Masa</th>
                <th className="px-4 py-2 text-left font-medium">Legacy</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {(data?.movements ?? []).map((row) => (
                <tr key={row.id}>
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums text-muted-foreground">
                    {formatMoment(row.performedAt)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2">
                    {MOVEMENT_LABEL[row.type] ?? row.type}
                    {LEGACY_TYPE[row.type] ? (
                      <span className="ml-2 rounded border px-1 font-mono text-[10px] uppercase text-muted-foreground">
                        {LEGACY_TYPE[row.type]}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2">
                    <span className="font-mono text-xs">{row.fractionSku ?? '—'}</span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 font-mono text-xs">
                    {describeRoute(row)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">
                    {formatTons(Math.abs(row.quantityKg))}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-muted-foreground">
                    {row.legacyMoveNo === null ? '—' : `#${row.legacyMoveNo}`}
                  </td>
                </tr>
              ))}
              {!loading && (data?.movements ?? []).length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-sm text-muted-foreground">
                    Księga jest pusta. Uruchom <span className="font-mono">mercato sortownia import</span>.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
