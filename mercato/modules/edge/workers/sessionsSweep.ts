import type { EntityManager } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { EDGE_SESSIONS_SWEEP_QUEUE } from '../lib/queues'

/**
 * Cykliczne zamykanie sesji agentów, którzy zamilkli.
 *
 * Warto powiedzieć, czego ten worker **nie** naprawia: pulpit floty i tak
 * pokazuje poprawny stan łączności, bo żywotność jest liczona z `last_seen_at`
 * przy odczycie, a nie odczytywana z flagi. To była decyzja z fazy 0 i dzięki
 * niej brak tego workera nie dawał fałszywego „online".
 *
 * Co naprawia: **księgę sesji**. Bez zamiatania sesja agenta odciętego od
 * prądu zostaje otwarta na zawsze, przez co liczba sesji na dobę - miara
 * migotania łącza - przestaje cokolwiek znaczyć, a ponowne połączenie
 * wygląda jak klon wypierający żywą sesję.
 */

const logger = createLogger('edge:sessions-sweep')

export const metadata: WorkerMeta = {
  queue: EDGE_SESSIONS_SWEEP_QUEUE,
  id: 'edge:sessions-sweep',
  concurrency: 1,
}

export default async function handle(_job: QueuedJob<Record<string, never>>, _ctx: JobContext): Promise<void> {
  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  const bus = container.resolve('commandBus') as CommandBus

  const scopes = await em.getConnection().execute<Array<{ tenant_id: string; id: string }>>(
    'select distinct tenant_id, id from organizations where deleted_at is null',
  )

  let zamkniete = 0
  const utracone: Array<{ robotId: string; silenceSeconds: number | null }> = []

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
      const envelope = await bus.execute('edge.sessions.sweep', {
        input: { tenantId: scope.tenant_id, organizationId: scope.id },
        ctx,
      })
      const result = envelope.result as {
        closed: number
        lost: Array<{ robotId: string; silenceSeconds: number | null }>
      }
      zamkniete += result.closed
      utracone.push(...result.lost)
    } catch (error) {
      logger.error('Zamiatanie sesji nie powiodło się dla tenanta', { tenantId: scope.tenant_id, err: error })
    }
  }

  /**
   * Utracone maszyny **nie są** tu kwarantannowane, mimo że worker ma do tego
   * wszystko pod ręką. Granica modułu z fazy 0 zostaje: `edge` stwierdza ciszę,
   * a wniosek „cisza znaczy: nie wolno pracować" należy do dziedziny i zapada
   * w `fleet`. Zautomatyzowanie tego kroku tutaj byłoby obejściem własnej
   * decyzji projektowej przy pomocy zadania cyklicznego.
   */
  if (utracone.length) {
    logger.warn('Sesje zamknięte po ciszy', { zamkniete, utracone: utracone.length })
  } else {
    logger.info('Przebieg zamiatania zakończony', { zamkniete })
  }
}
