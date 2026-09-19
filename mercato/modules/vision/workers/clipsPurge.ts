import type { EntityManager } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { VISION_CLIPS_PURGE_QUEUE } from '../lib/queues'

/**
 * Cykliczne oznaczanie materiału po ustawowym terminie.
 *
 * Powód istnienia jest jednozdaniowy: art. 22² § 3 Kodeksu pracy nakazuje
 * zniszczenie nagrań po trzech miesiącach, a do tej wersji realizowała to
 * komenda wiersza poleceń, której **nic nie uruchamiało**. Różnica między
 * zgodnością a notatką o zgodności to właśnie ten plik.
 *
 * Czego ten worker nie robi i robić nie będzie: nie kasuje plików. Bajty leżą
 * w magazynie obiektów, do którego ERP nie ma dostępu — i dobrze, bo inaczej
 * system ewidencyjny potrafiłby nieodwracalnie usunąć materiał dowodowy.
 * Worker oznacza, a zgodność zamyka potwierdzenie usunięcia przez tego, kto
 * bajty trzyma.
 */

const logger = createLogger('vision:clips-purge')

export const metadata: WorkerMeta = {
  queue: VISION_CLIPS_PURGE_QUEUE,
  id: 'vision:clips-purge',
  // Jeden na raz: to zadanie chodzi po wszystkich tenantach i nie ma powodu,
  // żeby dwa przebiegi konkurowały o te same wiersze.
  concurrency: 1,
}

export default async function handle(_job: QueuedJob<Record<string, never>>, _ctx: JobContext): Promise<void> {
  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  const bus = container.resolve('commandBus') as CommandBus

  /*
   * Zadanie jest zakresu systemowego, więc samo musi obejść tenantów.
   * Bierzemy je z organizacji, bo komendy wymagają pary tenant + organizacja,
   * a nie samego tenanta.
   */
  const scopes = await em.getConnection().execute<Array<{ tenant_id: string; id: string }>>(
    'select distinct tenant_id, id from organizations where deleted_at is null',
  )

  let oznaczone = 0
  let wstrzymane = 0

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
      const envelope = await bus.execute('vision.clips.purge', {
        input: { tenantId: scope.tenant_id, organizationId: scope.id },
        ctx,
      })
      const result = envelope.result as { purged: Array<{ uri: string }>; heldBack: number }
      oznaczone += result.purged.length
      wstrzymane += result.heldBack
    } catch (error) {
      // Awaria jednego tenanta nie może zatrzymać pozostałych: to jest
      // zadanie o terminie ustawowym i ma dotknąć każdego, kogo dotyczy.
      logger.error('Oznaczanie klipów nie powiodło się dla tenanta', {
        tenantId: scope.tenant_id,
        err: error,
      })
    }
  }

  /**
   * Liczba, która naprawdę mówi o zgodności: materiał **oznaczony i nadal
   * istniejący**, bo nikt nie potwierdził skasowania bajtów. Rośnie, gdy
   * proces kasowania po drugiej stronie nie działa — i wtedy ma być głośno,
   * bo z punktu widzenia przepisu nagranie wciąż tam jest.
   */
  const zalegle = await em.getConnection().execute<Array<{ count: string }>>(
    `select count(*) as count from vision_clips
      where marked_for_deletion_at is not null and deletion_confirmed_at is null`,
  )
  const niepotwierdzone = Number(zalegle?.[0]?.count ?? 0)

  if (niepotwierdzone > 0) {
    logger.warn('Materiał po terminie oznaczony, ale nieusunięty', { niepotwierdzone, oznaczone, wstrzymane })
  } else {
    logger.info('Przebieg oznaczania zakończony', { oznaczone, wstrzymane })
  }
}
