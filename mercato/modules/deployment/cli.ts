import { generateKeyPairSync, sign as signPayload, type KeyObject } from 'node:crypto'
import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { fingerprintPublicKey, payloads } from '../edge/lib/crypto'
import { leasePayload } from './lib/protocol'
import { LEASE_SECONDS, evaluateAuthorization, leaseSecondsFor } from './lib/lease'

/**
 * Komendy operatorskie kanału stanu pożądanego.
 *
 * `prove` odtwarza dowód fazy na żywej bazie i nie jest atrapą: agent generuje
 * prawdziwą parę Ed25519, podpisuje prawdziwe żądanie dzierżawy i przechodzi
 * tę samą ścieżkę uwierzytelnienia, co agent na robocie. Symulacja omijająca
 * podpis dowodziłaby wyłącznie tego, że da się napisać symulację.
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

function keypair(): { publicKeyPem: string; privateKey: KeyObject; fingerprint: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  return { publicKeyPem, privateKey, fingerprint: fingerprintPublicKey(publicKeyPem) }
}

function sign(privateKey: KeyObject, payload: string): string {
  return signPayload(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64')
}

/**
 * Wpięcie świeżego agenta dla robota i zwrócenie sesji.
 *
 * Każde wywołanie zakłada nową sesję, bo licznik kolejny dzierżaw jest per
 * sesja - tak samo jak licznik uderzeń serca. Agent po restarcie zaczyna od nowa.
 */
async function enrollAgent(
  bus: CommandBus,
  ctx: CommandRuntimeContext,
  scope: Scope,
  robotId: string,
  em: EntityManager,
): Promise<{ sessionId: string; privateKey: KeyObject }> {
  /**
   * Poprzedni agent robota jest odwoływany, a nie omijany.
   *
   * Kanał brzegowy dopuszcza jednego czynnego agenta na robota i słusznie -
   * dwa komputery pokładowe podpisujące się jako ta sama maszyna to stan,
   * którego nie da się rozstrzygnąć. Dowód potrzebuje własnej pary kluczy,
   * więc przechodzi tę samą drogą, co technik wymieniający komputer pokładowy:
   * odwołanie starego, wpis nowego. Odrzucona alternatywa - sięgnięcie po
   * istniejącą sesję - jest niewykonalna z założenia, bo klucz prywatny
   * poprzedniego agenta nigdy nie opuścił robota.
   */
  const current = await em.getConnection().execute<Array<{ id: string }>>(
    `select id from edge_agents where robot_id = ? and status = 'enrolled' limit 1`,
    [robotId],
  )
  if (current?.length) {
    await bus.execute('edge.agents.revoke', {
      input: { agentId: current[0].id, reason: 'Dowód fazy 2 - wymiana komputera pokładowego' },
      ctx,
    })
  }

  const key = keypair()
  const issued = (
    await bus.execute('edge.enrollment.issue', {
      input: { ...scope, robotId, ttlMinutes: 5, heartbeatIntervalSeconds: 30, livenessGraceSeconds: 30, lostAfterSeconds: 300 },
      ctx,
    })
  ).result as { token: string }

  const enrolled = (
    await bus.execute('edge.agents.enroll', {
      input: {
        token: issued.token,
        publicKey: key.publicKeyPem,
        signature: sign(key.privateKey, payloads.enroll(issued.token, key.fingerprint)),
        agentKind: 'onboard',
        agentVersion: 'prove-0.1.0',
      },
      ctx,
    })
  ).result as { sessionId: string }

  return { sessionId: enrolled.sessionId, privateKey: key.privateKey }
}

type RobotRow = { id: string; serial_number: string; cell_id: string | null; state: string }

async function findRobot(em: EntityManager, tenantId: string, serial: string): Promise<RobotRow> {
  const rows = await em.getConnection().execute<RobotRow[]>(
    `select id, serial_number, cell_id, state from fleet_robots
      where tenant_id = ? and serial_number = ? and deleted_at is null limit 1`,
    [tenantId, serial],
  )
  if (!rows?.length) throw new Error(`Nie znaleziono robota ${serial}. Uruchom: yarn mercato fleet seed`)
  return rows[0]
}

/**
 * Cela publiczna zakładana surowym INSERT-em, a nie komendą modułu `fleet`.
 *
 * `fleet` nie ma komendy tworzenia celi - ma ją zasiew, który celowo zakłada
 * jedną celę ogrodzoną. Dopisywanie tu komendy do obcego modułu byłoby
 * rozlewaniem granicy; celowany INSERT z jawnym `on conflict do nothing` jest
 * uczciwszy i widać go w kodzie. Gdyby cele zaczęły powstawać z interfejsu,
 * to jest pierwsze miejsce do przepisania.
 */
async function ensurePublicCell(em: EntityManager, scope: Scope): Promise<{ id: string; name: string }> {
  const sites = await em.getConnection().execute<Array<{ id: string }>>(
    `select id from fleet_sites where tenant_id = ? and deleted_at is null order by created_at limit 1`,
    [scope.tenantId],
  )
  if (!sites?.length) throw new Error('Brak obiektu w rejestrze floty. Uruchom: yarn mercato fleet seed')

  await em.getConnection().execute(
    `insert into fleet_cells (organization_id, tenant_id, site_id, code, name, cell_class, risk_class, created_at, updated_at)
     values (?, ?, ?, 'CELA-P', 'Cela P - stanowisko w przestrzeni publicznej', 'public-handover', 'public', now(), now())
     on conflict on constraint fleet_cells_code_unique do nothing`,
    [scope.organizationId, scope.tenantId, sites[0].id],
  )

  const rows = await em.getConnection().execute<Array<{ id: string; name: string }>>(
    `select id, name from fleet_cells where tenant_id = ? and code = 'CELA-P' limit 1`,
    [scope.tenantId],
  )
  return rows[0]
}

/**
 * Przypisanie polityki robotowi z wiersza poleceń.
 *
 * Istnieje, bo bez niego jedyną drogą do stanu pożądanego jest dowód fazy,
 * a dowód ma pokazywać zachowanie, nie być narzędziem administracyjnym.
 * Komenda nie omija żadnej bramki - idzie tą samą szyną, co panel.
 */
const assignCliCommand: ModuleCli = {
  command: 'assign',
  async run(rest) {
    const args = parseArgs(rest)
    const serial = typeof args.robot === 'string' ? args.robot : ''
    const policyKey = typeof args.policy === 'string' ? args.policy : ''
    if (!serial || !policyKey) {
      throw new Error('Podaj: --robot <numer seryjny> --policy <klucz polityki> [--version <n>]')
    }

    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const bus = container.resolve('commandBus') as CommandBus
    const scope = await resolveScope(em, args)
    const ctx = buildCommandContext(container, scope)

    const robot = await findRobot(em, scope.tenantId, serial)

    const wanted = args.version ? Number(args.version) : null
    const versions = await em.getConnection().execute<Array<{ id: string; version: number; status: string }>>(
      `select v.id, v.version, v.status
         from policy_registry_policy_versions v
         join policy_registry_policies p on p.id = v.policy_id
        where v.tenant_id = ? and p.policy_key = ?
          and (? is null or v.version = ?::int)
        order by v.version desc limit 1`,
      [scope.tenantId, policyKey, wanted, wanted],
    )
    if (!versions?.length) throw new Error(`Nie znaleziono wersji polityki ${policyKey}.`)
    const version = versions[0]

    if (version.status !== 'released') {
      // Wypuszczenie jest osobną decyzją i osobnym uprawnieniem; tutaj mówimy
      // o tym wprost zamiast robić to po cichu w tle przypisania.
      if (!args.release) {
        throw new Error(
          `Wersja ${policyKey} v${version.version} ma status ${version.status}. Dodaj --release, żeby ją wypuścić przed przypisaniem.`,
        )
      }
      await bus.execute('policy_registry.versions.transition', {
        input: { ...scope, policyVersionId: version.id, toStatus: 'released', reason: `Wypuszczenie przed przypisaniem do ${serial}` },
        ctx,
      })
      console.log(`Wypuszczono ${policyKey} v${version.version}`)
    }

    const result = (
      await bus.execute('deployment.assignments.assign', {
        input: {
          ...scope,
          robotId: robot.id,
          policyVersionId: version.id,
          reason: typeof args.reason === 'string' ? args.reason : `Przypisanie z CLI do ${serial}`,
          allowNonOperational: Boolean(args.force),
        },
        ctx,
      })
    ).result as { assignmentId: string; riskClass: string; leaseSeconds: number; supersededId: string | null }

    console.log(
      `${serial} ← ${policyKey} v${version.version}; cela ${result.riskClass}, dzierżawa ${result.leaseSeconds} s` +
        (result.supersededId ? ' (poprzednie przypisanie w historii)' : ''),
    )
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
      serial_number: string
      policy_key: string
      version: number
      risk_class: string
      lease_seconds: number
      desired_state: string
      expires_at: string | null
      revoked_at: string | null
    }>>(
      `select r.serial_number, p.policy_key, v.version, a.risk_class, a.lease_seconds, a.desired_state,
              l.expires_at, l.revoked_at
         from deployment_assignments a
         join fleet_robots r on r.id = a.robot_id
         join policy_registry_policy_versions v on v.id = a.policy_version_id
         join policy_registry_policies p on p.id = v.policy_id
         left join lateral (select expires_at, revoked_at from deployment_leases
                             where assignment_id = a.id order by issued_at desc limit 1) l on true
        where a.tenant_id = ? and a.superseded_at is null and a.revoked_at is null
        order by r.serial_number`,
      [scope.tenantId],
    )

    if (!rows.length) {
      console.log('Żaden robot nie ma przypisanej polityki. Uruchom: yarn mercato deployment prove')
      return
    }

    console.log(`Stan pożądany (tenant ${scope.tenantId}): ${rows.length} przypisań\n`)
    console.log('  robot          polityka             ryzyko     dzierżawa   mandat')
    console.log('  ' + '-'.repeat(84))
    for (const row of rows) {
      const auth = evaluateAuthorization({
        desiredState: row.desired_state as 'running' | 'stopped',
        lease: row.expires_at
          ? { expiresAt: new Date(row.expires_at), revokedAt: row.revoked_at ? new Date(row.revoked_at) : null }
          : null,
      })
      console.log(
        `  ${row.serial_number.padEnd(14)} ${`${row.policy_key} v${row.version}`.padEnd(20)} ${row.risk_class.padEnd(10)} ${String(row.lease_seconds).padStart(7)}s   ${auth.working ? 'ważny' : 'WYGASŁ'} - ${auth.reason}`,
      )
    }
  },
}

/**
 * Dowód fazy 2.
 *
 * Zdanie z mapy faz brzmi: *po wygaśnięciu dzierżawy robot w celi `public`
 * przechodzi do stanu niepracującego bez udziału centrali; ten sam robot
 * w celi `fenced` pracuje dalej.*
 *
 * „Ten sam robot" jest tu wzięte dosłownie: jedna maszyna dostaje dwie
 * dzierżawy - jedną stojąc w celi ogrodzonej, drugą po przestawieniu do celi
 * publicznej. Oba wiersze są prawdziwe i oba wydane w odstępie sekundy, więc
 * po odczekaniu tej samej ciszy porównujemy wyłącznie klasę ryzyka. Wariant
 * z dwoma różnymi robotami byłby wygodniejszy i słabszy - mieszałby do dowodu
 * różnicę egzemplarzy.
 */
const proveCommand: ModuleCli = {
  command: 'prove',
  async run(rest) {
    const args = parseArgs(rest)
    const waitSeconds = Number(args.wait ?? LEASE_SECONDS.public + 5)
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const bus = container.resolve('commandBus') as CommandBus
    const scope = await resolveScope(em, args)
    const ctx = buildCommandContext(container, scope)

    console.log('DOWÓD FAZY 2 - dzierżawa jako odwrotność heartbeatu\n')
    console.log('Długość dzierżawy per klasa ryzyka (z lib/lease.ts):')
    for (const [klasa, sekundy] of Object.entries(LEASE_SECONDS)) {
      console.log(`  ${klasa.padEnd(8)} ${String(sekundy).padStart(7)} s`)
    }

    const robot = await findRobot(em, scope.tenantId, String(args.robot ?? 'UR10E-0001'))
    if (robot.state !== 'operational') {
      console.log(`\nRobot ${robot.serial_number} jest w stanie ${robot.state}, a nie operational - przerywam.`)
      return
    }

    // Wersja polityki musi być wypuszczona; zasiew rejestru zostawia ją zarejestrowaną.
    const versions = await em.getConnection().execute<Array<{ id: string; status: string; policy_key: string; version: number }>>(
      `select v.id, v.status, p.policy_key, v.version
         from policy_registry_policy_versions v
         join policy_registry_policies p on p.id = v.policy_id
         join fleet_robots r on r.embodiment_revision_id = v.embodiment_revision_id
        where v.tenant_id = ? and r.id = ?
        order by v.version limit 1`,
      [scope.tenantId, robot.id],
    )
    if (!versions?.length) {
      console.log('\nBrak wersji polityki dla rewizji embodimentu tego robota. Uruchom: yarn mercato policy_registry seed')
      return
    }
    const version = versions[0]
    if (version.status !== 'released') {
      await bus.execute('policy_registry.versions.transition', {
        input: { ...scope, policyVersionId: version.id, toStatus: 'released', reason: 'Dowód fazy 2' },
        ctx,
      })
      console.log(`\nWypuszczono ${version.policy_key} v${version.version} - bez tego przypisanie odbija się o status.`)
    }

    const originalCellId = robot.cell_id
    const publicCell = await ensurePublicCell(em, scope)

    // --- 1. Cela ogrodzona -------------------------------------------------
    console.log(`\n1) ${robot.serial_number} stoi w celi ogrodzonej`)
    const fenced = (
      await bus.execute('deployment.assignments.assign', {
        input: {
          ...scope,
          robotId: robot.id,
          policyVersionId: version.id,
          reason: 'Dowód fazy 2 - cela ogrodzona',
        },
        ctx,
      })
    ).result as { assignmentId: string; riskClass: string; leaseSeconds: number }
    console.log(`   klasa ryzyka ${fenced.riskClass}, dzierżawa ${fenced.leaseSeconds} s`)

    const fencedAgent = await enrollAgent(bus, ctx, scope, robot.id, em)
    // Podpis liczony z **tego samego** znacznika czasu, który idzie w żądaniu.
    // Dwa osobne `new Date()` dałyby dwa różne ciągi i odmowę podpisu -
    // pułapka warta nazwania, bo wygląda niewinnie i wywala się raz na dziesięć.
    const fencedStamp = new Date().toISOString()
    const fencedLease = (
      await bus.execute('deployment.leases.issue', {
        input: {
          organizationId: scope.organizationId,
          agentSessionId: fencedAgent.sessionId,
          sequence: 1,
          timestamp: fencedStamp,
          signature: sign(fencedAgent.privateKey, leasePayload(fencedAgent.sessionId, 1, fencedStamp)),
        },
        ctx,
      })
    ).result as { expiresAt: string; leaseSeconds: number; renewAfterSeconds: number }
    console.log(`   mandat do ${fencedLease.expiresAt} (odnowienie po ${fencedLease.renewAfterSeconds} s)`)

    // --- 2. Ten sam robot, cela publiczna ----------------------------------
    console.log(`\n2) ten sam robot przestawiony do celi publicznej (${publicCell.name})`)
    // Celowany UPDATE jednego wiersza - przestawienie maszyny między celami
    // jest czynnością hali, a nie masową korektą danych.
    await em.getConnection().execute(`update fleet_robots set cell_id = ?, updated_at = now() where id = ?`, [
      publicCell.id,
      robot.id,
    ])

    const pub = (
      await bus.execute('deployment.assignments.assign', {
        input: {
          ...scope,
          robotId: robot.id,
          policyVersionId: version.id,
          reason: 'Dowód fazy 2 - przestawienie do przestrzeni publicznej',
        },
        ctx,
      })
    ).result as { assignmentId: string; riskClass: string; leaseSeconds: number }
    console.log(`   klasa ryzyka ${pub.riskClass}, dzierżawa ${pub.leaseSeconds} s`)

    const pubAgent = await enrollAgent(bus, ctx, scope, robot.id, em)
    const pubStamp = new Date().toISOString()
    const pubLease = (
      await bus.execute('deployment.leases.issue', {
        input: {
          organizationId: scope.organizationId,
          agentSessionId: pubAgent.sessionId,
          sequence: 1,
          timestamp: pubStamp,
          signature: sign(pubAgent.privateKey, leasePayload(pubAgent.sessionId, 1, pubStamp)),
        },
        ctx,
      })
    ).result as { expiresAt: string; leaseSeconds: number }
    console.log(`   mandat do ${pubLease.expiresAt}`)

    // --- 3. Cisza ----------------------------------------------------------
    const writesBefore = await em.getConnection().execute<Array<{ n: string }>>(
      `select (select count(*) from deployment_leases where tenant_id = ?)
            + (select count(*) from deployment_assignments where tenant_id = ?) as n`,
      [scope.tenantId, scope.tenantId],
    )
    console.log(`\n3) cisza przez ${waitSeconds} s - centrala nie zapisuje niczego`)
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000))

    const writesAfter = await em.getConnection().execute<Array<{ n: string }>>(
      `select (select count(*) from deployment_leases where tenant_id = ?)
            + (select count(*) from deployment_assignments where tenant_id = ?) as n`,
      [scope.tenantId, scope.tenantId],
    )
    console.log(`   wierszy przed ciszą ${writesBefore[0].n}, po ciszy ${writesAfter[0].n}`)

    // --- 4. Odczyt obu mandatów -------------------------------------------
    const leases = await em.getConnection().execute<Array<{
      risk_class: string
      expires_at: string
      revoked_at: string | null
      lease_seconds: number
    }>>(
      `select a.risk_class, l.expires_at, l.revoked_at, l.lease_seconds
         from deployment_leases l
         join deployment_assignments a on a.id = l.assignment_id
        where l.robot_id = ? and a.id in (?, ?)
        order by l.issued_at`,
      [robot.id, fenced.assignmentId, pub.assignmentId],
    )

    console.log('\n4) ten sam robot, ta sama cisza, dwie klasy celi:')
    for (const lease of leases) {
      const auth = evaluateAuthorization({
        desiredState: 'running',
        lease: {
          expiresAt: new Date(lease.expires_at),
          revokedAt: lease.revoked_at ? new Date(lease.revoked_at) : null,
        },
      })
      console.log(
        `   cela ${lease.risk_class.padEnd(7)} (dzierżawa ${String(lease.lease_seconds).padStart(6)} s): ${auth.working ? 'PRACUJE' : 'NIE PRACUJE'} - ${auth.reason}`,
      )
    }

    // Sprzątanie: robot wraca do swojej celi, żeby dowód dało się powtórzyć.
    if (originalCellId) {
      await em.getConnection().execute(`update fleet_robots set cell_id = ?, updated_at = now() where id = ?`, [
        originalCellId,
        robot.id,
      ])
      console.log(`\n   (robot wrócił do celi wyjściowej; przypisanie z celi publicznej zostaje w historii)`)
    }

    console.log('\n   Wniosek: o zatrzymaniu rozstrzygnął upływ czasu i jedna liczba wzięta')
    console.log('   z klasy ryzyka celi. Centrala nie wykonała żadnego zapisu w międzyczasie,')
    console.log('   a robot bez łącza policzyłby to samo z własnego zegara.')
  },
}

/** Krótka ściąga: jaka klasa ryzyka daje jaką dzierżawę. Używane w opisach wdrożeń. */
const leasesCommand: ModuleCli = {
  command: 'leases',
  async run(rest) {
    const args = parseArgs(rest)
    const klasa = typeof args.risk === 'string' ? args.risk : null
    if (klasa) {
      console.log(`${klasa}: ${leaseSecondsFor(klasa)} s`)
      return
    }
    for (const [name, seconds] of Object.entries(LEASE_SECONDS)) {
      console.log(`${name.padEnd(8)} ${String(seconds).padStart(7)} s`)
    }
    console.log('\nNieznana klasa ryzyka dostaje najkrótszą dzierżawę, nie najdłuższą.')
  },
}

export default [assignCliCommand, statusCommand, proveCommand, leasesCommand] satisfies ModuleCli[]
