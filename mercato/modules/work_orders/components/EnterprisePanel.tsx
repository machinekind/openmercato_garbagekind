'use client'

import * as React from 'react'
import { KpiCard } from '@open-mercato/ui/backend/charts'
import { apiFetch } from '@open-mercato/ui/backend/utils/api'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'

/**
 * Panel przedsiębiorstwa.
 *
 * Kolejność kolumn nie jest przypadkowa i oddaje, czyje to jest pytanie.
 * Najpierw zlecenie i odbiorca — bo kierownik zakładu zaczyna od „na czyją
 * rzecz". Potem postęp w kilogramach. Rozjazd jest na końcu, ale to on jest
 * jedyną liczbą na tym ekranie, której nie da się zobaczyć w żadnym innym
 * systemie: **ile materiału robot zgłosił jako przeniesiony, a nie przeniósł.**
 */

type Order = {
  id: string
  orderNumber: string
  sku: string
  cell: string | null
  policy: string | null
  salesOrderNumber: string | null
  status: string
  targetKg: number
  producedKg: number
  progressRatio: number | null
  batches: number
  openBatch: string | null
  driftKg: number | null
  driftRatio: number | null
  overclaimBatches: number
}

type Payload = {
  generatedAt: string
  totals: {
    ordersOpen: number
    producedKg: number
    driftKg: number
    ordersWithoutReference: number
    overclaimBatches: number
  }
  orders: Order[]
}

const STATUS_LABEL: Record<string, [string, string]> = {
  open: ['work_orders.label.status.open', "W toku"],
  completed: ['work_orders.label.status.completed', "Zamknięte"],
  cancelled: ['work_orders.label.status.cancelled', "Anulowane"],
}

function kg(locale: string, value: number): string {
  return `${value.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kg`
}

/**
 * Opis rozjazdu.
 *
 * `null` znaczy „nie mamy masy nominalnej sztuki", a nie „zero". Te dwie
 * rzeczy nie mogą wyglądać tak samo: pierwsza to brak pomiaru, druga to
 * pomiar wynoszący zero.
 */
type Tf = (key: string, fallback?: string | Record<string, string | number>, params?: Record<string, string | number>) => string

function describeDrift(t: Tf, locale: string, order: Order): { text: string; tone: string } {
  if (order.driftKg === null) return { text: t('work_orders.ui.noReference', 'brak odniesienia'), tone: 'text-muted-foreground' }
  const procent = order.driftRatio === null ? '' : ` (${(order.driftRatio * 100).toFixed(1)}%)`
  if (order.overclaimBatches > 0) {
    return { text: `${kg(locale, order.driftKg)}${procent}`, tone: 'text-red-600' }
  }
  if (order.driftKg > 0) return { text: `+${kg(locale, order.driftKg)}${procent}`, tone: 'text-amber-600' }
  return { text: `${kg(locale, order.driftKg)}${procent}`, tone: 'text-muted-foreground' }
}

export default function EnterprisePanel() {
  const t = useT()
  const locale = useLocale()
  const [data, setData] = React.useState<Payload | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    try {
      const response = await apiFetch('/api/work_orders/panel')
      if (!response.ok) {
        const body = (await response.json()) as { error?: string }
        setError(body?.error ?? t('work_orders.err.http', 'Błąd {status}', { status: String(response.status) }))
        return
      }
      setData((await response.json()) as Payload)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 30_000)
    return () => clearInterval(timer)
  }, [load])

  const totals = data?.totals
  const orders = data?.orders ?? []

  return (
    <div className="flex flex-col gap-6" data-testid="enterprise-panel">
      {error ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm">{error}</div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          title={t('work_orders.ui.openOrders', "Zlecenia w toku")}
          value={totals?.ordersOpen ?? null}
          loading={loading}
          footer={<span className="text-xs text-muted-foreground">{t('work_orders.ui.cellsOnOrders', "cele pracujące na zamówienia")}</span>}
        />
        <KpiCard
          title={t('work_orders.ui.produced', "Wyprodukowano")}
          value={totals ? Number(totals.producedKg.toFixed(1)) : null}
          loading={loading}
          footer={<span className="text-xs text-muted-foreground">{t('work_orders.ui.kgFromScale', "kilogramów z wagi, nie z deklaracji")}</span>}
        />
        <KpiCard
          title={t('work_orders.ui.drift', "Rozjazd")}
          value={totals ? Number(totals.driftKg.toFixed(1)) : null}
          loading={loading}
          footer={
            <span className="text-xs text-muted-foreground">
              {totals?.ordersWithoutReference
                ? t('work_orders.ui.nWithoutNominal', '{n} zleceń bez masy nominalnej', { n: String(totals.ordersWithoutReference) })
                : 'kg wagi minus deklaracja robota'}
            </span>
          }
        />
        <KpiCard
          title={t('work_orders.ui.missingMaterial', "Brakujący materiał")}
          value={totals?.overclaimBatches ?? null}
          loading={loading}
          footer={
            <span className="text-xs text-muted-foreground">{t('work_orders.ui.batchesOverclaimed', "partii, w których robot zgłosił więcej, niż przyniósł")}</span>
          }
        />
      </div>

      <div className="rounded-lg border">
        <div className="flex items-center justify-between border-b px-4 py-2">
          <span className="text-sm font-medium">{t("work_orders.h.zleceniaRobocze", "Zlecenia robocze")}</span>
          <span className="text-xs text-muted-foreground">
            {data ? t('work_orders.ui.asOf', 'stan na {t}', { t: new Date(data.generatedAt).toLocaleTimeString(locale) }) : ''}
          </span>
        </div>

        {orders.length === 0 && !loading ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {t('work_orders.empty.orders', 'Brak zleceń roboczych. Załóż je komendą')}{' '}
            <code className="rounded bg-muted px-1">mercato work_orders prove</code>.
          </div>
        ) : (
          <div className="divide-y">
            {orders.map((order) => {
              const drift = describeDrift(t, locale, order)
              return (
                <div key={order.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-medium">{order.orderNumber}</span>
                      <span className="font-mono text-xs text-muted-foreground">{order.sku}</span>
                      {order.salesOrderNumber ? (
                        <span
                          className="rounded border px-1 text-[10px] uppercase tracking-wide text-muted-foreground"
                          title={t('work_orders.ui.salesOrderBehind', "Zamówienie sprzedaży, na którego rzecz powstało zlecenie")}
                        >
                          {order.salesOrderNumber}
                        </span>
                      ) : null}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {[order.cell, order.policy].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>

                  <div className="w-40">
                    <div className="text-sm">
                      {kg(locale, order.producedKg)}
                      <span className="text-xs text-muted-foreground"> / {kg(locale, order.targetKg)}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {order.progressRatio === null ? '—' : `${(order.progressRatio * 100).toFixed(0)}%`}
                      {' · '}
                      {order.batches} partii
                      {order.openBatch ? ` · ${order.openBatch} w toku` : ''}
                    </div>
                  </div>

                  <div className="w-52 text-right">
                    <div className={`text-sm ${drift.tone}`}>{drift.text}</div>
                    <div className="text-xs text-muted-foreground">
                      {STATUS_LABEL[order.status] ? t(...STATUS_LABEL[order.status]) : order.status}
                      {order.overclaimBatches > 0 ? ` · ${order.overclaimBatches} do sprawdzenia` : ''}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
