import { generateKeyPairSync, sign as signPayload } from 'node:crypto'
import {
  connectAgentCommand,
  enrollAgentCommand,
  heartbeatCommand,
  issueEnrollmentCommand,
  revokeAgentCommand,
  rotateKeyCommand,
  sweepSessionsCommand,
} from '../commands/agents'
import { fingerprintPublicKey, payloads } from '../lib/crypto'
import { createFakeEm, makeCtx, type FakeEm } from './fakeEm'

/**
 * Testy wiązania komend.
 *
 * Reguły żywotności i kryptografia mają własne testy jako czyste funkcje.
 * Tutaj sprawdzamy rzecz osobną: czy komendy naprawdę ich **używają** - bo
 * reguła, której nikt nie woła, nie chroni niczego. W szczególności sprawdzamy
 * całą ścieżkę fazy 0: bilet → wpis → uderzenie serca → cisza → utrata.
 */

const ORG = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const ROBOT = '33333333-3333-4333-8333-333333333333'

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  return {
    publicKeyPem: pem,
    fingerprint: fingerprintPublicKey(pem),
    sign: (payload: string) => signPayload(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64'),
  }
}

async function issue(em: FakeEm, overrides: Record<string, unknown> = {}) {
  return (await issueEnrollmentCommand.execute(
    { organizationId: ORG, tenantId: TENANT, robotId: ROBOT, ...overrides },
    makeCtx(em),
  )) as unknown as { tokenId: string; token: string; expiresAt: Date }
}

async function enroll(em: FakeEm, token: string, key = keypair(), overrides: Record<string, unknown> = {}) {
  const result = await enrollAgentCommand.execute(
    {
      token,
      publicKey: key.publicKeyPem,
      signature: key.sign(payloads.enroll(token, key.fingerprint)),
      ...overrides,
    },
    makeCtx(em),
  )
  return { ...result, key }
}

describe('edge.enrollment.issue', () => {
  it('zwraca jawny bilet, a zapisuje wyłącznie jego skrót', async () => {
    const em = createFakeEm()
    const { token } = await issue(em)
    const stored = em.rows('EnrollmentToken')
    expect(stored).toHaveLength(1)
    // Sedno: jawny bilet nie może dać się odczytać z bazy.
    expect(JSON.stringify(stored[0])).not.toContain(token)
    expect(stored[0].tokenHash).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/))
  })

  it('odmawia progu utraty krótszego niż okno spóźnienia', async () => {
    // Inaczej „utracony" następowałby przed „spóźniony" - a rozdział tych
    // stanów jest jedynym powodem, dla którego oba istnieją.
    const em = createFakeEm()
    await expect(
      issue(em, { heartbeatIntervalSeconds: 60, livenessGraceSeconds: 60, lostAfterSeconds: 90 }),
    ).rejects.toThrow(/Próg utraty/)
  })
})

describe('edge.agents.enroll', () => {
  it('wpisuje agenta, klucz i otwiera sesję, a bilet oznacza jako zużyty', async () => {
    const em = createFakeEm()
    const { token } = await issue(em)
    const result = await enroll(em, token)

    expect(result.robotId).toBe(ROBOT)
    expect(em.rows('Agent')).toHaveLength(1)
    expect(em.rows('AgentKey')).toHaveLength(1)
    expect(em.rows('AgentSession')).toHaveLength(1)
    expect(em.rows('EnrollmentToken')[0].usedAt).toBeInstanceOf(Date)
    // Agent zaraz po wpisie jeszcze się nie odezwał - i pulpit ma to pokazać.
    expect(em.rows('Agent')[0].lastSeenAt).toBeNull()
  })

  it('DOWÓD POSIADANIA KLUCZA: przechwycony bilet z cudzym kluczem nie przechodzi', async () => {
    const em = createFakeEm()
    const { token } = await issue(em)
    const mallory = keypair()
    const alice = keypair()
    await expect(
      enrollAgentCommand.execute(
        {
          token,
          publicKey: mallory.publicKeyPem,
          // Podpis poprawny, ale złożony innym kluczem niż przedstawiony.
          signature: alice.sign(payloads.enroll(token, mallory.fingerprint)),
        },
        makeCtx(em),
      ),
    ).rejects.toThrow(/Podpis wpisu/)
  })

  it('bilet jest jednorazowy', async () => {
    const em = createFakeEm()
    const { token } = await issue(em)
    await enroll(em, token)
    await expect(enroll(em, token)).rejects.toThrow(/nieważny lub już zużyty/)
  })

  it('bilet wygasły nie działa', async () => {
    const em = createFakeEm()
    const { token } = await issue(em)
    em.rows('EnrollmentToken')[0].expiresAt = new Date(Date.now() - 1000)
    await expect(enroll(em, token)).rejects.toThrow(/wygasł/)
  })

  it('bilet nieistniejący i zużyty dają ten sam komunikat', async () => {
    // Rozróżnienie powiedziałoby zgadującemu, czy trafił w istniejący bilet.
    const em = createFakeEm()
    await expect(enroll(em, 'zmyslony-bilet')).rejects.toThrow(/nieważny lub już zużyty/)
  })

  it('drugi agent na tej samej maszynie jest odmawiany, nie podmieniany po cichu', async () => {
    const em = createFakeEm()
    const first = await issue(em)
    await enroll(em, first.token)
    const second = await issue(em)
    await expect(enroll(em, second.token)).rejects.toThrow(/ma już wpisanego agenta/)
  })
})

describe('edge.agents.heartbeat', () => {
  async function ready() {
    const em = createFakeEm()
    const { token } = await issue(em)
    const agent = await enroll(em, token)
    return { em, agent }
  }

  function beat(sessionId: string, sequence: number, key: ReturnType<typeof keypair>, when = new Date()) {
    const iso = when.toISOString()
    return {
      sessionId,
      sequence,
      timestamp: iso,
      signature: key.sign(payloads.heartbeat(sessionId, sequence, iso)),
    }
  }

  it('podpisane uderzenie serca odświeża agenta i zwraca następny termin', async () => {
    const { em, agent } = await ready()
    const result = await heartbeatCommand.execute(beat(agent.sessionId, 1, agent.key), makeCtx(em))
    expect(result.state).toBe('online')
    expect(result.nextDeadline.getTime()).toBeGreaterThan(Date.now())
    expect(em.rows('Agent')[0].lastSeenAt).toBeInstanceOf(Date)
    expect(em.rows('AgentSession')[0].lastSequence).toBe(1)
  })

  it('POWTÓRKA: ten sam numer kolejny drugi raz jest odrzucany', async () => {
    const { em, agent } = await ready()
    await heartbeatCommand.execute(beat(agent.sessionId, 5, agent.key), makeCtx(em))
    await expect(heartbeatCommand.execute(beat(agent.sessionId, 5, agent.key), makeCtx(em))).rejects.toThrow(
      /powtórka lub klon/,
    )
  })

  it('cudzy podpis nie utrzyma robota przy życiu na pulpicie', async () => {
    const { em, agent } = await ready()
    await expect(heartbeatCommand.execute(beat(agent.sessionId, 1, keypair()), makeCtx(em))).rejects.toThrow(
      /nie zgadza się z żadnym ważnym kluczem/,
    )
    expect(em.rows('Agent')[0].lastSeenAt).toBeNull()
  })

  it('znacznik czasu spoza okna rozjazdu zegarów jest odrzucany', async () => {
    const { em, agent } = await ready()
    const stale = new Date(Date.now() - 10 * 60_000)
    await expect(heartbeatCommand.execute(beat(agent.sessionId, 1, agent.key, stale), makeCtx(em))).rejects.toThrow(
      /rozjazd/,
    )
  })

  it('zamknięta sesja nie wraca do życia uderzeniem serca', async () => {
    const { em, agent } = await ready()
    em.rows('AgentSession')[0].endedAt = new Date()
    em.rows('AgentSession')[0].endedReason = 'timeout'
    await expect(heartbeatCommand.execute(beat(agent.sessionId, 1, agent.key), makeCtx(em))).rejects.toThrow(
      /wymagane ponowne połączenie/,
    )
  })
})

describe('edge.agents.connect', () => {
  it('WYKRYWANIE KLONÓW: druga sesja wypiera pierwszą i zostawia po tym ślad', async () => {
    const em = createFakeEm()
    const { token } = await issue(em)
    const agent = await enroll(em, token)

    const iso = new Date().toISOString()
    const result = await connectAgentCommand.execute(
      {
        agentId: agent.agentId,
        timestamp: iso,
        signature: agent.key.sign(payloads.connect(agent.agentId, iso)),
      },
      makeCtx(em),
    )

    expect(result.supersededSessionId).toBe(agent.sessionId)
    const sessions = em.rows('AgentSession')
    expect(sessions).toHaveLength(2)
    expect(sessions[0].endedReason).toBe('superseded')
    expect(sessions[1].endedAt).toBeUndefined()
  })
})

describe('edge.keys.rotate', () => {
  it('stary klucz dostaje koniec okna, a nie natychmiastowe odwołanie', async () => {
    const em = createFakeEm()
    const { token } = await issue(em)
    const agent = await enroll(em, token)
    const next = keypair()

    const result = await rotateKeyCommand.execute(
      {
        agentId: agent.agentId,
        publicKey: next.publicKeyPem,
        signature: next.sign(payloads.rotate(agent.agentId, next.fingerprint)),
        overlapMinutes: 15,
      },
      makeCtx(em),
    )

    const keys = em.rows('AgentKey')
    expect(keys).toHaveLength(2)
    expect(result.retiredKeyIds).toHaveLength(1)
    // Okno zakładkowe: stary klucz wciąż ważny, ale z datą końca.
    expect(keys[0].activeUntil).toBeInstanceOf(Date)
    expect((keys[0].activeUntil as Date).getTime()).toBeGreaterThan(Date.now())
    expect(keys[0].revokedAt).toBeUndefined()
  })

  it('rotację podpisuje NOWY klucz - dowodem jest posiadanie następcy', async () => {
    const em = createFakeEm()
    const { token } = await issue(em)
    const agent = await enroll(em, token)
    const next = keypair()
    await expect(
      rotateKeyCommand.execute(
        {
          agentId: agent.agentId,
          publicKey: next.publicKeyPem,
          // Podpis starym kluczem: dowodzi ciągłości, ale nie tego, że ktoś
          // w ogóle posiada klucz prywatny do przedstawionego następcy.
          signature: agent.key.sign(payloads.rotate(agent.agentId, next.fingerprint)),
        },
        makeCtx(em),
      ),
    ).rejects.toThrow(/Podpis rotacji/)
  })

  it('po rotacji agent podpisujący starym kluczem wciąż przechodzi', async () => {
    const em = createFakeEm()
    const { token } = await issue(em)
    const agent = await enroll(em, token)
    const next = keypair()
    await rotateKeyCommand.execute(
      {
        agentId: agent.agentId,
        publicKey: next.publicKeyPem,
        signature: next.sign(payloads.rotate(agent.agentId, next.fingerprint)),
      },
      makeCtx(em),
    )

    const iso = new Date().toISOString()
    await expect(
      heartbeatCommand.execute(
        {
          sessionId: agent.sessionId,
          sequence: 1,
          timestamp: iso,
          signature: agent.key.sign(payloads.heartbeat(agent.sessionId, 1, iso)),
        },
        makeCtx(em),
      ),
    ).resolves.toMatchObject({ sequence: 1 })
  })
})

describe('edge.agents.revoke', () => {
  it('odwołanie gasi klucze i sesje natychmiast, bez okna', async () => {
    const em = createFakeEm()
    const { token } = await issue(em)
    const agent = await enroll(em, token)

    const result = await revokeAgentCommand.execute(
      { agentId: agent.agentId, reason: 'Podejrzenie wycieku klucza' },
      makeCtx(em),
    )
    expect(result.revokedKeys).toBe(1)
    expect(em.rows('Agent')[0].status).toBe('revoked')
    expect(em.rows('AgentSession')[0].endedReason).toBe('revoked')

    const iso = new Date().toISOString()
    await expect(
      heartbeatCommand.execute(
        {
          sessionId: agent.sessionId,
          sequence: 1,
          timestamp: iso,
          signature: agent.key.sign(payloads.heartbeat(agent.sessionId, 1, iso)),
        },
        makeCtx(em),
      ),
    ).rejects.toThrow(/Sesja zamknięta/)
  })

  it('po odwołaniu można wpisać następcę na tej samej maszynie', async () => {
    const em = createFakeEm()
    const first = await issue(em)
    const agent = await enroll(em, first.token)
    await revokeAgentCommand.execute({ agentId: agent.agentId, reason: 'Wymiana komputera pokładowego' }, makeCtx(em))

    const second = await issue(em)
    await expect(enroll(em, second.token)).resolves.toMatchObject({ robotId: ROBOT })
    // Historia tożsamości zostaje w całości - to materiał audytowy.
    expect(em.rows('Agent')).toHaveLength(2)
  })
})

describe('edge.sessions.sweep', () => {
  it('ODCIĘCIE ZASILANIA: po progu ciszy sesja zostaje zamknięta jako timeout', async () => {
    const em = createFakeEm()
    const { token } = await issue(em)
    const agent = await enroll(em, token)

    const iso = new Date().toISOString()
    await heartbeatCommand.execute(
      {
        sessionId: agent.sessionId,
        sequence: 1,
        timestamp: iso,
        signature: agent.key.sign(payloads.heartbeat(agent.sessionId, 1, iso)),
      },
      makeCtx(em),
    )

    // Zasilanie odcięte: nic nie przychodzi, czas płynie.
    em.rows('Agent')[0].lastSeenAt = new Date(Date.now() - 3600_000)

    const result = await sweepSessionsCommand.execute({ tenantId: TENANT, organizationId: ORG }, makeCtx(em))
    expect(result.closed).toBe(1)
    expect(result.lost[0]).toMatchObject({ robotId: ROBOT })
    expect(em.rows('AgentSession')[0].endedReason).toBe('timeout')
  })

  it('agent w normie nie jest zamiatany', async () => {
    const em = createFakeEm()
    const { token } = await issue(em)
    const agent = await enroll(em, token)
    const iso = new Date().toISOString()
    await heartbeatCommand.execute(
      {
        sessionId: agent.sessionId,
        sequence: 1,
        timestamp: iso,
        signature: agent.key.sign(payloads.heartbeat(agent.sessionId, 1, iso)),
      },
      makeCtx(em),
    )
    const result = await sweepSessionsCommand.execute({ tenantId: TENANT, organizationId: ORG }, makeCtx(em))
    expect(result.closed).toBe(0)
  })

  it('GRANICA MODUŁU: zamiatanie nie zmienia stanu robota, tylko go zgłasza', async () => {
    const em = createFakeEm()
    const { token } = await issue(em)
    await enroll(em, token)
    em.rows('Agent')[0].lastSeenAt = new Date(Date.now() - 3600_000)

    const result = await sweepSessionsCommand.execute({ tenantId: TENANT, organizationId: ORG }, makeCtx(em))
    // Wniosek „cisza znaczy: nie wolno pracować" należy do dziedziny i zapada
    // w module fleet. Tu zwracamy fakt, nie wyrok.
    expect(result.lost).toHaveLength(1)
    expect(em.store.has('Robot')).toBe(false)
  })
})
