'use client'

import * as React from 'react'
import { KpiCard } from '@open-mercato/ui/backend/charts'
import { apiFetch } from '@open-mercato/ui/backend/utils/api'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'

/**
 * Pochodzenie na ekranie.
 *
 * Ekran pokazuje pętlę z obu stron, bo to są dwa różne pytania: **z czego
 * powstał ten zbiór** (tabela wersji ze składem) i **z czego wzięła się ta
 * polityka** (tabela per wersja polityki). Jedna tabela odpowiadałaby na
 * jedno z nich i sugerowała, że drugie jest tym samym.
 *
 * Kafelek „polityki bez zbioru" pokazuje liczbę, która w zamkniętej pętli
 * jest zerem. Każda inna wartość oznacza wersję, o której po regresie nie
 * będzie wiadomo, na czym się uczyła.
 */

type Composition = { demo: number; correction: number; failure: number; holdout: number }

type TrainingRunRow = {
  id: string
  runRef: string
  status: string
  framework: string | null
  policy: string | null
  startedAt: string
  finishedAt: string | null
}

type VersionRow = {
  id: string
  datasetKey: string
  datasetName: string
  taskKey: string
  embodimentKey: string
  version: number
  contentDigest: string
  episodeCount: number
  composition: Composition
  warnings: Array<{ code: string; message: string }>
  exportUri: string | null
  builtAt: string
  trainingRuns: TrainingRunRow[]
}

type Payload = {
  generatedAt: string
  totals: {
    datasetVersions: number
    trainingRuns: number
    loopClosed: boolean
    policiesWithoutDataset: number
    datasetsWithoutEpisodes: number
    datasetsWithoutPolicy: number
  }
  orphanPolicies: string[]
  versions: VersionRow[]
  byPolicy: Array<{
    policyVersionId: string
    policy: string
    datasetVersions: number
    sourceEpisodes: number
  }>
}

const RUN_STATUS_TONE: Record<string, string> = {
  running: 'text-amber-600',
  succeeded: 'text-emerald-600',
  failed: 'text-red-600',
}

function formatMoment(locale: string, value: string): string {
  return new Date(value).toLocaleString(locale, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function LineageBoard() {
  const t = useT()
  const locale = useLocale()
  const [data, setData] = React.useState<Payload | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    try {
      const response = await apiFetch('/api/datasets/datasets')
      if (!response.ok) {
        const body = (await response.json()) as { error?: string }
        setError(body?.error ?? t('datasets.err.http', 'Błąd {status}', { status: String(response.status) }))
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
  }, [load])

  const totals = data?.totals

  return (
    <div className="flex flex-col gap-6">
      {error ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm">{error}</div>
      ) : null}

      {data && data.orphanPolicies.length ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          <div className="font-medium">
            {data.orphanPolicies.length} wersji polityki bez wskazanego zbioru
          </div>
          <div className="mt-1 text-xs">
            {data.orphanPolicies.join(', ')} - po regresie jakości nie będzie wiadomo, na czym się uczyły,
            a hipotezy „zmiana w danych" i „zmiana w treningu" pozostaną nierozdzielone.
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          title={t('datasets.ui.datasetVersions', "Wersje zbiorów")}
          value={totals?.datasetVersions ?? null}
          loading={loading}
          footer={<span className="text-xs text-muted-foreground">{t('datasets.ui.identityIsContentDigest', "tożsamością jest odcisk zawartości")}</span>}
        />
        <KpiCard
          title={t('datasets.ui.trainingRuns', "Przebiegi treningowe")}
          value={totals?.trainingRuns ?? null}
          loading={loading}
          footer={<span className="text-xs text-muted-foreground">{t('datasets.ui.datasetPolicyLink', "ogniwo zbiór ↔ polityka")}</span>}
        />
        <KpiCard
          title={t('datasets.ui.policiesWithoutDataset', "Polityki bez zbioru")}
          value={totals?.policiesWithoutDataset ?? null}
          loading={loading}
          footer={<span className="text-xs text-muted-foreground">{t('datasets.ui.zeroInClosedLoop', "w zamkniętej pętli zero")}</span>}
        />
        <KpiCard
          title={t('datasets.ui.datasetsWithoutEpisodes', "Zbiory bez epizodów")}
          value={totals?.datasetsWithoutEpisodes ?? null}
          loading={loading}
          footer={
            <span className="text-xs text-muted-foreground">
              {totals?.datasetsWithoutPolicy ?? 0} zbiorów, na których jeszcze nic się nie uczyło
            </span>
          }
        />
      </div>

      {!loading && !data?.versions.length ? (
        <div className="rounded-md border px-4 py-6 text-sm text-muted-foreground">{t('datasets.ui.noDatasets', "Brak zbiorów danych. Uruchom")}<code>yarn mercato datasets prove</code>.
        </div>
      ) : null}

      {data?.versions.map((version) => (
        <div key={version.id} className="rounded-md border">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
            <div>
              <div className="font-medium">
                {version.datasetName} - wersja {version.version}
              </div>
              <div className="text-xs text-muted-foreground">
                {version.datasetKey} · zadanie {version.taskKey} · embodiment {version.embodimentKey} ·
                odcisk <span className="font-mono">{version.contentDigest.slice(0, 12)}</span>
              </div>
            </div>
            <div className="text-xs text-muted-foreground">{formatMoment(locale, version.builtAt)}</div>
          </div>

          <div className="grid gap-2 border-b px-4 py-3 text-sm sm:grid-cols-5">
            <div>
              <div className="text-xs text-muted-foreground">{t("datasets.h.epizody", "epizody")}</div>
              <div>{version.episodeCount}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t("datasets.h.demonstracje", "demonstracje")}</div>
              <div>{version.composition.demo}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t("datasets.h.korekcyjne", "korekcyjne")}</div>
              <div className="font-medium">{version.composition.correction}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t("datasets.h.negatywne", "negatywne")}</div>
              <div>{version.composition.failure}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t("datasets.h.ewaluacyjne", "ewaluacyjne")}</div>
              <div>{version.composition.holdout}</div>
            </div>
          </div>

          {version.warnings.length ? (
            <ul className="border-b px-4 py-2 text-xs text-amber-600">
              {version.warnings.map((warning) => (
                <li key={warning.code}>{warning.message}</li>
              ))}
            </ul>
          ) : null}

          {version.trainingRuns.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-normal">{t("datasets.h.przebieg", "przebieg")}</th>
                  <th className="px-4 py-2 font-normal">status</th>
                  <th className="px-4 py-2 font-normal">{t('datasets.ui.policyProduced', "powstała polityka")}</th>
                  <th className="px-4 py-2 font-normal">framework</th>
                  <th className="px-4 py-2 font-normal">start</th>
                </tr>
              </thead>
              <tbody>
                {version.trainingRuns.map((run) => (
                  <tr key={run.id} className="border-t">
                    <td className="px-4 py-2 font-mono text-xs">{run.runRef}</td>
                    <td className={`px-4 py-2 ${RUN_STATUS_TONE[run.status] ?? ''}`}>{run.status}</td>
                    <td className="px-4 py-2">{run.policy ?? '-'}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{run.framework ?? '-'}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{formatMoment(locale, run.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="px-4 py-3 text-sm text-muted-foreground">{t('datasets.ui.nothingTrainedYet', "Na tej wersji zbioru nic się jeszcze nie uczyło.")}</div>
          )}
        </div>
      ))}

      {data?.byPolicy.length ? (
        <div className="rounded-md border">
          <div className="border-b px-4 py-3">
            <div className="font-medium">{t('datasets.ui.reverseSide', "Strona odwrotna: z czego wzięła się polityka")}</div>
            <div className="text-xs text-muted-foreground">{t("datasets.prose.1", "liczba epizodów rozróżnialnych - jedna polityka bywa dostrajana kolejno na dwóch zbiorach, które częściowo się pokrywają")}</div>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-normal">{t("datasets.h.wersjaPolityki", "wersja polityki")}</th>
                <th className="px-4 py-2 font-normal">{t('datasets.ui.datasetVersionsLower', "wersji zbiorów")}</th>
                <th className="px-4 py-2 font-normal">{t('datasets.ui.sourceEpisodes', "epizodów źródłowych")}</th>
              </tr>
            </thead>
            <tbody>
              {data.byPolicy.map((row) => (
                <tr key={row.policyVersionId} className="border-t">
                  <td className="px-4 py-2">{row.policy}</td>
                  <td className="px-4 py-2">{row.datasetVersions}</td>
                  <td className="px-4 py-2">{row.sourceEpisodes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}
