import type { EntityManager } from '@mikro-orm/postgresql'
import { Calibration, EmbodimentRevision } from '../data/entities'
import { evaluateCalibration } from './calibration'

/**
 * Werdykt kalibracyjny dla robota - wymagania bierze z jego rewizji embodimentu.
 *
 * Mieszkał wcześniej w `commands/robots.ts` i stamtąd importowały go zarówno
 * komendy, jak i wiersz poleceń. To był błąd o skutku niewidocznym do czasu,
 * aż jakakolwiek komenda wiersza poleceń przeszła przez szynę komend: plik
 * z komendami rejestruje je efektem ubocznym importu, więc jego statyczny
 * import z `cli.ts` w zestawieniu z leniwym importem tego samego pliku przez
 * ładowarkę szyny kończył się `Duplicate command registration`.
 *
 * Reguła wyniesiona z tej awarii: **plik z komendami nie jest biblioteką**.
 * Cokolwiek ma być wołane spoza szyny, mieszka w `lib/`.
 */
export async function evaluateRobotCalibration(
  em: EntityManager,
  robot: { id: string; embodimentRevisionId: string },
  tenantId: string,
  now: Date = new Date(),
) {
  const revision = await em.findOne(EmbodimentRevision, {
    id: robot.embodimentRevisionId,
    tenantId,
  } as never)
  const required = ((revision as unknown as { requiredCalibrations?: string[] | null })
    ?.requiredCalibrations ?? []) as string[]

  const records = (await em.find(Calibration, {
    robotId: robot.id,
    tenantId,
  } as never)) as unknown as Array<{
    kind: string
    measuredAt: Date
    validUntil: Date
    invalidatedAt?: Date | null
  }>

  return evaluateCalibration(required, records, now)
}
