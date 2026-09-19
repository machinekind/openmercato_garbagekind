import { createHash } from 'node:crypto'
import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { demoJointContract } from './lib/vectorContract'
import { Policy } from './data/entities'

/**
 * Komendy operatorskie rejestru polityk.
 *
 * `seed` zakłada dwie polityki związane z rewizjami embodimentu z zasiewu
 * floty. `prove` odtwarza dowód fazy na żywej bazie — bo warunkiem zaliczenia
 * jest zdanie o zachowaniu systemu, a nie zielona suita testów.
 */

type Scope = { tenantId: string; organizationId: string }

function parseArgs(rest: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {}
  for (let index = 0; index < rest.length; index += 1) {
    const part = rest[index]
    if (!part?.startsWith('--')) continue
    const [key, value] = part.slice(2).split('=')
    if (value !== undefined) args[key] = value
    else if (rest[index + 1] && !rest[index + 1]!.startsWith('--')) {
      args[key] = rest[index + 1]!
      index += 1
    } else args[key] = true
  }
  return args
}

async function resolveScope(em: EntityManager, args: Record<string, string | boolean>): Promise<Scope> {
  const tenantId = typeof args.tenant === 'string' ? args.tenant : ''
  const organizationId = typeof args.org === 'string' ? args.org : ''
  if (tenantId && organizationId) return { tenantId, organizationId }
  const rows = await em.getConnection().execute<Array<{ tenant_id: string; id: string }>>(
    'select tenant_id, id from organizations where deleted_at is null order by created_at asc limit 1',
  )
  if (!rows?.length) throw new Error('Brak organizacji — uruchom najpierw inicjalizację aplikacji.')
  return { tenantId: rows[0].tenant_id, organizationId: rows[0].id }
}

function buildCommandContext(
  container: Awaited<ReturnType<typeof createRequestContainer>>,
  scope: Scope,
): CommandRuntimeContext {
  return {
    container,
    auth: null,
    organizationScope: { selectedId: scope.organizationId, filterIds: [scope.organizationId] },
  } as unknown as CommandRuntimeContext
}

/**
 * Skróty artefaktów w zasiewie są deterministyczne.
 *
 * To nie jest udawanie prawdziwego sha256 pliku — to prawdziwy sha256 ustalonego
 * ciągu. Dzięki temu powtórne uruchomienie `seed` musi trafić w deduplikację,
 * czyli zasiew sam jest pierwszą połową dowodu. Losowe skróty rozmnażałyby
 * wersje przy każdym uruchomieniu i ukryłyby dokładnie ten błąd, który ta faza
 * ma wykluczyć.
 */
function demoDigest(label: string): string {
  return createHash('sha256').update(`policy_registry.demo:${label}`, 'utf8').digest('hex')
}

type RevisionRow = { id: string; embodiment_key: string; revision: number; spec_digest: string; dof_count: number | null }

async function loadRevisions(em: EntityManager, tenantId: string): Promise<RevisionRow[]> {
  return em.getConnection().execute<RevisionRow[]>(
    `select id, embodiment_key, revision, spec_digest, dof_count
       from fleet_embodiment_revisions
      where tenant_id = ? and deleted_at is null
      order by embodiment_key, revision`,
    [tenantId],
  )
}

const POLICIES = [
  {
    policyKey: 'pick-bin-ur10e',
    name: 'Pobranie z pojemnika — UR10e',
    embodimentKey: 'ur10e-pick',
    taskKey: 'bin-picking',
    learningMethod: 'rl' as const,
    versions: ['w1', 'w2'],
  },
  {
    policyKey: 'insert-peg-fr3',
    name: 'Wsunięcie kołka — FR3',
    embodimentKey: 'fr3-assembly',
    taskKey: 'peg-in-hole',
    learningMethod: 'il' as const,
    versions: ['w1'],
  },
]

const seedCommand: ModuleCli = {
  command: 'seed',
  async run(rest) {
    const args = parseArgs(rest)
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const bus = container.resolve('commandBus') as CommandBus
    const scope = await resolveScope(em, args)
    const ctx = buildCommandContext(container, scope)

    const revisions = await loadRevisions(em, scope.tenantId)
    if (!revisions.length) {
      console.log('Brak rewizji embodimentu. Uruchom najpierw: yarn mercato fleet seed')
      return
    }
    const byKey = new Map(revisions.map((r) => [r.embodiment_key, r]))

    console.log(`Rejestr polityk: zasiew do organizacji ${scope.organizationId}`)

    for (const entry of POLICIES) {
      const revision = byKey.get(entry.embodimentKey)
      if (!revision) {
        console.log(`  pomijam ${entry.policyKey}: brak rewizji ${entry.embodimentKey}`)
        continue
      }

      let policyId: string
      const existing = (await em.findOne(Policy, {
        tenantId: scope.tenantId,
        policyKey: entry.policyKey,
      } as never)) as unknown as { id: string } | null

      if (existing) {
        policyId = existing.id
      } else {
        const created = (await bus.execute('policy_registry.policies.register', {
          input: {
            organizationId: scope.organizationId,
            tenantId: scope.tenantId,
            policyKey: entry.policyKey,
            name: entry.name,
            embodimentKey: entry.embodimentKey,
            taskKey: entry.taskKey,
            learningMethod: entry.learningMethod,
          },
          ctx,
        })) as { result?: { policyId?: string } }
        policyId = created.result!.policyId as string
      }

      for (const label of entry.versions) {
        const weights = demoDigest(`${entry.policyKey}:${label}:weights`)
        const config = demoDigest(`${entry.policyKey}:${label}:config`)
        const result = (await bus.execute('policy_registry.versions.register', {
          input: {
            organizationId: scope.organizationId,
            tenantId: scope.tenantId,
            policyId,
            embodimentRevisionId: revision.id,
            declaredSpecDigest: revision.spec_digest,
            ...demoJointContract(revision.dof_count ?? 6),
            artifacts: [
              { role: 'weights', digest: weights, uri: `s3://policies/${entry.policyKey}/${label}/weights.safetensors`, mediaType: 'application/octet-stream' },
              { role: 'config', digest: config, uri: `s3://policies/${entry.policyKey}/${label}/config.json`, mediaType: 'application/json' },
            ],
            provenance: { trainingRun: `demo-${label}`, note: 'zasiew demonstracyjny' },
          },
          ctx,
        })) as { result?: { version?: number; deduplicated?: boolean; contentDigest?: string } }

        const r = result.result!
        console.log(
          `  ${entry.policyKey} v${r.version} ${r.deduplicated ? '(powtórka — ta sama wersja)' : '(nowa)'} skrót ${String(r.contentDigest).slice(0, 12)}`,
        )
      }
    }

    console.log('  żadna wersja nie jest jeszcze wypuszczona — to osobna decyzja i osobne uprawnienie')
  },
}

const statusCommand: ModuleCli = {
  command: 'status',
  async run(rest) {
    const args = parseArgs(rest)
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const scope = await resolveScope(em, args)

    const rows = await em.getConnection().execute<Array<{
      policy_key: string
      version: number
      content_digest: string
      status: string
      embodiment_key: string | null
      revision: number | null
      spec_digest: string | null
      embodiment_spec_digest: string
      roles: string | null
    }>>(
      `select p.policy_key, v.version, v.content_digest, v.status,
              e.embodiment_key, e.revision, e.spec_digest, v.embodiment_spec_digest,
              (select string_agg(a.role, '+' order by a.role)
                 from policy_registry_artifacts a where a.policy_version_id = v.id) as roles
         from policy_registry_policy_versions v
         join policy_registry_policies p on p.id = v.policy_id
         left join fleet_embodiment_revisions e on e.id = v.embodiment_revision_id
        where v.tenant_id = ?
        order by p.policy_key, v.version`,
      [scope.tenantId],
    )

    if (!rows.length) {
      console.log('Rejestr polityk jest pusty. Uruchom: yarn mercato policy_registry seed')
      return
    }

    console.log(`Rejestr polityk (tenant ${scope.tenantId}): ${rows.length} wersji\n`)
    console.log('  polityka              wer  skrót treści  sprzęt                 artefakty      status')
    console.log('  ' + '-'.repeat(96))
    for (const row of rows) {
      const sprzet = row.embodiment_key ? `${row.embodiment_key}@r${row.revision}` : 'BRAK REWIZJI'
      const drift = row.spec_digest && row.spec_digest !== row.embodiment_spec_digest ? ' !ROZJAZD' : ''
      console.log(
        `  ${row.policy_key.padEnd(21)} v${String(row.version).padEnd(3)} ${row.content_digest.slice(0, 12)}  ${(sprzet + drift).padEnd(22)} ${(row.roles ?? '—').padEnd(14)} ${row.status}`,
      )
    }
    console.log('')
    console.log('  Tożsamością wersji jest skrót treści. Numer jest etykietą dla ludzi.')
  },
}

/**
 * Dowód fazy odtwarzany na żywej bazie.
 *
 * Dwa zdania z mapy faz, oba sprawdzane przez faktyczne wywołanie komendy,
 * a nie przez atrapę: rejestracja pod obcym `spec_digest` odbija się z nazwanym
 * powodem, a powtórne wgranie tych samych wag nie tworzy drugiej wersji.
 */
const proveCommand: ModuleCli = {
  command: 'prove',
  async run(rest) {
    const args = parseArgs(rest)
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const bus = container.resolve('commandBus') as CommandBus
    const scope = await resolveScope(em, args)
    const ctx = buildCommandContext(container, scope)

    const revisions = await loadRevisions(em, scope.tenantId)
    const target = revisions.find((r) => r.embodiment_key === 'ur10e-pick')
    const foreign = revisions.find((r) => r.embodiment_key !== 'ur10e-pick')
    if (!target || !foreign) {
      console.log('Potrzebne co najmniej dwie rewizje embodimentu. Uruchom: yarn mercato fleet seed')
      return
    }

    const policy = (await em.findOne(Policy, {
      tenantId: scope.tenantId,
      policyKey: 'pick-bin-ur10e',
    } as never)) as unknown as { id: string } | null
    if (!policy) {
      console.log('Brak polityki pick-bin-ur10e. Uruchom: yarn mercato policy_registry seed')
      return
    }

    const weights = demoDigest('pick-bin-ur10e:w1:weights')
    const config = demoDigest('pick-bin-ur10e:w1:config')
    const artifacts = [
      { role: 'weights', digest: weights, uri: 's3://policies/pick-bin-ur10e/w1/weights.safetensors' },
      { role: 'config', digest: config, uri: 's3://policies/pick-bin-ur10e/w1/config.json' },
    ]

    const base = {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      policyId: policy.id,
      ...demoJointContract(target.dof_count ?? 6),
    }

    console.log('DOWÓD FAZY 1 — rejestr polityk\n')

    // 1. Obcy odcisk kontraktu przy właściwej rewizji.
    console.log('1) ta sama rewizja, ale polityka uczona pod innym odciskiem kontraktu')
    try {
      await bus.execute('policy_registry.versions.register', {
        input: {
          ...base,
          embodimentRevisionId: target.id,
          declaredSpecDigest: 'demo:ur10e-pick:r999-inny-kontrakt',
          artifacts,
        },
        ctx,
      })
      console.log('   BŁĄD DOWODU: zapis przeszedł, a nie powinien')
    } catch (error) {
      console.log(`   odbite: ${error instanceof Error ? error.message : String(error)}`)
    }

    // 2. Rewizja z innej rodziny sprzętu.
    console.log('\n2) rewizja z innej rodziny sprzętu')
    try {
      await bus.execute('policy_registry.versions.register', {
        input: {
          ...base,
          embodimentRevisionId: foreign.id,
          declaredSpecDigest: foreign.spec_digest,
          artifacts,
        },
        ctx,
      })
      console.log('   BŁĄD DOWODU: zapis przeszedł, a nie powinien')
    } catch (error) {
      console.log(`   odbite: ${error instanceof Error ? error.message : String(error)}`)
    }

    // 3. Powtórne wgranie tych samych wag.
    console.log('\n3) powtórne wgranie tych samych wag pod właściwą rewizję')
    const before = await em.getConnection().execute<Array<{ n: string }>>(
      'select count(*) as n from policy_registry_policy_versions where tenant_id = ? and policy_id = ?',
      [scope.tenantId, policy.id],
    )
    const result = (await bus.execute('policy_registry.versions.register', {
      input: {
        ...base,
        embodimentRevisionId: target.id,
        declaredSpecDigest: target.spec_digest,
        artifacts,
      },
      ctx,
    })) as { result?: { version?: number; deduplicated?: boolean; contentDigest?: string } }
    const after = await em.getConnection().execute<Array<{ n: string }>>(
      'select count(*) as n from policy_registry_policy_versions where tenant_id = ? and policy_id = ?',
      [scope.tenantId, policy.id],
    )
    console.log(
      `   zwrócono v${result.result?.version} deduplicated=${result.result?.deduplicated}; wersji przed ${before[0].n}, po ${after[0].n}`,
    )

    console.log('\n   Wniosek: tożsamością wersji jest skrót artefaktów, a niezgodność sprzętu')
    console.log('   wychodzi przy rejestracji — czyli zanim ktokolwiek wskaże robota.')
  },
}

export default [seedCommand, statusCommand, proveCommand] satisfies ModuleCli[]
