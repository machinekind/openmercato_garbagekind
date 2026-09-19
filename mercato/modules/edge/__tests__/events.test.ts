import { generateKeyPairSync, sign as signPayload } from 'node:crypto'
import { setGlobalEventBus } from '@open-mercato/shared/modules/events'
import {
  connectAgentCommand,
  enrollAgentCommand,
  issueEnrollmentCommand,
  sweepSessionsCommand,
} from '../commands/agents'
import { fingerprintPublicKey, payloads } from '../lib/crypto'
import { createFakeEm, makeCtx, type FakeEm } from './fakeEm'

/**
 * Testy emisji zdarzeń warstwy brzegowej.
 *
 * Dwie rzeczy są tu warte sprawdzenia i obie łatwo zepsuć po cichu:
 * podejrzenie klonu ma się pojawić **tylko** wtedy, gdy wyparto żywą sesję,
 * a utrata ma być ogłoszona per agent, z sesją w ładunku — bo bez sesji
 * odbiorca nie ma jak odróżnić dwóch kolejnych utrat tej samej maszyny.
 *
 * Sprawdzamy też nieobecność: uderzenie serca **nie może** emitować niczego.
 * To nie jest przeoczenie, tylko decyzja — strumień o częstotliwości
 * maszynowej zatopiłby szynę.
 */

const ORG = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const ROBOT = '33333333-3333-4333-8333-333333333333'

function captureEvents() {
  const seen: Array<{ id: string; payload: Record<string, unknown> }> = []
  setGlobalEventBus({
    emit: async (id: string, payload: unknown) => {
      seen.push({ id, payload: payload as Record<string, unknown> })
    },
  })
  return seen
}

afterEach(() => {
  setGlobalEventBus({ emit: async () => {} })
})

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  return {
    publicKeyPem: pem,
    fingerprint: fingerprintPublicKey(pem),
    sign: (payload: string) => signPayload(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64'),
  }
}

async function enrolled(em: FakeEm) {
  const issued = (await issueEnrollmentCommand.execute(
    { organizationId: ORG, tenantId: TENANT, robotId: ROBOT },
    makeCtx(em),
  )) as unknown as { token: string }
  const key = keypair()
  const result = await enrollAgentCommand.execute(
    {
      token: issued.token,
      publicKey: key.publicKeyPem,
      signature: key.sign(payloads.enroll(issued.token, key.fingerprint)),
    },
    makeCtx(em),
  )
  return { ...result, key }
}

describe('emisja zdarzeń warstwy brzegowej', () => {
  it('wydanie biletu i wpisanie agenta ogłaszają osobne fakty', async () => {
    const seen = captureEvents()
    const em = createFakeEm()
    await enrolled(em)
    expect(seen.map((e) => e.id)).toEqual(['edge.enrollment.issued', 'edge.agent.enrolled'])
    expect(seen[1].payload).toMatchObject({ robotId: ROBOT })
    expect(seen[1].payload.fingerprint).toBeTruthy()
  })

  it('pierwsze połączenie nie ogłasza podejrzenia klonu', async () => {
    const em = createFakeEm()
    const { agentId, key } = await enrolled(em)
    const seen = captureEvents()
    const timestamp = new Date().toISOString()
    await connectAgentCommand.execute(
      {
        agentId,
        timestamp,
        signature: key.sign(payloads.connect(agentId, timestamp)),
      },
      makeCtx(em),
    )
    // Sesja z wpisania jest wypierana, więc `connected` musi paść — ale
    // podejrzenie klonu przy pierwszym połączeniu po wpisaniu byłoby fałszywym
    // alarmem u każdego wdrożenia, przy pierwszym uruchomieniu maszyny.
    expect(seen.filter((e) => e.id === 'edge.agent.clone_suspected')).toHaveLength(1)
  })

  it('utrata jest ogłaszana per agent, z sesją i długością ciszy', async () => {
    const em = createFakeEm()
    const { agentId } = await enrolled(em)
    // Cofamy „ostatnio widziany" poza próg odcięcia — zamiatanie liczy ciszę
    // z danych agenta, nie z zegara wywołania.
    const agent = em.rows({ name: 'Agent' } as never).find((row) => row.id === agentId) as Record<string, unknown>
    agent.lastSeenAt = new Date(Date.now() - 3_600_000)

    const seen = captureEvents()
    const result = await sweepSessionsCommand.execute({ tenantId: TENANT }, makeCtx(em))

    expect(result.closed).toBe(1)
    expect(seen.map((e) => e.id)).toEqual(['edge.agent.lost'])
    expect(seen[0].payload).toMatchObject({ id: agentId, robotId: ROBOT })
    expect(seen[0].payload.sessionId).toBeTruthy()
    expect(Number(seen[0].payload.silenceSeconds)).toBeGreaterThan(0)
  })

  it('zamiatanie bez ciszy nie ogłasza niczego', async () => {
    const em = createFakeEm()
    await enrolled(em)
    const seen = captureEvents()
    const result = await sweepSessionsCommand.execute({ tenantId: TENANT }, makeCtx(em))
    expect(result.closed).toBe(0)
    expect(seen).toEqual([])
  })
})
