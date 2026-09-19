'use client'

import * as React from 'react'
import { KpiCard } from '@open-mercato/ui/backend/charts'
import { apiFetch } from '@open-mercato/ui/backend/utils/api'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'

/**
 * Pulpit wdrożeń etapowych.
 *
 * Przy każdym etapie stoi ostatni werdykt bramy **razem ze zmierzonymi
 * liczbami i progiem**. Sam status („wycofany") zmusza do przeliczenia księgi
 * wstecz, żeby powiedzieć dlaczego — a księga w międzyczasie urosła.
 *
 * Kolumna „kto" przy werdykcie pokazuje `automat` albo nazwisko. W poprawnie
 * działającym wdrożeniu zawsze jest tam automat; podpis człowieka przy
 * wycofaniu znaczy, że automat nie zdążył, i to też jest informacja.
 */

type Gate = {
  decision: string
  reason: string
  episodes: number
  interventionRate: number
  severeRate: number
  successRate: number
  evaluatedAt: string | null
  automatic: boolean
}

type Stage = {
  id: string
  ordinal: number
  name: string
  status: string
  members: number
  rolledBackMembers: number
  thresholds: {
    minEpisodes: number
    maxInterventionRate: number
    maxSevereRate: number
    minSuccessRate: number
  }
  lastGate: Gate | null
}

type RolloutRow = {
  id: string
  name: string
  mode: string
  status: string
  statusReason: string | null
  policy: string
  startedAt: string | null
  finishedAt: string | null
  shadowCaveat: string | null
  stages: Stage[]
}

type Payload = {
  generatedAt: string
  totals: { rollouts: number; running: number; rolledBack: number; completed: number }
  rollouts: RolloutRow[]
}

const STATUS_LABEL: Record<string, [string, string]> = {
  planned: ['rollout.label.status.planned', "zaplanowane"],
  running: ['rollout.label.status.running', "w biegu"],
  halted: ['rollout.label.status.halted', "wstrzymane"],
  completed: ['rollout.label.status.completed', "zakończone"],
  rolled_back: ['rollout.label.status.rolled_back', "wycofane"],
  pending: ['rollout.label.status.pending', "oczekuje"],
  passed: ['rollout.label.status.passed', "zaliczony"],
}

const STATUS_TONE: Record<string, string> = {
  running: 'text-emerald-600',
  passed: 'text-emerald-600',
  completed: 'text-emerald-600',
  halted: 'text-amber-600',
  rolled_back: 'text-red-600',
  pending: 'text-muted-foreground',
  planned: 'text-muted-foreground',
}

const DECISION_LABEL: Record<string, [string, string]> = {
  advance: ['rollout.label.decision.advance', "przepuść"],
  hold: ['rollout.label.decision.hold', "wstrzymaj — za mało danych"],
  rollback: ['rollout.label.decision.rollback', "WYCOFAJ"],
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

export default function RolloutBoard() {
  const t = useT()
  const [data, setData] = React.useState<Payload | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    try {
      const response = await apiFetch('/api/rollout/rollouts')
      if (!response.ok) {
        const body = (await response.json()) as { error?: string }
        setError(body?.error ?? t('rollout.err.http', 'Błąd {status}', { status: String(response.status) }))
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
    const timer = setInterval(() => void load(), 15_000)
    return () => clearInterval(timer)
  }, [load])

  const totals = data?.totals
  const rollouts = data?.rollouts ?? []

  return (
    <div className="flex flex-col gap-6">
      {error ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm">{error}</div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard title={t('rollout.ui.rollouts', "Wdrożenia")} value={totals?.rollouts ?? null} loading={loading} />
        <KpiCard
          title={t('rollout.ui.running', "W biegu")}
          value={totals?.running ?? null}
          loading={loading}
          footer={<span className="text-xs text-muted-foreground">etap czynny, brama czeka na dane</span>}
        />
        <KpiCard
          title={t('rollout.ui.rolledBack', "Wycofane")}
          value={totals?.rolledBack ?? null}
          loading={loading}
          footer={
            <span className="text-xs text-muted-foreground">{t('rollout.ui.rollbackIsCheaper', "wycofanie jest tańsze niż diagnoza, więc jest domyślne")}</span>
          }
        />
        <KpiCard title={t('rollout.ui.completed', "Zakończone")} value={totals?.completed ?? null} loading={loading} />
      </div>

      {!loading && !rollouts.length ? (
        <div className="rounded-md border px-4 py-6 text-sm text-muted-foreground">{t('rollout.ui.noRollouts', "Brak zaplanowanych wdrożeń. Uruchom")}<code>yarn mercato rollout prove</code>.
        </div>
      ) : null}

      {rollouts.map((rollout) => (
        <div key={rollout.id} className="rounded-md border">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
            <div>
              <div className="font-medium">{rollout.name}</div>
              <div className="text-xs text-muted-foreground">
                {rollout.policy} · tryb {rollout.mode === 'shadow' ? 'cieniowy' : 'czynny'}
              </div>
            </div>
            <div className={`text-sm ${STATUS_TONE[rollout.status] ?? ''}`}>
              {STATUS_LABEL[rollout.status] ? t(...STATUS_LABEL[rollout.status]) : rollout.status}
              {rollout.statusReason ? (
                <div className="text-xs text-muted-foreground">{rollout.statusReason}</div>
              ) : null}
            </div>
          </div>

          {rollout.shadowCaveat ? (
            <div className="border-b bg-amber-500/10 px-4 py-2 text-xs">{rollout.shadowCaveat}</div>
          ) : null}

          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-normal">{t("rollout.h.etap", "etap")}</th>
                <th className="px-4 py-2 font-normal">{t("rollout.h.roboty", "roboty")}</th>
                <th className="px-4 py-2 font-normal">status</th>
                <th className="px-4 py-2 font-normal">{t("rollout.h.brama", "brama")}</th>
                <th className="px-4 py-2 font-normal">zmierzone</th>
                <th className="px-4 py-2 font-normal">{t('rollout.ui.threshold', "próg")}</th>
                <th className="px-4 py-2 font-normal">{t("rollout.h.kto", "kto")}</th>
              </tr>
            </thead>
            <tbody>
              {rollout.stages.map((stage) => (
                <tr key={stage.id} className="border-t align-top">
                  <td className="px-4 py-2">
                    {stage.ordinal}. {stage.name}
                  </td>
                  <td className="px-4 py-2">
                    {stage.members}
                    {stage.rolledBackMembers ? (
                      <span className="text-xs text-red-600"> ({stage.rolledBackMembers} wycofanych)</span>
                    ) : null}
                  </td>
                  <td className={`px-4 py-2 ${STATUS_TONE[stage.status] ?? ''}`}>
                    {STATUS_LABEL[stage.status] ? t(...STATUS_LABEL[stage.status]) : stage.status}
                  </td>
                  <td
                    className={`px-4 py-2 ${stage.lastGate?.decision === 'rollback' ? 'text-red-600' : stage.lastGate?.decision === 'hold' ? 'text-amber-600' : ''}`}
                  >
                    {stage.lastGate ? DECISION_LABEL[stage.lastGate.decision] ? t(...DECISION_LABEL[stage.lastGate.decision]) : stage.lastGate.decision : '—'}
                    {stage.lastGate ? (
                      <div className="text-xs text-muted-foreground">{stage.lastGate.reason}</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {stage.lastGate ? (
                      <>
                        ep {stage.lastGate.episodes}
                        <br />
                        int {pct(stage.lastGate.interventionRate)} / {t('rollout.ui.severe', 'ciężkie')} {pct(stage.lastGate.severeRate)}
                        <br />
                        skut. {pct(stage.lastGate.successRate)}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    ep ≥ {stage.thresholds.minEpisodes}
                    <br />
                    int ≤ {pct(stage.thresholds.maxInterventionRate)} / {t('rollout.ui.severe', 'ciężkie')} ≤{' '}
                    {pct(stage.thresholds.maxSevereRate)}
                    <br />
                    skut. ≥ {pct(stage.thresholds.minSuccessRate)}
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {stage.lastGate ? (stage.lastGate.automatic ? 'automat' : t('rollout.ui.human', "człowiek")) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}
