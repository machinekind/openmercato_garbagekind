import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import { registerCommand, type CommandHandler } from '@open-mercato/shared/lib/commands'
import { Calibration, EmbodimentRevision, Robot, type RobotState } from '../data/entities'
import { emitFleetEvent } from '../events'

/**
 * Detektor wygasłej kalibracji.
 *
 * Dlaczego to w ogóle istnieje: ważność pomiaru wyprowadzamy przy odczycie
 * (`lib/calibration.ts`) i tak ma zostać - stan wyliczony nie potrafi się
 * rozjechać z faktem. Ale wyprowadzenie przy odczycie nikogo nie budzi:
 * robot z przeterminowanym pomiarem wygląda w każdym zestawieniu identycznie
 * jak sprawny, dopóki ktoś nie otworzy akurat tego ekranu. Ta komenda zamienia
 * fakt wyliczalny w fakt ogłoszony.
 *
 * Czego **nie** robi: nie wstawia robota do kwarantanny. Kwarantanna jest
 * przejściem w cyklu życia z własnym uzasadnieniem i własnym wpisem w księdze
 * przejść; decyzję o niej podejmuje subskrybent tego zdarzenia albo człowiek,
 * mając całość obrazu. Detektor, który sam zatrzymuje maszyny, po pierwszym
 * fałszywym alarmie zostaje wyłączony - i wtedy nie ogłasza już niczego.
 */

const detectSchema = z.object({
  organizationId: z.string().uuid(),
  tenantId: z.string().uuid(),
  /** Wyłącznie do testów i ręcznego odtwarzania przebiegu z przeszłości. */
  now: z.coerce.date().optional(),
})

export type DetectExpiredCalibrationsInput = z.infer<typeof detectSchema>

export type ExpiredCalibration = {
  calibrationId: string
  robotId: string
  kind: string
  validUntil: string
  robotState: RobotState
  required: boolean
}

function resolveEm(ctx: { container: { resolve: (key: string) => unknown } }): EntityManager {
  return (ctx.container.resolve('em') as EntityManager).fork()
}

const detectExpiredCommand: CommandHandler<
  DetectExpiredCalibrationsInput,
  { expired: ExpiredCalibration[] }
> = {
  id: 'fleet.calibrations.detect_expired',
  async execute(rawInput, ctx) {
    const input = detectSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)
    const now = input.now ?? new Date()

    /*
     * Filtr po `expiryNotifiedAt: null` jest tym, co czyni komendę
     * idempotentną: drugi przebieg na tym samym stanie nie nadaje niczego.
     * Bez niego zdarzenie „kalibracja wygasła" wracałoby co godzinę, aż do
     * naprawy - czyli dokładnie wtedy, gdy ma coś znaczyć, znaczyłoby najmniej.
     */
    const kandydaci = (await em.find(Calibration, {
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      expiryNotifiedAt: null,
      invalidatedAt: null,
    } as never)) as unknown as Array<{
      id: string
      robotId: string
      kind: string
      validUntil: Date
      expiryNotifiedAt?: Date | null
    }>

    const wygasłe = kandydaci.filter((c) => c.validUntil.getTime() <= now.getTime())
    if (wygasłe.length === 0) return { expired: [] }

    // Robot i jego rewizja embodimentu są potrzebne do dwóch pól ładunku,
    // które decydują o pilności: w jakim stanie jest maszyna i czy ten rodzaj
    // pomiaru jest w ogóle wymagany dla tej klasy sprzętu. Pobieramy je hurtem,
    // nie w pętli.
    const robotIds = Array.from(new Set(wygasłe.map((c) => c.robotId)))
    const roboty = (await em.find(Robot, {
      id: { $in: robotIds },
      tenantId: input.tenantId,
    } as never)) as unknown as Array<{ id: string; state: RobotState; embodimentRevisionId: string }>
    const robotById = new Map(roboty.map((r) => [r.id, r]))

    const revisionIds = Array.from(new Set(roboty.map((r) => r.embodimentRevisionId)))
    const rewizje = revisionIds.length
      ? ((await em.find(EmbodimentRevision, {
          id: { $in: revisionIds },
          tenantId: input.tenantId,
        } as never)) as unknown as Array<{ id: string; requiredCalibrations?: string[] | null }>)
      : []
    const requiredByRevision = new Map(
      rewizje.map((r) => [r.id, new Set(r.requiredCalibrations ?? [])]),
    )

    const expired: ExpiredCalibration[] = []
    for (const kalibracja of wygasłe) {
      const robot = robotById.get(kalibracja.robotId)
      if (!robot) {
        /*
         * Kalibracja bez robota to sierota po usunięciu rekordu. Odhaczamy ją,
         * żeby nie wracała co przebieg, ale nie ogłaszamy: nie ma komu
         * zareagować i nie ma czego zatrzymać.
         */
        kalibracja.expiryNotifiedAt = now
        continue
      }
      const required = requiredByRevision.get(robot.embodimentRevisionId)?.has(kalibracja.kind) ?? false
      kalibracja.expiryNotifiedAt = now
      expired.push({
        calibrationId: kalibracja.id,
        robotId: robot.id,
        kind: kalibracja.kind,
        validUntil: kalibracja.validUntil.toISOString(),
        robotState: robot.state,
        required,
      })
    }

    /*
     * Zrzut przed emisją, nie po: odhaczenie musi być trwałe zanim ktokolwiek
     * dostanie zdarzenie. Odwrotna kolejność przy awarii między emisją
     * a zapisem dałaby powtórne ogłoszenie tego samego faktu.
     */
    await em.flush()

    for (const wpis of expired) {
      await emitFleetEvent('fleet.calibration.expired', {
        id: wpis.calibrationId,
        organizationId: input.organizationId,
        tenantId: input.tenantId,
        robotId: wpis.robotId,
        kind: wpis.kind,
        validUntil: wpis.validUntil,
        robotState: wpis.robotState,
        required: wpis.required,
      })
    }

    return { expired }
  },
}

registerCommand(detectExpiredCommand)
export { detectExpiredCommand }
