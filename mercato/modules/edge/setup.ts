import { createHash } from 'node:crypto'
import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { EDGE_SESSIONS_SWEEP_QUEUE } from './lib/queues'

const logger = createLogger('edge')

function stableScheduleUuid(key: string): string {
  const hex = createHash('sha256').update(key).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

const SESSIONS_SWEEP_SCHEDULE_ID = stableScheduleUuid('edge:sessions-sweep')

/**
 * Co pięć minut.
 *
 * Nie krócej, bo zamiatanie nie jest tym, co utrzymuje pulpit w prawdzie -
 * żywotność liczy się z `last_seen_at` przy odczycie. Nie dłużej, bo przy
 * progach utraty rzędu minut księga sesji rozjeżdżałaby się z rzeczywistością
 * na tyle, że liczba sesji na dobę przestałaby mierzyć migotanie łącza.
 */
const SESSIONS_SWEEP_INTERVAL = '5m'

export async function ensureSessionsSweepSchedule(container: import('awilix').AwilixContainer | undefined): Promise<void> {
  if (!container) return
  let schedulerService: { register: (registration: Record<string, unknown>) => Promise<void> } | undefined
  try {
    schedulerService = container.resolve('schedulerService')
  } catch {
    schedulerService = undefined
  }
  if (!schedulerService) {
    logger.warn('Moduł harmonogramu niedostępny - zamiatanie sesji NIE jest zautomatyzowane')
    return
  }
  try {
    await schedulerService.register({
      id: SESSIONS_SWEEP_SCHEDULE_ID,
      name: 'Zamiatanie sesji agentów po ciszy',
      description:
        'Zamyka sesje agentów, którzy przekroczyli próg utraty. Nie zmienia stanu robota - ' +
        'wniosek o kwarantannie należy do modułu floty.',
      scopeType: 'system',
      scheduleType: 'interval',
      scheduleValue: SESSIONS_SWEEP_INTERVAL,
      timezone: 'UTC',
      targetType: 'queue',
      targetQueue: EDGE_SESSIONS_SWEEP_QUEUE,
      targetPayload: {},
      sourceType: 'module',
      sourceModule: 'edge',
      isEnabled: true,
    })
  } catch (error) {
    logger.warn('Nie udało się zarejestrować harmonogramu zamiatania sesji', { err: error })
  }
}

/**
 * Podgląd łączności dostaje każdy pracownik - bo pytanie „czy ten robot
 * w ogóle się odzywa" pada przy każdej awarii i blokowanie go tylko wydłuża
 * drogę do odpowiedzi.
 *
 * Wpis, rotacja i odwołanie zostają przy administratorze: to operacje na
 * tożsamości, a nie na danych.
 *
 * Kontrakt generatora wymaga eksportu `default` albo nazwanego `setup`;
 * sam `defaultRoleFeatures` przechodzi bez błędu i bez skutku.
 */
export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['edge.*'],
    employee: ['edge.view'],
  },

  async seedDefaults({ container }) {
    await ensureSessionsSweepSchedule(container)
  },
}

export default setup
