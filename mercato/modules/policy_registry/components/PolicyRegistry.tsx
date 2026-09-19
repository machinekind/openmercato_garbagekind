'use client'

import * as React from 'react'
import { KpiCard } from '@open-mercato/ui/backend/charts'
import { apiFetch } from '@open-mercato/ui/backend/utils/api'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'

/**
 * Rejestr polityk na ekranie.
 *
 * Ekran jest zbudowany wokół jednej kolumny, której nie ma w żadnym
 * repozytorium modeli: **na czym wolno to uruchomić**. Lista wag posortowana
 * po dacie jest katalogiem plików; dopiero odcisk kontraktu embodimentu robi
 * z niej rejestr, w którym da się odmówić wdrożenia przed ruchem ramienia.
 *
 * Drugą rzeczą wyciągniętą na wierzch jest skrót treści — bo to on, a nie
 * numer, jest tożsamością wersji. Numer pokazujemy mniejszym drukiem obok.
 */

type VersionRow = {
  id: string
  version: number
  contentDigest: string
  status: string
  statusReason: string | null
  embodiment: string | null
  embodimentRevision: number | null
  embodimentDrift: boolean
  artifactRoles: string[]
  createdAt: string
}

type PolicyRow = {
  id: string
  policyKey: string
  name: string
  embodimentKey: string
  taskKey: string
  learningMethod: string
  versions: VersionRow[]
}

type Payload = {
  generatedAt: string
  totals: {
    policies: number
    versions: number
    released: number
    deprecated: number
    embodimentDrift: number
    orphanedEmbodiment: number
  }
  policies: PolicyRow[]
}

const STATUS_LABEL: Record<string, string> = {
  registered: 'zarejestrowana',
  released: 'wypuszczona',
  deprecated: 'wycofana',
}

/** Kolor niesie dopuszczalność, nie kategorię: zielony znaczy „wolno tym wdrażać". */
const STATUS_TONE: Record<string, string> = {
  released: 'text-emerald-600',
  registered: 'text-amber-600',
  deprecated: 'text-muted-foreground',
}

const METHOD_LABEL: Record<string, string> = {
  rl: 'RL',
  il: 'demonstracje',
  offline_rl: 'offline RL',
  vla: 'VLA',
  classical: 'klasyczna',
}

function shortDigest(digest: string): string {
  return digest.slice(0, 12)
}

function formatMoment(locale: string, value: string): string {
  return new Date(value).toLocaleString(locale, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function PolicyRegistry() {
  const t = useT()
  const locale = useLocale()
  const [data, setData] = React.useState<Payload | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    try {
      const response = await apiFetch('/api/policy_registry/policies')
      if (!response.ok) {
        const body = (await response.json()) as { error?: string }
        setError(body?.error ?? t('policy_registry.err.http', 'Błąd {status}', { status: String(response.status) }))
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
  const policies = data?.policies ?? []

  return (
    <div className="flex flex-col gap-6">
      {error ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm">{error}</div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          title={t('policy_registry.ui.policies', "Polityki")}
          value={totals?.policies ?? null}
          loading={loading}
          footer={<span className="text-xs text-muted-foreground">{t('policy_registry.ui.eachWithEmbodiment', "każda z zadeklarowanym embodimentem")}</span>}
        />
        <KpiCard
          title={t('policy_registry.ui.versions', "Wersje")}
          value={totals?.versions ?? null}
          loading={loading}
          footer={
            <span className="text-xs text-muted-foreground">{t('policy_registry.ui.identityIsDigest', "tożsamością jest skrót artefaktów, nie numer")}</span>
          }
        />
        <KpiCard
          title={t('policy_registry.ui.released', "Wypuszczone")}
          value={totals?.released ?? null}
          loading={loading}
          footer={<span className="text-xs text-muted-foreground">{t('policy_registry.ui.onlyTheseDeployable', "tylko te da się wdrożyć")}</span>}
        />
        <KpiCard
          title={t('policy_registry.ui.embodimentMismatch', "Rozjazd embodimentu")}
          value={totals ? totals.embodimentDrift + totals.orphanedEmbodiment : null}
          loading={loading}
          footer={
            <span className="text-xs text-muted-foreground">{t('policy_registry.ui.zeroInHealthy', "w zdrowym rejestrze zero — każda inna wartość jest awarią")}</span>
          }
        />
      </div>

      {!loading && !policies.length ? (
        <div className="rounded-md border px-4 py-6 text-sm text-muted-foreground">
          Rejestr polityk jest pusty. Uruchom <code>yarn mercato policy_registry seed</code>.
        </div>
      ) : null}

      <div className="flex flex-col gap-4">
        {policies.map((policy) => (
          <div key={policy.id} className="rounded-md border">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
              <div>
                <div className="font-medium">{policy.name}</div>
                <div className="text-xs text-muted-foreground">
                  {policy.policyKey} · {t('policy_registry.ui.task', 'zadanie')} {policy.taskKey} ·{' '}
                  {METHOD_LABEL[policy.learningMethod] ?? policy.learningMethod}
                </div>
              </div>
              <div className="text-xs text-muted-foreground">embodiment {policy.embodimentKey}</div>
            </div>

            {policy.versions.length ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2 font-normal">{t("policy_registry.h.wersja", "wersja")}</th>
                    <th className="px-4 py-2 font-normal">{t('policy_registry.ui.contentDigest', "skrót treści")}</th>
                    <th className="px-4 py-2 font-normal">{t('policy_registry.ui.hardware', "sprzęt")}</th>
                    <th className="px-4 py-2 font-normal">{t("policy_registry.h.artefakty", "artefakty")}</th>
                    <th className="px-4 py-2 font-normal">status</th>
                    <th className="px-4 py-2 font-normal">zarejestrowana</th>
                  </tr>
                </thead>
                <tbody>
                  {policy.versions.map((version) => (
                    <tr key={version.id} className="border-t">
                      <td className="px-4 py-2">v{version.version}</td>
                      <td className="px-4 py-2 font-mono text-xs">{shortDigest(version.contentDigest)}</td>
                      <td className="px-4 py-2">
                        {version.embodiment ? (
                          <span className={version.embodimentDrift ? 'text-red-600' : ''}>
                            {version.embodiment}
                            {version.embodimentDrift ? ' — kontrakt się rozjechał' : ''}
                          </span>
                        ) : (
                          <span className="text-red-600">{t('policy_registry.ui.revisionGone', "rewizja zniknęła z rejestru floty")}</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {version.artifactRoles.join(', ') || '—'}
                      </td>
                      <td className={`px-4 py-2 ${STATUS_TONE[version.status] ?? ''}`}>
                        {STATUS_LABEL[version.status] ?? version.status}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {formatMoment(locale, version.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="px-4 py-3 text-sm text-muted-foreground">{t('policy_registry.ui.policyNoVersions', "Polityka bez żadnej wersji — zadeklarowany embodiment, brak wag.")}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
