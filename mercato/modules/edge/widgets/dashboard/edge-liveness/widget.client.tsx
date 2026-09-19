"use client"

import * as React from 'react'
import { useRouter } from 'next/navigation'
import type { DashboardWidgetComponentProps } from '@open-mercato/shared/modules/dashboard/widgets'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import type { EdgeLivenessSettings } from './widget'

type Totals = { agents: number; online: number; late: number; lost: number; neverSeen: number; revoked: number }

export default function EdgeLivenessWidget({ refreshToken }: DashboardWidgetComponentProps<EdgeLivenessSettings>) {
  const t = useT()
  const router = useRouter()
  const [totals, setTotals] = React.useState<Totals | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let anulowane = false
    void (async () => {
      const call = await apiCall<{ totals: Totals }>('/api/edge/agents')
      if (anulowane) return
      if (!call.ok || !call.result) {
        setError(t('edge.widget.error', 'Nie udało się pobrać stanu łączności.'))
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

  const milczace = totals.lost + totals.neverSeen

  return (
    <button type="button" onClick={() => router.push('/backend/edge')} className="flex h-full w-full flex-col gap-2 text-left">
      <div className="text-3xl font-semibold tabular-nums">
        {totals.online}
        <span className="text-base font-normal text-muted-foreground"> / {totals.agents}</span>
      </div>
      <div className="text-xs text-muted-foreground">{t('edge.widget.reporting', 'agentów się odzywa')}</div>

      {/*
        Milczące i spóźnione rozdzielone, bo to dwie różne sytuacje: spóźnienie
        to zwykle sieć, cisza ponad próg to maszyna, o której nic nie wiemy.
      */}
      <div className="mt-auto flex gap-3 text-xs">
        <span className={totals.late ? 'text-amber-600' : 'text-muted-foreground'}>
          {totals.late} {t('edge.ui.late', 'Spóźnieni')}
        </span>
        <span className={milczace ? 'text-red-600' : 'text-muted-foreground'}>
          {milczace} {t('edge.widget.silent', 'milczy')}
        </span>
      </div>
    </button>
  )
}
