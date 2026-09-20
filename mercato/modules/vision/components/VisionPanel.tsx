'use client'

import * as React from 'react'
import { KpiCard } from '@open-mercato/ui/backend/charts'
import { apiFetch } from '@open-mercato/ui/backend/utils/api'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'

/**
 * Panel wzroku maszynowego.
 *
 * Ekran pokazuje **podejrzanego**, nie rozjazd. Rozjazd widać już w panelu
 * przedsiębiorstwa; nowa informacja zaczyna się tam, gdzie da się powiedzieć,
 * po której stronie leży błąd - i gdzie kamera bywa tą stroną.
 */

type Suspect =
  | 'none' | 'nominal_mass' | 'grip_to_bin' | 'under_reporting'
  | 'vision' | 'foreign_material' | 'inconclusive' | 'no_reference'

type Batch = {
  containerCode: string
  sku: string
  cell: string | null
  visionCount: number | null
  claimedCount: number
  massImpliedCount: number | null
  weighedKg: number
  suspect: Suspect
  reason: string
  contaminationRatio: number | null
  windows: number
  countingMode: string | null
}

type CameraRow = {
  code: string
  viewRole: string
  purpose: string
  retentionDays: number
  peopleInView: boolean
  cell: string | null
  formalGaps: string[]
}

type Payload = {
  generatedAt: string
  totals: {
    cameras: number
    camerasWithGaps: number
    batches: number
    withThirdWitness: number
    suspected: number
  }
  cameras: CameraRow[]
  batches: Batch[]
}

const SUSPECT_LABEL: Record<Suspect, [string, string]> = {
  none: ['vision.label.suspect.none', "zgodne"],
  nominal_mass: ['vision.label.suspect.nominal_mass', "masa nominalna"],
  grip_to_bin: ['vision.label.suspect.grip_to_bin', "ubytek w drodze do pojemnika"],
  under_reporting: ['vision.label.suspect.under_reporting', "zaniżone zgłoszenia"],
  vision: ['vision.label.suspect.vision', "kamera nie widzi"],
  foreign_material: ['vision.label.suspect.foreign_material', "obcy materiał"],
  inconclusive: ['vision.label.suspect.inconclusive', "nierozstrzygnięte"],
  no_reference: ['vision.label.suspect.no_reference', "brak odniesienia"],
}

/** Kolor niesie, kto jest podejrzany - nie samo „coś nie gra". */
const SUSPECT_TONE: Record<Suspect, string> = {
  none: 'text-emerald-600',
  nominal_mass: 'text-amber-600',
  grip_to_bin: 'text-red-600',
  under_reporting: 'text-amber-600',
  vision: 'text-sky-600',
  foreign_material: 'text-amber-600',
  inconclusive: 'text-red-600',
  no_reference: 'text-muted-foreground',
}

export default function VisionPanel() {
  const t = useT()
  const locale = useLocale()
  const [data, setData] = React.useState<Payload | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    try {
      const response = await apiFetch('/api/vision/panel')
      if (!response.ok) {
        const body = (await response.json()) as { error?: string }
        setError(body?.error ?? t('vision.err.http', 'Błąd {status}', { status: String(response.status) }))
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
  const batches = data?.batches ?? []
  const cameras = data?.cameras ?? []

  return (
    <div className="flex flex-col gap-6" data-testid="vision-panel">
      {error ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm">{error}</div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          title={t('vision.ui.cameras', "Kamery")}
          value={totals?.cameras ?? null}
          loading={loading}
          footer={
            <span className="text-xs text-muted-foreground">
              {totals?.camerasWithGaps
                ? `${totals.camerasWithGaps} z brakami formalnymi`
                : t('vision.ui.noticesDone', "obowiązki informacyjne dopełnione")}
            </span>
          }
        />
        <KpiCard
          title={t('vision.ui.batchesWithThirdWitness', "Partie z trzecim świadkiem")}
          value={totals?.withThirdWitness ?? null}
          loading={loading}
          footer={
            <span className="text-xs text-muted-foreground">
              {totals ? `z ${totals.batches} zamkniętych - reszta ma tylko robota i wagę` : t('vision.ui.restOnlyRobotScale', "reszta ma tylko robota i wagę")}
            </span>
          }
        />
        <KpiCard
          title={t('vision.ui.withSuspect', "Z podejrzanym")}
          value={totals?.suspected ?? null}
          loading={loading}
          footer={<span className="text-xs text-muted-foreground">{t('vision.ui.batchesDiverging', "partii, gdzie pomiary się rozjeżdżają")}</span>}
        />
        <KpiCard
          title={t('vision.ui.suspectCamera', "Podejrzana kamera")}
          value={batches.filter((b) => b.suspect === 'vision').length}
          loading={loading}
          footer={
            <span className="text-xs text-muted-foreground">{t('vision.ui.visionAtFault', "przypadków, gdzie to wizja się myli, nie robot")}</span>
          }
        />
      </div>

      <div className="rounded-lg border">
        <div className="flex items-center justify-between border-b px-4 py-2">
          <span className="text-sm font-medium">{t('vision.ui.threeWitnesses', "Trzej świadkowie")}</span>
          <span className="text-xs text-muted-foreground">
            {data ? t('vision.ui.asOf', 'stan na {t}', { t: new Date(data.generatedAt).toLocaleTimeString(locale) }) : ''}
          </span>
        </div>

        {batches.length === 0 && !loading ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {t('vision.empty.batches', 'Brak zamkniętych partii. Uruchom')}{' '}
            <code className="rounded bg-muted px-1">mercato vision prove</code>.
          </div>
        ) : (
          <div className="divide-y">
            {batches.map((batch) => (
              <div key={batch.containerCode} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium">{batch.containerCode}</span>
                    <span className="font-mono text-xs text-muted-foreground">{batch.sku}</span>
                    {batch.countingMode === 'mixed' ? (
                      <span
                        className="rounded border px-1 text-[10px] uppercase tracking-wide text-amber-600"
                        title={t('vision.ui.mixedCountingModes', "Okna mieszają zliczanie ścieżek i detekcji - sumy nie da się złożyć")}
                      >
                        tryby mieszane
                      </span>
                    ) : null}
                  </div>
                  <div className="truncate text-xs text-muted-foreground" title={batch.reason}>
                    {batch.reason}
                  </div>
                </div>

                <div className="w-48 text-xs">
                  {/* Trzy liczby obok siebie - bo dopiero ich układ niesie diagnozę. */}
                  <div>
                    wizja <span className="font-medium">{batch.visionCount ?? '-'}</span>
                    {' · '}robot <span className="font-medium">{batch.claimedCount}</span>
                    {' · '}masa <span className="font-medium">{batch.massImpliedCount ?? '-'}</span>
                  </div>
                  <div className="text-muted-foreground">
                    {batch.weighedKg.toFixed(1)} kg
                    {batch.contaminationRatio !== null
                      ? ` · ${(batch.contaminationRatio * 100).toFixed(1)}% obcych`
                      : ''}
                  </div>
                </div>

                <div className="w-52 text-right">
                  <div className={`text-sm ${SUSPECT_TONE[batch.suspect]}`}>{t(...SUSPECT_LABEL[batch.suspect])}</div>
                  <div className="text-xs text-muted-foreground">
                    {batch.windows ? `${batch.windows} okien wizji` : 'bez kamery'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-lg border">
        <div className="border-b px-4 py-2 text-sm font-medium">{t('vision.ui.camerasAndCompliance', "Kamery i zgodność formalna")}</div>
        <div className="divide-y">
          {cameras.map((camera) => (
            <div key={camera.code} className="flex flex-wrap items-center gap-x-4 px-4 py-2 text-xs">
              <span className="w-40 font-mono">{camera.code}</span>
              <span className="w-32 text-muted-foreground">{camera.viewRole}</span>
              <span className="w-40 text-muted-foreground">
                {/* Cel z zamkniętego katalogu art. 22² § 1 KP - nie opis własny. */}
                {camera.purpose} · {camera.retentionDays} dni
              </span>
              <span className={camera.formalGaps.length ? 'text-red-600' : 'text-muted-foreground'}>
                {camera.formalGaps.length ? camera.formalGaps.join(', ') : t('vision.ui.ok', "w porządku")}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
