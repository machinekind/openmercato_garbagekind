'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { KpiCard } from '@open-mercato/ui/backend/charts'
import { apiFetch } from '@open-mercato/ui/backend/utils/api'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'

/**
 * Rejestr floty na ekranie.
 *
 * Pierwsza wartość, jaką ta platforma dostarcza, nie jest wyrafinowana:
 * **ile robotów rejestr twierdzi, że istnieje, a ile stoi w hali**. Ta liczba
 * się nie zgadza w każdym wdrożeniu — dlatego ekran zaczyna się od stanu
 * liczbowego, a nie od wykresu.
 */

type Robot = {
  id: string
  serialNumber: string
  name: string
  state: string
  stateReason: string | null
  stateChangedAt: string | null
  embodiment: string | null
  cell: string | null
  site: string | null
  riskClass: string | null
  externallyOperated: boolean
  calibrationState: 'valid' | 'expiring' | 'blocked' | 'unknown'
  calibrationDaysLeft: number | null
}

/**
 * Stan łączności przychodzi z osobnego modułu (`edge`) i osobnym zapytaniem.
 *
 * Składanie dzieje się tutaj, w przeglądarce, a nie po stronie serwera —
 * dzięki czemu `fleet` nie wie nic o agencie, a rejestr działa również wtedy,
 * gdy kanału brzegowego nie ma wcale (świeże wdrożenie, flota spisana ręcznie).
 * Brak odpowiedzi z `/api/edge/agents` nie jest tu błędem, tylko brakiem
 * kolumny — i tak jest to napisane niżej.
 */
type LinkState = 'online' | 'late' | 'lost' | 'never_seen'

type AgentLink = {
  robotId: string
  state: LinkState
  status: 'enrolled' | 'revoked'
  silenceSeconds: number | null
  sessionsLastDay: number
  reason: string
}

type EdgePayload = {
  totals: { agents: number; online: number; late: number; lost: number; neverSeen: number }
  byRobot: Record<string, AgentLink>
}

type Payload = {
  generatedAt: string
  totals: {
    robots: number
    active: number
    quarantined: number
    calibrationBlocked: number
    calibrationExpiring: number
    externallyOperated: number
  }
  byState: Record<string, number>
  robots: Robot[]
}

const STATE_LABEL: Record<string, [string, string]> = {
  registered: ['fleet.label.state.registered', "Zarejestrowany"],
  commissioning: ['fleet.label.state.commissioning', "Uruchamianie"],
  ready: ['fleet.label.state.ready', "Gotowy"],
  operational: ['fleet.label.state.operational', "W ruchu"],
  maintenance: ['fleet.label.state.maintenance', "Serwis"],
  quarantined: ['fleet.label.state.quarantined', "Kwarantanna"],
  decommissioning: ['fleet.label.state.decommissioning', "Wycofywanie"],
  decommissioned: ['fleet.label.state.decommissioned', "Wycofany"],
}

/** Kolor niesie pilność, nie kategorię: czerwony znaczy „ta maszyna nie pracuje". */
const STATE_TONE: Record<string, string> = {
  operational: 'text-emerald-600',
  ready: 'text-emerald-600',
  quarantined: 'text-red-600',
  maintenance: 'text-amber-600',
  decommissioned: 'text-muted-foreground',
}

function formatMoment(locale: string, value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString(locale, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Opis łączności.
 *
 * `null` znaczy „nie wiemy", a nie „nie działa" — i te dwie rzeczy nie mogą
 * wyglądać tak samo, bo pierwsza jest normalnym stanem floty bez agentów,
 * a druga jest awarią.
 */
type Tf = (key: string, fallback?: string | Record<string, string | number>, params?: Record<string, string | number>) => string

function describeLink(t: Tf, link: AgentLink | undefined): { text: string; tone: string } | null {
  if (!link) return null
  if (link.status === 'revoked') return { text: t('fleet.link.revoked', 'agent odwołany'), tone: 'text-muted-foreground' }
  if (link.state === 'never_seen') return { text: t('fleet.link.neverSeen', 'agent wpisany, nigdy się nie odezwał'), tone: 'text-amber-600' }
  if (link.state === 'lost') return { text: t('fleet.link.lostFor', 'bez łączności od {sec} s', { sec: String(link.silenceSeconds) }), tone: 'text-red-600' }
  if (link.state === 'late') return { text: t('fleet.link.lateFor', 'spóźniony {sec} s', { sec: String(link.silenceSeconds) }), tone: 'text-amber-600' }
  // Migotanie łącza i stabilna łączność wyglądają w „ostatnio widziany"
  // identycznie — liczba sesji na dobę jest jedyną rzeczą, która je rozdziela.
  if (link.sessionsLastDay > 3) {
    return { text: t('fleet.link.flapping', 'łączność, ale {n} sesji/dobę', { n: String(link.sessionsLastDay) }), tone: 'text-amber-600' }
  }
  return { text: t('fleet.link.online', 'łączność'), tone: 'text-emerald-600' }
}

function describeCalibration(t: Tf, robot: Robot): { text: string; tone: string } {
  if (robot.calibrationState === 'blocked') {
    return { text: t('fleet.calib.invalid', 'kalibracja nieważna'), tone: 'text-red-600' }
  }
  if (robot.calibrationState === 'expiring') {
    return { text: t('fleet.calib.expiring', 'kalibracja wygasa za {d} dni', { d: String(robot.calibrationDaysLeft) }), tone: 'text-amber-600' }
  }
  if (robot.calibrationState === 'valid') {
    return { text: t('fleet.calib.valid', 'kalibracja ważna {d} dni', { d: String(robot.calibrationDaysLeft) }), tone: 'text-muted-foreground' }
  }
  return { text: t('fleet.calib.notRequired', 'brak wymagań kalibracyjnych'), tone: 'text-muted-foreground' }
}

export default function FleetRegistry() {
  const t = useT()
  const router = useRouter()
  const locale = useLocale()
  const [data, setData] = React.useState<Payload | null>(null)
  const [edge, setEdge] = React.useState<EdgePayload | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    try {
      const response = await apiFetch('/api/fleet/robots')
      if (!response.ok) {
        const body = (await response.json()) as { error?: string }
        setError(body?.error ?? t('fleet.err.http', 'Błąd {status}', { status: String(response.status) }))
        return
      }
      setData((await response.json()) as Payload)
      setError(null)

      // Kanał brzegowy jest opcjonalny: 404 znaczy „moduł nie zainstalowany",
      // 403 „brak uprawnienia edge.view". Ani jedno, ani drugie nie jest
      // powodem, żeby rejestr floty przestał się wyświetlać.
      try {
        const link = await apiFetch('/api/edge/agents')
        setEdge(link.ok ? ((await link.json()) as EdgePayload) : null)
      } catch {
        setEdge(null)
      }
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
  const robots = data?.robots ?? []

  return (
    <div className="flex flex-col gap-6">
      {error ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm">{error}</div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <KpiCard
          title={t('fleet.ui.robotsInRegistry', "Roboty w rejestrze")}
          value={totals?.robots ?? null}
          loading={loading}
          footer={
            <span className="text-xs text-muted-foreground">
              {totals?.externallyOperated
                ? t('fleet.ui.nExternallyOperated', '{n} obsługiwanych przez integratora', { n: String(totals.externallyOperated) })
                : t('fleet.ui.allSelfOperated', "wszystkie obsługiwane własnymi siłami")}
            </span>
          }
        />
        <KpiCard
          title={t('fleet.ui.active', "Czynne")}
          value={totals?.active ?? null}
          loading={loading}
          footer={<span className="text-xs text-muted-foreground">{t("fleet.h.gotoweLubWRuchu", "gotowe lub w ruchu")}</span>}
        />
        <KpiCard
          title={t('fleet.ui.quarantined', "W kwarantannie")}
          value={totals?.quarantined ?? null}
          loading={loading}
          footer={
            <span className="text-xs text-muted-foreground">{t('fleet.ui.notClearedHint', "niedopuszczone — bywają mechanicznie sprawne")}</span>
          }
        />
        <KpiCard
          title={t('fleet.ui.noLink', "Bez łączności")}
          value={edge ? edge.totals.lost + edge.totals.late : null}
          loading={loading}
          footer={
            <span className="text-xs text-muted-foreground">
              {edge
                ? t('fleet.ui.nOfMAgentsOnline', '{n} z {m} agentów się odzywa', { n: String(edge.totals.online), m: String(edge.totals.agents) })
                : t('fleet.ui.edgeUnavailable', "kanał brzegowy niedostępny")}
            </span>
          }
        />
        <KpiCard
          title={t('fleet.ui.calibrationBlock', "Blokada kalibracji")}
          value={totals?.calibrationBlocked ?? null}
          loading={loading}
          footer={
            <span className="text-xs text-muted-foreground">
              {totals?.calibrationExpiring
                ? t('fleet.ui.nExpiring14d', '{n} wygasa w ciągu 14 dni', { n: String(totals.calibrationExpiring) })
                : t('fleet.ui.nothingExpiring14d', "nic nie wygasa w ciągu 14 dni")}
            </span>
          }
        />
      </div>

      <div className="rounded-lg border">
        <div className="flex items-center justify-between border-b px-4 py-2">
          <span className="text-sm font-medium">{t("fleet.h.rejestrFloty", "Rejestr floty")}</span>
          <span className="text-xs text-muted-foreground">
            {data ? t('fleet.ui.asOf', 'stan na {t}', { t: formatMoment(locale, data.generatedAt) }) : ''}
          </span>
        </div>

        {robots.length === 0 && !loading ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {t('fleet.empty.registry', 'Rejestr jest pusty. Zaimportuj flotę komendą')}{' '}
            <code className="rounded bg-muted px-1">mercato fleet seed</code>.
          </div>
        ) : (
          <div className="divide-y">
            {robots.map((robot) => {
              const calibration = describeCalibration(t, robot)
              const link = describeLink(t, edge?.byRobot?.[robot.id])
              return (
                <div
                  key={robot.id}
                  role="link"
                  tabIndex={0}
                  /*
                   * Cały wiersz jest wejściem w szczegóły, a nie osobny link
                   * „otwórz" na końcu: operator hali trafia palcem w wiersz,
                   * nie w ośmiopikselową ikonę.
                   */
                  onClick={() => router.push(`/backend/fleet/${robot.id}`)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') router.push(`/backend/fleet/${robot.id}`) }}
                  className="flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-muted/50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-medium">{robot.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">{robot.serialNumber}</span>
                      {robot.externallyOperated ? (
                        <span
                          className="rounded border px-1 text-[10px] uppercase tracking-wide text-muted-foreground"
                          title={t('fleet.ui.ownerDiffersTitle', "Właściciel i operator to różne podmioty")}
                        >
                          integrator
                        </span>
                      ) : null}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {[robot.embodiment, robot.site, robot.cell].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>

                  <div className="w-44">
                    <div className={`text-sm ${STATE_TONE[robot.state] ?? ''}`}>
                      {STATE_LABEL[robot.state] ? t(...STATE_LABEL[robot.state]) : robot.state}
                    </div>
                    {/* Powód jest tu, a nie w szczegółach: przy kwarantannie to
                        jedyna rzecz odróżniająca wygasłą kalibrację od incydentu. */}
                    <div className="truncate text-xs text-muted-foreground" title={robot.stateReason ?? ''}>
                      {robot.stateReason ?? '—'}
                    </div>
                  </div>

                  <div className="w-56 text-right">
                    <div className={`text-xs ${calibration.tone}`}>{calibration.text}</div>
                    {link ? <div className={`text-xs ${link.tone}`}>{link.text}</div> : null}
                    <div className="text-xs text-muted-foreground">
                      od {formatMoment(locale, robot.stateChangedAt)}
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
