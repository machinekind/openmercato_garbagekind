'use client'

import * as React from 'react'
import { KpiCard } from '@open-mercato/ui/backend/charts'
import { apiFetch } from '@open-mercato/ui/backend/utils/api'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'

/**
 * Pulpit stanu pożądanego.
 *
 * Kolumna, wokół której zbudowany jest ekran, to **czas do wygaśnięcia
 * dzierżawy**, a nie nazwa stanu. „Pracuje" bez tej liczby nie mówi, czy
 * maszyna pracuje dlatego, że wszystko gra, czy dlatego, że mandat jeszcze nie
 * zdążył wygasnąć — a to są dwa różne wdrożenia.
 *
 * Ekran odświeża się co 10 s, bo w celi publicznej cały mandat trwa 120 s.
 * Odświeżanie co 30 s, jak w rejestrze floty, pokazywałoby robota jako
 * pracującego przez jedną czwartą czasu po tym, jak sam się zatrzymał.
 */

type Row = {
  assignmentId: string
  robotId: string
  serialNumber: string
  robotState: string
  cell: string | null
  riskClass: string
  leaseSeconds: number
  desiredState: string
  policy: string
  reason: string
  assignedAt: string
  leaseExpiresAt: string | null
  working: boolean
  authorizationReason: string
  secondsLeft: number | null
  reportedState: string | null
  reportedAt: string | null
  reconciliation: string
}

type Payload = {
  generatedAt: string
  totals: { assignments: number; working: number; haltedByLease: number; drift: number; unknown: number }
  byRiskClass: Record<string, number>
  assignments: Row[]
}

const RISK_LABEL: Record<string, [string, string]> = {
  fenced: ['deployment.label.risk.fenced', "ogrodzona"],
  shared: ['deployment.label.risk.shared', "dzielona"],
  public: ['deployment.label.risk.public', "publiczna"],
}

/** Kolor niesie pilność zatrzymania, nie kategorię celi. */
const RISK_TONE: Record<string, string> = {
  fenced: 'text-muted-foreground',
  shared: 'text-amber-600',
  public: 'text-red-600',
}

const RECONCILIATION_LABEL: Record<string, [string, string]> = {
  converged: ['deployment.label.reconciliation.converged', "zgodny"],
  drift: ['deployment.label.reconciliation.drift', "ROZJAZD"],
  unknown: ['deployment.label.reconciliation.unknown', "nie zgłosił"],
}

type Tf = (key: string, fallback?: string | Record<string, string | number>, params?: Record<string, string | number>) => string

function formatDuration(t: Tf, seconds: number | null): string {
  if (seconds === null) return '—'
  const abs = Math.abs(seconds)
  const text =
    abs >= 86400
      ? `${Math.floor(abs / 86400)} d ${Math.floor((abs % 86400) / 3600)} h`
      : abs >= 3600
        ? `${Math.floor(abs / 3600)} h ${Math.floor((abs % 3600) / 60)} min`
        : abs >= 60
          ? `${Math.floor(abs / 60)} min ${abs % 60} s`
          : `${abs} s`
  return seconds < 0 ? t('deployment.ui.elapsed', 'minęło {t}', { t: text }) : text
}

export default function DeploymentBoard() {
  const t = useT()
  const [data, setData] = React.useState<Payload | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    try {
      const response = await apiFetch('/api/deployment/assignments')
      if (!response.ok) {
        const body = (await response.json()) as { error?: string }
        setError(body?.error ?? t('deployment.err.http', 'Błąd {status}', { status: String(response.status) }))
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
    const timer = setInterval(() => void load(), 10_000)
    return () => clearInterval(timer)
  }, [load])

  const totals = data?.totals
  const rows = data?.assignments ?? []

  return (
    <div className="flex flex-col gap-6">
      {error ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm">{error}</div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          title={t('deployment.ui.assignments', "Przypisania")}
          value={totals?.assignments ?? null}
          loading={loading}
          footer={<span className="text-xs text-muted-foreground">{t('deployment.ui.activeDesiredState', "czynny stan pożądany floty")}</span>}
        />
        <KpiCard
          title={t('deployment.ui.withValidLease', "Z ważnym mandatem")}
          value={totals?.working ?? null}
          loading={loading}
          footer={<span className="text-xs text-muted-foreground">{t('deployment.ui.leaseNotExpired', "dzierżawa jeszcze nie wygasła")}</span>}
        />
        <KpiCard
          title={t('deployment.ui.stoppedByLease', "Zatrzymane dzierżawą")}
          value={totals?.haltedByLease ?? null}
          loading={loading}
          footer={
            <span className="text-xs text-muted-foreground">{t('deployment.ui.nothingRecorded', "centrala nic nie zapisała — mandat po prostu upłynął")}</span>
          }
        />
        <KpiCard
          title={t('deployment.ui.stateDrift', "Rozjazd stanu")}
          value={totals?.drift ?? null}
          loading={loading}
          footer={
            <span className="text-xs text-muted-foreground">
              {totals ? t('deployment.ui.nRobotsSilent', '{n} robotów nic nie zgłosiło', { n: String(totals.unknown) }) : '—'}
            </span>
          }
        />
      </div>

      {!loading && !rows.length ? (
        <div className="rounded-md border px-4 py-6 text-sm text-muted-foreground">{t('deployment.ui.noAssignments', "Żaden robot nie ma przypisanej polityki. Uruchom")}<code>yarn mercato deployment prove</code>.
        </div>
      ) : null}

      {rows.length ? (
        <div className="rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-normal">{t("deployment.h.robot", "robot")}</th>
                <th className="px-4 py-2 font-normal">{t("deployment.h.polityka", "polityka")}</th>
                <th className="px-4 py-2 font-normal">{t("deployment.h.celaRyzyko", "cela / ryzyko")}</th>
                <th className="px-4 py-2 font-normal">{t('deployment.ui.lease', "dzierżawa")}</th>
                <th className="px-4 py-2 font-normal">{t('deployment.ui.untilExpiry', "do wygaśnięcia")}</th>
                <th className="px-4 py-2 font-normal">{t("deployment.h.mandat", "mandat")}</th>
                <th className="px-4 py-2 font-normal">{t("deployment.h.uzgodnienie", "uzgodnienie")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.assignmentId} className="border-t">
                  <td className="px-4 py-2">
                    <div>{row.serialNumber}</div>
                    <div className="text-xs text-muted-foreground">{row.robotState}</div>
                  </td>
                  <td className="px-4 py-2">{row.policy}</td>
                  <td className={`px-4 py-2 ${RISK_TONE[row.riskClass] ?? ''}`}>
                    {row.cell ?? '—'}
                    <span className="text-xs"> · {RISK_LABEL[row.riskClass] ? t(...RISK_LABEL[row.riskClass]) : row.riskClass}</span>
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {formatDuration(t, row.leaseSeconds)}
                  </td>
                  <td className={`px-4 py-2 ${row.working ? '' : 'text-red-600'}`}>
                    {formatDuration(t, row.secondsLeft)}
                  </td>
                  <td className={`px-4 py-2 ${row.working ? 'text-emerald-600' : 'text-red-600'}`}>
                    {row.working ? t('deployment.ui.valid', "ważny") : t('deployment.ui.expired', "wygasł")}
                    <div className="text-xs text-muted-foreground">{row.authorizationReason}</div>
                  </td>
                  <td
                    className={`px-4 py-2 ${row.reconciliation === 'drift' ? 'text-red-600' : row.reconciliation === 'unknown' ? 'text-amber-600' : 'text-muted-foreground'}`}
                  >
                    {RECONCILIATION_LABEL[row.reconciliation] ? t(...RECONCILIATION_LABEL[row.reconciliation]) : row.reconciliation}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}
