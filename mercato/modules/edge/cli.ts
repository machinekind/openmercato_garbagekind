import { generateKeyPairSync, sign as signPayload, type KeyObject } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { ensureSessionsSweepSchedule } from './setup'
import { fingerprintPublicKey, payloads } from './lib/crypto'
import { evaluateLiveness } from './lib/liveness'

/**
 * Komendy operatorskie kanału brzegowego.
 *
 * `simulate` jest tu najważniejszy i nie jest atrapą: generuje prawdziwą parę
 * kluczy Ed25519, podpisuje prawdziwe komunikaty i przechodzi tę samą ścieżkę
 * uwierzytelnienia, co agent na robocie. Symulacja, która omijałaby podpis,
 * dowodziłaby wyłącznie tego, że da się napisać symulację.
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
 * Zamiana numeru seryjnego na identyfikator robota — surowym zapytaniem,
 * nie importem encji z modułu `fleet`.
 *
 * Kierunek zależności ma zostać jednostronny i luźny: `edge` zna kolumnę
 * `robot_id`, a nie model dziedzinowy floty.
 */
async function resolveRobotId(em: EntityManager, scope: Scope, hint: string): Promise<{ id: string; label: string }> {
  const rows = await em.getConnection().execute<Array<{ id: string; serial_number: string; name: string }>>(
    `select id, serial_number, name from fleet_robots
      where tenant_id = ? and deleted_at is null and (serial_number = ? or id::text = ?)
      limit 1`,
    [scope.tenantId, hint, hint],
  )
  if (!rows?.length) throw new Error(`Nie znaleziono robota: ${hint}`)
  return { id: rows[0].id, label: `${rows[0].serial_number} (${rows[0].name})` }
}

function keypair(): { publicKeyPem: string; privateKey: KeyObject; fingerprint: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  return { publicKeyPem, privateKey, fingerprint: fingerprintPublicKey(publicKeyPem) }
}

function sign(privateKey: KeyObject, payload: string): string {
  return signPayload(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64')
}

const issueCommand: ModuleCli = {
  command: 'issue',
  async run(rest) {
    const args = parseArgs(rest)
    const robotHint = typeof args.robot === 'string' ? args.robot : ''
    if (!robotHint) throw new Error('Podaj robota: --robot <numer seryjny|uuid>')

    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const scope = await resolveScope(em, args)
    const robot = await resolveRobotId(em, scope, robotHint)

    const bus = container.resolve('commandBus') as CommandBus
    const envelope = await bus.execute('edge.enrollment.issue', {
      input: {
        ...scope,
        robotId: robot.id,
        ttlMinutes: Number(args.ttl ?? 60),
        heartbeatIntervalSeconds: Number(args.interval ?? 30),
        livenessGraceSeconds: Number(args.grace ?? 30),
        lostAfterSeconds: Number(args.lost ?? 300),
      },
      ctx: buildCommandContext(container, scope),
    })

    const result = envelope.result as { token: string; expiresAt: Date }
    console.log(`Robot : ${robot.label}`)
    console.log(`Bilet : ${result.token}`)
    console.log(`Ważny : do ${new Date(result.expiresAt).toISOString()}`)
    // Ostrzeżenie nie jest kurtuazją: to jedyny moment, w którym jawny bilet
    // w ogóle istnieje po stronie centrali.
    console.log('\nBilet nie jest nigdzie zapisany w jawnej postaci — po zamknięciu terminala nie da się go odtworzyć.')
  },
}

const simulateCommand: ModuleCli = {
  command: 'simulate',
  async run(rest) {
    const args = parseArgs(rest)
    const robotHint = typeof args.robot === 'string' ? args.robot : ''
    if (!robotHint) throw new Error('Podaj robota: --robot <numer seryjny|uuid>')

    const beats = Number(args.beats ?? 3)
    const intervalSeconds = Number(args.interval ?? 2)
    const grace = Number(args.grace ?? 2)
    const lostAfter = Number(args.lost ?? 10)

    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const scope = await resolveScope(em, args)
    const robot = await resolveRobotId(em, scope, robotHint)
    const bus = container.resolve('commandBus') as CommandBus
    const ctx = buildCommandContext(container, scope)

    const key = keypair()
    console.log(`Robot     : ${robot.label}`)
    console.log(`Odcisk    : ${key.fingerprint.slice(0, 16)}…`)

    const issued = (
      await bus.execute('edge.enrollment.issue', {
        input: {
          ...scope,
          robotId: robot.id,
          ttlMinutes: 5,
          heartbeatIntervalSeconds: intervalSeconds,
          livenessGraceSeconds: grace,
          lostAfterSeconds: lostAfter,
        },
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
          agentVersion: 'sim-0.1.0',
          heartbeatIntervalSeconds: intervalSeconds,
          livenessGraceSeconds: grace,
          lostAfterSeconds: lostAfter,
        },
        ctx,
      })
    ).result as { agentId: string; sessionId: string }

    console.log(`Agent     : ${enrolled.agentId}`)
    console.log(`Sesja     : ${enrolled.sessionId}`)
    console.log(`Progi     : odstęp ${intervalSeconds}s, tolerancja ${grace}s, utrata po ${lostAfter}s\n`)

    for (let sequence = 1; sequence <= beats; sequence += 1) {
      const iso = new Date().toISOString()
      const envelope = await bus.execute('edge.agents.heartbeat', {
        input: {
          sessionId: enrolled.sessionId,
          sequence,
          timestamp: iso,
          signature: sign(key.privateKey, payloads.heartbeat(enrolled.sessionId, sequence, iso)),
        },
        ctx,
      })
      const result = envelope.result as { state: string; nextDeadline: Date }
      console.log(
        `  #${sequence} ${result.state}  termin ${new Date(result.nextDeadline).toISOString().slice(11, 19)}`,
      )
      if (sequence < beats) await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000))
    }

    console.log('\nAgent milknie — to jest moment odcięcia zasilania.')
    console.log(`Po ${lostAfter} s uruchom: mercato edge sweep`)
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
      serial_number: string | null
      agent_kind: string
      status: 'enrolled' | 'revoked'
      last_seen_at: string | null
      heartbeat_interval_seconds: number
      liveness_grace_seconds: number
      lost_after_seconds: number
      fingerprint: string | null
      open_sessions: string
    }>>(
      `select r.serial_number, a.agent_kind, a.status, a.last_seen_at,
              a.heartbeat_interval_seconds, a.liveness_grace_seconds, a.lost_after_seconds,
              k.fingerprint,
              (select count(*) from edge_agent_sessions s where s.agent_id = a.id and s.ended_at is null) as open_sessions
         from edge_agents a
         left join fleet_robots r on r.id = a.robot_id
         left join lateral (
              select fingerprint from edge_agent_keys k
               where k.agent_id = a.id and k.revoked_at is null
               order by k.active_from desc limit 1
         ) k on true
        where a.tenant_id = ?
        order by r.serial_number nulls last`,
      [scope.tenantId],
    )

    if (!rows.length) {
      console.log('Żaden agent nie jest wpisany.')
      return
    }

    const now = new Date()
    for (const row of rows) {
      const verdict = evaluateLiveness(
        {
          lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at) : null,
          heartbeatIntervalSeconds: row.heartbeat_interval_seconds,
          livenessGraceSeconds: row.liveness_grace_seconds,
          lostAfterSeconds: row.lost_after_seconds,
          status: row.status,
        },
        now,
      )
      const silence = verdict.silenceSeconds === null ? '—' : `${verdict.silenceSeconds}s`
      console.log(
        [
          (row.serial_number ?? '—').padEnd(14),
          row.status.padEnd(9),
          verdict.state.padEnd(11),
          `cisza=${silence}`.padEnd(14),
          `sesje=${row.open_sessions}`.padEnd(9),
          (row.fingerprint ?? '').slice(0, 12),
        ].join(' '),
      )
    }
  },
}


/**
 * Rejestracja harmonogramu w tenancie, który już istnieje.
 *
 * Platforma woła `seedDefaults` wyłącznie przy inicjalizacji tenanta, więc
 * moduł **doinstalowany później nigdy nie zarejestrowałby swojego zadania
 * cyklicznego** — i nikt by tego nie zauważył, bo brak zadania nie generuje
 * błędu, tylko ciszę. Ta komenda domyka tę lukę i jest idempotentna:
 * identyfikator harmonogramu jest stały, a `register` nadpisuje.
 */
const installSchedulesCommand: ModuleCli = {
  command: 'install-schedules',
  async run(_rest) {
    const container = await createRequestContainer()
    await ensureSessionsSweepSchedule(container as unknown as import('awilix').AwilixContainer)
    console.log('Harmonogram zamiatania sesji po ciszy: zarejestrowany (albo już był).')
    console.log('Sprawdzenie: yarn mercato scheduler list')
  },
}

const sweepCommand: ModuleCli = {
  command: 'sweep',
  async run(rest) {
    const args = parseArgs(rest)
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const scope = await resolveScope(em, args)

    const bus = container.resolve('commandBus') as CommandBus
    const envelope = await bus.execute('edge.sessions.sweep', {
      input: scope,
      ctx: buildCommandContext(container, scope),
    })
    const result = envelope.result as {
      closed: number
      lost: Array<{ robotId: string; silenceSeconds: number | null }>
    }

    console.log(`Zamknięto sesji po ciszy: ${result.closed}`)
    for (const entry of result.lost) {
      const robot = await em.getConnection().execute<Array<{ serial_number: string }>>(
        'select serial_number from fleet_robots where id = ? limit 1',
        [entry.robotId],
      )
      console.log(`  utracony: ${robot[0]?.serial_number ?? entry.robotId} — cisza ${entry.silenceSeconds}s`)
    }
    if (result.lost.length) {
      // Zamiatanie stwierdza ciszę; decyzja o kwarantannie należy do floty.
      console.log('\nDecyzja o kwarantannie należy do modułu fleet:')
      console.log('  mercato fleet ... (przejście do quarantined z powodem „utrata łączności")')
    }
  },
}

export default [issueCommand, simulateCommand, statusCommand, sweepCommand, installSchedulesCommand] satisfies ModuleCli[]
