"use client"

import * as React from 'react'
import { useRouter } from 'next/navigation'
import type { DashboardWidgetComponentProps } from '@open-mercato/shared/modules/dashboard/widgets'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import type { SafetyClearanceSettings } from './widget'

type Totals = {
  cleared: number
  blocked: number
  declaredAsSafetyFunction: number
  openIncidents: number
}

export default function SafetyClearanceWidget({ refreshToken }: DashboardWidgetComponentProps<SafetyClearanceSettings>) {
  const t = useT()
  const router = useRouter()
  const [totals, setTotals] = React.useState<Totals | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let anulowane = false
    void (async () => {
      const call = await apiCall<{ totals: Totals }>('/api/safety/clearance')
      if (anulowane) return
      if (!call.ok || !call.result) {
        setError(t('safety.widget.error', 'Nie udało się pobrać stanu dopuszczeń.'))
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

  return (
    <button type="button" onClick={() => router.push('/backend/safety')} className="flex h-full w-full flex-col gap-2 text-left">
      <div className="text-3xl font-semibold tabular-nums">{totals.cleared}</div>
      <div className="text-xs text-muted-foreground">{t('safety.widget.clearedPairs', 'dopuszczonych par polityka × cela')}</div>

      <div className="mt-auto flex flex-col gap-1 text-xs">
        <span className={totals.blocked ? 'text-amber-600' : 'text-muted-foreground'}>
          {totals.blocked} {t('safety.ui.blocked', 'Zablokowane')}
        </span>
        {/*
          Ta linia jest czerwona nawet przy jedynce i to jest celowe: nie ma
          „dopuszczalnego poziomu" uzasadnień deklarujących uczoną politykę
          jako funkcję bezpieczeństwa.
        */}
        <span className={totals.declaredAsSafetyFunction ? 'text-red-600 font-medium' : 'text-muted-foreground'}>
          {totals.declaredAsSafetyFunction} {t('safety.widget.declaredAsFn', 'polityka jako funkcja bezp.')}
        </span>
      </div>
    </button>
  )
}
