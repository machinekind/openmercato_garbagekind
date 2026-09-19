"use client"

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { RobotActions } from './RobotActions'

/**
 * Szczegóły robota — ścieżka odczytu, której do tej wersji nie było.
 *
 * Rejestr floty był listą, w którą nie dało się kliknąć: operator widział,
 * że maszyna stoi w kwarantannie, i nie miał jak sprawdzić dlaczego.
 *
 * Ekran jest zbudowany wokół **księgi przejść**, a nie wokół pól rekordu.
 * Pola rekordu mówią, jak jest; księga mówi, jak do tego doszło — i przy
 * kwarantannie tylko to drugie pozwala odróżnić maszynę, która raz na kwartał
 * łapie kolizję, od maszyny, która wraca do serwisu trzeci raz w tygodniu.
 */

type Transition = {
  fromState: string | null
  toState: string
  reason: string
  actorUserId: string | null
  at: string
}

type Calibration = {
  id: string
  kind: string
  measuredAt: string
  validUntil: string
  invalidatedAt: string | null
  expiryAnnouncedAt: string | null
}

type Payload = {
  robot: {
    id: string
    serialNumber: string
    name: string
    state: string
    stateReason: string | null
    stateChangedAt: string | null
    externallyOperated: boolean
    cell: string | null
    riskClass: string | null
    site: string | null
    embodimentKey: string | null
    embodimentRevision: number | null
    specDigest: string | null
    requiredCalibrations: string[]
  }
  transitions: Transition[]
  calibrations: Calibration[]
  agent: {
    id: string
    status: string
    kind: string
    version: string | null
    lastSeenAt: string | null
    lostAfterSeconds: number
  } | null
}

const TON: Record<string, string> = {
  operational: 'text-emerald-600',
  ready: 'text-emerald-600',
  quarantined: 'text-red-600',
  maintenance: 'text-amber-600',
  decommissioned: 'text-muted-foreground',
}

export default function RobotDetail({ robotId }: { robotId: string }) {
  const t = useT()
  const locale = useLocale()
  const router = useRouter()
  const [dane, setDane] = React.useState<Payload | null>(null)
  const [blad, setBlad] = React.useState<string | null>(null)
  const [brak, setBrak] = React.useState(false)

  const wczytaj = React.useCallback(async () => {
    const call = await apiCall<Payload>(`/api/fleet/robots/${robotId}`)
    if (call.status === 404) { setBrak(true); return }
    if (!call.ok || !call.result) {
      setBlad(t('fleet.detail.error', 'Nie udało się pobrać danych robota.'))
      return
    }
    setBlad(null)
    setDane(call.result)
  }, [robotId, t])

  React.useEffect(() => { void wczytaj() }, [wczytaj])

  // Brak rekordu jest osobnym stanem strony, nie odmianą błędu — inaczej
  // operator dostaje „coś poszło nie tak" tam, gdzie odpowiedź brzmi
  // „tego robota nie ma w rejestrze".
  if (brak) {
    return (
      <ErrorMessage
        label={t('fleet.detail.notFound', 'Tego robota nie ma w rejestrze tego tenanta.')}
        action={
          <Button type="button" variant="outline" onClick={() => router.push('/backend/fleet')}>
            {t('fleet.detail.backToList', 'Wróć do rejestru')}
          </Button>
        }
      />
    )
  }
  if (blad) return <ErrorMessage label={blad} />
  if (!dane) return <LoadingMessage label={t('common.loading', 'Wczytywanie…')} />

  const r = dane.robot
  const czas = (iso: string) => new Date(iso).toLocaleString(locale)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-lg border px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-3">
            <span className="text-lg font-medium">{r.name}</span>
            <span className="font-mono text-xs text-muted-foreground">{r.serialNumber}</span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {[r.site, r.cell, r.embodimentKey ? `${r.embodimentKey} r${r.embodimentRevision ?? '?'}` : null]
              .filter(Boolean)
              .join(' · ')}
          </div>
          <div className={`mt-2 text-sm ${TON[r.state] ?? ''}`}>
            {r.state}
            {r.stateReason ? <span className="text-muted-foreground"> — {r.stateReason}</span> : null}
          </div>
          {r.externallyOperated ? (
            <div className="mt-1 text-xs text-amber-600">
              {t('fleet.detail.externallyOperated', 'Właściciel i operator to różne podmioty')}
            </div>
          ) : null}
        </div>

        <RobotActions
          robot={{ id: r.id, serialNumber: r.serialNumber, name: r.name, state: r.state, requiredCalibrations: r.requiredCalibrations }}
          onDone={wczytaj}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border">
          <div className="border-b px-4 py-2 text-sm font-medium">
            {t('fleet.detail.transitions', 'Księga przejść')}
          </div>
          {dane.transitions.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">
              {t('fleet.detail.noTransitions', 'Brak wpisów.')}
            </div>
          ) : (
            <div className="divide-y">
              {dane.transitions.map((p, i) => (
                <div key={`${p.at}-${i}`} className="px-4 py-2 text-sm">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-xs text-muted-foreground">{czas(p.at)}</span>
                    <span className={TON[p.toState] ?? ''}>
                      {p.fromState ?? '—'} → {p.toState}
                    </span>
                    {/* Brak identyfikatora znaczy, że przejście wykonał system.
                        To jest informacja, nie luka w danych. */}
                    <span className="text-xs text-muted-foreground">
                      {p.actorUserId
                        ? t('fleet.detail.byHuman', 'człowiek')
                        : t('fleet.detail.bySystem', 'system')}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">{p.reason}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-6">
          <div className="rounded-lg border">
            <div className="border-b px-4 py-2 text-sm font-medium">
              {t('fleet.detail.calibrations', 'Kalibracje')}
            </div>
            {dane.calibrations.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">
                {t('fleet.detail.noCalibrations', 'Brak pomiarów.')}
              </div>
            ) : (
              <div className="divide-y">
                {dane.calibrations.map((k) => {
                  const wygasla = new Date(k.validUntil).getTime() <= Date.now()
                  const wymagana = r.requiredCalibrations.includes(k.kind)
                  return (
                    <div key={k.id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2 text-sm">
                      <span>
                        {k.kind}
                        {wymagana ? null : (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {t('fleet.detail.notRequired', 'spoza listy wymaganych')}
                          </span>
                        )}
                      </span>
                      <span className={`text-xs ${k.invalidatedAt ? 'text-muted-foreground' : wygasla ? 'text-red-600' : 'text-muted-foreground'}`}>
                        {k.invalidatedAt
                          ? t('fleet.detail.invalidated', 'unieważniona')
                          : `${t('fleet.detail.validUntil', 'ważna do')} ${czas(k.validUntil)}`}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <div className="rounded-lg border">
            <div className="border-b px-4 py-2 text-sm font-medium">
              {t('fleet.detail.agent', 'Agent brzegowy')}
            </div>
            <div className="px-4 py-3 text-sm">
              {dane.agent ? (
                <div className="flex flex-col gap-1">
                  <div className="text-xs text-muted-foreground">
                    {dane.agent.kind}{dane.agent.version ? ` · ${dane.agent.version}` : ''} · {dane.agent.status}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {dane.agent.lastSeenAt
                      ? `${t('fleet.detail.lastSeen', 'ostatnio widziany')}: ${czas(dane.agent.lastSeenAt)}`
                      : t('fleet.detail.neverSeen', 'nigdy się nie odezwał')}
                  </div>
                </div>
              ) : (
                /* Brak agenta to normalny stan maszyny bez kanału brzegowego,
                   a nie awaria — i musi wyglądać inaczej niż utrata łączności. */
                <span className="text-xs text-muted-foreground">
                  {t('fleet.detail.noAgent', 'Ta maszyna nie ma wpisanego agenta.')}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
