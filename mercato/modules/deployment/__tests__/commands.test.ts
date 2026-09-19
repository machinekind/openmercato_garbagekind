import { generateKeyPairSync, sign as signPayload } from 'node:crypto'
import { assignCommand, issueLeaseCommand } from '../commands/assignments'
import { leasePayload } from '../lib/protocol'
import { LEASE_SECONDS } from '../lib/lease'

/**
 * Testy wiązania komend.
 *
 * Reguła dzierżawy ma własny test jako czysta funkcja. Tutaj sprawdzamy, czy
 * komenda jej **używa** i czy bramki wstępne (stan robota, status wersji,
 * rewizja embodimentu) naprawdę są wołane — bo bramka, której nikt nie woła,
 * nie chroni niczego.
 */

type Row = Record<string, unknown>

const scope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
}
const ROBOT_ID = '33333333-3333-4333-8333-333333333333'
const VERSION_ID = '44444444-4444-4444-8444-444444444444'
const SESSION_ID = '55555555-5555-4555-8555-555555555555'
const CELL_ID = '66666666-6666-4666-8666-666666666666'
const REVISION_ID = '77777777-7777-4777-8777-777777777777'

const ROBOT = {
  id: ROBOT_ID,
  tenant_id: scope.tenantId,
  organization_id: scope.organizationId,
  state: 'operational',
  serial_number: 'UR10E-0001',
  embodiment_revision_id: REVISION_ID,
  cell_id: CELL_ID,
  risk_class: 'fenced',
}

const VERSION = {
  id: VERSION_ID,
  status: 'released',
  content_digest: 'a'.repeat(64),
  embodiment_revision_id: REVISION_ID,
  policy_key: 'pick-bin-ur10e',
  version: 1,
  lease_expiry_behavior: 'hold_position',
}

function makeCtx(options: {
  robot?: Row | null
  version?: Row | null
  previousAssignment?: Row | null
  assignment?: Row | null
  session?: Row | null
  keys?: Row[]
  maxSequence?: number | null
  /** Odpowiedź bramy dopuszczenia; domyślnie „dopuszczone". */
  clearance?: { cleared: boolean; reasons?: string[] }
} = {}) {
  const persisted: Row[] = []
  const executed: string[] = []
  const commands: string[] = []

  const em = {
    fork: () => em,
    findOne: jest.fn(async (entity: unknown, where: Row) => {
      const name = (entity as { name?: string })?.name ?? String(entity)
      if (name.includes('Assignment')) {
        if (where.id !== undefined) return options.assignment ?? null
        // Zapytanie o czynne przypisanie robota.
        return options.previousAssignment ?? options.assignment ?? null
      }
      return null
    }),
    getConnection: () => ({
      execute: jest.fn(async (query: string) => {
        executed.push(query)
        if (query.includes('fleet_robots')) {
          return options.robot === undefined ? [ROBOT] : options.robot ? [options.robot] : []
        }
        if (query.includes('policy_registry_policy_versions')) {
          return options.version === undefined ? [VERSION] : options.version ? [options.version] : []
        }
        if (query.includes('edge_agent_sessions')) {
          return options.session === undefined
            ? [
                {
                  session_id: SESSION_ID,
                  agent_id: 'agent-1',
                  robot_id: ROBOT_ID,
                  tenant_id: scope.tenantId,
                  organization_id: scope.organizationId,
                  ended_at: null,
                  agent_status: 'enrolled',
                },
              ]
            : options.session
              ? [options.session]
              : []
        }
        if (query.includes('edge_agent_keys')) return options.keys ?? []
        if (query.includes('max(sequence)')) {
          return [{ max: options.maxSequence === undefined ? 0 : options.maxSequence }]
        }
        return []
      }),
    }),
    create: jest.fn((entity: unknown, data: Row) => ({
      __table: (entity as { name?: string })?.name,
      ...data,
    })),
    persist: jest.fn((row: Row) => {
      persisted.push(row)
    }),
    flush: jest.fn(async () => {
      for (const row of persisted) if (!row.id) row.id = `id-${persisted.indexOf(row) + 1}`
    }),
  }

  /**
   * Szyna komend w atrapie.
   *
   * Przypisanie woła `safety.clearance.check` przed zapisem (brama dodana
   * przy fazie 5). Domyślna odpowiedź to „dopuszczone", bo testy tego pliku
   * badają bramki stanu robota, statusu wersji i rewizji embodimentu —
   * brama dopuszczenia ma własne testy w module `safety` i osobny przypadek
   * niżej. Bez domyślnej odpowiedzi każdy test wywracałby się na braku
   * dopuszczenia zamiast na badanym warunku.
   */
  const commandBus = {
    execute: jest.fn(async (id: string) => {
      commands.push(id)
      if (id === 'safety.clearance.check') {
        return { result: options.clearance ?? { cleared: true, reasons: [] } }
      }
      return { result: {} }
    }),
  }

  return {
    persisted,
    executed,
    commands,
    ctx: {
      container: { resolve: (key: string) => (key === 'commandBus' ? commandBus : em) },
      auth: { sub: 'user-1' },
    } as never,
  }
}

const assignInput = {
  ...scope,
  robotId: ROBOT_ID,
  policyVersionId: VERSION_ID,
  reason: 'Wdrożenie testowe',
}

describe('deployment.assignments.assign — bramki wstępne', () => {
  it('odmawia wersji historycznej bez zachowania po wygaśnięciu dzierżawy', async () => {
    const { lease_expiry_behavior: _missing, ...legacyVersion } = VERSION
    const { ctx, commands } = makeCtx({ version: legacyVersion })
    await expect(assignCommand.execute(assignInput, ctx)).rejects.toThrow(/nie deklaruje zachowania/)
    expect(commands).not.toContain('safety.clearance.check')
  })

  it('przypisuje politykę robotowi w ruchu i bierze dzierżawę z klasy ryzyka celi', async () => {
    const { ctx, persisted } = makeCtx()
    const result = await assignCommand.execute(assignInput, ctx)
    expect(result.riskClass).toBe('fenced')
    expect(result.leaseSeconds).toBe(LEASE_SECONDS.fenced)
    const assignment = persisted.find((r) => r.__table === 'Assignment')!
    // Skrót treści jest kopiowany do przypisania, żeby robot mógł porównać go
    // z tym, co faktycznie załadował, bez dodatkowego zapytania.
    expect(assignment.policyContentDigest).toBe(VERSION.content_digest)
    expect(assignment.leaseExpiryBehavior).toBe('hold_position')
  })

  it('cela publiczna daje dzierżawę w minutach, nie w dniach', async () => {
    const { ctx } = makeCtx({ robot: { ...ROBOT, risk_class: 'public' } })
    const result = await assignCommand.execute(assignInput, ctx)
    expect(result.leaseSeconds).toBe(LEASE_SECONDS.public)
  })

  it('odmawia robotowi, który nie jest w ruchu', async () => {
    const { ctx, persisted } = makeCtx({ robot: { ...ROBOT, state: 'quarantined' } })
    await expect(assignCommand.execute(assignInput, ctx)).rejects.toThrow(/operational/)
    expect(persisted).toHaveLength(0)
  })

  it('dopuszcza robota poza ruchem tylko przy jawnej deklaracji', async () => {
    const { ctx } = makeCtx({ robot: { ...ROBOT, state: 'ready' } })
    const result = await assignCommand.execute({ ...assignInput, allowNonOperational: true }, ctx)
    expect(result.assignmentId).toBeTruthy()
  })

  it('odmawia wersji, która nie jest wypuszczona', async () => {
    const { ctx } = makeCtx({ version: { ...VERSION, status: 'registered' } })
    await expect(assignCommand.execute(assignInput, ctx)).rejects.toThrow(/wypuszczoną/)
  })

  it('odmawia wersji wycofanej', async () => {
    const { ctx } = makeCtx({ version: { ...VERSION, status: 'deprecated' } })
    await expect(assignCommand.execute(assignInput, ctx)).rejects.toThrow(/deprecated/)
  })

  it('odmawia, gdy robot jest innej rewizji embodimentu niż wersja', async () => {
    // Robot bywa modernizowany: wymiana chwytaka podnosi rewizję i wersja,
    // która wczoraj była zgodna, dziś nie jest.
    const { ctx } = makeCtx({ robot: { ...ROBOT, embodiment_revision_id: 'inna-rewizja' } })
    await expect(assignCommand.execute(assignInput, ctx)).rejects.toThrow(/rewizji embodimentu/)
  })

  it('odmawia robotowi bez celi, bo nie ma z czego wyznaczyć dzierżawy', async () => {
    const { ctx } = makeCtx({ robot: { ...ROBOT, cell_id: null, risk_class: null } })
    await expect(assignCommand.execute(assignInput, ctx)).rejects.toThrow(/nie stoi w żadnej celi/)
  })

  it('odmawia, gdy polityka nie jest dopuszczona do klasy celi', async () => {
    // Brama dodana przy fazie 5: dopuszczenie jest warunkiem wstępnym
    // przypisania, nie jego skutkiem ubocznym.
    const { ctx, persisted } = makeCtx({
      clearance: { cleared: false, reasons: ['brak zatwierdzonego uzasadnienia dla klasy celi fenced-pick-place'] },
    })
    await expect(assignCommand.execute(assignInput, ctx)).rejects.toThrow(/nie jest dopuszczona do klasy celi/)
    expect(persisted).toHaveLength(0)
  })

  it('allowNonOperational NIE omija bramy dopuszczenia', async () => {
    // Tryb cieniowy dotyczy stanu robota, nie dopuszczenia polityki do celi.
    const { ctx } = makeCtx({
      robot: { ...ROBOT, state: 'ready' },
      clearance: { cleared: false, reasons: ['brak kompletu ewaluacji'] },
    })
    await expect(
      assignCommand.execute({ ...assignInput, allowNonOperational: true }, ctx),
    ).rejects.toThrow(/nie jest dopuszczona/)
  })

  it('brama dopuszczenia jest wołana przed zapisem, nie po', async () => {
    const { ctx, commands } = makeCtx()
    await assignCommand.execute(assignInput, ctx)
    expect(commands).toContain('safety.clearance.check')
  })

  it('poprzednie przypisanie odchodzi w historię zamiast znikać', async () => {
    const previous: Row = { id: 'prev-1', supersededAt: null }
    const { ctx } = makeCtx({ previousAssignment: previous })
    const result = await assignCommand.execute(assignInput, ctx)
    expect(result.supersededId).toBe('prev-1')
    expect(previous.supersededAt).toBeInstanceOf(Date)
  })
})

describe('deployment.leases.issue — uwierzytelnienie i termin', () => {
  function signedInput(sequence = 1) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const stamp = new Date().toISOString()
    const signature = signPayload(
      null,
      Buffer.from(leasePayload(SESSION_ID, sequence, stamp), 'utf8'),
      privateKey,
    ).toString('base64')
    return {
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      input: {
        organizationId: scope.organizationId,
        agentSessionId: SESSION_ID,
        sequence,
        timestamp: stamp,
        signature,
      },
    }
  }

  const activeKey = (pem: string) => ({
    public_key: pem,
    active_from: new Date(Date.now() - 60_000).toISOString(),
    active_until: null,
    revoked_at: null,
  })

  const assignment = {
    id: 'assign-1',
    policyVersionId: VERSION_ID,
    policyContentDigest: VERSION.content_digest,
    desiredState: 'running',
    riskClass: 'public',
    leaseSeconds: LEASE_SECONDS.public,
    leaseExpiryBehavior: 'hold_position',
  }

  it('wydaje dzierżawę na podstawie prawdziwego podpisu agenta', async () => {
    const { publicKeyPem, input } = signedInput()
    const { ctx, persisted } = makeCtx({ keys: [activeKey(publicKeyPem)], assignment })
    const result = await issueLeaseCommand.execute(input, ctx)

    expect(result.desiredState).toBe('running')
    expect(result.leaseSeconds).toBe(LEASE_SECONDS.public)
    expect(result.leaseExpiryBehavior).toBe('hold_position')
    const lease = persisted.find((r) => r.__table === 'Lease')!
    const issued = lease.issuedAt as Date
    const expires = lease.expiresAt as Date
    expect(Math.round((expires.getTime() - issued.getTime()) / 1000)).toBe(LEASE_SECONDS.public)
  })

  it('odrzuca podpis złożony obcym kluczem', async () => {
    const { input } = signedInput()
    const foreign = generateKeyPairSync('ed25519')
    const { ctx } = makeCtx({
      keys: [activeKey(foreign.publicKey.export({ type: 'spki', format: 'pem' }).toString())],
      assignment,
    })
    await expect(issueLeaseCommand.execute(input, ctx)).rejects.toThrow(/nie zgadza się z żadnym ważnym kluczem/)
  })

  it('odrzuca podpis zebrany w kontekście uderzenia serca', async () => {
    // Wiązanie kontekstu: kto przechwyci heartbeat, nie przedłuży sobie mandatu.
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const stamp = new Date().toISOString()
    const heartbeatSignature = signPayload(
      null,
      Buffer.from(`edge.heartbeat:${SESSION_ID}:1:${stamp}`, 'utf8'),
      privateKey,
    ).toString('base64')
    const { ctx } = makeCtx({
      keys: [activeKey(publicKey.export({ type: 'spki', format: 'pem' }).toString())],
      assignment,
    })
    await expect(
      issueLeaseCommand.execute(
        {
          organizationId: scope.organizationId,
          agentSessionId: SESSION_ID,
          sequence: 1,
          timestamp: stamp,
          signature: heartbeatSignature,
        },
        ctx,
      ),
    ).rejects.toThrow(/nie zgadza się/)
  })

  it('odrzuca powtórzony numer kolejny', async () => {
    const { publicKeyPem, input } = signedInput(3)
    const { ctx } = makeCtx({ keys: [activeKey(publicKeyPem)], assignment, maxSequence: 3 })
    await expect(issueLeaseCommand.execute(input, ctx)).rejects.toThrow(/powtórka lub klon/)
  })

  it('odrzuca zamkniętą sesję', async () => {
    const { publicKeyPem, input } = signedInput()
    const { ctx } = makeCtx({
      keys: [activeKey(publicKeyPem)],
      assignment,
      session: {
        session_id: SESSION_ID,
        agent_id: 'agent-1',
        robot_id: ROBOT_ID,
        tenant_id: scope.tenantId,
        organization_id: scope.organizationId,
        ended_at: new Date().toISOString(),
        agent_status: 'enrolled',
      },
    })
    await expect(issueLeaseCommand.execute(input, ctx)).rejects.toThrow(/zamknięta/)
  })

  it('odrzuca agenta odwołanego', async () => {
    const { publicKeyPem, input } = signedInput()
    const { ctx } = makeCtx({
      keys: [activeKey(publicKeyPem)],
      assignment,
      session: {
        session_id: SESSION_ID,
        agent_id: 'agent-1',
        robot_id: ROBOT_ID,
        tenant_id: scope.tenantId,
        organization_id: scope.organizationId,
        ended_at: null,
        agent_status: 'revoked',
      },
    })
    await expect(issueLeaseCommand.execute(input, ctx)).rejects.toThrow(/odwołany/)
  })

  it('brak przypisania daje „stój", a nie błąd', async () => {
    // Robot bez przypisania to normalny stan świeżo uruchomionej maszyny.
    // 404 wepchnąłby agenta w pętlę ponawiania jak przy awarii.
    const { publicKeyPem, input } = signedInput()
    const { ctx, persisted } = makeCtx({ keys: [activeKey(publicKeyPem)], assignment: null })
    const result = await issueLeaseCommand.execute(input, ctx)
    expect(result.desiredState).toBe('stopped')
    expect(result.policyVersionId).toBeNull()
    // I nie zostawia po sobie dzierżawy, na którą robot mógłby się powołać.
    expect(persisted).toHaveLength(0)
  })
})
