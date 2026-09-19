"use client"

import * as React from 'react'
import { useRouter } from 'next/navigation'
import type { DashboardWidgetComponentProps } from '@open-mercato/shared/modules/dashboard/widgets'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import type { FleetReadinessSettings } from './widget'

type Totals = {
  robots: number
  active: number
  quarantined: number
  calibrationBlocked: number
  calibrationExpiring: number
  externallyOperated: number
}

export default function FleetReadinessWidget({ refreshToken }: DashboardWidgetComponentProps<FleetReadinessSettings>) {
  const t = useT()
  const router = useRouter()
  const [totals, setTotals] = React.useState<Totals | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let anulowane = false
    void (async () => {
      const call = await apiCall<{ totals: Totals }>('/api/fleet/robots')
      if (anulowane) return
      if (!call.ok || !call.result) {
        setError(t('fleet.widget.error', 'Nie udało się pobrać stanu floty.'))
        return
      }
      setError(null)
      setTotals(call.result.totals)
    })()
    return () => {
      anulowane = true
    }
  }, [refreshToken, t])

  if (error) return <ErrorMessage label={error} />
  if (!totals) return <LoadingMessage label={t('common.loading', 'Wczytywanie…')} />

  /*
   * Kolejność kafelków nie jest alfabetyczna ani „od największego": zaczyna
   * się od liczby, która odpowiada na pytanie operatora, a kończy na tych,
   * które mówią, dlaczego nie jest wyższa.
   */
  const pola: Array<{ etykieta: string; wartosc: number; alarm: boolean }> = [
    { etykieta: t('fleet.ui.active', 'Czynne'), wartosc: totals.active, alarm: false },
    { etykieta: t('fleet.ui.quarantined', 'W kwarantannie'), wartosc: totals.quarantined, alarm: totals.quarantined > 0 },
    { etykieta: t('fleet.ui.calibrationBlock', 'Blokada kalibracji'), wartosc: totals.calibrationBlocked, alarm: totals.calibrationBlocked > 0 },
    { etykieta: t('fleet.widget.expiring', 'Kalibracja wygasa'), wartosc: totals.calibrationExpiring, alarm: false },
  ]

  return (
    <div className="flex h-full flex-col gap-3">
      <button
        type="button"
        onClick={() => router.push('/backend/fleet')}
        className="text-left"
      >
        <div className="text-3xl font-semibold tabular-nums">
          {totals.active}
          <span className="text-base font-normal text-muted-foreground"> / {totals.robots}</span>
        </div>
        <div className="text-xs text-muted-foreground">
          {t('fleet.widget.readyOfTotal', 'maszyn wolno uruchomić')}
        </div>
      </button>

      <div className="grid grid-cols-2 gap-2 text-xs">
        {pola.map((pole) => (
          <div key={pole.etykieta} className="rounded border px-2 py-1">
            <div className={`text-lg tabular-nums ${pole.alarm ? 'text-red-600' : ''}`}>{pole.wartosc}</div>
            <div className="text-muted-foreground">{pole.etykieta}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
