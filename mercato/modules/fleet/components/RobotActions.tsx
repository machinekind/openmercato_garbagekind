"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@open-mercato/ui/primitives/dialog'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useCurrentUserId } from '@open-mercato/ui/backend/utils/useCurrentUserId'
import { allowedTargets, checkTransition, type TransitionActor } from '../lib/lifecycle'
import type { RobotState } from '../data/entities'

/**
 * Akcje operatorskie na robocie.
 *
 * Do tej wersji każda z nich była komendą wiersza poleceń, więc w praktyce
 * nie istniała: operator hali nie zatrzyma maszyny przez `mercato fleet`.
 *
 * Dwie decyzje warte wypisania.
 *
 * **Podpis składa człowiek, nie serwer.** Komenda wymaga `approvedBy` przy
 * każdym przejściu dopuszczającym maszynę do ruchu. Kusiło, żeby trasa
 * dokładała tam identyfikator zalogowanego użytkownika po cichu - i to
 * zamieniłoby „człowiek bierze odpowiedzialność" w „serwer podpisał za niego".
 * Dlatego identyfikator wędruje z przeglądarki i tylko po zaznaczeniu
 * świadomego potwierdzenia.
 *
 * **Lista stanów docelowych liczona z grafu, nie wypisana w formularzu.**
 * `allowedTargets` to ta sama czysta funkcja, której używa komenda. Gdyby
 * formularz miał własną listę, po pierwszej zmianie grafu pokazywałby
 * przejścia, które serwer odrzuca - a operator uczyłby się, że system kłamie.
 */

type Robot = {
  id: string
  serialNumber: string
  name: string
  state: string
  requiredCalibrations?: string[]
}

type MutationContext = {
  formId: string
  resourceKind: string
  resourceId: string
  retryLastMutation: () => void
}

type Props = {
  robot: Robot
  onDone: () => void | Promise<void>
}

function toMessage(status: number, result: unknown, zapasowy: string): string {
  const body = result as { error?: string } | null
  if (body?.error) return body.error
  return `${zapasowy} (HTTP ${status})`
}

export function RobotActions({ robot, onDone }: Props) {
  const t = useT()
  const userId = useCurrentUserId()
  const [okno, setOkno] = React.useState<'transition' | 'calibration' | null>(null)
  const [zapis, setZapis] = React.useState(false)
  const [blad, setBlad] = React.useState<string | null>(null)

  const { runMutation, retryLastMutation } = useGuardedMutation<MutationContext>({
    contextId: `fleet-robot-actions:${robot.id}`,
    blockedMessage: t('fleet.actions.blocked', 'Zapis wstrzymany przez strażnika mutacji.'),
  })

  const stan = robot.state as RobotState
  const cele = React.useMemo(() => allowedTargets(stan), [stan])

  // formularz przejścia
  const [toState, setToState] = React.useState<RobotState | ''>('')
  const [powod, setPowod] = React.useState('')
  const [podpis, setPodpis] = React.useState(false)

  // formularz kalibracji
  const [rodzaj, setRodzaj] = React.useState('')
  const [zmierzono, setZmierzono] = React.useState(() => new Date().toISOString().slice(0, 10))
  const [wazneDo, setWazneDo] = React.useState('')

  const werdykt = toState ? checkTransition(stan, toState, 'human' as TransitionActor) : null
  const wymagaPodpisu = werdykt?.requiresApproval === true

  const otworz = (ktore: 'transition' | 'calibration') => {
    setBlad(null)
    setToState('')
    setPowod('')
    setPodpis(false)
    setRodzaj(robot.requiredCalibrations?.[0] ?? '')
    setZmierzono(new Date().toISOString().slice(0, 10))
    setWazneDo('')
    setOkno(ktore)
  }

  async function wyslij(sciezka: string, ladunek: Record<string, unknown>, sukces: string) {
    setZapis(true)
    setBlad(null)
    try {
      await runMutation({
        operation: async () => {
          const call = await apiCall(sciezka, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(ladunek),
          })
          if (!call.ok) {
            throw new Error(toMessage(call.status, call.result, t('fleet.actions.failed', 'Zapis nie powiódł się')))
          }
          return call
        },
        context: {
          formId: `fleet-robot-actions:${robot.id}`,
          resourceKind: 'fleet.robot',
          resourceId: robot.id,
          retryLastMutation,
        },
        mutationPayload: ladunek,
      })
      flash(sukces, 'success')
      setOkno(null)
      await onDone()
    } catch (err) {
      /*
       * Komunikat z serwera idzie do formularza w całości. Komendy tej wtyczki
       * odmawiają zdaniami napisanymi dla człowieka („Nie można dopuścić
       * robota: brak ważnej kalibracji camera_extrinsics") i to jest jedyna
       * informacja, z której operator wie, co zrobić dalej. Podmiana jej na
       * własne „wystąpił błąd" kasuje całą wartość tych bramek.
       */
      const message = err instanceof Error && err.message
        ? err.message
        : t('fleet.actions.failed', 'Zapis nie powiódł się')
      setBlad(message)
      flash(message, 'error')
    } finally {
      setZapis(false)
    }
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={cele.length === 0}
          onClick={() => otworz('transition')}
        >
          {cele.length === 0
            ? t('fleet.actions.terminal', 'Stan końcowy')
            : t('fleet.actions.changeState', 'Zmień stan')}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => otworz('calibration')}>
          {t('fleet.actions.recordCalibration', 'Zapisz kalibrację')}
        </Button>
      </div>

      <Dialog open={okno === 'transition'} onOpenChange={(open) => { if (!open) setOkno(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('fleet.actions.changeStateOf', 'Zmiana stanu')} - {robot.serialNumber}
            </DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-3 text-sm">
            <div className="text-xs text-muted-foreground">
              {t('fleet.actions.currentState', 'Stan bieżący')}: <span className="font-medium">{robot.state}</span>
            </div>

            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{t('fleet.actions.targetState', 'Stan docelowy')}</span>
              <select
                className="rounded border px-2 py-1"
                value={toState}
                onChange={(e) => { setToState(e.target.value as RobotState); setPodpis(false) }}
              >
                <option value="">{t('fleet.actions.pick', '- wybierz -')}</option>
                {cele.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                {t('fleet.actions.reason', 'Powód')} - {t('fleet.actions.reasonHint', 'trafia do księgi przejść i zostaje tam na stałe')}
              </span>
              <textarea
                className="rounded border px-2 py-1"
                rows={3}
                value={powod}
                onChange={(e) => setPowod(e.target.value)}
                maxLength={500}
              />
            </label>

            {wymagaPodpisu ? (
              <label className="flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/5 px-3 py-2">
                <input type="checkbox" checked={podpis} onChange={(e) => setPodpis(e.target.checked)} className="mt-1" />
                <span className="text-xs">
                  {t(
                    'fleet.actions.signature',
                    'Biorę odpowiedzialność za dopuszczenie tej maszyny. Mój identyfikator zostanie zapisany w księdze przejść.',
                  )}
                </span>
              </label>
            ) : null}

            {blad ? <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs">{blad}</div> : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOkno(null)}>
              {t('fleet.actions.cancel', 'Anuluj')}
            </Button>
            <Button
              type="button"
              disabled={
                zapis
                || !toState
                || powod.trim().length === 0
                || (wymagaPodpisu && (!podpis || !userId))
              }
              onClick={() => wyslij(
                '/api/fleet/robots/transition',
                {
                  robotId: robot.id,
                  toState,
                  reason: powod.trim(),
                  actor: 'human',
                  ...(wymagaPodpisu ? { approvedBy: userId } : {}),
                },
                t('fleet.actions.stateChanged', 'Stan robota zmieniony.'),
              )}
            >
              {zapis ? t('fleet.actions.saving', 'Zapisywanie…') : t('fleet.actions.confirm', 'Zatwierdź')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={okno === 'calibration'} onOpenChange={(open) => { if (!open) setOkno(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('fleet.actions.recordCalibration', 'Zapisz kalibrację')} - {robot.serialNumber}
            </DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-3 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{t('fleet.actions.calibrationKind', 'Rodzaj pomiaru')}</span>
              <input
                className="rounded border px-2 py-1"
                value={rodzaj}
                onChange={(e) => setRodzaj(e.target.value)}
                list="fleet-required-calibrations"
                maxLength={120}
              />
              {/* Podpowiadamy pomiary wymagane przez rewizję embodimentu,
                  ale nie zamykamy listy: technik bywa mądrzejszy od rejestru. */}
              <datalist id="fleet-required-calibrations">
                {(robot.requiredCalibrations ?? []).map((k) => <option key={k} value={k} />)}
              </datalist>
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">{t('fleet.actions.measuredAt', 'Data pomiaru')}</span>
                <input type="date" className="rounded border px-2 py-1" value={zmierzono} onChange={(e) => setZmierzono(e.target.value)} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  {t('fleet.actions.validUntil', 'Ważne do')}
                </span>
                <input type="date" className="rounded border px-2 py-1" value={wazneDo} onChange={(e) => setWazneDo(e.target.value)} />
              </label>
            </div>
            <div className="text-xs text-muted-foreground">
              {t(
                'fleet.actions.validUntilHint',
                'Data ważności jest obowiązkowa. Kalibracja bez terminu to kalibracja, o której nikt nie przypomni.',
              )}
            </div>

            {blad ? <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs">{blad}</div> : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOkno(null)}>
              {t('fleet.actions.cancel', 'Anuluj')}
            </Button>
            <Button
              type="button"
              disabled={zapis || !rodzaj.trim() || !zmierzono || !wazneDo}
              onClick={() => wyslij(
                '/api/fleet/calibrations',
                {
                  robotId: robot.id,
                  kind: rodzaj.trim(),
                  measuredAt: new Date(`${zmierzono}T00:00:00Z`).toISOString(),
                  validUntil: new Date(`${wazneDo}T00:00:00Z`).toISOString(),
                  ...(userId ? { measuredBy: userId } : {}),
                },
                t('fleet.actions.calibrationSaved', 'Kalibracja zapisana.'),
              )}
            >
              {zapis ? t('fleet.actions.saving', 'Zapisywanie…') : t('fleet.actions.confirm', 'Zatwierdź')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export default RobotActions
