import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import { registerCommand, type CommandHandler } from '@open-mercato/shared/lib/commands'
import { Episode, Intervention, type EpisodeOutcome, type InterventionKind } from '../data/entities'
import { emitEpisodesEvent } from '../events'

/**
 * Komendy księgi epizodów.
 *
 * Dwie zasady, których ten plik pilnuje:
 *
 * 1. **Epizod jest niezmienny po zapisaniu.** Nie ma komendy edycji epizodu.
 *    Powtórne wysłanie tego samego `external_ref` zwraca istniejący wpis —
 *    agent po utracie łącza wysyła zaległe epizody ponownie i nie może przez
 *    to rozmnożyć księgi. Ta sama zasada, co przy skrócie wag w rejestrze
 *    polityk: idempotencja siedzi w unikacie bazy, nie w pamięci procesu.
 *
 * 2. **Interwencja dopisuje się do epizodu, nigdy go nie nadpisuje.**
 *    Licznik na epizodzie rośnie, ale wynik epizodu zostaje taki, jaki zgłosił
 *    robot. Zamiana wyniku na „przerwany" przy każdej interwencji skasowałaby
 *    rozróżnienie między „człowiek poprawił coś w locie, zadanie się udało"
 *    a „człowiek przerwał, zadanie przepadło" — a to jest różnica między
 *    wdrożeniem dojrzałym a niedziałającym.
 */

const scoped = z.object({
  organizationId: z.string().uuid(),
  tenantId: z.string().uuid(),
})

const outcomes = ['success', 'failure', 'aborted', 'timeout'] as const
const kinds = ['adjust', 'manual_reset', 'teleop_takeover', 'abort', 'estop'] as const

export const episodeRecordSchema = scoped.extend({
  robotId: z.string().uuid(),
  externalRef: z.string().trim().min(1).max(191),
  taskKey: z.string().trim().min(1).max(120),
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date(),
  outcome: z.enum(outcomes),
  outcomeDetail: z.string().trim().max(500).optional(),
  policyVersionId: z.string().uuid().nullable().optional(),
  cellId: z.string().uuid().nullable().optional(),
  assignmentId: z.string().uuid().nullable().optional(),
  metrics: z.record(z.string(), z.unknown()).optional(),
})

export const interventionRecordSchema = scoped.extend({
  robotId: z.string().uuid(),
  episodeId: z.string().uuid().nullable().optional(),
  kind: z.enum(kinds),
  stage: z.string().trim().max(120).optional(),
  reasonCategory: z.string().trim().min(1).max(120),
  reason: z.string().trim().min(1).max(500),
  occurredAt: z.coerce.date(),
  recoverySeconds: z.number().int().nonnegative().optional(),
  actorUserId: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(2000).optional(),
})

export type EpisodeRecordInput = z.infer<typeof episodeRecordSchema>
export type InterventionRecordInput = z.infer<typeof interventionRecordSchema>

function resolveEm(ctx: { container: { resolve: (key: string) => unknown } }): EntityManager {
  return (ctx.container.resolve('em') as EntityManager).fork()
}

/**
 * Nazwany kształt epizodu używany przez komendę interwencji.
 *
 * Alias istnieje, bo `as unknown as typeof episode` przy zmiennej
 * zainicjowanej na `null` zawęża typ do `null`, a po `if (!episode) throw`
 * do `never` — i każdy odczyt pola staje się błędem widocznym wyłącznie
 * w `tsc --noEmit`, nigdy w teście. Atrapa EntityManagera jest typowana
 * luźno i przepuszcza to bez mrugnięcia.
 */
type EpisodeRef = {
  id: string
  robotId: string
  cellId?: string | null
  policyVersionId?: string | null
  interventionCount: number
}

export type EpisodeRecordResult = {
  episodeId: string
  sequence: number
  /** `true`, gdy epizod o tym `external_ref` już był w księdze. */
  duplicate: boolean
}

const recordEpisodeCommand: CommandHandler<EpisodeRecordInput, EpisodeRecordResult> = {
  id: 'episodes.episodes.record',
  async execute(rawInput, ctx) {
    const input = episodeRecordSchema.parse(rawInput ?? {})
    if (input.endedAt.getTime() < input.startedAt.getTime()) {
      throw new Error('Epizod nie może skończyć się przed rozpoczęciem.')
    }

    const em = resolveEm(ctx)

    const existing = (await em.findOne(Episode, {
      tenantId: input.tenantId,
      robotId: input.robotId,
      externalRef: input.externalRef,
    } as never)) as unknown as { id: string; sequence: number } | null

    if (existing) {
      // Powtórka nie jest błędem — agent po utracie łącza dosyła zaległości.
      return { episodeId: existing.id, sequence: Number(existing.sequence), duplicate: true }
    }

    const maxRows = await em.getConnection().execute<Array<{ max: number | null }>>(
      `select max(sequence) as max from episodes_episodes where tenant_id = ? and robot_id = ?`,
      [input.tenantId, input.robotId],
    )
    const sequence = Number(maxRows?.[0]?.max ?? 0) + 1

    const episode = em.create(Episode, {
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      robotId: input.robotId,
      cellId: input.cellId ?? null,
      policyVersionId: input.policyVersionId ?? null,
      assignmentId: input.assignmentId ?? null,
      sequence,
      externalRef: input.externalRef,
      taskKey: input.taskKey,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      durationMs: input.endedAt.getTime() - input.startedAt.getTime(),
      outcome: input.outcome as EpisodeOutcome,
      outcomeDetail: input.outcomeDetail ?? null,
      interventionCount: 0,
      metrics: input.metrics ?? null,
    } as never)

    em.persist(episode)
    await em.flush()

    /*
     * Wyjście duplikatem wyżej świadomie nie emituje: ten sam `externalRef`
     * to ten sam epizod, a nie drugi. Ponowne wysłanie z hali po zerwaniu
     * łącza nie może podwajać statystyk ani odpalać automatyzacji drugi raz.
     */
    const episodeId = (episode as unknown as { id: string }).id
    await emitEpisodesEvent('episodes.episode.recorded', {
      id: episodeId,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      robotId: input.robotId,
      sequence,
      taskKey: input.taskKey,
      outcome: input.outcome,
      durationMs: input.endedAt.getTime() - input.startedAt.getTime(),
      policyVersionId: input.policyVersionId ?? null,
      cellId: input.cellId ?? null,
    })

    return { episodeId, sequence, duplicate: false }
  },
}

const recordInterventionCommand: CommandHandler<
  InterventionRecordInput,
  { interventionId: string; episodeId: string | null; interventionCount: number | null }
> = {
  id: 'episodes.interventions.record',
  async execute(rawInput, ctx) {
    const input = interventionRecordSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)

    let episode: EpisodeRef | null = null

    if (input.episodeId) {
      /**
       * Rzutowanie idzie przez `unknown`, a nie przez `never`.
       *
       * `as never` kompiluje się i zawęża typ do `never`, przez co **każdy**
       * odczyt pola z tego obiektu staje się błędem dopiero przy `tsc`, a nigdy
       * w teście — atrapa `EntityManager` jest i tak typowana luźno. To był
       * realny błąd znaleziony przez `tsc --noEmit` po zielonej suicie.
       */
      episode = (await em.findOne(Episode, {
        id: input.episodeId,
        tenantId: input.tenantId,
      } as never)) as unknown as EpisodeRef | null
      if (!episode) throw new Error(`Epizod ${input.episodeId} nie istnieje.`)
      if (episode.robotId !== input.robotId) {
        // Interwencja przypisana do cudzego epizodu zepsułaby kadencję obu
        // robotów naraz i byłaby nie do wykrycia w raporcie.
        throw new Error('Interwencja wskazuje epizod innego robota.')
      }
    }

    const intervention = em.create(Intervention, {
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      episodeId: episode?.id ?? null,
      robotId: input.robotId,
      // Cela i wersja polityki brane z epizodu, a nie z wejścia: interwencja
      // dotyczy tego, co robot wtedy robił, a nie tego, co robi teraz.
      cellId: episode?.cellId ?? null,
      policyVersionId: episode?.policyVersionId ?? null,
      kind: input.kind as InterventionKind,
      stage: input.stage ?? null,
      reasonCategory: input.reasonCategory,
      reason: input.reason,
      actorUserId: input.actorUserId ?? ctx.auth?.sub ?? null,
      occurredAt: input.occurredAt,
      recoverySeconds: input.recoverySeconds ?? null,
      notes: input.notes ?? null,
    } as never)

    if (episode) episode.interventionCount = Number(episode.interventionCount ?? 0) + 1

    em.persist(intervention)
    await em.flush()

    const interventionId = (intervention as unknown as { id: string }).id
    const wspólne = {
      id: interventionId,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      robotId: input.robotId,
      episodeId: episode?.id ?? null,
      kind: input.kind,
      reasonCategory: input.reasonCategory,
      reason: input.reason,
      occurredAt: input.occurredAt.toISOString(),
    }
    await emitEpisodesEvent('episodes.intervention.recorded', {
      ...wspólne,
      recoverySeconds: input.recoverySeconds ?? null,
    })

    // Wydzielenie po rodzaju, nie po nazwie: zatrzymanie awaryjne, przerwanie
    // i przejęcie zdalne to sytuacje, w których człowiek musiał odebrać
    // maszynie sprawczość. Korekta chwytu nią nie jest.
    if (input.kind === 'estop' || input.kind === 'abort' || input.kind === 'teleop_takeover') {
      await emitEpisodesEvent('episodes.intervention.emergency', wspólne)
    }

    return {
      interventionId,
      episodeId: episode?.id ?? null,
      interventionCount: episode ? episode.interventionCount : null,
    }
  },
}

/**
 * Przeliczenie licznika interwencji z tabeli.
 *
 * Istnieje, bo denormalizacja bez drogi powrotnej jest długiem, który ktoś
 * kiedyś spłaci ręcznym UPDATE-em o drugiej w nocy. Komenda nie kasuje
 * niczego — ustawia licznik na to, co mówi tabela interwencji, i zwraca listę
 * epizodów, które się rozjechały, żeby dało się o tym powiedzieć wprost.
 */
export const reconcileCountsSchema = scoped.extend({
  robotId: z.string().uuid().optional(),
})

const reconcileCountsCommand: CommandHandler<
  z.infer<typeof reconcileCountsSchema>,
  { checked: number; corrected: number; corrections: Array<{ episodeId: string; was: number; is: number }> }
> = {
  id: 'episodes.episodes.reconcile_counts',
  async execute(rawInput, ctx) {
    const input = reconcileCountsSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)

    const rows = await em.getConnection().execute<Array<{ id: string; stored: number; actual: number }>>(
      `select e.id, e.intervention_count as stored,
              (select count(*) from episodes_interventions i where i.episode_id = e.id) as actual
         from episodes_episodes e
        where e.tenant_id = ?
          and (? is null or e.robot_id = ?::uuid)`,
      [input.tenantId, input.robotId ?? null, input.robotId ?? null],
    )

    const corrections: Array<{ episodeId: string; was: number; is: number }> = []
    for (const row of rows) {
      const stored = Number(row.stored)
      const actual = Number(row.actual)
      if (stored === actual) continue
      corrections.push({ episodeId: row.id, was: stored, is: actual })
      // Celowany UPDATE jednego wiersza, nie masowy przelicz-wszystko.
      await em.getConnection().execute(
        `update episodes_episodes set intervention_count = ?, updated_at = now() where id = ?`,
        [actual, row.id],
      )
    }

    // Emitujemy tylko, gdy coś naprawdę było do poprawienia. Przebieg
    // kontrolny bez rozjazdu jest brakiem newsa i nie zasługuje na zdarzenie.
    if (corrections.length > 0) {
      await emitEpisodesEvent('episodes.counts.corrected', {
        organizationId: input.organizationId,
        tenantId: input.tenantId,
        checked: rows.length,
        corrected: corrections.length,
      })
    }

    return { checked: rows.length, corrected: corrections.length, corrections }
  },
}

registerCommand(recordEpisodeCommand)
registerCommand(recordInterventionCommand)
registerCommand(reconcileCountsCommand)

export { recordEpisodeCommand, recordInterventionCommand, reconcileCountsCommand }
