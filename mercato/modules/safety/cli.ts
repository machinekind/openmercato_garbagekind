import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { DEFAULT_SUITES, type ClearanceVerdict } from './lib/clearance'

/**
 * Komendy operatorskie warstwy bezpieczeństwa.
 *
 * `prove` odtwarza dowód fazy: wersja polityki bez kompletu przejść
 * ewaluacyjnych nie daje się wdrożyć w celi klasy, dla której uzasadnienie
 * nie zostało zatwierdzone — i odmowa przychodzi z **kanału stanu
 * pożądanego**, a nie z osobnego raportu.
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

const SUITE_NAMES: Record<string, string> = {
  'reach-envelope': 'Koperta zasięgu — ramię nie wychodzi poza obszar roboczy',
  'grasp-release-integrity': 'Integralność chwytu i zwolnienia',
  'out-of-distribution-halt': 'Zatrzymanie przy obserwacji spoza rozkładu',
  'force-pressure-limits': 'Limity siły i nacisku (ISO/TS 15066)',
  'bystander-detection': 'Wykrywanie osób postronnych',
}

const seedCommand: ModuleCli = {
  command: 'seed',
  async run(rest) {
    const args = parseArgs(rest)
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const bus = container.resolve('commandBus') as CommandBus
    const scope = await resolveScope(em, args)
    const ctx = buildCommandContext(container, scope)

    console.log('Katalog zestawów ewaluacyjnych:')
    for (const suite of DEFAULT_SUITES) {
      await bus.execute('safety.suites.define', {
        input: {
          ...scope,
          suiteKey: suite.suiteKey,
          name: SUITE_NAMES[suite.suiteKey] ?? suite.suiteKey,
          requiredFor: suite.requiredFor,
          caseCount: 20,
        },
        ctx,
      })
      console.log(`  ${suite.suiteKey.padEnd(26)} wymagany dla: ${suite.requiredFor.join(', ')}`)
    }
    console.log('\n  Cela ogrodzona wymaga najmniej, przestrzeń publiczna najwięcej.')
    console.log('  Limity siły z ISO/TS 15066 nie obowiązują za płotem — rytuał uczy omijania wymagań.')
  },
}

const statusCommand: ModuleCli = {
  command: 'status',
  async run(rest) {
    const args = parseArgs(rest)
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const scope = await resolveScope(em, args)

    const cases = await em.getConnection().execute<Array<{
      label: string
      cell_class: string
      status: string
      valid_until: string | null
      declared_as_safety_function: boolean
    }>>(
      `select p.policy_key || ' v' || v.version as label, c.cell_class, c.status, c.valid_until,
              c.declared_as_safety_function
         from safety_cases c
         join policy_registry_policy_versions v on v.id = c.policy_version_id
         join policy_registry_policies p on p.id = v.policy_id
        where c.tenant_id = ? order by 1, 2`,
      [scope.tenantId],
    )

    if (!cases.length) {
      console.log('Brak uzasadnień bezpieczeństwa. Uruchom: yarn mercato safety prove')
      return
    }

    console.log(`Uzasadnienia bezpieczeństwa (tenant ${scope.tenantId})\n`)
    console.log('  wersja                klasa celi              status       ważne do')
    console.log('  ' + '-'.repeat(78))
    for (const row of cases) {
      const ostrzezenie = row.declared_as_safety_function ? '  !! FUNKCJA BEZPIECZEŃSTWA' : ''
      console.log(
        `  ${row.label.padEnd(21)} ${row.cell_class.padEnd(23)} ${row.status.padEnd(12)} ${row.valid_until ? new Date(row.valid_until).toISOString().slice(0, 10) : '—'}${ostrzezenie}`,
      )
    }
  },
}

/**
 * Dowód fazy 5.
 *
 * Zdanie z mapy faz: *wersja polityki bez kompletu przejść ewaluacyjnych nie
 * daje się wdrożyć w celi klasy, dla której uzasadnienie nie zostało
 * zatwierdzone.*
 *
 * Kluczowe jest, **skąd** przychodzi odmowa: nie z osobnego raportu, tylko
 * z komendy przypisania stanu pożądanego. Raport mówiący „nie wolno" obok
 * kanału, który i tak wdroży, nie jest bramą.
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

    const robots = await em.getConnection().execute<Array<{
      id: string
      serial_number: string
      cell_class: string
      risk_class: string
    }>>(
      `select r.id, r.serial_number, c.cell_class, c.risk_class
         from fleet_robots r join fleet_cells c on c.id = r.cell_id
        where r.tenant_id = ? and r.state = 'operational' and r.deleted_at is null
        order by r.serial_number limit 1`,
      [scope.tenantId],
    )
    if (!robots.length) {
      console.log('Brak robota w ruchu stojącego w celi. Uruchom: yarn mercato fleet seed')
      return
    }
    const robot = robots[0]

    const versions = await em.getConnection().execute<Array<{ id: string; label: string; status: string }>>(
      `select v.id, p.policy_key || ' v' || v.version as label, v.status
         from policy_registry_policy_versions v
         join policy_registry_policies p on p.id = v.policy_id
         join fleet_robots r on r.embodiment_revision_id = v.embodiment_revision_id
        where v.tenant_id = ? and r.id = ? order by v.version limit 1`,
      [scope.tenantId, robot.id],
    )
    if (!versions.length) {
      console.log('Brak wersji polityki dla rewizji tego robota. Uruchom: yarn mercato policy_registry seed')
      return
    }
    const version = versions[0]
    if (version.status !== 'released') {
      await bus.execute('policy_registry.versions.transition', {
        input: { ...scope, policyVersionId: version.id, toStatus: 'released', reason: 'Dowód fazy 5' },
        ctx,
      })
    }

    console.log('DOWÓD FAZY 5 — dopuszczenie dotyczy klasy celi, nie celi\n')
    console.log(`   robot ${robot.serial_number}, klasa celi ${robot.cell_class}, ryzyko ${robot.risk_class}`)
    console.log(`   wersja ${version.label}`)

    /**
     * Stan wyjściowy dowodu: uzasadnienie wycofane, przebiegi wyczyszczone.
     *
     * Celowane UPDATE-y i DELETE dotyczące **tej jednej wersji polityki**,
     * a nie masowe czyszczenie tabel. Wycofanie obejmuje wszystkie klasy celi
     * tej wersji, bo poprzedni przebieg zostawia sondę w klasie testowej,
     * a deklaracja funkcji bezpieczeństwa blokuje wersję wszędzie. Dowód ma być powtarzalny, ale nie
     * kosztem kasowania cudzych danych — ta sama zasada, co przy poprawkach
     * w księdze epizodów.
     */
    await em.getConnection().execute(
      `update safety_cases set status = 'withdrawn', withdrawn_reason = 'Dowód fazy 5 — reset punktu wyjścia', updated_at = now()
        where tenant_id = ? and policy_version_id = ? and status <> 'withdrawn'`,
      [scope.tenantId, version.id],
    )
    await em.getConnection().execute(
      `delete from safety_eval_runs where tenant_id = ? and policy_version_id = ?`,
      [scope.tenantId, version.id],
    )

    const wymagane = await em.getConnection().execute<Array<{ suite_key: string; required_for: string[] }>>(
      `select suite_key, required_for from safety_eval_suites where tenant_id = ? order by suite_key`,
      [scope.tenantId],
    )
    const dlaKlasy = wymagane.filter((s) => (s.required_for ?? []).includes(robot.risk_class))
    console.log(
      `   zestawy wymagane dla ryzyka ${robot.risk_class}: ${dlaKlasy.map((s) => s.suite_key).join(', ') || '(brak — uruchom safety seed)'}`,
    )

    async function sprobujWdrozyc(etykieta: string): Promise<void> {
      const wynik = await bus
        .execute('deployment.assignments.assign', {
          input: {
            ...scope,
            robotId: robot.id,
            policyVersionId: version.id,
            reason: `Dowód fazy 5 — ${etykieta}`,
          },
          ctx,
        })
        .then(() => 'WDROŻONE')
        .catch((error: Error) => `odbite: ${error.message}`)
      console.log(`   ${wynik}`)
    }

    async function sprawdzDopuszczenie(): Promise<ClearanceVerdict> {
      return (
        await bus.execute('safety.clearance.check', {
          input: {
            ...scope,
            policyVersionId: version.id,
            cellClass: robot.cell_class,
            riskClass: robot.risk_class,
          },
          ctx,
        })
      ).result as ClearanceVerdict
    }

    // 1. Nic nie ma: brak uzasadnienia, brak ewaluacji.
    console.log('\n1) brak uzasadnienia i brak przebiegów ewaluacyjnych')
    const w1 = await sprawdzDopuszczenie()
    console.log(`   dopuszczenie: ${w1.cleared}; powody: ${w1.reasons.join(' | ')}`)
    await sprobujWdrozyc('bez uzasadnienia')

    // 2. Komplet ewaluacji, ale uzasadnienie wciąż robocze.
    console.log('\n2) komplet zaliczonych zestawów, uzasadnienie tylko w wersji roboczej')
    for (const suite of dlaKlasy) {
      await bus.execute('safety.runs.record', {
        input: {
          ...scope,
          policyVersionId: version.id,
          suiteKey: suite.suite_key,
          result: 'pass',
          ranAt: new Date(),
          passedCases: 20,
          totalCases: 20,
          evidenceUri: `s3://evals/${version.id}/${suite.suite_key}.json`,
        },
        ctx,
      })
    }
    const draft = (
      await bus.execute('safety.cases.draft', {
        input: {
          ...scope,
          policyVersionId: version.id,
          cellClass: robot.cell_class,
          riskClass: robot.risk_class,
          standards: ['EU 2023/1230', 'ISO 10218-1:2025', 'ISO 10218-2:2025', 'ISO/TS 15066:2016'],
          safetyLayerKind: 'safety_rated_speed_limit',
          safetyLayer:
            'Kurtyna świetlna kat. 3 PL d + nadzorowane ograniczenie prędkości w sterowniku bezpieczeństwa; polityka nie uczestniczy w łańcuchu bezpieczeństwa.',
          hazards: [{ id: 'H1', opis: 'Zgniecenie przy chwycie', srodek: 'ograniczenie siły w sterowniku' }],
        },
        ctx,
      })
    ).result as { safetyCaseId: string }
    const w2 = await sprawdzDopuszczenie()
    console.log(`   dopuszczenie: ${w2.cleared}; powody: ${w2.reasons.join(' | ')}`)
    await sprobujWdrozyc('uzasadnienie robocze')

    // 3. Uzasadnienie zatwierdzone — wdrożenie przechodzi.
    console.log('\n3) uzasadnienie zatwierdzone dla KLASY celi')
    const rok = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
    await bus.execute('safety.cases.approve', {
      input: {
        ...scope,
        safetyCaseId: draft.safetyCaseId,
        approvedBy: scope.organizationId,
        validUntil: rok,
      },
      ctx,
    })
    const w3 = await sprawdzDopuszczenie()
    console.log(`   dopuszczenie: ${w3.cleared}`)
    await sprobujWdrozyc('komplet spełniony')

    // 4. Jeden zestaw powtórzony z wynikiem negatywnym.
    console.log('\n4) jeden zestaw przebiegł ponownie i nie przeszedł')
    if (dlaKlasy.length) {
      await bus.execute('safety.runs.record', {
        input: {
          ...scope,
          policyVersionId: version.id,
          suiteKey: dlaKlasy[0].suite_key,
          result: 'fail',
          ranAt: new Date(Date.now() + 1000),
          passedCases: 17,
          totalCases: 20,
        },
        ctx,
      })
      const w4 = await sprawdzDopuszczenie()
      console.log(`   dopuszczenie: ${w4.cleared}; powody: ${w4.reasons.join(' | ')}`)
      console.log('   (dopuszczenie bierze NAJNOWSZY przebieg, nie jakikolwiek zaliczony)')
      await sprobujWdrozyc('zestaw niezaliczony')
    }

    // 5. Próba zadeklarowania polityki jako funkcji bezpieczeństwa.
    console.log('\n5) próba zatwierdzenia uzasadnienia deklarującego politykę jako funkcję bezpieczeństwa')
    const klasaTestowa = `${robot.cell_class}-probe-${Date.now().toString(36)}`
    const zly = (
      await bus.execute('safety.cases.draft', {
        input: {
          ...scope,
          policyVersionId: version.id,
          cellClass: klasaTestowa,
          riskClass: robot.risk_class,
          safetyLayerKind: 'safety_rated_torque_limit',
          safetyLayer: 'Polityka sama pilnuje limitów siły.',
          declaredAsSafetyFunction: true,
        },
        ctx,
      })
    ).result as { safetyCaseId: string }

    const odmowa = await bus
      .execute('safety.cases.approve', {
        input: { ...scope, safetyCaseId: zly.safetyCaseId, approvedBy: scope.organizationId, validUntil: rok },
        ctx,
      })
      .then(() => 'ZATWIERDZONE — BŁĄD DOWODU')
      .catch((error: Error) => `odbite: ${error.message}`)
    console.log(`   ${odmowa}`)

    /**
     * Sprzątanie po sondzie — i to nie jest kosmetyka.
     *
     * Deklaracja „polityka jest funkcją bezpieczeństwa" dotyczy natury polityki,
     * nie jednej celi, więc dopuszczenie odmawia jej **we wszystkich** klasach.
     * Zostawiona sonda zablokowałaby tę wersję na stałe i wszędzie. Zachowanie
     * jest poprawne; to dowód musi po sobie posprzątać. Wycofanie, nie DELETE:
     * ślad po próbie zostaje w bazie razem z powodem.
     */
    await bus.execute('safety.cases.withdraw', {
      input: { ...scope, safetyCaseId: zly.safetyCaseId, reason: 'Dowód fazy 5 — sonda, sprzątanie' },
      ctx,
    })
    const w5 = await sprawdzDopuszczenie()
    console.log(`   po wycofaniu sondy dopuszczenie dla ${robot.cell_class}: ${w5.cleared} (powody: ${w5.reasons.join(' | ') || 'brak'})`)
    console.log('   (deklaracja dotyczy natury polityki, nie jednej celi — dopóki istniała,')
    console.log('    blokowała tę wersję we WSZYSTKICH klasach celi)')

    console.log('\n   Wniosek: odmowa przychodzi z kanału stanu pożądanego, a nie z osobnego')
    console.log('   raportu. Raport mówiący „nie wolno" obok kanału, który i tak wdroży,')
    console.log('   nie jest bramą.')
  },
}

/**
 * Dopisanie widgetu pulpitu do istniejących list ról.
 *
 * Obejście tej samej luki platformy, co `install-schedules`, tylko groźniejszej
 * w skutkach. `dashboard_role_widgets` trzyma **jawną listę dozwolonych
 * widgetów** na rolę, zapisaną przy inicjalizacji tenanta. Kod platformy czyta
 * ją tak: lista niepusta znaczy „wolno wyłącznie to, co na niej jest".
 *
 * Moduł doinstalowany później nie ma jak się na tej liście znaleźć, więc jego
 * widget nie pojawia się nawet w katalogu „Customize" — jest zarejestrowany,
 * załadowany i niewidoczny dla nikogo. Bez tej komendy byłby martwym kodem.
 *
 * Dopisujemy wyłącznie do ról, które już mają uprawnienie `safety.view` —
 * bezpośrednio albo przez wieloznacznik. Rola bez tego uprawnienia i tak
 * odbiłaby się o kontrolę cech przy renderowaniu, a dopisanie jej widgetu
 * byłoby cichą zmianą cudzej konfiguracji.
 */
const installWidgetsCommand: ModuleCli = {
  command: 'install-widgets',
  async run(_rest) {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager

    /*
     * Surowy SQL, nie encja rdzenia. Import klasy encji z obcego modułu
     * kończy się podwójną rejestracją metadanych MikroORM — to jest ta sama
     * pułapka, którą opisuje komentarz w `deployment/commands/assignments.ts`.
     */
    const wynik = await em.getConnection().execute<Array<{ role_id: string }>>(
      `update dashboard_role_widgets d
          set widget_ids_json = d.widget_ids_json || '["safety.dashboard.clearance"]'::jsonb,
              updated_at = now()
        where d.deleted_at is null
          and not (d.widget_ids_json @> '["safety.dashboard.clearance"]'::jsonb)
          and exists (
            select 1 from role_acls a
             where a.role_id = d.role_id
               and a.deleted_at is null
               and (a.features_json @> '["safety.view"]'::jsonb
                 or a.features_json @> '["safety.*"]'::jsonb)
          )
        returning d.role_id`,
    )

    const ile = Array.isArray(wynik) ? wynik.length : 0
    if (ile === 0) {
      console.log('Widget safety.dashboard.clearance: żadna lista nie wymagała zmiany.')
      console.log('Albo jest już dopisany, albo żadna rola nie ma uprawnienia safety.view.')
      return
    }
    console.log(`Widget safety.dashboard.clearance dopisany do list ról: ${ile}`)
    console.log('Widoczny po odświeżeniu pulpitu, w katalogu „Customize".')
  },
}

export default [seedCommand, statusCommand, proveCommand, installWidgetsCommand] satisfies ModuleCli[]
