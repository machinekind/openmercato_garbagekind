import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'

/**
 * Komendy operatorskie zbiorów danych.
 *
 * `prove` odtwarza dowód fazy: dla wersji polityki da się wskazać zbiór,
 * a dla zbioru - listę epizodów źródłowych, i odwrotnie. Obie strony są
 * sprawdzane osobnym zapytaniem, bo to są dwa odwzorowania, nie jedno.
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
  if (!rows?.length) throw new Error('Brak organizacji - uruchom najpierw inicjalizację aplikacji.')
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

const statusCommand: ModuleCli = {
  command: 'status',
  async run(rest) {
    const args = parseArgs(rest)
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const scope = await resolveScope(em, args)

    const rows = await em.getConnection().execute<Array<{
      dataset_key: string
      version: number
      content_digest: string
      episode_count: number
      demo_count: number
      correction_count: number
      failure_count: number
      holdout_count: number
      policies: string | null
    }>>(
      `select d.dataset_key, v.version, v.content_digest, v.episode_count,
              v.demo_count, v.correction_count, v.failure_count, v.holdout_count,
              (select string_agg(distinct p.policy_key || ' v' || pv.version, ', ')
                 from datasets_training_runs t
                 join policy_registry_policy_versions pv on pv.id = t.policy_version_id
                 join policy_registry_policies p on p.id = pv.policy_id
                where t.dataset_version_id = v.id) as policies
         from datasets_versions v
         join datasets_datasets d on d.id = v.dataset_id
        where v.tenant_id = ?
        order by d.dataset_key, v.version`,
      [scope.tenantId],
    )

    if (!rows.length) {
      console.log('Brak zbiorów danych. Uruchom: yarn mercato datasets prove')
      return
    }

    console.log(`Zbiory danych (tenant ${scope.tenantId})\n`)
    console.log('  zbiór                wer  odcisk        ep  demo  kor  neg  eval  powstałe polityki')
    console.log('  ' + '-'.repeat(96))
    for (const row of rows) {
      console.log(
        `  ${row.dataset_key.padEnd(20)} v${String(row.version).padEnd(3)} ${row.content_digest.slice(0, 12)} ` +
          `${String(row.episode_count).padStart(3)} ${String(row.demo_count).padStart(5)} ${String(row.correction_count).padStart(4)} ` +
          `${String(row.failure_count).padStart(4)} ${String(row.holdout_count).padStart(5)}  ${row.policies ?? '-'}`,
      )
    }
  },
}

/**
 * Dowód fazy 6.
 *
 * Zdanie z mapy faz: *dla dowolnej wersji polityki da się wskazać zbiór,
 * a dla zbioru - listę epizodów źródłowych, i odwrotnie.*
 *
 * „I odwrotnie" jest tu sprawdzane dosłownie: jedno zapytanie idzie od
 * polityki do epizodów, drugie od epizodu do polityk, i oba muszą wskazać
 * ten sam zbiór. Sprawdzenie tylko w jedną stronę przeszłoby również dla
 * modelu, w którym pochodzenie jest luźnym polem JSON.
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
    const stamp = Date.now().toString(36)

    console.log('DOWÓD FAZY 6 - pętla zamknięta w obie strony\n')

    const dataset = (
      await bus.execute('datasets.datasets.define', {
        input: {
          ...scope,
          datasetKey: 'bin-picking-ur10e',
          name: 'Chwytanie z pojemnika - UR10e',
          taskKey: 'bin-picking',
          embodimentKey: 'ur10e-pick',
          description: 'Epizody z celi odkładczej, wraz z interwencjami jako demonstracjami korekcyjnymi.',
        },
        ctx,
      })
    ).result as { datasetId: string }

    // 1. Budowanie wersji z księgi epizodów.
    console.log('1) budowanie wersji zbioru z księgi epizodów')
    const built = (
      await bus.execute('datasets.versions.build', {
        input: {
          ...scope,
          datasetId: dataset.datasetId,
          criteria: { taskKey: 'bin-picking', holdoutRatio: 0.2 },
          exportUri: `s3://datasets/bin-picking-ur10e/${stamp}.tar`,
        },
        ctx,
      })
    ).result as {
      datasetVersionId: string
      version: number
      contentDigest: string
      episodeCount: number
      warnings: Array<{ code: string; message: string }>
      deduplicated: boolean
    }
    console.log(
      `   wersja ${built.version}, epizodów ${built.episodeCount}, odcisk ${built.contentDigest.slice(0, 12)}, powtórka=${built.deduplicated}`,
    )
    for (const warning of built.warnings) console.log(`   ostrzeżenie [${warning.code}]: ${warning.message}`)

    // 2. Przebudowanie z tych samych kryteriów - ta sama wersja.
    console.log('\n2) przebudowanie z tych samych kryteriów nad niezmienioną księgą')
    const again = (
      await bus.execute('datasets.versions.build', {
        input: { ...scope, datasetId: dataset.datasetId, criteria: { taskKey: 'bin-picking', holdoutRatio: 0.2 } },
        ctx,
      })
    ).result as { version: number; deduplicated: boolean }
    console.log(`   zwrócono wersję ${again.version}, powtórka=${again.deduplicated}`)

    // 3. Przebieg treningowy i domknięcie pętli.
    console.log('\n3) przebieg treningowy i domknięcie pętli')
    const versions = await em.getConnection().execute<Array<{ id: string; label: string }>>(
      `select v.id, p.policy_key || ' v' || v.version as label
         from policy_registry_policy_versions v
         join policy_registry_policies p on p.id = v.policy_id
        where v.tenant_id = ? and p.policy_key = 'pick-bin-ur10e'
        order by v.version desc limit 1`,
      [scope.tenantId],
    )
    if (!versions.length) {
      console.log('   Brak wersji polityki pick-bin-ur10e. Uruchom: yarn mercato policy_registry seed')
      return
    }
    const policy = versions[0]

    const runRef = `train-${stamp}`
    await bus.execute('datasets.runs.register', {
      input: {
        ...scope,
        datasetVersionId: built.datasetVersionId,
        runRef,
        framework: 'diffusion-policy 0.4',
        hyperparameters: { seed: 7, epochs: 120, lr: 0.0001 },
      },
      ctx,
    })

    const nieudany = await bus
      .execute('datasets.runs.complete', { input: { ...scope, runRef, status: 'succeeded' }, ctx })
      .then(() => 'ZAMKNIĘTY BEZ POLITYKI - BŁĄD DOWODU')
      .catch((error: Error) => `odbite: ${error.message}`)
    console.log(`   próba zamknięcia przebiegu bez wskazania polityki → ${nieudany}`)

    await bus.execute('datasets.runs.complete', {
      input: { ...scope, runRef, status: 'succeeded', policyVersionId: policy.id },
      ctx,
    })
    console.log(`   przebieg ${runRef} zamknięty; powstała polityka ${policy.label}`)

    // 4. Pętla w stronę „polityka → epizody".
    console.log('\n4) od wersji polityki do epizodów źródłowych')
    const fromPolicy = await em.getConnection().execute<Array<{
      dataset_key: string
      version: number
      episodes: string
      corrections: string
    }>>(
      `select d.dataset_key, v.version,
              count(distinct m.episode_id) as episodes,
              count(distinct m.episode_id) filter (where m.role = 'correction') as corrections
         from datasets_training_runs t
         join datasets_versions v on v.id = t.dataset_version_id
         join datasets_datasets d on d.id = v.dataset_id
         join datasets_members m on m.dataset_version_id = v.id
        where t.tenant_id = ? and t.policy_version_id = ?
        group by 1, 2`,
      [scope.tenantId, policy.id],
    )
    for (const row of fromPolicy) {
      console.log(
        `   ${policy.label} ← ${row.dataset_key} v${row.version}: ${row.episodes} epizodów (${row.corrections} korekcyjnych)`,
      )
    }

    // 5. Pętla w stronę „epizod → polityki".
    console.log('\n5) od pojedynczego epizodu do polityk, które się na nim uczyły')
    const sample = await em.getConnection().execute<Array<{ episode_id: string; role: string }>>(
      `select episode_id, role from datasets_members
        where dataset_version_id = ? order by role, episode_id limit 1`,
      [built.datasetVersionId],
    )
    if (sample.length) {
      const episodeId = sample[0].episode_id
      const fromEpisode = await em.getConnection().execute<Array<{
        label: string
        dataset_key: string
        version: number
        role: string
      }>>(
        `select p.policy_key || ' v' || pv.version as label, d.dataset_key, v.version, m.role
           from datasets_members m
           join datasets_versions v on v.id = m.dataset_version_id
           join datasets_datasets d on d.id = v.dataset_id
           join datasets_training_runs t on t.dataset_version_id = v.id
           join policy_registry_policy_versions pv on pv.id = t.policy_version_id
           join policy_registry_policies p on p.id = pv.policy_id
          where m.episode_id = ?`,
        [episodeId],
      )
      console.log(`   epizod ${episodeId.slice(0, 8)}… (rola ${sample[0].role}) →`)
      for (const row of fromEpisode) {
        console.log(`     ${row.dataset_key} v${row.version} → ${row.label}`)
      }
      const zgodne = fromEpisode.some((row) => row.label === policy.label)
      console.log(`   obie strony wskazują tę samą politykę: ${zgodne}`)
    }

    // 6. Kontrola zamknięcia pętli dla całej instancji.
    console.log('\n6) pętla dla całej instancji')
    const sieroty = await em.getConnection().execute<Array<{ label: string }>>(
      `select p.policy_key || ' v' || v.version as label
         from policy_registry_policy_versions v
         join policy_registry_policies p on p.id = v.policy_id
        where v.tenant_id = ?
          and not exists (select 1 from datasets_training_runs t
                           where t.policy_version_id = v.id)
        order by 1`,
      [scope.tenantId],
    )
    const pusteZbiory = await em.getConnection().execute<Array<{ n: string }>>(
      `select count(*) as n from datasets_versions v
        where v.tenant_id = ?
          and not exists (select 1 from datasets_members m where m.dataset_version_id = v.id)`,
      [scope.tenantId],
    )
    console.log(`   wersje polityki bez wskazanego zbioru: ${sieroty.length}${sieroty.length ? ` (${sieroty.map((s) => s.label).join(', ')})` : ''}`)
    console.log(`   wersje zbioru bez epizodów: ${pusteZbiory[0].n}`)

    console.log('\n   Wniosek: pętla jest zamknięta dla wersji, która przeszła przez potok')
    console.log('   treningowy. Wersje wgrane ręcznie zostają sierotami i platforma mówi')
    console.log('   o nich wprost zamiast udawać, że pochodzenie jest znane.')
  },
}

export default [statusCommand, proveCommand] satisfies ModuleCli[]
