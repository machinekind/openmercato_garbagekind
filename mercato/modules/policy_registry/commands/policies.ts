import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import { registerCommand, type CommandHandler } from '@open-mercato/shared/lib/commands'
import {
  Policy,
  PolicyArtifact,
  PolicyVersion,
  PolicyVersionEvent,
  type PolicyVersionStatus,
} from '../data/entities'
import { computeContentDigest, validateArtifactSet, type ArtifactInput } from '../lib/digest'
import { checkEmbodimentCompatibility, type EmbodimentContract } from '../lib/compatibility'
import { emitPolicyRegistryEvent } from '../events'

/**
 * Komendy rejestru polityk.
 *
 * Dwie rzeczy, które ten plik ma zagwarantować i które są całą treścią fazy:
 *
 * 1. Wersja nie powstaje dla embodimentu o innym odcisku kontraktu, a odmowa
 *    ma **nazwany powód**, nie „walidacja nie przeszła".
 * 2. Powtórne wgranie tych samych wag nie tworzy drugiej wersji — zwraca
 *    pierwszą i mówi wprost, że to powtórka.
 */

const scoped = z.object({
  organizationId: z.string().uuid(),
  tenantId: z.string().uuid(),
})

const learningMethods = ['rl', 'il', 'offline_rl', 'vla', 'classical'] as const
const artifactRoles = ['weights', 'config', 'preprocessor', 'normalizer', 'metadata'] as const

export const policyRegisterSchema = scoped.extend({
  policyKey: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Klucz polityki: małe litery, cyfry, kropka, myślnik, podkreślenie.'),
  name: z.string().trim().min(1).max(191),
  /**
   * Wymagane, bez wartości domyślnej.
   *
   * To jest zapisana w schemacie wersja zdania „polityka bez zadeklarowanego
   * embodimentu nie daje się zapisać". Wartość domyślna albo pole opcjonalne
   * przeniosłyby tę kontrolę na moment wdrożenia, czyli na moment, w którym
   * robot już stoi i czeka.
   */
  embodimentKey: z.string().trim().min(1).max(120),
  taskKey: z.string().trim().min(1).max(120),
  learningMethod: z.enum(learningMethods).default('rl'),
  description: z.string().trim().max(2000).optional(),
})

const artifactSchema = z.object({
  role: z.enum(artifactRoles),
  digest: z.string().trim().length(64),
  uri: z.string().trim().min(1).max(1000),
  sizeBytes: z.number().int().nonnegative().optional(),
  mediaType: z.string().trim().max(191).optional(),
})

export const versionRegisterSchema = scoped.extend({
  policyId: z.string().uuid(),
  embodimentRevisionId: z.string().uuid(),
  /** Odcisk kontraktu, pod który polityka była uczona — deklarowany, nie odczytywany. */
  declaredSpecDigest: z.string().trim().min(1).max(255),
  artifacts: z.array(artifactSchema).min(1),
  observationDim: z.number().int().positive().optional(),
  actionDim: z.number().int().positive().optional(),
  trainedDofCount: z.number().int().positive().optional(),
  provenance: z.record(z.string(), z.unknown()).optional(),
})

const versionStatuses = ['registered', 'released', 'deprecated'] as const

export const versionTransitionSchema = scoped.extend({
  policyVersionId: z.string().uuid(),
  toStatus: z.enum(versionStatuses),
  reason: z.string().trim().min(1).max(500),
})

export type PolicyRegisterInput = z.infer<typeof policyRegisterSchema>
export type VersionRegisterInput = z.infer<typeof versionRegisterSchema>
export type VersionTransitionInput = z.infer<typeof versionTransitionSchema>

function resolveEm(ctx: { container: { resolve: (key: string) => unknown } }): EntityManager {
  return (ctx.container.resolve('em') as EntityManager).fork()
}

/**
 * Rewizja embodimentu czytana surowym SQL-em, a nie przez encję modułu `fleet`.
 *
 * Decyzja: `policy_registry` zna **tabelę** rejestru floty, ale nie importuje
 * jego klas encji. Import klasy związałby dwa moduły na poziomie metadanych
 * MikroORM (jedna klasa zarejestrowana dwa razy pod dwiema ścieżkami to
 * gwarantowane „Metadata for entity X not found" po stronie, która zgubi
 * kolejność ładowania). Odrzucona alternatywa: wołanie komendy `fleet.*` po
 * odczyt — odrzucona, bo szyna komend jest kanałem zapisu, a odczyt przez nią
 * dokłada warstwę bez żadnej gwarancji w zamian.
 */
async function loadEmbodimentContract(
  em: EntityManager,
  revisionId: string,
  tenantId: string,
): Promise<EmbodimentContract | null> {
  const rows = await em.getConnection().execute<Array<{
    id: string
    embodiment_key: string
    revision: number
    spec_digest: string
    dof_count: number | null
  }>>(
    `select id, embodiment_key, revision, spec_digest, dof_count
       from fleet_embodiment_revisions
      where id = ? and tenant_id = ? and deleted_at is null
      limit 1`,
    [revisionId, tenantId],
  )
  if (!rows?.length) return null
  const row = rows[0]
  return {
    id: row.id,
    embodimentKey: row.embodiment_key,
    revision: Number(row.revision),
    specDigest: row.spec_digest,
    dofCount: row.dof_count == null ? null : Number(row.dof_count),
  }
}

const registerPolicyCommand: CommandHandler<PolicyRegisterInput, { policyId: string }> = {
  id: 'policy_registry.policies.register',
  async execute(rawInput, ctx) {
    const input = policyRegisterSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)

    const existing = await em.findOne(Policy, {
      tenantId: input.tenantId,
      policyKey: input.policyKey,
    } as never)
    if (existing) {
      throw new Error(`Polityka o kluczu ${input.policyKey} już istnieje w tym tenancie.`)
    }

    const policy = em.create(Policy, {
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      policyKey: input.policyKey,
      name: input.name,
      embodimentKey: input.embodimentKey,
      taskKey: input.taskKey,
      learningMethod: input.learningMethod,
      description: input.description ?? null,
    } as never)

    em.persist(policy)
    await em.flush()

    const policyId = (policy as unknown as { id: string }).id
    await emitPolicyRegistryEvent('policy_registry.policy.registered', {
      id: policyId,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      policyKey: input.policyKey,
      name: input.name,
    })

    return { policyId }
  },
}

export type VersionRegisterResult = {
  policyVersionId: string
  version: number
  contentDigest: string
  /** `true`, gdy komplet wag już był zarejestrowany i zwracamy istniejącą wersję. */
  deduplicated: boolean
}

const registerVersionCommand: CommandHandler<VersionRegisterInput, VersionRegisterResult> = {
  id: 'policy_registry.versions.register',
  async execute(rawInput, ctx) {
    const input = versionRegisterSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)

    const policy = (await em.findOne(Policy, {
      id: input.policyId,
      tenantId: input.tenantId,
      deletedAt: null,
    } as never)) as unknown as { id: string; embodimentKey: string } | null
    if (!policy) throw new Error(`Polityka ${input.policyId} nie istnieje w tym tenancie.`)

    // 1. Kontrola kompletu artefaktów PRZED sięgnięciem do embodimentu.
    //    Kolejność jest celowa: komplet bez wag jest błędem wgrywającego,
    //    a rozjazd embodimentu — błędem wdrożeniowym. Pierwszy komunikat
    //    powinien być tym bliższym przyczynie.
    const verdict = validateArtifactSet(input.artifacts as ArtifactInput[])
    if (!verdict.ok) throw new Error(`Komplet artefaktów odrzucony: ${verdict.reason}.`)

    // 2. Zgodność ze sprzętem — nazwany powód odmowy.
    const contract = await loadEmbodimentContract(em, input.embodimentRevisionId, input.tenantId)
    const compatibility = checkEmbodimentCompatibility(contract, {
      policyEmbodimentKey: policy.embodimentKey,
      declaredSpecDigest: input.declaredSpecDigest,
      observationDim: input.observationDim ?? null,
      actionDim: input.actionDim ?? null,
      trainedDofCount: input.trainedDofCount ?? null,
    })
    if (!compatibility.compatible) {
      throw new Error(
        `Nie można zarejestrować wersji [${compatibility.code}]: ${compatibility.reason}.`,
      )
    }

    // 3. Tożsamość = skrót kompletu.
    const contentDigest = computeContentDigest(verdict.normalized)

    const duplicate = (await em.findOne(PolicyVersion, {
      tenantId: input.tenantId,
      policyId: input.policyId,
      contentDigest,
    } as never)) as unknown as { id: string; version: number } | null

    if (duplicate) {
      /**
       * Powtórka nie jest błędem — jest odpowiedzią.
       *
       * Rzucenie wyjątku zmusiłoby każdy potok CI do odróżniania „wgrałem to
       * już wcześniej" od realnej awarii, a w praktyce skończyłoby się
       * połknięciem obu. Zwracamy istniejącą wersję z flagą, żeby wołający
       * mógł to odnotować i iść dalej.
       */
      return {
        policyVersionId: duplicate.id,
        version: Number(duplicate.version),
        contentDigest,
        deduplicated: true,
      }
    }

    // Numer kolejny liczony z bazy, bo jest tylko etykietą; tożsamość niesie skrót.
    const maxRows = await em.getConnection().execute<Array<{ max: number | null }>>(
      `select max(version) as max from policy_registry_policy_versions
        where tenant_id = ? and policy_id = ?`,
      [input.tenantId, input.policyId],
    )
    const nextVersion = Number(maxRows?.[0]?.max ?? 0) + 1

    const version = em.create(PolicyVersion, {
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      policyId: input.policyId,
      version: nextVersion,
      contentDigest,
      embodimentRevisionId: input.embodimentRevisionId,
      embodimentSpecDigest: (contract as EmbodimentContract).specDigest,
      status: 'registered' as PolicyVersionStatus,
      statusReason: 'Rejestracja kompletu artefaktów',
      statusChangedAt: new Date(),
      provenance: input.provenance ?? null,
      observationDim: input.observationDim ?? null,
      actionDim: input.actionDim ?? null,
      registeredBy: ctx.auth?.sub ?? null,
    } as never)

    // Dwa zrzuty: `id` nadaje Postgres przy `flush()`, a artefakty i wpis do
    // dziennika muszą mieć na co wskazać. Generowanie UUID po stronie aplikacji
    // odrzucone — baza zostaje jedynym źródłem tożsamości.
    em.persist(version)
    await em.flush()

    const policyVersionId = (version as unknown as { id: string }).id

    for (const artifact of verdict.normalized) {
      em.persist(
        em.create(PolicyArtifact, {
          organizationId: input.organizationId,
          tenantId: input.tenantId,
          policyVersionId,
          role: artifact.role,
          digest: artifact.digest,
          uri: artifact.uri,
          sizeBytes: artifact.sizeBytes ?? null,
          mediaType: artifact.mediaType ?? null,
        } as never),
      )
    }

    em.persist(
      em.create(PolicyVersionEvent, {
        organizationId: input.organizationId,
        tenantId: input.tenantId,
        policyVersionId,
        fromStatus: null,
        toStatus: 'registered' as PolicyVersionStatus,
        reason: 'Rejestracja kompletu artefaktów',
        actorUserId: ctx.auth?.sub ?? null,
      } as never),
    )
    await em.flush()

    /*
     * Emitujemy wyłącznie na ścieżce nowej wersji. Wyjście deduplikacyjne
     * wyżej nie nadaje niczego i tak ma zostać: ten sam odcisk treści to ten
     * sam fakt, a zdarzenie powtórzone przy każdym ponownym wgraniu z CI
     * uruchamiałoby automatyzacje drugi raz na tej samej wersji.
     */
    await emitPolicyRegistryEvent('policy_registry.version.registered', {
      id: policyVersionId,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      policyId: input.policyId,
      version: nextVersion,
      contentDigest,
      embodimentRevisionId: input.embodimentRevisionId,
      declaredSpecDigest: input.declaredSpecDigest,
    })

    return { policyVersionId, version: nextVersion, contentDigest, deduplicated: false }
  },
}

/**
 * Przejścia statusu wersji.
 *
 * Graf jest celowo ubogi: `registered → released → deprecated` i powrót
 * `released → registered` nie istnieje. Wersja raz wypuszczona na flotę
 * zostaje wypuszczona — cofnięcie robi się przez `deprecated`, żeby
 * w dzienniku został ślad, że coś tam działało.
 */
const ALLOWED_STATUS: Record<PolicyVersionStatus, PolicyVersionStatus[]> = {
  registered: ['released', 'deprecated'],
  released: ['deprecated'],
  deprecated: [],
}

const transitionVersionCommand: CommandHandler<
  VersionTransitionInput,
  { policyVersionId: string; fromStatus: PolicyVersionStatus; toStatus: PolicyVersionStatus }
> = {
  id: 'policy_registry.versions.transition',
  async execute(rawInput, ctx) {
    const input = versionTransitionSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)

    const version = (await em.findOne(PolicyVersion, {
      id: input.policyVersionId,
      tenantId: input.tenantId,
    } as never)) as unknown as {
      id: string
      status: PolicyVersionStatus
      statusReason?: string | null
      statusChangedAt?: Date | null
    } | null
    if (!version) throw new Error(`Wersja polityki ${input.policyVersionId} nie istnieje.`)

    const from = version.status
    if (from === input.toStatus) {
      throw new Error(`Wersja jest już w statusie ${input.toStatus}.`)
    }
    const targets = ALLOWED_STATUS[from] ?? []
    if (!targets.includes(input.toStatus)) {
      const lista = targets.length ? targets.join(', ') : 'żaden — to status końcowy'
      throw new Error(`Z ${from} nie da się przejść do ${input.toStatus}; dozwolone: ${lista}.`)
    }

    version.status = input.toStatus
    version.statusReason = input.reason
    version.statusChangedAt = new Date()

    em.persist(
      em.create(PolicyVersionEvent, {
        organizationId: input.organizationId,
        tenantId: input.tenantId,
        policyVersionId: version.id,
        fromStatus: from,
        toStatus: input.toStatus,
        reason: input.reason,
        actorUserId: ctx.auth?.sub ?? null,
      } as never),
    )
    await em.flush()

    await emitPolicyRegistryEvent('policy_registry.version.transitioned', {
      id: version.id,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      fromStatus: from,
      toStatus: input.toStatus,
      reason: input.reason,
    })

    // Dwa statusy dostają własne zdarzenie, bo reagują na nie inni odbiorcy:
    // zwolnienie otwiera drogę do przypisania, wycofanie każe przejrzeć
    // maszyny, które tę wersję już mają.
    if (input.toStatus === 'released') {
      await emitPolicyRegistryEvent('policy_registry.version.released', {
        id: version.id,
        organizationId: input.organizationId,
        tenantId: input.tenantId,
        fromStatus: from,
        reason: input.reason,
      })
    } else if (input.toStatus === 'deprecated') {
      await emitPolicyRegistryEvent('policy_registry.version.deprecated', {
        id: version.id,
        organizationId: input.organizationId,
        tenantId: input.tenantId,
        fromStatus: from,
        reason: input.reason,
      })
    }

    return { policyVersionId: version.id, fromStatus: from, toStatus: input.toStatus }
  },
}

registerCommand(registerPolicyCommand)
registerCommand(registerVersionCommand)
registerCommand(transitionVersionCommand)

export { registerPolicyCommand, registerVersionCommand, transitionVersionCommand }
