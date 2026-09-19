import { createHash } from 'node:crypto'
import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { VISION_CLIPS_PURGE_QUEUE } from './lib/queues'

const logger = createLogger('vision')

/**
 * Identyfikator harmonogramu wyprowadzony ze stabilnego klucza.
 *
 * `register` jest zapisem nadpisującym, więc stały identyfikator sprawia,
 * że wywołanie przy każdym starcie tenanta jest bezpieczne. Losowy dawałby
 * nowy harmonogram przy każdym uruchomieniu i po tygodniu zadanie chodziłoby
 * kilkanaście razy na dobę.
 */
function stableScheduleUuid(key: string): string {
  const hex = createHash('sha256').update(key).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

const CLIPS_PURGE_SCHEDULE_ID = stableScheduleUuid('vision:clips-purge')

/**
 * Częstotliwość a termin ustawowy.
 *
 * Termin z art. 22² § 3 KP jest liczony **per nagranie**, więc przebieg co
 * dobę znaczy, że materiał może przeleżeć do 24 godzin ponad termin. Uznaję
 * to za dopuszczalny luz przy okresie trzymiesięcznym i zapisuję wprost,
 * zamiast udawać, że przebieg dobowy daje zgodność co do sekundy. Zacieśnienie
 * to zmiana jednej stałej niżej.
 */
const CLIPS_PURGE_INTERVAL = '24h'

export async function ensureClipsPurgeSchedule(container: import('awilix').AwilixContainer | undefined): Promise<void> {
  if (!container) return

  let schedulerService: { register: (registration: Record<string, unknown>) => Promise<void> } | undefined
  try {
    schedulerService = container.resolve('schedulerService')
  } catch {
    schedulerService = undefined
  }
  if (!schedulerService) {
    /*
     * Brak modułu harmonogramu nie może wywrócić instalacji modułu wizji —
     * ale musi być głośny, bo bez niego termin ustawowy znów zależy od tego,
     * czy ktoś pamięta wpisać komendę.
     */
    logger.warn('Moduł harmonogramu niedostępny — oznaczanie materiału po terminie NIE jest zautomatyzowane')
    return
  }

  try {
    await schedulerService.register({
      id: CLIPS_PURGE_SCHEDULE_ID,
      name: 'Materiał wideo po terminie ustawowym',
      description:
        'Oznacza klipy, których termin z art. 22² § 3 Kodeksu pracy upłynął. Nie kasuje plików — ' +
        'zgodność zamyka potwierdzenie usunięcia przez magazyn obiektów.',
      scopeType: 'system',
      scheduleType: 'interval',
      scheduleValue: CLIPS_PURGE_INTERVAL,
      timezone: 'UTC',
      targetType: 'queue',
      targetQueue: VISION_CLIPS_PURGE_QUEUE,
      targetPayload: {},
      sourceType: 'module',
      sourceModule: 'vision',
      isEnabled: true,
    })
  } catch (error) {
    logger.warn('Nie udało się zarejestrować harmonogramu oznaczania klipów', { err: error })
  }
}

/**
 * Pracownik widzi zliczenia, bo to informacja o produkcji. **Nie** dostaje
 * dostępu do nagrań — te są danymi osobowymi jego i jego kolegów.
 */
export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['vision.*'],
    employee: ['vision.view'],
  },

  async seedDefaults({ container }) {
    await ensureClipsPurgeSchedule(container)
  },
}

export default setup
