import type { EntityManager } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { FLEET_CALIBRATION_EXPIRY_QUEUE } from '../lib/queues'

/**
 * Cykliczne wykrywanie wygasłych kalibracji.
 *
 * Detektor jest tanim procesem, ale jego brak był drogi: bez niego „wygasła
 * kalibracja" była faktem, który system potrafił policzyć i nie potrafił
 * nikomu powiedzieć.
 */

const logger = createLogger('fleet:calibration-expiry')

export const metadata: WorkerMeta = {
  queue: FLEET_CALIBRATION_EXPIRY_QUEUE,
  id: 'fleet:calibration-expiry',
  // Jeden na raz - zadanie obchodzi wszystkie organizacje i nie ma powodu,
  // żeby dwa przebiegi konkurowały o te same wiersze.
  concurrency: 1,
}

export default async function handle(_job: QueuedJob<Record<string, never>>, _ctx: JobContext): Promise<void> {
  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  const bus = container.resolve('commandBus') as CommandBus

  const scopes = await em.getConnection().execute<Array<{ tenant_id: string; id: string }>>(
    'select distinct tenant_id, id from organizations where deleted_at is null',
  )

  let ogłoszone = 0
  let wymagane = 0

  for (const scope of scopes) {
    const ctx = {
      container,
      auth: null,
      organizationScope: {
        selectedId: scope.id,
        filterIds: [scope.id],
        allowedIds: [scope.id],
        tenantId: scope.tenant_id,
      },
      selectedOrganizationId: scope.id,
      organizationIds: [scope.id],
    } as unknown as CommandRuntimeContext

    try {
      const envelope = await bus.execute('fleet.calibrations.detect_expired', {
        input: { tenantId: scope.tenant_id, organizationId: scope.id },
        ctx,
      })
      const result = envelope.result as { expired: Array<{ required: boolean }> }
      ogłoszone += result.expired.length
      wymagane += result.expired.filter((e) => e.required).length
    } catch (error) {
      // Awaria jednej organizacji nie zatrzymuje pozostałych: robot w cudzej
      // hali nie przestaje mieć przeterminowanego pomiaru dlatego, że u sąsiada
      // padło zapytanie.
      logger.error('Wykrywanie wygasłych kalibracji nie powiodło się dla organizacji', {
        tenantId: scope.tenant_id,
        organizationId: scope.id,
        err: error,
      })
    }
  }

  if (wymagane > 0) {
    // Rozdział jest istotny: pomiar wymagany przez rewizję embodimentu blokuje
    // dopuszczenie maszyny, pomiar spoza listy wymaganych jest informacją.
    logger.warn('Wygasły kalibracje wymagane przez rewizję embodimentu', { wymagane, ogłoszone })
  } else if (ogłoszone > 0) {
    logger.info('Ogłoszono wygaśnięcie kalibracji', { ogłoszone })
  }
}
