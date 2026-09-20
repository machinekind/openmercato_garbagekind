import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { cadence, cadenceBy, verifyAgainstLedger, type EpisodeEntry } from './lib/cadence'

/**
 * Komendy operatorskie księgi epizodów.
 *
 * `simulate` zakłada wiarygodny przebieg produkcyjny - z interwencjami, bo
 * przebieg bez nich nie pokazuje niczego, co ta księga ma pokazywać.
 * `prove` odtwarza dowód fazy: raport kadencji liczony czystą funkcją musi
 * zgodzić się **co do sztuki** z niezależnym przeliczeniem po stronie bazy.
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

/**
 * Deterministyczny generator pseudolosowy.
 *
 * `Math.random()` dałby przy każdym uruchomieniu inną księgę, a dowód fazy
 * polega na porównaniu dwóch niezależnych przeliczeń **tych samych** danych.
 * Ziarno w argumencie pozwala odtworzyć dokładnie ten sam przebieg.
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0xffffffff
  }
}

const ETAPY = ['podejście', 'chwyt', 'przeniesienie', 'odłożenie', 'wycofanie']
const PRZYCZYNY = [
  { category: 'grasp_failure', reason: 'Chwytak zsunął się z detalu', kinds: ['manual_reset', 'teleop_takeover'] },
  { category: 'object_not_detected', reason: 'Detal nierozpoznany w pojemniku', kinds: ['adjust', 'abort'] },
  { category: 'workspace_obstruction', reason: 'Pojemnik przesunięty poza zasięg', kinds: ['adjust'] },
  { category: 'person_in_safety_zone', reason: 'Człowiek wszedł w obszar roboczy', kinds: ['estop'] },
] as const

const simulateCommand: ModuleCli = {
  command: 'simulate',
  async run(rest) {
    const args = parseArgs(rest)
    const count = Number(args.count ?? 60)
    const seed = Number(args.seed ?? 20260919)
    const random = makeRandom(seed)

    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const bus = container.resolve('commandBus') as CommandBus
    const scope = await resolveScope(em, args)
    const ctx = buildCommandContext(container, scope)

    /**
     * Epizody generujemy dla robotów, które mają przypisaną politykę, a jeśli
     * takich nie ma - dla robotów w ruchu, z `policy_version_id` pustym.
     * Ten drugi przypadek jest celowo dopuszczony: praca teleoperacyjna też
     * trafia do księgi i musi ciągnąć autonomię w dół.
     */
    const robots = await em.getConnection().execute<Array<{
      id: string
      serial_number: string
      cell_id: string | null
      policy_version_id: string | null
      assignment_id: string | null
    }>>(
      `select r.id, r.serial_number, r.cell_id, a.policy_version_id, a.id as assignment_id
         from fleet_robots r
         left join deployment_assignments a
           on a.robot_id = r.id and a.superseded_at is null and a.revoked_at is null
        where r.tenant_id = ? and r.deleted_at is null and r.state = 'operational'
        order by r.serial_number`,
      [scope.tenantId],
    )

    if (!robots.length) {
      console.log('Brak robotów w ruchu. Uruchom: yarn mercato fleet seed')
      return
    }

    console.log(`Generuję ${count} epizodów na ${robots.length} robotach (ziarno ${seed})`)

    const start = Date.now() - count * 90_000
    let episodes = 0
    let interventions = 0

    for (let index = 0; index < count; index += 1) {
      const robot = robots[index % robots.length]
      const startedAt = new Date(start + index * 90_000)
      const duration = 25_000 + Math.floor(random() * 40_000)
      const endedAt = new Date(startedAt.getTime() + duration)

      /**
       * Prawdopodobieństwo niepowodzenia maleje z czasem.
       *
       * Krzywa jest tu po to, żeby raport kadencji miał co pokazać w podziale
       * na okresy. Stałe prawdopodobieństwo dawałoby wdrożenie, które nigdzie
       * nie idzie - a takie też się zdarzają, tylko nie nadają się na przykład.
       */
      const progress = index / Math.max(1, count - 1)
      const failureChance = 0.28 - 0.2 * progress
      const failed = random() < failureChance

      const recorded = (
        await bus.execute('episodes.episodes.record', {
          input: {
            ...scope,
            robotId: robot.id,
            externalRef: `sim-${seed}-${index}`,
            taskKey: 'bin-picking',
            startedAt,
            endedAt,
            outcome: failed ? (random() < 0.3 ? 'timeout' : 'failure') : 'success',
            outcomeDetail: failed ? 'Detal nie trafił do gniazda' : undefined,
            policyVersionId: robot.policy_version_id,
            assignmentId: robot.assignment_id,
            cellId: robot.cell_id,
            metrics: { cycleMs: duration, graspAttempts: failed ? 3 : 1 },
          },
          ctx,
        })
      ).result as { episodeId: string; duplicate: boolean }

      if (recorded.duplicate) continue
      episodes += 1

      // Nie każde niepowodzenie kończy się interwencją - i to jest sedno.
      // Epizod nieudany, po którym robot sam się pozbierał, jest dowodem
      // dojrzałości; ten sam epizod przerwany przez człowieka nie jest.
      if (!failed || random() > 0.55) continue

      const przyczyna = PRZYCZYNY[Math.floor(random() * PRZYCZYNY.length)]
      await bus.execute('episodes.interventions.record', {
        input: {
          ...scope,
          robotId: robot.id,
          episodeId: recorded.episodeId,
          kind: przyczyna.kinds[Math.floor(random() * przyczyna.kinds.length)],
          stage: ETAPY[Math.floor(random() * ETAPY.length)],
          reasonCategory: przyczyna.category,
          reason: przyczyna.reason,
          occurredAt: new Date(startedAt.getTime() + Math.floor(duration * 0.6)),
          recoverySeconds: 30 + Math.floor(random() * 240),
        },
        ctx,
      })
      interventions += 1
    }

    console.log(`  zapisano epizodów: ${episodes}, interwencji: ${interventions}`)
    console.log('  Uruchom: yarn mercato episodes cadence')
  },
}

type LedgerRow = {
  id: string
  robot_id: string
  serial_number: string
  sequence: number
  outcome: string
  intervention_count: number
  policy_key: string | null
  policy_version: number | null
  cell_name: string | null
}

async function loadLedger(em: EntityManager, tenantId: string): Promise<LedgerRow[]> {
  return em.getConnection().execute<LedgerRow[]>(
    `select e.id, e.robot_id, r.serial_number, e.sequence, e.outcome, e.intervention_count,
            p.policy_key, v.version as policy_version, c.name as cell_name
       from episodes_episodes e
       join fleet_robots r on r.id = e.robot_id
       left join policy_registry_policy_versions v on v.id = e.policy_version_id
       left join policy_registry_policies p on p.id = v.policy_id
       left join fleet_cells c on c.id = e.cell_id
      where e.tenant_id = ?
      order by e.robot_id, e.sequence`,
    [tenantId],
  )
}

function toEntries(rows: LedgerRow[]): Array<EpisodeEntry & { policy: string | null; cell: string | null; robot: string }> {
  return rows.map((row) => ({
    id: row.id,
    sequence: Number(row.sequence),
    outcome: row.outcome as EpisodeEntry['outcome'],
    interventionCount: Number(row.intervention_count),
    policy: row.policy_key ? `${row.policy_key} v${row.policy_version}` : null,
    cell: row.cell_name,
    robot: row.serial_number,
  }))
}

const cadenceCommand: ModuleCli = {
  command: 'cadence',
  async run(rest) {
    const args = parseArgs(rest)
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const scope = await resolveScope(em, args)

    const entries = toEntries(await loadLedger(em, scope.tenantId))
    if (!entries.length) {
      console.log('Księga epizodów jest pusta. Uruchom: yarn mercato episodes simulate')
      return
    }

    const overall = cadence(entries)
    console.log(`Kadencja autonomii (tenant ${scope.tenantId})\n`)
    console.log(`  epizodów            : ${overall.episodes}`)
    console.log(`  interwencji         : ${overall.interventions}`)
    console.log(
      `  epizodów/interwencję: ${overall.meanEpisodesBetweenInterventions === null ? 'brak interwencji' : overall.meanEpisodesBetweenInterventions.toFixed(2)}`,
    )
    console.log(`  bieżąca seria       : ${overall.currentStreak} (najdłuższa ${overall.longestStreak})`)
    console.log(`  autonomia           : ${(overall.autonomyRate * 100).toFixed(1)}%`)
    console.log(`  skuteczność         : ${(overall.successRate * 100).toFixed(1)}%`)

    for (const [tytul, mapa] of [
      ['per polityka', cadenceBy(entries, (e) => e.policy)],
      ['per cela', cadenceBy(entries, (e) => e.cell)],
      ['per robot', cadenceBy(entries, (e) => e.robot)],
    ] as const) {
      console.log(`\n  ${tytul}:`)
      for (const [klucz, raport] of [...mapa.entries()].sort()) {
        console.log(
          `    ${klucz.padEnd(24)} ep ${String(raport.episodes).padStart(4)}  int ${String(raport.interventions).padStart(3)}  ep/int ${(raport.meanEpisodesBetweenInterventions ?? NaN).toFixed(2).padStart(7)}  seria ${raport.currentStreak}`,
        )
      }
    }
  },
}

const reconcileCommand: ModuleCli = {
  command: 'reconcile',
  async run(rest) {
    const args = parseArgs(rest)
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const bus = container.resolve('commandBus') as CommandBus
    const scope = await resolveScope(em, args)

    const result = (
      await bus.execute('episodes.episodes.reconcile_counts', {
        input: { ...scope },
        ctx: buildCommandContext(container, scope),
      })
    ).result as { checked: number; corrected: number; corrections: Array<{ episodeId: string; was: number; is: number }> }

    console.log(`Sprawdzono epizodów: ${result.checked}, poprawiono: ${result.corrected}`)
    for (const correction of result.corrections) {
      console.log(`  ${correction.episodeId}: licznik ${correction.was} → ${correction.is}`)
    }
    if (!result.corrected) console.log('  Licznik na epizodach zgadza się z tabelą interwencji.')
  },
}

/**
 * Dowód fazy 3.
 *
 * Zdanie z mapy faz: *raport „epizody między interwencjami" liczony per
 * polityka i per cela, zgodny co do sztuki z księgą epizodów.*
 *
 * „Zgodny co do sztuki" jest tu sprawdzany krzyżowo: raport liczy czysta
 * funkcja przechodząca po wczytanej księdze, a kontrolę liczy **baza**
 * osobnym zapytaniem, które nie dotyka licznika zdenormalizowanego i o funkcji
 * nic nie wie. Zgodność dwóch przeliczeń tą samą drogą nie dowodziłaby niczego.
 */
const proveCommand: ModuleCli = {
  command: 'prove',
  async run(rest) {
    const args = parseArgs(rest)
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const scope = await resolveScope(em, args)

    const rows = await loadLedger(em, scope.tenantId)
    if (!rows.length) {
      console.log('Księga epizodów jest pusta. Uruchom: yarn mercato episodes simulate')
      return
    }
    const entries = toEntries(rows)

    console.log('DOWÓD FAZY 3 - kadencja autonomii zgodna z księgą\n')

    // 1. Kontrola sumaryczna wobec księgi liczonej przez bazę.
    const ledgerRows = await em.getConnection().execute<Array<{ episodes: string; interventions: string }>>(
      `select (select count(*) from episodes_episodes where tenant_id = ?) as episodes,
              (select count(*) from episodes_interventions where tenant_id = ?) as interventions`,
      [scope.tenantId, scope.tenantId],
    )
    const ledger = {
      episodes: Number(ledgerRows[0].episodes),
      interventions: Number(ledgerRows[0].interventions),
    }
    const overall = cadence(entries)
    const check = verifyAgainstLedger(overall, ledger)

    console.log('1) raport kontra księga')
    console.log(`   raport: ${overall.episodes} epizodów, ${overall.interventions} interwencji`)
    console.log(`   księga: ${ledger.episodes} epizodów, ${ledger.interventions} interwencji`)
    console.log(`   spójne: ${check.consistent}`)
    for (const problem of check.problems) console.log(`   ROZJAZD: ${problem}`)

    // 2. Cross-walidacja per polityka - liczby z bazy, bez licznika na epizodzie.
    console.log('\n2) epizody między interwencjami per polityka (raport ↔ niezależne zapytanie)')
    const sqlPerPolicy = await em.getConnection().execute<Array<{
      label: string | null
      episodes: string
      interventions: string
    }>>(
      `select case when p.policy_key is null then null
                   else p.policy_key || ' v' || v.version end as label,
              count(distinct e.id) as episodes,
              count(i.id) as interventions
         from episodes_episodes e
         left join policy_registry_policy_versions v on v.id = e.policy_version_id
         left join policy_registry_policies p on p.id = v.policy_id
         left join episodes_interventions i on i.episode_id = e.id
        where e.tenant_id = ?
        group by 1 order by 1`,
      [scope.tenantId],
    )

    const reportPerPolicy = cadenceBy(entries, (e) => e.policy)
    let mismatches = 0
    for (const row of sqlPerPolicy) {
      if (row.label === null) {
        console.log(`   (bez polityki)        ep ${row.episodes}  int ${row.interventions}  - poza raportem per polityka, celowo`)
        continue
      }
      const report = reportPerPolicy.get(row.label)
      const sqlEpisodes = Number(row.episodes)
      const sqlInterventions = Number(row.interventions)
      const zgodne =
        report != null && report.episodes === sqlEpisodes && report.interventions === sqlInterventions
      if (!zgodne) mismatches += 1
      console.log(
        `   ${row.label.padEnd(20)} raport ep ${String(report?.episodes ?? 0).padStart(4)} int ${String(report?.interventions ?? 0).padStart(3)}` +
          `  │  SQL ep ${String(sqlEpisodes).padStart(4)} int ${String(sqlInterventions).padStart(3)}  │  ${zgodne ? 'zgodne' : 'ROZJAZD'}` +
          `  │  ep/int ${(report?.meanEpisodesBetweenInterventions ?? NaN).toFixed(2)}`,
      )
    }

    // 3. To samo per cela.
    console.log('\n3) epizody między interwencjami per cela (raport ↔ niezależne zapytanie)')
    const sqlPerCell = await em.getConnection().execute<Array<{
      label: string | null
      episodes: string
      interventions: string
    }>>(
      `select c.name as label, count(distinct e.id) as episodes, count(i.id) as interventions
         from episodes_episodes e
         left join fleet_cells c on c.id = e.cell_id
         left join episodes_interventions i on i.episode_id = e.id
        where e.tenant_id = ?
        group by 1 order by 1`,
      [scope.tenantId],
    )
    const reportPerCell = cadenceBy(entries, (e) => e.cell)
    for (const row of sqlPerCell) {
      if (row.label === null) continue
      const report = reportPerCell.get(row.label)
      const zgodne =
        report != null &&
        report.episodes === Number(row.episodes) &&
        report.interventions === Number(row.interventions)
      if (!zgodne) mismatches += 1
      console.log(
        `   ${row.label.slice(0, 30).padEnd(31)} raport ep ${String(report?.episodes ?? 0).padStart(4)} int ${String(report?.interventions ?? 0).padStart(3)}` +
          `  │  SQL ep ${String(row.episodes).padStart(4)} int ${String(row.interventions).padStart(3)}  │  ${zgodne ? 'zgodne' : 'ROZJAZD'}`,
      )
    }

    // 4. Niezmiennik serii: suma długości serii = epizody bez interwencji.
    const streakSum = overall.streaks.reduce((a, b) => a + b, 0)
    console.log('\n4) niezmiennik serii')
    console.log(
      `   suma długości serii ${streakSum} = epizody bez interwencji ${overall.cleanEpisodes}: ${streakSum === overall.cleanEpisodes}`,
    )
    console.log(
      `   z interwencją ${overall.intervenedEpisodes} + bez ${overall.cleanEpisodes} = ${overall.episodes}: ${overall.intervenedEpisodes + overall.cleanEpisodes === overall.episodes}`,
    )

    console.log(`\n   Rozjazdów: ${mismatches}. ${mismatches === 0 ? 'Raport zgadza się z księgą co do sztuki.' : 'RAPORT NIE ZGADZA SIĘ Z KSIĘGĄ.'}`)
    console.log('   Kontrola liczona jest przez bazę osobnym zapytaniem, które nie dotyka')
    console.log('   licznika zdenormalizowanego - zgodność dwóch przeliczeń tą samą drogą')
    console.log('   nie dowodziłaby niczego.')
  },
}

export default [simulateCommand, cadenceCommand, reconcileCommand, proveCommand] satisfies ModuleCli[]
