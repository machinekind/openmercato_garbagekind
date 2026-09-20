import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import { registerCommand, type CommandHandler } from '@open-mercato/shared/lib/commands'
import { Dataset, DatasetMember, DatasetVersion, TrainingRun, type MemberRole } from '../data/entities'
import {
  composition,
  contentDigest,
  roleFor,
  warnings,
  type EpisodeCandidate,
} from '../lib/lineage'
import { emitDatasetsEvent } from '../events'

/**
 * Komendy zbiorów danych.
 *
 * `datasets.versions.build` buduje wersję **z księgi epizodów**, a nie
 * z przesłanej listy. To jest decyzja: wersja zbudowana z listy podanej przez
 * wołającego byłaby zapisem tego, co ktoś twierdzi, że wziął. Budowanie
 * z kryteriów po stronie serwera sprawia, że skład zbioru jest funkcją księgi
 * i da się go odtworzyć - a to jest warunek zdania „wiadomo, z czego powstał".
 */

const scoped = z.object({
  organizationId: z.string().uuid(),
  tenantId: z.string().uuid(),
})

export const datasetDefineSchema = scoped.extend({
  datasetKey: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Klucz zbioru: małe litery, cyfry, kropka, myślnik, podkreślenie.'),
  name: z.string().trim().min(1).max(191),
  taskKey: z.string().trim().min(1).max(120),
  embodimentKey: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
})

export const versionBuildSchema = scoped.extend({
  datasetId: z.string().uuid(),
  /** Kryteria wyboru epizodów z księgi. Zapisywane przy wersji, żeby dało się ją odtworzyć. */
  criteria: z
    .object({
      policyVersionIds: z.array(z.string().uuid()).optional(),
      cellIds: z.array(z.string().uuid()).optional(),
      taskKey: z.string().trim().max(120).optional(),
      since: z.coerce.date().optional(),
      until: z.coerce.date().optional(),
      /** Udział epizodów odkładanych na ewaluację, wybieranych deterministycznie. */
      holdoutRatio: z.number().min(0).max(0.5).default(0.2),
      limit: z.number().int().positive().max(100_000).optional(),
    })
    .default({ holdoutRatio: 0.2 }),
  exportUri: z.string().trim().max(1000).optional(),
})

export const runRegisterSchema = scoped.extend({
  datasetVersionId: z.string().uuid(),
  runRef: z.string().trim().min(1).max(191),
  framework: z.string().trim().max(120).optional(),
  hyperparameters: z.record(z.string(), z.unknown()).optional(),
  startedAt: z.coerce.date().optional(),
})

export const runCompleteSchema = scoped.extend({
  runRef: z.string().trim().min(1).max(191),
  status: z.enum(['succeeded', 'failed']),
  policyVersionId: z.string().uuid().nullable().optional(),
})

export type DatasetDefineInput = z.infer<typeof datasetDefineSchema>
export type VersionBuildInput = z.infer<typeof versionBuildSchema>
export type RunRegisterInput = z.infer<typeof runRegisterSchema>
export type RunCompleteInput = z.infer<typeof runCompleteSchema>

function resolveEm(ctx: { container: { resolve: (key: string) => unknown } }): EntityManager {
  return (ctx.container.resolve('em') as EntityManager).fork()
}

const defineDatasetCommand: CommandHandler<DatasetDefineInput, { datasetId: string }> = {
  id: 'datasets.datasets.define',
  async execute(rawInput, ctx) {
    const input = datasetDefineSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)

    const existing = (await em.findOne(Dataset, {
      tenantId: input.tenantId,
      datasetKey: input.datasetKey,
    } as never)) as unknown as { id: string } | null
    if (existing) return { datasetId: existing.id }

    const dataset = em.create(Dataset, {
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      datasetKey: input.datasetKey,
      name: input.name,
      taskKey: input.taskKey,
      embodimentKey: input.embodimentKey,
      description: input.description ?? null,
    } as never)
    em.persist(dataset)
    await em.flush()
    const datasetId = (dataset as unknown as { id: string }).id
    await emitDatasetsEvent('datasets.dataset.defined', {
      id: datasetId,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      datasetKey: input.datasetKey,
      taskKey: input.taskKey,
      embodimentKey: input.embodimentKey,
    })

    return { datasetId }
  },
}

export type VersionBuildResult = {
  datasetVersionId: string
  version: number
  contentDigest: string
  episodeCount: number
  warnings: Array<{ code: string; message: string }>
  /** `true`, gdy ten sam zestaw epizodów już istniał jako wersja. */
  deduplicated: boolean
}

/**
 * Deterministyczny wybór części ewaluacyjnej.
 *
 * Losowanie `Math.random()` dałoby przy każdym budowaniu inny podział i dwa
 * przebiegi z tych samych kryteriów byłyby dwiema różnymi wersjami zbioru -
 * co unieważniłoby deduplikację po odcisku zawartości. Podział liczony
 * z identyfikatora epizodu jest stabilny i odtwarzalny.
 */
function isHoldout(episodeId: string, ratio: number): boolean {
  if (ratio <= 0) return false
  let hash = 0
  for (let index = 0; index < episodeId.length; index += 1) {
    hash = (hash * 31 + episodeId.charCodeAt(index)) >>> 0
  }
  return (hash % 1000) / 1000 < ratio
}

const buildVersionCommand: CommandHandler<VersionBuildInput, VersionBuildResult> = {
  id: 'datasets.versions.build',
  async execute(rawInput, ctx) {
    const input = versionBuildSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)

    const dataset = (await em.findOne(Dataset, {
      id: input.datasetId,
      tenantId: input.tenantId,
      deletedAt: null,
    } as never)) as unknown as { id: string; taskKey: string; embodimentKey: string } | null
    if (!dataset) throw new Error(`Zbiór ${input.datasetId} nie istnieje.`)

    const criteria = input.criteria
    const conditions: string[] = ['e.tenant_id = ?']
    const params: unknown[] = [input.tenantId]

    /**
     * Epizody ograniczone do rewizji embodimentu z rodziny zadeklarowanej przy
     * zbiorze.
     *
     * Zbiór zebrany na jednym sprzęcie nie jest zbiorem dla innego. Filtr jest
     * tutaj, a nie w kryteriach wołającego, bo to nie jest preferencja -
     * to jest warunek sensowności zbioru.
     */
    conditions.push(
      `exists (select 1 from fleet_robots r
                 join fleet_embodiment_revisions er on er.id = r.embodiment_revision_id
                where r.id = e.robot_id and er.embodiment_key = ?)`,
    )
    params.push(dataset.embodimentKey)

    conditions.push('e.task_key = ?')
    params.push(criteria.taskKey ?? dataset.taskKey)

    if (criteria.policyVersionIds?.length) {
      conditions.push(`e.policy_version_id = any(?::uuid[])`)
      params.push(criteria.policyVersionIds)
    }
    if (criteria.cellIds?.length) {
      conditions.push(`e.cell_id = any(?::uuid[])`)
      params.push(criteria.cellIds)
    }
    if (criteria.since) {
      conditions.push('e.started_at >= ?')
      params.push(criteria.since)
    }
    if (criteria.until) {
      conditions.push('e.started_at <= ?')
      params.push(criteria.until)
    }

    const limit = criteria.limit ? ` limit ${Number(criteria.limit)}` : ''
    const rows = await em.getConnection().execute<Array<{
      id: string
      outcome: string
      intervention_count: number
      policy_version_id: string | null
      cell_class: string | null
    }>>(
      `select e.id, e.outcome, e.intervention_count, e.policy_version_id, c.cell_class
         from episodes_episodes e
         left join fleet_cells c on c.id = e.cell_id
        where ${conditions.join(' and ')}
        order by e.robot_id, e.sequence${limit}`,
      params,
    )

    if (!rows.length) throw new Error('Kryteria nie wybrały ani jednego epizodu z księgi.')

    const members = rows.map((row) => {
      const candidate: EpisodeCandidate = {
        episodeId: row.id,
        outcome: row.outcome as EpisodeCandidate['outcome'],
        interventionCount: Number(row.intervention_count),
        policyVersionId: row.policy_version_id,
        cellClass: row.cell_class,
      }
      /**
       * Część ewaluacyjna wydzielana **przed** przypisaniem roli treningowej.
       *
       * Epizod odłożony na ewaluację nie może jednocześnie być demonstracją
       * treningową; gdyby mógł, wynik na części wydzielonej przestałby cokolwiek
       * mówić o wdrożeniu.
       */
      const role: MemberRole = isHoldout(row.id, criteria.holdoutRatio) ? 'holdout' : roleFor(candidate)
      return { episodeId: row.id, role }
    })

    const digest = contentDigest(members)

    const duplicate = (await em.findOne(DatasetVersion, {
      tenantId: input.tenantId,
      datasetId: input.datasetId,
      contentDigest: digest,
    } as never)) as unknown as { id: string; version: number; episodeCount: number } | null

    if (duplicate) {
      // Powtórka nie jest błędem: przebudowanie z tych samych kryteriów
      // nad niezmienioną księgą ma dać tę samą wersję, a nie kolejną.
      return {
        datasetVersionId: duplicate.id,
        version: Number(duplicate.version),
        contentDigest: digest,
        episodeCount: Number(duplicate.episodeCount),
        warnings: [],
        deduplicated: true,
      }
    }

    const maxRows = await em.getConnection().execute<Array<{ max: number | null }>>(
      `select max(version) as max from datasets_versions where tenant_id = ? and dataset_id = ?`,
      [input.tenantId, input.datasetId],
    )
    const nextVersion = Number(maxRows?.[0]?.max ?? 0) + 1

    const comp = composition(members)
    const composed = warnings(comp)

    const versionRow = em.create(DatasetVersion, {
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      datasetId: input.datasetId,
      version: nextVersion,
      contentDigest: digest,
      episodeCount: comp.total,
      demoCount: comp.byRole.demo,
      correctionCount: comp.byRole.correction,
      failureCount: comp.byRole.failure,
      holdoutCount: comp.byRole.holdout,
      warnings: composed.length ? composed : null,
      criteria: criteria as unknown as Record<string, unknown>,
      exportUri: input.exportUri ?? null,
      builtBy: ctx.auth?.sub ?? null,
    } as never)

    // Dwa zrzuty: identyfikator wersji nadaje baza, a skład musi mieć na co wskazać.
    em.persist(versionRow)
    await em.flush()
    const datasetVersionId = (versionRow as unknown as { id: string }).id

    for (const member of members) {
      em.persist(
        em.create(DatasetMember, {
          organizationId: input.organizationId,
          tenantId: input.tenantId,
          datasetVersionId,
          episodeId: member.episodeId,
          role: member.role,
        } as never),
      )
    }
    await em.flush()

    /*
     * Wyjście deduplikacyjne wyżej nie emituje: ten sam odcisk treści to ta
     * sama wersja zbioru. Przebudowa z niezmienionych kryteriów nad
     * niezmienioną księgą nie jest nowym faktem.
     */
    await emitDatasetsEvent('datasets.version.built', {
      id: datasetVersionId,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      datasetId: input.datasetId,
      version: nextVersion,
      contentDigest: digest,
      episodeCount: comp.total,
      // Ostrzeżenia o składzie, nie sam licznik: zbiór z samych udanych
      // epizodów ma ten sam `episodeCount` co zbiór zrównoważony.
      warnings: composed,
    })

    return {
      datasetVersionId,
      version: nextVersion,
      contentDigest: digest,
      episodeCount: comp.total,
      warnings: composed,
      deduplicated: false,
    }
  },
}

const registerRunCommand: CommandHandler<RunRegisterInput, { trainingRunId: string; duplicate: boolean }> = {
  id: 'datasets.runs.register',
  async execute(rawInput, ctx) {
    const input = runRegisterSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)

    const version = (await em.findOne(DatasetVersion, {
      id: input.datasetVersionId,
      tenantId: input.tenantId,
    } as never)) as unknown as { id: string } | null
    if (!version) throw new Error(`Wersja zbioru ${input.datasetVersionId} nie istnieje.`)

    const existing = (await em.findOne(TrainingRun, {
      tenantId: input.tenantId,
      runRef: input.runRef,
    } as never)) as unknown as { id: string } | null
    if (existing) return { trainingRunId: existing.id, duplicate: true }

    const run = em.create(TrainingRun, {
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      datasetVersionId: input.datasetVersionId,
      runRef: input.runRef,
      framework: input.framework ?? null,
      hyperparameters: input.hyperparameters ?? null,
      status: 'running',
      startedAt: input.startedAt ?? new Date(),
    } as never)
    em.persist(run)
    await em.flush()

    const trainingRunId = (run as unknown as { id: string }).id
    await emitDatasetsEvent('datasets.run.registered', {
      id: trainingRunId,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      datasetVersionId: input.datasetVersionId,
      runRef: input.runRef,
      framework: input.framework ?? null,
    })

    return { trainingRunId, duplicate: false }
  },
}

/**
 * Domknięcie przebiegu treningowego - moment, w którym pętla się zamyka.
 *
 * Dopiero tutaj powstaje wiązanie wersja zbioru ↔ wersja polityki. Wiązanie
 * zapisywane przy rejestracji przebiegu byłoby wiązaniem z polityką, której
 * jeszcze nie ma; wiązanie zapisywane przy rejestracji wersji polityki
 * wymagałoby, żeby rejestr polityk wiedział o zbiorach.
 */
const completeRunCommand: CommandHandler<
  RunCompleteInput,
  { trainingRunId: string; status: string; policyVersionId: string | null }
> = {
  id: 'datasets.runs.complete',
  async execute(rawInput, ctx) {
    const input = runCompleteSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)

    const run = (await em.findOne(TrainingRun, {
      tenantId: input.tenantId,
      runRef: input.runRef,
    } as never)) as unknown as {
      id: string
      status: string
      datasetVersionId: string
      policyVersionId?: string | null
      finishedAt?: Date | null
    } | null
    if (!run) throw new Error(`Przebieg treningowy ${input.runRef} nie istnieje.`)
    if (run.status !== 'running') throw new Error(`Przebieg jest już w stanie ${run.status}.`)

    if (input.status === 'succeeded' && !input.policyVersionId) {
      // Przebieg udany bez wskazanej wersji polityki jest dziurą w pętli:
      // zbiór byłby wtedy źródłem czegoś, czego nie da się wskazać.
      throw new Error('Przebieg zakończony sukcesem musi wskazać wersję polityki, która z niego powstała.')
    }

    if (input.policyVersionId) {
      const rows = await em.getConnection().execute<Array<{ id: string }>>(
        `select id from policy_registry_policy_versions where id = ? and tenant_id = ? limit 1`,
        [input.policyVersionId, input.tenantId],
      )
      if (!rows?.length) throw new Error(`Wersja polityki ${input.policyVersionId} nie istnieje.`)
    }

    run.status = input.status
    run.policyVersionId = input.policyVersionId ?? null
    run.finishedAt = new Date()
    await em.flush()

    await emitDatasetsEvent('datasets.run.completed', {
      id: run.id,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      runRef: input.runRef,
      status: input.status,
      datasetVersionId: run.datasetVersionId,
      policyVersionId: run.policyVersionId ?? null,
    })

    return { trainingRunId: run.id, status: input.status, policyVersionId: run.policyVersionId ?? null }
  },
}

registerCommand(defineDatasetCommand)
registerCommand(buildVersionCommand)
registerCommand(registerRunCommand)
registerCommand(completeRunCommand)

export { defineDatasetCommand, buildVersionCommand, registerRunCommand, completeRunCommand }
