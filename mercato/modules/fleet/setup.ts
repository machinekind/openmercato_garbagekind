import { createHash } from 'node:crypto'
import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { FLEET_CALIBRATION_EXPIRY_QUEUE } from './lib/queues'

const logger = createLogger('fleet')

/**
 * Identyfikator harmonogramu wyprowadzony ze stabilnego klucza.
 *
 * `register` nadpisuje, więc stały identyfikator czyni wywołanie przy każdym
 * starcie tenanta bezpiecznym. Losowy dawałby nowy harmonogram przy każdym
 * uruchomieniu i po tygodniu detektor chodziłby kilkanaście razy na godzinę.
 */
function stableScheduleUuid(key: string): string {
  const hex = createHash('sha256').update(key).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

const CALIBRATION_EXPIRY_SCHEDULE_ID = stableScheduleUuid('fleet:calibration-expiry')

/**
 * Co godzinę, nie co minutę.
 *
 * Ważność kalibracji liczy się w dniach i tygodniach, więc godzinne opóźnienie
 * ogłoszenia nie zmienia niczyjej decyzji. Częstszy przebieg kosztowałby tyle
 * samo zapytań przy zerowym zysku informacyjnym.
 */
const CALIBRATION_EXPIRY_INTERVAL = '1h'

export async function ensureCalibrationExpirySchedule(
  container: import('awilix').AwilixContainer | undefined,
): Promise<void> {
  if (!container) return

  let schedulerService: { register: (registration: Record<string, unknown>) => Promise<void> } | undefined
  try {
    schedulerService = container.resolve('schedulerService')
  } catch {
    schedulerService = undefined
  }
  if (!schedulerService) {
    logger.warn('Moduł harmonogramu niedostępny - wygaśnięcie kalibracji NIE będzie ogłaszane')
    return
  }

  try {
    await schedulerService.register({
      id: CALIBRATION_EXPIRY_SCHEDULE_ID,
      name: 'Wygasłe kalibracje',
      description:
        'Ogłasza zdarzenie fleet.calibration.expired dla pomiarów, których ważność upłynęła. ' +
        'Nie zatrzymuje maszyn - o kwarantannie decyduje subskrybent albo człowiek.',
      scopeType: 'system',
      scheduleType: 'interval',
      scheduleValue: CALIBRATION_EXPIRY_INTERVAL,
      timezone: 'UTC',
      targetType: 'queue',
      targetQueue: FLEET_CALIBRATION_EXPIRY_QUEUE,
      targetPayload: {},
      sourceType: 'module',
      sourceModule: 'fleet',
      isEnabled: true,
    })
  } catch (error) {
    logger.warn('Nie udało się zarejestrować harmonogramu wygasłych kalibracji', { err: error })
  }
}

/**
 * Domyślne nadanie uprawnień rolom przy instalacji modułu.
 *
 * Operator floty dostaje podgląd, zmianę stanu i kalibrację - bo to on
 * zatrzymuje i wypuszcza maszyny. Wycofanie zostaje przy administratorze:
 * to decyzja nieodwracalna, unieważniająca trwale tożsamość agenta.
 *
 * Kontrakt generatora: rejestr czyta `default` albo nazwany eksport `setup`.
 * Sam `defaultRoleFeatures` nie zostanie zauważony i uprawnienia po cichu
 * nie powstaną - nauczka kosztująca jeden przebieg diagnostyczny.
 */
export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['fleet.*'],
    employee: ['fleet.view', 'fleet.transition', 'fleet.calibrate'],
  },

  async seedDefaults({ container }) {
    await ensureCalibrationExpirySchedule(container)
  },
}

export default setup
