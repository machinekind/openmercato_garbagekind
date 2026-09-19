import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'

/**
 * Komendy operatorskie wdrożeń etapowych.
 *
 * `prove` odtwarza dowód fazy na żywej bazie i pokazuje **obie** strony bramy:
 * etap z czystymi liczbami przechodzi dalej, etap z przekroczonym progiem
 * wycofuje się i zatrzymuje etapy następne. Sam przypadek negatywny
 * dowodziłby tylko tego, że da się napisać funkcję zawsze zwracającą
 * „wycofaj".
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

async function robotBySerial(em: EntityManager, tenantId: string, serial: string) {
  const rows = await em.getConnection().execute<Array<{ id: string; embodiment_revision_id: string; state: string }>>(
    `select id, embodiment_revision_id, state from fleet_robots
      where tenant_id = ? and serial_number = ? and deleted_at is null limit 1`,
    [tenantId, serial],
  )
  if (!rows?.length) throw new Error(`Nie znaleziono robota ${serial}.`)
  return rows[0]
}

async function versionByKey(em: EntityManager, tenantId: string, policyKey: string, version: number) {
  const rows = await em.getConnection().execute<Array<{ id: string; status: string }>>(
    `select v.id, v.status from policy_registry_policy_versions v
       join policy_registry_policies p on p.id = v.policy_id
      where v.tenant_id = ? and p.policy_key = ? and v.version = ? limit 1`,
    [tenantId, policyKey, version],
  )
  if (!rows?.length) throw new Error(`Nie znaleziono wersji ${policyKey} v${version}.`)
  return rows[0]
}

/**
 * Wstrzyknięcie epizodów pod konkretny etap.
 *
 * Epizody idą **komendą księgi**, a nie INSERT-em: brama ma czytać dokładnie
 * to, co czyta raport kadencji. Gdyby dowód wpisywał wiersze z pominięciem
 * komendy, dowodziłby zgodności bramy z tym INSERT-em, a nie z księgą.
 */
async function feedEpisodes(
  bus: CommandBus,
  ctx: CommandRuntimeContext,
  scope: Scope,
  options: {
    robotId: string
    policyVersionId: string
    count: number
    interventionEvery: number | null
    severeEvery: number | null
    tag: string
  },
): Promise<{ episodes: number; interventions: number }> {
  let episodes = 0
  let interventions = 0
  /**
   * Epizody idą gęsto, co milisekundę, a nie co sekundę.
   *
   * Brama liczy epizody od chwili uruchomienia etapu. Przy odstępie sekundowym
   * epizody etapu poprzedniego wchodziły w okno etapu następnego i rozcieńczały
   * dokładnie ten sygnał, który brama ma wyłapać — pierwsze przejście dowodu
   * pokazało 12,5% zamiast 25%. To jest artefakt generatora, nie bramy, ale
   * gdyby został, dowód mówiłby coś innego, niż twierdzi.
   */
  const base = Date.now()

  for (let index = 0; index < options.count; index += 1) {
    const startedAt = new Date(base + index)
    const endedAt = new Date(startedAt.getTime() + 30_000)
    const withIntervention =
      options.interventionEvery !== null && (index + 1) % options.interventionEvery === 0
    const severe = options.severeEvery !== null && (index + 1) % options.severeEvery === 0

    const recorded = (
      await bus.execute('episodes.episodes.record', {
        input: {
          ...scope,
          robotId: options.robotId,
          externalRef: `${options.tag}-${index}`,
          taskKey: 'bin-picking',
          startedAt,
          endedAt,
          outcome: withIntervention ? 'failure' : 'success',
          policyVersionId: options.policyVersionId,
        },
        ctx,
      })
    ).result as { episodeId: string; duplicate: boolean }
    if (recorded.duplicate) continue
    episodes += 1

    if (!withIntervention && !severe) continue
    await bus.execute('episodes.interventions.record', {
      input: {
        ...scope,
        robotId: options.robotId,
        episodeId: recorded.episodeId,
        kind: severe ? 'estop' : 'teleop_takeover',
        stage: 'chwyt',
        reasonCategory: severe ? 'person_in_safety_zone' : 'grasp_failure',
        reason: severe ? 'Człowiek w obszarze roboczym' : 'Chwytak zsunął się z detalu',
        occurredAt: new Date(startedAt.getTime() + 15_000),
      },
      ctx,
    })
    interventions += 1
  }

  return { episodes, interventions }
}

async function currentAssignment(em: EntityManager, tenantId: string, robotId: string) {
  const rows = await em.getConnection().execute<Array<{ policy_key: string; version: number }>>(
    `select p.policy_key, v.version
       from deployment_assignments a
       join policy_registry_policy_versions v on v.id = a.policy_version_id
       join policy_registry_policies p on p.id = v.policy_id
      where a.tenant_id = ? and a.robot_id = ? and a.superseded_at is null and a.revoked_at is null
      limit 1`,
    [tenantId, robotId],
  )
  return rows?.length ? `${rows[0].policy_key} v${rows[0].version}` : 'bez polityki'
}

const statusCommand: ModuleCli = {
  command: 'status',
  async run(rest) {
    const args = parseArgs(rest)
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const scope = await resolveScope(em, args)

    const rows = await em.getConnection().execute<Array<{
      name: string
      status: string
      ordinal: number
      stage_name: string
      stage_status: string
      decision: string | null
      reason: string | null
    }>>(
      `select r.name, r.status, s.ordinal, s.name as stage_name, s.status as stage_status,
              g.decision, g.reason
         from rollout_stages s
         join rollout_rollouts r on r.id = s.rollout_id
         left join lateral (select decision, reason from rollout_gate_evaluations
                             where stage_id = s.id order by evaluated_at desc limit 1) g on true
        where s.tenant_id = ?
        order by r.created_at desc, s.ordinal`,
      [scope.tenantId],
    )

    if (!rows.length) {
      console.log('Brak wdrożeń etapowych. Uruchom: yarn mercato rollout prove')
      return
    }

    let last = ''
    for (const row of rows) {
      if (row.name !== last) {
        console.log(`\n${row.name} — ${row.status}`)
        last = row.name
      }
      console.log(
        `  ${row.ordinal}. ${row.stage_name.padEnd(28)} ${row.stage_status.padEnd(12)} ${row.decision ?? '—'}${row.reason ? ` (${row.reason})` : ''}`,
      )
    }
  },
}

/**
 * Dowód fazy 4.
 *
 * Zdanie z mapy faz: *przekroczenie progu interwencji na etapie 1 zatrzymuje
 * etap 2 i wycofuje etap 1 bez udziału człowieka.*
 *
 * Dowód ma dwie części, bo jedna nie wystarcza. Najpierw etap z czystymi
 * liczbami przechodzi dalej — bez tego cały dowód sprowadzałby się do
 * pokazania funkcji, która zawsze zwraca „wycofaj". Dopiero potem etap
 * z przekroczonym progiem.
 */

/**
 * Ustanawia dopuszczenie bezpieczeństwa dla wersji polityki w klasie celi robota.
 *
 * Dopisane po fazie 5, która wprowadziła bramę w `deployment.assignments.assign`.
 * Dowód fazy 4 opiera się na wdrażaniu i wycofywaniu wersji, więc bez tej
 * preambuły przestał się odtwarzać — brama odbijała pierwsze przypisanie
 * i dowód kończył się błędem, zamiast pokazywać zachowanie, o którym mówi.
 *
 * To jest realny koszt kolejności faz: warstwa bezpieczeństwa dołożona później
 * unieważnia dowody wcześniejszych faz, które jej nie znały. Naprawa idzie
 * w dowód, a nie w bramę — brama ma blokować i robi to poprawnie.
 *
 * Operacja jest idempotentna: powtórne uruchomienie zastaje uzasadnienie już
 * zatwierdzone i nie tworzy drugiego.
 */
async function zapewnijDopuszczenie(
  em: EntityManager,
  bus: CommandBus,
  ctx: CommandRuntimeContext,
  scope: Scope,
  policyVersionId: string,
  cellClass: string,
  riskClass: string,
): Promise<void> {
  const istnieje = await em.getConnection().execute<Array<{ id: string }>>(
    `select id from safety_cases
      where tenant_id = ? and policy_version_id = ? and cell_class = ? and status = 'approved'
        and (valid_until is null or valid_until > now())
      limit 1`,
    [scope.tenantId, policyVersionId, cellClass],
  )

  if (!istnieje.length) {
    const draft = (
      await bus.execute('safety.cases.draft', {
        input: {
          ...scope,
          policyVersionId,
          cellClass,
          riskClass,
          standards: ['ISO 10218-2:2025', 'ISO/TS 15066:2016'],
          // Warstwa deterministyczna jest warunkiem zatwierdzenia i ma nim
          // zostać: to ona egzekwuje bezpieczeństwo, nie wyuczona polityka.
          // Rodzaj ze słownika zamkniętego — sam opis nie wystarcza do zatwierdzenia.
          safetyLayerKind: 'safety_rated_speed_limit',
          safetyLayer: 'Bariera prędkości i momentu w sterowniku celi, niezależna od polityki.',
        },
        ctx,
      })
    ).result as { safetyCaseId: string }

    const rok = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
    await bus.execute('safety.cases.approve', {
      input: { ...scope, safetyCaseId: draft.safetyCaseId, approvedBy: scope.organizationId, validUntil: rok },
      ctx,
    })
  }

  // Przebiegi ewaluacyjne dla wszystkich zestawów wymaganych dla tej klasy ryzyka.
  // Filtrowanie po stronie JS, a nie w SQL: operator jsonb `?` zderza się
  // ze znakiem zapytania jako placeholderem parametru i sterownik rozkłada
  // zapytanie na czynniki pierwsze. Ta sama droga, co w `safety/cli.ts`.
  const wszystkie = await em.getConnection().execute<Array<{ suite_key: string; required_for: string[] | null }>>(
    `select suite_key, required_for from safety_eval_suites where tenant_id = ?`,
    [scope.tenantId],
  )
  const zestawy = wszystkie.filter((s) => (s.required_for ?? []).includes(riskClass))
  for (const zestaw of zestawy) {
    await bus.execute('safety.runs.record', {
      input: {
        ...scope,
        policyVersionId,
        suiteKey: zestaw.suite_key,
        result: 'pass',
        ranAt: new Date(),
      },
      ctx,
    })
  }
}

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

    const version = await versionByKey(em, scope.tenantId, 'pick-bin-ur10e', 2)
    if (version.status !== 'released') {
      await bus.execute('policy_registry.versions.transition', {
        input: { ...scope, policyVersionId: version.id, toStatus: 'released', reason: 'Dowód fazy 4' },
        ctx,
      })
    }

    const pierwszy = await robotBySerial(em, scope.tenantId, String(args.robot1 ?? 'UR10E-0001'))
    const drugi = await robotBySerial(em, scope.tenantId, String(args.robot2 ?? 'UR10E-0002'))

    console.log('DOWÓD FAZY 4 — brama etapowa odwołuje się do liczb, nie do opinii\n')

    /**
     * Dowód zaczyna od znanego punktu wyjścia.
     *
     * Robot dostaje v1 przed wdrożeniem v2, żeby wycofanie miało dokąd wrócić.
     * Bez tego powtórne uruchomienie dowodu zastawałoby maszynę już na v2
     * i „wycofanie" sprowadzałoby się do przypisania jej tego, co ma —
     * widać by było werdykt, a nie skutek.
     */
    const bazowa = await versionByKey(em, scope.tenantId, 'pick-bin-ur10e', 1)
    if (bazowa.status !== 'released') {
      await bus.execute('policy_registry.versions.transition', {
        input: { ...scope, policyVersionId: bazowa.id, toStatus: 'released', reason: 'Dowód fazy 4 — punkt wyjścia' },
        ctx,
      })
    }
    /*
     * Brama bezpieczeństwa z fazy 5 stoi przed każdym przypisaniem. Dowód
     * fazy 4 mówi o bramie ETAPOWEJ, nie o bezpieczeństwie, więc musi sam
     * doprowadzić obie wersje do stanu dopuszczonego — inaczej mierzyłby
     * cudzą odmowę zamiast własnego progu.
     */
    const cela = await em.getConnection().execute<Array<{ cell_class: string; risk_class: string }>>(
      `select c.cell_class, c.risk_class from fleet_robots r
         join fleet_cells c on c.id = r.cell_id where r.id = ? limit 1`,
      [pierwszy.id],
    )
    if (!cela.length) throw new Error('Robot dowodu nie stoi w celi — uruchom: yarn mercato fleet seed')
    for (const wersja of [bazowa.id, version.id]) {
      await zapewnijDopuszczenie(em, bus, ctx, scope, wersja, cela[0].cell_class, cela[0].risk_class)
    }
    console.log(`   dopuszczenie dla klasy ${cela[0].cell_class}: ustanowione dla v1 i v2`)

    await bus.execute('deployment.assignments.assign', {
      input: {
        ...scope,
        robotId: pierwszy.id,
        policyVersionId: bazowa.id,
        reason: 'Dowód fazy 4 — ustawienie punktu wyjścia',
      },
      ctx,
    })
    console.log(`   przed wdrożeniem: UR10E-0001 → ${await currentAssignment(em, scope.tenantId, pierwszy.id)}`)

    const progi = {
      minEpisodes: 20,
      maxInterventionRate: 0.1,
      maxSevereRate: 0.02,
      minSuccessRate: 0.8,
    }
    console.log(
      `   progi etapu: ep ≥ ${progi.minEpisodes}, interwencje ≤ ${(progi.maxInterventionRate * 100).toFixed(0)}%, ` +
        `ciężkie ≤ ${(progi.maxSevereRate * 100).toFixed(0)}%, skuteczność ≥ ${(progi.minSuccessRate * 100).toFixed(0)}%`,
    )

    /* ---------- A. Etap z przekroczonym progiem ---------- */
    /*
     * Wycofanie idzie PIERWSZE, a nie drugie.
     *
     * Kolejność ma znaczenie dla samego dowodu: gdyby najpierw przeszło
     * wdrożenie udane, robot miałby już wersję docelową i wycofanie
     * sprowadziłoby się do przypisania mu tego, co i tak ma. Widać by było
     * werdykt, a nie skutek. Przy tej kolejności robot wraca z v2 na v1
     * i skutek jest w wydruku.
     */
    console.log('\nA) wdrożenie, które przekracza próg interwencji')
    const zly = (
      await bus.execute('rollout.rollouts.plan', {
        input: {
          ...scope,
          name: `Dowód 4A — próg przekroczony (${stamp})`,
          policyVersionId: version.id,
          stages: [
            { name: 'Etap 1 — jeden robot', robotIds: [pierwszy.id], thresholds: progi },
            { name: 'Etap 2 — reszta celi', robotIds: [drugi.id], thresholds: progi },
          ],
        },
        ctx,
      })
    ).result as { rolloutId: string; stageIds: string[] }

    const przedWycofaniem = await currentAssignment(em, scope.tenantId, pierwszy.id)
    await bus.execute('rollout.stages.start', { input: { ...scope, stageId: zly.stageIds[0] }, ctx })
    console.log(`   etap 1 uruchomiony; UR10E-0001 → ${await currentAssignment(em, scope.tenantId, pierwszy.id)}`)

    // Co czwarty epizod z interwencją: 25% wobec progu 10%.
    const brudne = await feedEpisodes(bus, ctx, scope, {
      robotId: pierwszy.id,
      policyVersionId: version.id,
      count: 24,
      interventionEvery: 4,
      severeEvery: null,
      tag: `r4a-brudne-${stamp}`,
    })
    console.log(`   etap 1: ${brudne.episodes} epizodów, ${brudne.interventions} interwencji`)

    const werdyktB = (
      await bus.execute('rollout.gates.evaluate', { input: { ...scope, stageId: zly.stageIds[0] }, ctx })
    ).result as {
      decision: string
      reason: string
      haltedStages: number
      rolledBackRobots: number
      measured: { episodes: number; interventionRate: number; successRate: number }
    }

    console.log(`   brama etapu 1: ${werdyktB.decision} — ${werdyktB.reason}`)
    console.log(
      `   zatrzymanych etapów następnych: ${werdyktB.haltedStages}; wycofanych robotów: ${werdyktB.rolledBackRobots}`,
    )
    console.log(
      `   po wycofaniu: UR10E-0001 → ${await currentAssignment(em, scope.tenantId, pierwszy.id)} (przed wdrożeniem miał ${przedWycofaniem})`,
    )

    const startB2 = await bus
      .execute('rollout.stages.start', { input: { ...scope, stageId: zly.stageIds[1] }, ctx })
      .then(() => 'etap 2 URUCHOMIONY — BŁĄD DOWODU')
      .catch((error: Error) => `etap 2 odrzucony: ${error.message}`)
    console.log(`   ${startB2}`)

    /* ---------- B. Etap z czystymi liczbami ---------- */
    console.log('\nB) wdrożenie, które przechodzi bramę')
    const dobry = (
      await bus.execute('rollout.rollouts.plan', {
        input: {
          ...scope,
          name: `Dowód 4B — czyste liczby (${stamp})`,
          policyVersionId: version.id,
          stages: [
            { name: 'Etap 1 — jeden robot', robotIds: [pierwszy.id], thresholds: progi },
            { name: 'Etap 2 — reszta celi', robotIds: [drugi.id], thresholds: progi },
          ],
        },
        ctx,
      })
    ).result as { rolloutId: string; stageIds: string[] }

    await bus.execute('rollout.stages.start', { input: { ...scope, stageId: dobry.stageIds[0] }, ctx })
    const czyste = await feedEpisodes(bus, ctx, scope, {
      robotId: pierwszy.id,
      policyVersionId: version.id,
      count: 25,
      interventionEvery: null,
      severeEvery: null,
      tag: `r4b-czyste-${stamp}`,
    })
    console.log(`   etap 1: ${czyste.episodes} epizodów, ${czyste.interventions} interwencji`)

    const werdyktA = (
      await bus.execute('rollout.gates.evaluate', { input: { ...scope, stageId: dobry.stageIds[0] }, ctx })
    ).result as { decision: string; reason: string }
    console.log(`   brama etapu 1: ${werdyktA.decision} — ${werdyktA.reason}`)

    const startB = await bus
      .execute('rollout.stages.start', { input: { ...scope, stageId: dobry.stageIds[1] }, ctx })
      .then(() => 'etap 2 uruchomiony')
      .catch((error: Error) => `etap 2 ODRZUCONY: ${error.message}`)
    console.log(`   ${startB}`)

    /* ---------- C. Kto podjął decyzję ---------- */
    const wpisy = await em.getConnection().execute<Array<{ decision: string; actor_user_id: string | null }>>(
      `select g.decision, g.actor_user_id
         from rollout_gate_evaluations g
        where g.rollout_id in (?, ?) order by g.evaluated_at`,
      [dobry.rolloutId, zly.rolloutId],
    )
    console.log('\nC) dziennik bramy — kto zdecydował')
    for (const wpis of wpisy) {
      console.log(`   ${wpis.decision.padEnd(9)} ${wpis.actor_user_id === null ? 'automat' : 'człowiek'}`)
    }

    console.log('\n   Wniosek: ta sama brama, te same progi, dwa różne zestawy liczb,')
    console.log('   dwie różne decyzje — i obie bez podpisu człowieka.')
  },
}

export default [statusCommand, proveCommand] satisfies ModuleCli[]
