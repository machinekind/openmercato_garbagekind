'use client'

import * as React from 'react'
import { KpiCard } from '@open-mercato/ui/backend/charts'
import { apiFetch } from '@open-mercato/ui/backend/utils/api'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'

/**
 * Macierz dopuszczeń na ekranie.
 *
 * Ekran jest zbudowany wokół kolumny „czego brakuje", a nie wokół statusu.
 * Lista uzasadnień ze statusami jest rejestrem dokumentów; dopiero powód
 * odmowy przy każdej parze (wersja, klasa celi) czyni z niej narzędzie —
 * bo mówi, co zrobić, żeby dopuszczenie powstało.
 *
 * Kafelek „polityka jako funkcja bezpieczeństwa" pokazuje liczbę, która
 * w zdrowym systemie jest zerem. Każda inna wartość oznacza, że ktoś próbuje
 * wepchnąć produkt klienta w ocenę przez jednostkę notyfikowaną.
 */

type MatrixRow = {
  policyVersionId: string
  policy: string
  policyStatus: string
  cellClass: string
  riskClass: string
  cleared: boolean
  reasons: string[]
  missingSuites: string[]
  failedSuites: string[]
}

type IncidentRow = {
  id: string
  harm: string
  priority: string
  haltDeployment: boolean
  description: string
  occurredAt: string
  safetyLayerEngaged: boolean
  policyImplicated: boolean
}

type Payload = {
  generatedAt: string
  totals: {
    versions: number
    cellClasses: number
    cleared: number
    blocked: number
    declaredAsSafetyFunction: number
    openIncidents: number
  }
  suites: Array<{ suiteKey: string; name: string; requiredFor: string[] }>
  matrix: MatrixRow[]
  incidents: IncidentRow[]
}

const RISK_LABEL: Record<string, [string, string]> = {
  fenced: ['safety.label.risk.fenced', "ogrodzona"],
  shared: ['safety.label.risk.shared', "dzielona"],
  public: ['safety.label.risk.public', "publiczna"],
}

const HARM_LABEL: Record<string, [string, string]> = {
  none: ['safety.label.harm.none', "bez skutku"],
  near_miss: ['safety.label.harm.near_miss', "potencjalnie wypadkowe"],
  first_aid: ['safety.label.harm.first_aid', "pierwsza pomoc"],
  lost_time: ['safety.label.harm.lost_time', "niezdolność do pracy"],
  serious: ['safety.label.harm.serious', "ciężkie"],
}

const PRIORITY_TONE: Record<string, string> = {
  informacyjny: 'text-muted-foreground',
  do_analizy: 'text-amber-600',
  pilny: 'text-red-600',
  wstrzymanie_wdrożenia: 'text-red-600',
}

function formatMoment(locale: string, value: string): string {
  return new Date(value).toLocaleString(locale, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function SafetyBoard() {
  const t = useT()
  const locale = useLocale()
  const [data, setData] = React.useState<Payload | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    try {
      const response = await apiFetch('/api/safety/clearance')
      if (!response.ok) {
        const body = (await response.json()) as { error?: string }
        setError(body?.error ?? t('safety.err.http', 'Błąd {status}', { status: String(response.status) }))
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

      {totals && totals.declaredAsSafetyFunction > 0 ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm">
          <div className="font-medium">
            {totals.declaredAsSafetyFunction} uzasadnień deklaruje uczoną politykę jako funkcję bezpieczeństwa
          </div>
          <div className="mt-1 text-xs">{t("safety.prose.1", "To wpycha maszynę w Annex I część A rozporządzenia (UE) 2023/1230, czyli w obowiązkową ocenę przez jednostkę notyfikowaną, dla której nie istnieje ustalona metoda wykazania zgodności. Bezpieczeństwo ma egzekwować osobna warstwa deterministyczna.")}</div>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          title={t('safety.ui.clearedPairs', "Dopuszczone pary")}
          value={totals?.cleared ?? null}
          loading={loading}
          footer={<span className="text-xs text-muted-foreground">{t('safety.ui.versionByCellClass', 'wersja polityki × klasa celi')}</span>}
        />
        <KpiCard
          title={t('safety.ui.blocked', "Zablokowane")}
          value={totals?.blocked ?? null}
          loading={loading}
          footer={<span className="text-xs text-muted-foreground">{t('safety.ui.eachWithNamedReason', "każda z nazwanym powodem")}</span>}
        />
        <KpiCard
          title={t('safety.ui.policyAsSafetyFn', "Polityka jako funkcja bezp.")}
          value={totals?.declaredAsSafetyFunction ?? null}
          loading={loading}
          footer={<span className="text-xs text-muted-foreground">{t("safety.h.wZdrowymSystemieZero", "w zdrowym systemie zero")}</span>}
        />
        <KpiCard
          title={t('safety.ui.haltingIncidents', "Incydenty wstrzymujące")}
          value={totals?.openIncidents ?? null}
          loading={loading}
          footer={<span className="text-xs text-muted-foreground">{t('safety.ui.withdrawCaseForClass', "wycofują uzasadnienie dla klasy celi")}</span>}
        />
      </div>

      <div className="rounded-md border">
        <div className="border-b px-4 py-3">
          <div className="font-medium">{t('safety.ui.clearanceMatrix', "Macierz dopuszczeń")}</div>
          <div className="text-xs text-muted-foreground">{t("safety.prose.2", "dopuszczenie dotyczy klasy celi, nie pojedynczej celi — inaczej każda nowa cela wymagałaby osobnego uzasadnienia dla niezmienionej konfiguracji")}</div>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="px-4 py-2 font-normal">{t("safety.h.wersjaPolityki", "wersja polityki")}</th>
              <th className="px-4 py-2 font-normal">{t("safety.h.klasaCeli", "klasa celi")}</th>
              <th className="px-4 py-2 font-normal">{t("safety.h.ryzyko", "ryzyko")}</th>
              <th className="px-4 py-2 font-normal">{t("safety.h.dopuszczenie", "dopuszczenie")}</th>
              <th className="px-4 py-2 font-normal">{t("safety.h.czegoBrakuje", "czego brakuje")}</th>
            </tr>
          </thead>
          <tbody>
            {(data?.matrix ?? []).map((row) => (
              <tr key={`${row.policyVersionId}-${row.cellClass}`} className="border-t align-top">
                <td className="px-4 py-2">{row.policy}</td>
                <td className="px-4 py-2">{row.cellClass}</td>
                <td className="px-4 py-2 text-xs text-muted-foreground">
                  {RISK_LABEL[row.riskClass] ? t(...RISK_LABEL[row.riskClass]) : row.riskClass}
                </td>
                <td className={`px-4 py-2 ${row.cleared ? 'text-emerald-600' : 'text-red-600'}`}>
                  {row.cleared ? 'dopuszczona' : 'ZABLOKOWANA'}
                </td>
                <td className="px-4 py-2 text-xs text-muted-foreground">
                  {row.cleared ? '—' : row.reasons.join('; ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data?.suites.length ? (
        <div className="rounded-md border">
          <div className="border-b px-4 py-3">
            <div className="font-medium">{t("safety.h.zestawyEwaluacyjne", "Zestawy ewaluacyjne")}</div>
            <div className="text-xs text-muted-foreground">{t("safety.prose.3", "limity siły i nacisku (ISO/TS 15066) mają sens tam, gdzie kontakt z człowiekiem jest możliwy — wymaganie ich za płotem byłoby rytuałem")}</div>
          </div>
          <table className="w-full text-sm">
            <tbody>
              {data.suites.map((suite) => (
                <tr key={suite.suiteKey} className="border-t">
                  <td className="px-4 py-2">{suite.name}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{suite.suiteKey}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {t('safety.ui.requiredFor', 'wymagany dla:')} {suite.requiredFor.map((r) => RISK_LABEL[r] ? t(...RISK_LABEL[r]) : r).join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {data?.incidents.length ? (
        <div className="rounded-md border">
          <div className="border-b px-4 py-3">
            <div className="font-medium">{t("safety.h.incydenty", "Incydenty")}</div>
            <div className="text-xs text-muted-foreground">{t('safety.ui.twoAxisClassification', "klasyfikacja dwuwymiarowa: czy ktoś ucierpiał i czy zadziałała warstwa bezpieczeństwa")}</div>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-normal">{t("safety.h.kiedy", "kiedy")}</th>
                <th className="px-4 py-2 font-normal">{t("safety.h.skutek", "skutek")}</th>
                <th className="px-4 py-2 font-normal">warstwa bezp.</th>
                <th className="px-4 py-2 font-normal">{t("safety.h.priorytet", "priorytet")}</th>
                <th className="px-4 py-2 font-normal">{t("safety.h.opis", "opis")}</th>
              </tr>
            </thead>
            <tbody>
              {data.incidents.map((incident) => (
                <tr key={incident.id} className="border-t">
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {formatMoment(locale, incident.occurredAt)}
                  </td>
                  <td className="px-4 py-2">{HARM_LABEL[incident.harm] ? t(...HARM_LABEL[incident.harm]) : incident.harm}</td>
                  <td className="px-4 py-2 text-xs">
                    {incident.safetyLayerEngaged ? t('safety.ui.engaged', "zadziałała") : '—'}
                    {incident.policyImplicated ? ' / polityka zamieszana' : ''}
                  </td>
                  <td className={`px-4 py-2 ${PRIORITY_TONE[incident.priority] ?? ''}`}>
                    {incident.priority.replace(/_/g, ' ')}
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{incident.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}
