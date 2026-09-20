"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@open-mercato/ui/primitives/dialog'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'

/**
 * Zgłoszenie zdarzenia bezpieczeństwa.
 *
 * Formularz jest krótki celowo. Zgłoszenie, które zajmuje pięć minut,
 * nie powstaje przy zmianie zmiany - a zdarzenie potencjalnie wypadkowe
 * niezgłoszone jest zdarzeniem, którego nie ma w statystyce i przez to nie
 * ma go też w analizie przyczyn.
 *
 * Czego formularz **nie** pyta: o priorytet ani o to, czy wstrzymać wdrożenia.
 * To wylicza `classifyIncident` z samych faktów - skutku, udziału warstwy
 * bezpieczeństwa i udziału polityki. Gdyby o ciężarze decydował zgłaszający,
 * ta sama sytuacja miałaby inny priorytet zależnie od tego, kto akurat stał
 * przy maszynie.
 */

type MutationContext = {
  formId: string
  resourceKind: string
  resourceId: string
  retryLastMutation: () => void
}

type Robot = { id: string; serialNumber: string }

const SKUTKI = ['none', 'near_miss', 'first_aid', 'lost_time', 'serious'] as const

export function IncidentDialog({ robots, onDone }: { robots: Robot[]; onDone: () => void | Promise<void> }) {
  const t = useT()
  const [otwarte, setOtwarte] = React.useState(false)
  const [zapis, setZapis] = React.useState(false)
  const [blad, setBlad] = React.useState<string | null>(null)

  const [harm, setHarm] = React.useState<(typeof SKUTKI)[number]>('near_miss')
  const [robotId, setRobotId] = React.useState('')
  const [opis, setOpis] = React.useState('')
  const [kiedy, setKiedy] = React.useState(() => new Date().toISOString().slice(0, 16))
  const [warstwaZadzialala, setWarstwaZadzialala] = React.useState(false)
  const [politykaWSprawie, setPolitykaWSprawie] = React.useState(false)

  const { runMutation, retryLastMutation } = useGuardedMutation<MutationContext>({
    contextId: 'safety-incident',
    blockedMessage: t('safety.incident.blocked', 'Zapis wstrzymany przez strażnika mutacji.'),
  })

  const ETYKIETY: Record<string, string> = {
    none: t('safety.label.harm.none', 'bez skutku'),
    near_miss: t('safety.label.harm.near_miss', 'potencjalnie wypadkowe'),
    first_aid: t('safety.label.harm.first_aid', 'pierwsza pomoc'),
    lost_time: t('safety.label.harm.lost_time', 'niezdolność do pracy'),
    serious: t('safety.label.harm.serious', 'ciężkie'),
  }

  async function wyslij() {
    setZapis(true)
    setBlad(null)
    const ladunek = {
      harm,
      description: opis.trim(),
      occurredAt: new Date(kiedy).toISOString(),
      safetyLayerEngaged: warstwaZadzialala,
      policyImplicated: politykaWSprawie,
      ...(robotId ? { robotId } : {}),
    }
    try {
      const odpowiedz = await runMutation({
        operation: async () => {
          const call = await apiCall<{ priority?: string; haltDeployment?: boolean; reason?: string }>(
            '/api/safety/incidents',
            { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ladunek) },
          )
          if (!call.ok) {
            const body = call.result as { error?: string } | null
            throw new Error(body?.error ?? t('safety.incident.failed', 'Zgłoszenie nie powiodło się'))
          }
          return call.result
        },
        context: {
          formId: 'safety-incident',
          resourceKind: 'safety.incident',
          resourceId: robotId || 'nieprzypisany',
          retryLastMutation,
        },
        mutationPayload: ladunek,
      })
      /*
       * Werdykt wraca do zgłaszającego, zamiast znikać w bazie. Człowiek, który
       * właśnie zgłosił przygniecenie, ma od razu wiedzieć, że to wstrzymało
       * wdrożenia dla całej klasy celi - inaczej dowie się o tym przypadkiem.
       */
      const w = odpowiedz as { priority?: string; haltDeployment?: boolean } | undefined
      flash(
        w?.haltDeployment
          ? t('safety.incident.savedHalting', 'Zdarzenie zapisane. Dopuszczenie dla tej klasy celi zostało wycofane.')
          : t('safety.incident.saved', 'Zdarzenie zapisane.'),
        w?.haltDeployment ? 'error' : 'success',
      )
      setOtwarte(false)
      setOpis('')
      await onDone()
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : t('safety.incident.failed', 'Zgłoszenie nie powiodło się')
      setBlad(message)
      flash(message, 'error')
    } finally {
      setZapis(false)
    }
  }

  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => { setBlad(null); setOtwarte(true) }}>
        {t('safety.incident.report', 'Zgłoś zdarzenie')}
      </Button>

      <Dialog open={otwarte} onOpenChange={(open) => { if (!open) setOtwarte(false) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('safety.incident.title', 'Zgłoszenie zdarzenia bezpieczeństwa')}</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-3 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{t('safety.incident.harm', 'Skutek')}</span>
              <select className="rounded border px-2 py-1" value={harm} onChange={(e) => setHarm(e.target.value as typeof harm)}>
                {SKUTKI.map((s) => <option key={s} value={s}>{ETYKIETY[s]}</option>)}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                {t('safety.incident.robot', 'Maszyna')} - {t('safety.incident.robotOptional', 'jeśli zdarzenie jej dotyczy')}
              </span>
              <select className="rounded border px-2 py-1" value={robotId} onChange={(e) => setRobotId(e.target.value)}>
                <option value="">{t('safety.incident.noRobot', '- nie dotyczy konkretnej maszyny -')}</option>
                {robots.map((r) => <option key={r.id} value={r.id}>{r.serialNumber}</option>)}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{t('safety.incident.when', 'Kiedy')}</span>
              <input type="datetime-local" className="rounded border px-2 py-1" value={kiedy} onChange={(e) => setKiedy(e.target.value)} />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{t('safety.incident.description', 'Co się stało')}</span>
              <textarea className="rounded border px-2 py-1" rows={4} maxLength={2000} value={opis} onChange={(e) => setOpis(e.target.value)} />
            </label>

            <label className="flex items-center gap-2">
              <input type="checkbox" checked={warstwaZadzialala} onChange={(e) => setWarstwaZadzialala(e.target.checked)} />
              <span className="text-xs">{t('safety.incident.layerEngaged', 'Zadziałała warstwa bezpieczeństwa (kurtyna, e-stop, ogranicznik)')}</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={politykaWSprawie} onChange={(e) => setPolitykaWSprawie(e.target.checked)} />
              <span className="text-xs">{t('safety.incident.policyImplicated', 'Zachowanie polityki miało udział w zdarzeniu')}</span>
            </label>

            <div className="text-xs text-muted-foreground">
              {t(
                'safety.incident.classifyHint',
                'Priorytetu nie ustala zgłaszający - wylicza go system ze skutku i z tego, czy zadziałała warstwa bezpieczeństwa.',
              )}
            </div>

            {blad ? <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs">{blad}</div> : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOtwarte(false)}>
              {t('safety.incident.cancel', 'Anuluj')}
            </Button>
            <Button type="button" disabled={zapis || opis.trim().length === 0} onClick={() => void wyslij()}>
              {zapis ? t('safety.incident.saving', 'Zapisywanie…') : t('safety.incident.submit', 'Zgłoś')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export default IncidentDialog
