'use client'

import * as React from 'react'
import { KpiCard } from '@open-mercato/ui/backend/charts'
import { apiFetch } from '@open-mercato/ui/backend/utils/api'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'

/**
 * Ekran łączności agentów.
 *
 * Istnieje obok rejestru floty, a nie zamiast niego, bo odpowiada na inne
 * pytanie. Rejestr mówi, czy maszynie **wolno** pracować; ten ekran mówi,
 * czy centrala **w ogóle wie**, co się z nią dzieje. Odcisk klucza jest tu
 * na wierzchu, bo to jedyna rzecz, którą technik może porównać z tym, co
 * widzi na robocie — a wpis agenta bez takiego porównania jest zaufaniem
 * udzielonym w ciemno.
 */

type LinkState = 'online' | 'late' | 'lost' | 'never_seen'

type Agent = {
  agentId: string
  robotId: string
  agentKind: string
  agentVersion: string | null
  status: 'enrolled' | 'revoked'
  state: LinkState
  silenceSeconds: number | null
  lastSeenAt: string | null
  fingerprint: string | null
  sessionsLastDay: number
  reason: string
}

type Payload = {
  generatedAt: string
  totals: { agents: number; online: number; late: number; lost: number; neverSeen: number; revoked: number }
  agents: Agent[]
}

const STATE_LABEL: Record<LinkState, [string, string]> = {
  online: ['edge.label.state.online', "Łączność"],
  late: ['edge.label.state.late', "Spóźniony"],
  lost: ['edge.label.state.lost', "Utracony"],
  never_seen: ['edge.label.state.never_seen', "Nigdy się nie odezwał"],
}

const STATE_TONE: Record<LinkState, string> = {
  online: 'text-emerald-600',
  late: 'text-amber-600',
  lost: 'text-red-600',
  never_seen: 'text-amber-600',
}

export default function AgentLinkBoard() {
  const t = useT()
  const locale = useLocale()
  const [data, setData] = React.useState<Payload | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    try {
      const response = await apiFetch('/api/edge/agents')
      if (!response.ok) {
        const body = (await response.json()) as { error?: string }
        setError(body?.error ?? t('edge.err.http', 'Błąd {status}', { status: String(response.status) }))
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
    // Odświeżanie co 10 s, a nie co 30 jak w rejestrze: żywotność zmienia się
    // w sekundach, a ekran pokazujący nieaktualną łączność jest gorszy niż brak ekranu.
    const timer = setInterval(() => void load(), 10_000)
    return () => clearInterval(timer)
  }, [load])

  const totals = data?.totals
  const agents = data?.agents ?? []

  return (
    <div className="flex flex-col gap-6">
      {error ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm">{error}</div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard title={t('edge.ui.agents', "Agenci")} value={totals?.agents ?? null} loading={loading}
          footer={<span className="text-xs text-muted-foreground">{totals?.revoked ? `${totals.revoked} odwołanych` : t('edge.ui.noneRevoked', "żaden nieodwołany")}</span>} />
        <KpiCard title={t('edge.ui.reporting', "Odzywają się")} value={totals?.online ?? null} loading={loading}
          footer={<span className="text-xs text-muted-foreground">{t('edge.ui.withinInterval', "w oknie odstępu z tolerancją")}</span>} />
        <KpiCard title={t('edge.ui.late', "Spóźnieni")} value={totals?.late ?? null} loading={loading}
          footer={<span className="text-xs text-muted-foreground">{t('edge.ui.usuallyNetwork', "zwykle sieć, nie zasilanie")}</span>} />
        <KpiCard title={t('edge.ui.lost', "Utraceni")} value={totals?.lost ?? null} loading={loading}
          footer={<span className="text-xs text-muted-foreground">{t('edge.ui.silenceBeyondThreshold', "cisza dłuższa niż próg utraty")}</span>} />
      </div>

      <div className="rounded-lg border">
        <div className="flex items-center justify-between border-b px-4 py-2">
          <span className="text-sm font-medium">{t('edge.ui.agentLink', "Łączność agentów")}</span>
          <span className="text-xs text-muted-foreground">
            {data ? t('edge.ui.asOf', 'stan na {t}', { t: new Date(data.generatedAt).toLocaleTimeString(locale) }) : ''}
          </span>
        </div>

        {agents.length === 0 && !loading ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {t('edge.empty.agents', 'Żaden agent nie jest wpisany. Wystaw bilet komendą')}{' '}
            <code className="rounded bg-muted px-1">mercato edge issue --robot &lt;numer&gt;</code>.
          </div>
        ) : (
          <div className="divide-y">
            {agents.map((agent) => (
              <div key={agent.agentId} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-xs">{agent.fingerprint?.slice(0, 16) ?? '—'}</span>
                    <span className="text-xs text-muted-foreground">{agent.agentKind}</span>
                    {agent.agentVersion ? (
                      <span className="text-xs text-muted-foreground">{agent.agentVersion}</span>
                    ) : null}
                    {agent.status === 'revoked' ? (
                      <span className="rounded border px-1 text-[10px] uppercase tracking-wide text-muted-foreground">{t('edge.ui.revoked', "odwołany")}</span>
                    ) : null}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{agent.reason}</div>
                </div>

                <div className="w-40">
                  <div className={`text-sm ${STATE_TONE[agent.state]}`}>{t(...STATE_LABEL[agent.state])}</div>
                  <div className="text-xs text-muted-foreground">
                    {/* Liczba sesji na dobę rozdziela stabilne łącze od migoczącego —
                        w kolumnie „ostatnio widziany" wyglądają identycznie. */}
                    {agent.sessionsLastDay} sesji/dobę
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
