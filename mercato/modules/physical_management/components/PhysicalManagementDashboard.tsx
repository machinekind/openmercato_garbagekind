'use client'

import * as React from 'react'
import { apiFetch } from '@open-mercato/ui/backend/utils/api'
import PlantLayout from '../../fleet/components/PlantLayout'

type Source = {
  id: string
  code: string
  name: string
  kind: 'video' | 'video_and_people_tracking'
  state: 'online' | 'stale' | 'waiting' | 'disabled'
  cellName: string | null
  viewRole: string
  purpose: string
  retentionDays: number
  lastSeenAt: string | null
  countingMode: string | null
  latestPeopleCount: number
  latestFramesAnalyzed: number
}

type Activity = {
  id: string
  cameraCode: string
  cellName: string | null
  startedAt: string
  endedAt: string
  countingMode: string
  peopleCount: number
  meanConfidence: number | null
  framesAnalyzed: number
}

type Overview = {
  generatedAt: string
  privacy: {
    mode: string
    rawVideoStoredInErp: boolean
    biometricIdentityStored: boolean
  }
  totals: {
    sites: number
    cells: number
    videoSources: number
    trackingSources: number
    onlineSources: number
    peopleTrackWindows: number
    latestPeopleSignals: number
    robots: number
    operationalRobots: number
  }
  sources: Source[]
  activity: Activity[]
}

const STATE: Record<Source['state'], { label: string; className: string }> = {
  online: { label: 'online', className: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
  stale: { label: 'brak świeżych danych', className: 'bg-amber-500/10 text-amber-700 dark:text-amber-300' },
  waiting: { label: 'oczekuje na dane', className: 'bg-slate-500/10 text-slate-700 dark:text-slate-300' },
  disabled: { label: 'wyłączone', className: 'bg-red-500/10 text-red-700 dark:text-red-300' },
}

function time(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('pl-PL')
}

function Metric({ value, label, detail }: { value: number; label: string; detail?: string }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="text-3xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-sm font-medium">{label}</div>
      {detail ? <div className="mt-1 text-xs text-muted-foreground">{detail}</div> : null}
    </div>
  )
}

export default function PhysicalManagementDashboard() {
  const [overview, setOverview] = React.useState<Overview | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    try {
      const response = await apiFetch('/api/physical_management/overview')
      if (!response.ok) {
        const body = (await response.json()) as { error?: string }
        throw new Error(body.error ?? `Błąd ${response.status}`)
      }
      setOverview((await response.json()) as Overview)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 15_000)
    return () => clearInterval(timer)
  }, [load])

  return (
    <div className="flex flex-col gap-6" data-testid="physical-management-dashboard">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Physical Management</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Digital twin obiektu, źródła wideo i anonimowe sygnały ruchu ludzi.
            </p>
          </div>
          <button className="rounded-md border px-3 py-2 text-sm hover:bg-muted" onClick={() => void load()}>
            Odśwież
          </button>
        </div>
        <div className="mt-3 rounded-md border border-blue-500/30 bg-blue-500/5 px-4 py-3 text-sm">
          Privacy by design: ERP przechowuje zagregowane okna anonimowych ścieżek. Surowe wideo i tożsamość
          biometryczna pozostają poza systemem.
        </div>
      </div>

      {error ? <div className="rounded-md border border-red-500/40 bg-red-500/5 p-3 text-sm text-red-700">{error}</div> : null}
      {loading && !overview ? <div className="text-sm text-muted-foreground">Ładowanie digital twin…</div> : null}

      {overview ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <Metric value={overview.totals.sites} label="obiekt" detail={`${overview.totals.cells} stref`} />
            <Metric
              value={overview.totals.videoSources}
              label="źródła wideo"
              detail={`${overview.totals.onlineSources} online`}
            />
            <Metric
              value={overview.totals.trackingSources}
              label="źródła trackingu"
              detail="anonimowe ścieżki na brzegu"
            />
            <Metric
              value={overview.totals.latestPeopleSignals}
              label="ostatni sygnał osób"
              detail={`${overview.totals.peopleTrackWindows} okien typu tracks`}
            />
            <Metric
              value={overview.totals.operationalRobots}
              label="roboty operacyjne"
              detail={`${overview.totals.robots} w rejestrze`}
            />
          </div>

          <section className="rounded-lg border bg-card">
            <div className="border-b px-4 py-3">
              <h2 className="font-semibold">Źródła danych</h2>
              <p className="text-xs text-muted-foreground">Stan adapterów, kontekst obiektu i ostatnia próbka.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="px-4 py-2 font-medium">Źródło</th>
                    <th className="px-4 py-2 font-medium">Typ</th>
                    <th className="px-4 py-2 font-medium">Strefa</th>
                    <th className="px-4 py-2 font-medium">Stan</th>
                    <th className="px-4 py-2 font-medium">Ostatnie dane</th>
                    <th className="px-4 py-2 text-right font-medium">Osoby</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.sources.map((source) => (
                    <tr key={source.id} className="border-b last:border-0">
                      <td className="px-4 py-3">
                        <div className="font-medium">{source.name}</div>
                        <div className="font-mono text-xs text-muted-foreground">{source.code}</div>
                      </td>
                      <td className="px-4 py-3">
                        {source.kind === 'video_and_people_tracking' ? 'wideo + tracking' : 'wideo'}
                        <div className="text-xs text-muted-foreground">{source.viewRole}</div>
                      </td>
                      <td className="px-4 py-3">{source.cellName ?? 'nieprzypisana'}</td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2 py-1 text-xs ${STATE[source.state].className}`}>
                          {STATE[source.state].label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs">{time(source.lastSeenAt)}</td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums">{source.latestPeopleCount}</td>
                    </tr>
                  ))}
                  {!overview.sources.length ? (
                    <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">Brak źródeł.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-lg border bg-card">
            <div className="border-b px-4 py-3">
              <h2 className="font-semibold">Ostatnie okna ruchu ludzi</h2>
              <p className="text-xs text-muted-foreground">
                Zliczenia ścieżek lub detekcji wykonane na brzegu; bez identyfikacji osoby.
              </p>
            </div>
            <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
              {overview.activity.slice(0, 9).map((item) => (
                <div key={item.id} className="rounded-md border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium">{item.cellName ?? item.cameraCode}</span>
                    <span className="text-2xl font-semibold tabular-nums">{item.peopleCount}</span>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    {item.countingMode === 'tracks' ? 'anonimowe ścieżki' : 'detekcje'} · {item.framesAnalyzed} klatek
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{time(item.endedAt)}</div>
                </div>
              ))}
              {!overview.activity.length ? (
                <div className="text-sm text-muted-foreground">Brak okien zawierających klasę „person”.</div>
              ) : null}
            </div>
          </section>

          <section className="rounded-lg border bg-card p-4">
            <div className="mb-4">
              <h2 className="font-semibold">Digital twin hali</h2>
              <p className="text-xs text-muted-foreground">
                Wspólna geometria obiektu, strefy ryzyka, maszyny i warstwy operacyjne.
              </p>
            </div>
            <PlantLayout />
          </section>

          <div className="text-right text-xs text-muted-foreground">Stan na {time(overview.generatedAt)}</div>
        </>
      ) : null}
    </div>
  )
}
