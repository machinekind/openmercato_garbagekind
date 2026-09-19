import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import { registerCommand, type CommandHandler } from '@open-mercato/shared/lib/commands'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import {
  GateEvaluation,
  Rollout,
  RolloutStage,
  StageMember,
  type RolloutMode,
  type RolloutStatus,
  type StageStatus,
} from '../data/entities'
import { DEFAULT_THRESHOLDS, SEVERE_KINDS, evaluateGate, stagesToHalt } from '../lib/gate'
import { emitRolloutEvent } from '../events'

/**
 * Komendy wdrożeń etapowych.
 *
 * Najważniejsza jest `rollout.gates.evaluate`: to ona zatrzymuje etapy
 * następne i wycofuje bieżący **bez udziału człowieka**. Wycofanie idzie
 * komendą `deployment.assignments.assign`, a nie zapisem do tabeli wdrożeń —
 * inaczej stan pożądany w hali rozjechałby się ze stanem wdrożenia w panelu,
 * czyli dokładnie tam, gdzie takiego rozjazdu być nie może.
 */

const scoped = z.object({
  organizationId: z.string().uuid(),
  tenantId: z.string().uuid(),
})

const thresholdSchema = z.object({
  minEpisodes: z.number().int().positive().default(DEFAULT_THRESHOLDS.minEpisodes),
  maxInterventionRate: z.number().min(0).max(1).default(DEFAULT_THRESHOLDS.maxInterventionRate),
  maxSevereRate: z.number().min(0).max(1).default(DEFAULT_THRESHOLDS.maxSevereRate),
  minSuccessRate: z.number().min(0).max(1).default(DEFAULT_THRESHOLDS.minSuccessRate),
})

export const planSchema = scoped.extend({
  name: z.string().trim().min(1).max(191),
  policyVersionId: z.string().uuid(),
  mode: z.enum(['shadow', 'active']).default('active'),
  stages: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(191),
        robotIds: z.array(z.string().uuid()).min(1),
        thresholds: thresholdSchema.partial().optional(),
      }),
    )
    .min(1),
})

export const startStageSchema = scoped.extend({
  stageId: z.string().uuid(),
})

export const evaluateSchema = scoped.extend({
  stageId: z.string().uuid(),
  /** Podpis człowieka, gdy bramę ocenia ktoś ręcznie. Puste znaczy: automat. */
  actorUserId: z.string().uuid().nullable().optional(),
})

export type PlanInput = z.infer<typeof planSchema>
export type StartStageInput = z.infer<typeof startStageSchema>
export type EvaluateInput = z.infer<typeof evaluateSchema>

function resolveEm(ctx: { container: { resolve: (key: string) => unknown } }): EntityManager {
  return (ctx.container.resolve('em') as EntityManager).fork()
}

const planCommand: CommandHandler<PlanInput, { rolloutId: string; stageIds: string[] }> = {
  id: 'rollout.rollouts.plan',
  async execute(rawInput, ctx) {
    const input = planSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)

    const versions = await em.getConnection().execute<Array<{ id: string; status: string }>>(
      `select id, status from policy_registry_policy_versions where id = ? and tenant_id = ? limit 1`,
      [input.policyVersionId, input.tenantId],
    )
    if (!versions?.length) throw new Error(`Wersja polityki ${input.policyVersionId} nie istnieje.`)

    /**
     * Ten sam robot nie może być w dwóch etapach tego samego wdrożenia.
     *
     * Nie jest to ochrona przed literówką: robot w etapie pierwszym i trzecim
     * sprawiłby, że wycofanie etapu pierwszego zdjęłoby politykę maszynie,
     * która właśnie zbiera dane dla etapu trzeciego — i brama etapu trzeciego
     * orzekałaby o populacji, której nie ma.
     */
    const seen = new Set<string>()
    for (const stage of input.stages) {
      for (const robotId of stage.robotIds) {
        if (seen.has(robotId)) {
          throw new Error(`Robot ${robotId} występuje w więcej niż jednym etapie tego wdrożenia.`)
        }
        seen.add(robotId)
      }
    }

    const rollout = em.create(Rollout, {
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      name: input.name,
      policyVersionId: input.policyVersionId,
      mode: input.mode as RolloutMode,
      status: 'planned' as RolloutStatus,
      createdBy: ctx.auth?.sub ?? null,
    } as never)

    // Identyfikator nadaje baza — etapy muszą mieć na co wskazać.
    em.persist(rollout)
    await em.flush()
    const rolloutId = (rollout as unknown as { id: string }).id

    const stageIds: string[] = []
    for (let index = 0; index < input.stages.length; index += 1) {
      const definition = input.stages[index]
      const thresholds = { ...DEFAULT_THRESHOLDS, ...(definition.thresholds ?? {}) }

      const stage = em.create(RolloutStage, {
        organizationId: input.organizationId,
        tenantId: input.tenantId,
        rolloutId,
        ordinal: index + 1,
        name: definition.name,
        status: 'pending' as StageStatus,
        minEpisodes: thresholds.minEpisodes,
        maxInterventionRate: String(thresholds.maxInterventionRate),
        maxSevereRate: String(thresholds.maxSevereRate),
        minSuccessRate: String(thresholds.minSuccessRate),
      } as never)
      em.persist(stage)
      await em.flush()

      const stageId = (stage as unknown as { id: string }).id
      stageIds.push(stageId)

      for (const robotId of definition.robotIds) {
        /**
         * Poprzednia wersja polityki zapisywana **teraz**, przy planowaniu.
         *
         * Nie w chwili wycofania: wycofanie dzieje się wtedy, gdy coś się pali,
         * i nie może zależeć od zapytania, które akurat wtedy zwróci co innego.
         */
        const previous = await em.getConnection().execute<Array<{ policy_version_id: string }>>(
          `select policy_version_id from deployment_assignments
            where tenant_id = ? and robot_id = ? and superseded_at is null and revoked_at is null
            limit 1`,
          [input.tenantId, robotId],
        )
        em.persist(
          em.create(StageMember, {
            organizationId: input.organizationId,
            tenantId: input.tenantId,
            stageId,
            robotId,
            previousPolicyVersionId: previous?.[0]?.policy_version_id ?? null,
          } as never),
        )
      }
      await em.flush()
    }

    await emitRolloutEvent('rollout.rollout.planned', {
      id: rolloutId,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      name: input.name,
      policyVersionId: input.policyVersionId,
      mode: input.mode,
      stageCount: stageIds.length,
    })

    return { rolloutId, stageIds }
  },
}

type StageRow = {
  id: string
  rollout_id: string
  ordinal: number
  status: StageStatus
  min_episodes: number
  max_intervention_rate: string
  max_severe_rate: string
  min_success_rate: string
  policy_version_id: string
  rollout_status: RolloutStatus
  mode: RolloutMode
}

async function loadStage(em: EntityManager, stageId: string, tenantId: string): Promise<StageRow | null> {
  const rows = await em.getConnection().execute<StageRow[]>(
    `select s.id, s.rollout_id, s.ordinal, s.status, s.min_episodes, s.max_intervention_rate,
            s.max_severe_rate, s.min_success_rate,
            r.policy_version_id, r.status as rollout_status, r.mode
       from rollout_stages s
       join rollout_rollouts r on r.id = s.rollout_id
      where s.id = ? and s.tenant_id = ? limit 1`,
    [stageId, tenantId],
  )
  return rows?.length ? rows[0] : null
}

const startStageCommand: CommandHandler<
  StartStageInput,
  { stageId: string; applied: number; skipped: Array<{ robotId: string; reason: string }> }
> = {
  id: 'rollout.stages.start',
  async execute(rawInput, ctx) {
    const input = startStageSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)
    const bus = ctx.container.resolve('commandBus') as CommandBus

    const row = await loadStage(em, input.stageId, input.tenantId)
    if (!row) throw new Error(`Etap ${input.stageId} nie istnieje.`)
    if (row.status !== 'pending') throw new Error(`Etap jest w stanie ${row.status}, a nie oczekującym.`)
    if (row.rollout_status === 'halted' || row.rollout_status === 'rolled_back') {
      // To jest druga połowa zdania „przekroczenie progu zatrzymuje etap 2":
      // wstrzymane wdrożenie nie daje się wystartować dalej, nawet ręcznie.
      throw new Error(`Wdrożenie jest w stanie ${row.rollout_status} — etapu nie da się uruchomić.`)
    }

    const previousStages = await em.getConnection().execute<Array<{ ordinal: number; status: string; name: string }>>(
      `select ordinal, status, name from rollout_stages
        where rollout_id = ? and ordinal < ? order by ordinal`,
      [row.rollout_id, row.ordinal],
    )
    const unfinished = previousStages.find((stage) => stage.status !== 'passed')
    if (unfinished) {
      throw new Error(
        `Etap ${unfinished.ordinal} („${unfinished.name}") jest w stanie ${unfinished.status} — etapowość nie jest opcjonalna.`,
      )
    }

    const members = await em.getConnection().execute<Array<{ id: string; robot_id: string }>>(
      `select id, robot_id from rollout_stage_members where stage_id = ? and rolled_back_at is null`,
      [input.stageId],
    )

    let applied = 0
    const skipped: Array<{ robotId: string; reason: string }> = []

    for (const member of members) {
      try {
        await bus.execute('deployment.assignments.assign', {
          input: {
            organizationId: input.organizationId,
            tenantId: input.tenantId,
            robotId: member.robot_id,
            policyVersionId: row.policy_version_id,
            reason: `Wdrożenie etapowe, etap ${row.ordinal}`,
          },
          ctx,
        })
        await em.getConnection().execute(
          `update rollout_stage_members set applied_at = now() where id = ?`,
          [member.id],
        )
        applied += 1
      } catch (error) {
        /**
         * Robot, którego nie da się objąć etapem, nie zatrzymuje etapu.
         *
         * Powód dziedzinowy: maszyna w serwisie albo z wygasłą kalibracją
         * jest normalnym stanem floty, a wdrożenie, które wywraca się na
         * pierwszym takim robocie, nie ruszy nigdy. Pominięcia lądują
         * w wyniku komendy i w dzienniku, więc nikną cicho tylko wtedy,
         * gdy nikt nie czyta.
         */
        skipped.push({ robotId: member.robot_id, reason: error instanceof Error ? error.message : String(error) })
      }
    }

    await em.getConnection().execute(
      `update rollout_stages set status = 'running', started_at = now(), updated_at = now() where id = ?`,
      [input.stageId],
    )
    await em.getConnection().execute(
      `update rollout_rollouts
          set status = 'running',
              started_at = coalesce(started_at, now()),
              updated_at = now()
        where id = ?`,
      [row.rollout_id],
    )

    await emitRolloutEvent('rollout.stage.started', {
      id: input.stageId,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      rolloutId: row.rollout_id,
      // Liczba pominiętych jedzie w ładunku celowo: etap, w którym pominięto
      // połowę floty, ma w statusie to samo słowo `running` co etap udany.
      applied,
      skipped: skipped.length,
    })

    return { stageId: input.stageId, applied, skipped }
  },
}

export type EvaluateResult = {
  stageId: string
  decision: string
  reason: string
  measured: { episodes: number; interventionRate: number; severeRate: number; successRate: number }
  haltedStages: number
  rolledBackRobots: number
}

/**
 * Ocena bramy — serce fazy.
 *
 * Liczby bierzemy z księgi epizodów (moduł `episodes`) surowym SQL-em, tak samo
 * jak rejestr polityk czyta rewizje embodimentu. Liczymy je **dla populacji
 * etapu i dla okresu od jego uruchomienia**: epizody sprzed wdrożenia dotyczą
 * poprzedniej wersji polityki i wliczenie ich rozcieńczyłoby dokładnie ten
 * sygnał, który brama ma wyłapać.
 */
const evaluateGateCommand: CommandHandler<EvaluateInput, EvaluateResult> = {
  id: 'rollout.gates.evaluate',
  async execute(rawInput, ctx) {
    const input = evaluateSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)
    const bus = ctx.container.resolve('commandBus') as CommandBus

    const row = await loadStage(em, input.stageId, input.tenantId)
    if (!row) throw new Error(`Etap ${input.stageId} nie istnieje.`)
    if (row.status !== 'running') throw new Error(`Etap jest w stanie ${row.status} — brama ocenia tylko etapy w biegu.`)

    const severeList = SEVERE_KINDS.map((k) => `'${k}'`).join(', ')
    const statsRows = await em.getConnection().execute<Array<{
      episodes: string
      intervened: string
      severe: string
      successes: string
    }>>(
      `with populacja as (
          select m.robot_id from rollout_stage_members m
           where m.stage_id = ? and m.rolled_back_at is null
       ),
       okno as (
          select coalesce(started_at, now()) as od from rollout_stages where id = ?
       ),
       ep as (
          select e.id, e.outcome, e.intervention_count
            from episodes_episodes e
            join populacja p on p.robot_id = e.robot_id
            cross join okno
           where e.tenant_id = ?
             and e.policy_version_id = ?
             and e.started_at >= okno.od
       )
       select (select count(*) from ep) as episodes,
              (select count(*) from ep where intervention_count > 0) as intervened,
              (select count(*) from episodes_interventions i
                 join ep on ep.id = i.episode_id
                where i.kind in (${severeList})) as severe,
              (select count(*) from ep where outcome = 'success') as successes`,
      [input.stageId, input.stageId, input.tenantId, row.policy_version_id],
    )

    const stats = {
      episodes: Number(statsRows[0]?.episodes ?? 0),
      intervenedEpisodes: Number(statsRows[0]?.intervened ?? 0),
      severeInterventions: Number(statsRows[0]?.severe ?? 0),
      successes: Number(statsRows[0]?.successes ?? 0),
    }

    const verdict = evaluateGate(stats, {
      minEpisodes: Number(row.min_episodes),
      maxInterventionRate: Number(row.max_intervention_rate),
      maxSevereRate: Number(row.max_severe_rate),
      minSuccessRate: Number(row.min_success_rate),
    })

    em.persist(
      em.create(GateEvaluation, {
        organizationId: input.organizationId,
        tenantId: input.tenantId,
        rolloutId: row.rollout_id,
        stageId: input.stageId,
        decision: verdict.decision,
        reason: verdict.reason,
        episodes: verdict.measured.episodes,
        interventionRate: verdict.measured.interventionRate.toFixed(6),
        severeRate: verdict.measured.severeRate.toFixed(6),
        successRate: verdict.measured.successRate.toFixed(6),
        breached: verdict.breached.length ? verdict.breached : null,
        actorUserId: input.actorUserId ?? null,
      } as never),
    )
    await em.flush()

    let haltedStages = 0
    let rolledBackRobots = 0

    if (verdict.decision === 'advance') {
      await em.getConnection().execute(
        `update rollout_stages set status = 'passed', finished_at = now(), updated_at = now() where id = ?`,
        [input.stageId],
      )
      const remaining = await em.getConnection().execute<Array<{ n: string }>>(
        `select count(*) as n from rollout_stages where rollout_id = ? and status <> 'passed'`,
        [row.rollout_id],
      )
      if (Number(remaining[0].n) === 0) {
        await em.getConnection().execute(
          `update rollout_rollouts set status = 'completed', finished_at = now(), updated_at = now() where id = ?`,
          [row.rollout_id],
        )
      }
    }

    if (verdict.decision === 'rollback') {
      // 1. Wszystkie etapy następne — nie tylko kolejny. Wdrożenie
      //    pięcioetapowe, w którym po wycofaniu etapu 1 rusza etap 3,
      //    jest wdrożeniem jednoetapowym z opóźnieniem.
      const allStages = await em.getConnection().execute<Array<{ id: string; ordinal: number; status: string }>>(
        `select id, ordinal, status from rollout_stages where rollout_id = ? order by ordinal`,
        [row.rollout_id],
      )
      const toHalt = stagesToHalt(
        allStages.map((s) => ({ id: s.id, ordinal: Number(s.ordinal), status: s.status })),
        Number(row.ordinal),
      )
      for (const stage of toHalt) {
        await em.getConnection().execute(
          `update rollout_stages set status = 'halted', updated_at = now() where id = ?`,
          [stage.id],
        )
        haltedStages += 1
      }

      // 2. Wycofanie bieżącego etapu — przez komendę stanu pożądanego,
      //    nie przez zapis do tabeli wdrożeń.
      const members = await em.getConnection().execute<Array<{
        id: string
        robot_id: string
        previous_policy_version_id: string | null
      }>>(
        `select id, robot_id, previous_policy_version_id from rollout_stage_members
          where stage_id = ? and rolled_back_at is null and applied_at is not null`,
        [input.stageId],
      )

      for (const member of members) {
        if (member.previous_policy_version_id) {
          await bus.execute('deployment.assignments.assign', {
            input: {
              organizationId: input.organizationId,
              tenantId: input.tenantId,
              robotId: member.robot_id,
              policyVersionId: member.previous_policy_version_id,
              reason: `Wycofanie etapu ${row.ordinal}: ${verdict.reason}`,
            },
            ctx,
          })
        } else {
          /**
           * Robot bez wcześniejszej polityki wraca do stanu „bez polityki".
           *
           * Odwołanie przypisania, nie przypisanie czegokolwiek innego:
           * podstawienie „jakiejś" wersji byłoby wdrożeniem wykonanym
           * w panice, czyli dokładnie tym, czemu wycofanie ma zapobiegać.
           */
          const current = await em.getConnection().execute<Array<{ id: string }>>(
            `select id from deployment_assignments
              where tenant_id = ? and robot_id = ? and superseded_at is null and revoked_at is null limit 1`,
            [input.tenantId, member.robot_id],
          )
          if (current?.length) {
            await bus.execute('deployment.assignments.revoke', {
              input: {
                organizationId: input.organizationId,
                tenantId: input.tenantId,
                assignmentId: current[0].id,
                reason: `Wycofanie etapu ${row.ordinal}: ${verdict.reason}`,
              },
              ctx,
            })
          }
        }
        await em.getConnection().execute(
          `update rollout_stage_members set rolled_back_at = now() where id = ?`,
          [member.id],
        )
        rolledBackRobots += 1
      }

      await em.getConnection().execute(
        `update rollout_stages set status = 'rolled_back', finished_at = now(), updated_at = now() where id = ?`,
        [input.stageId],
      )
      await em.getConnection().execute(
        `update rollout_rollouts set status = 'rolled_back', status_reason = ?, finished_at = now(), updated_at = now() where id = ?`,
        [verdict.reason, row.rollout_id],
      )
    }

    const wspólne = {
      id: input.stageId,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      rolloutId: row.rollout_id,
      reason: verdict.reason,
      measured: verdict.measured as unknown as Record<string, unknown>,
    }
    if (verdict.decision === 'advance') {
      await emitRolloutEvent('rollout.gate.advanced', wspólne)
    } else if (verdict.decision === 'hold') {
      await emitRolloutEvent('rollout.gate.held', wspólne)
    } else if (verdict.decision === 'rollback') {
      await emitRolloutEvent('rollout.gate.rolled_back', {
        ...wspólne,
        haltedStages,
        rolledBackRobots,
      })
    }

    return {
      stageId: input.stageId,
      decision: verdict.decision,
      reason: verdict.reason,
      measured: verdict.measured,
      haltedStages,
      rolledBackRobots,
    }
  },
}

registerCommand(planCommand)
registerCommand(startStageCommand)
registerCommand(evaluateGateCommand)

export { planCommand, startStageCommand, evaluateGateCommand }
