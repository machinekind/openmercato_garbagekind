import { generateKeyPairSync, sign as signPayload } from 'node:crypto'
import { setGlobalEventBus } from '@open-mercato/shared/modules/events'
import { reportCommand } from '../commands/assignments'
import { reportPayload } from '../lib/protocol'

/**
 * Testy wyzwalania zboczem.
 *
 * To jest najłatwiejsza do zepsucia reguła w całej wtyczce, bo psuje się
 * cicho i w dobrą stronę: usunięcie porównania z poprzednim werdyktem nie
 * wywala niczego, tylko zamienia zdarzenie w strumień powtarzany co
 * kilkadziesiąt sekund przez cały czas trwania rozjazdu. Test istnieje po to,
 * żeby ta zmiana kosztowała czerwony wynik, a nie zaufanie operatora.
 */

type Row = Record<string, unknown>

const ORG = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const ROBOT = '33333333-3333-4333-8333-333333333333'
const SESSION = '55555555-5555-4555-8555-555555555555'
const VERSION = '44444444-4444-4444-8444-444444444444'

/**
 * Jeden klucz agenta na cały plik: zgłoszenie stanu jest podpisywane, więc
 * bez tego każdy przypadek wywracałby się na uwierzytelnieniu zamiast na
 * badanej regule wyzwalania zboczem.
 */
const AGENT_KEYS = generateKeyPairSync('ed25519')
const AGENT_PUBLIC_PEM = AGENT_KEYS.publicKey.export({ type: 'spki', format: 'pem' }).toString()

function sign(state: 'running' | 'stopped', timestamp: string): string {
  return signPayload(
    null,
    Buffer.from(reportPayload(SESSION, state, timestamp), 'utf8'),
    AGENT_KEYS.privateKey,
  ).toString('base64')
}

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

/** `poprzedniWerdykt` to werdykt ostatniego raportu tej maszyny — albo brak. */
function makeCtx(poprzedniWerdykt: string | null) {
  const persisted: Row[] = []
  const em = {
    fork: () => em,
    findOne: jest.fn(async (entity: unknown) => {
      const name = (entity as { name?: string })?.name ?? String(entity)
      if (name.includes('Assignment')) {
        return { id: 'assign-1', policyVersionId: VERSION, desiredState: 'running' }
      }
      return null
    }),
    find: jest.fn(async (entity: unknown) => {
      const name = (entity as { name?: string })?.name ?? String(entity)
      if (name.includes('StateReport')) {
        return poprzedniWerdykt ? [{ reconciliation: poprzedniWerdykt }] : []
      }
      return []
    }),
    create: jest.fn((_entity: unknown, data: Row) => ({ id: 'report-1', ...data })),
    persist: jest.fn((row: Row) => persisted.push(row)),
    flush: jest.fn(async () => {}),
    getConnection: () => ({
      execute: jest.fn(async (query: string) => {
        if (query.includes('edge_agent_keys')) {
          return [
            {
              public_key: AGENT_PUBLIC_PEM,
              active_from: new Date(Date.now() - 60_000).toISOString(),
              active_until: null,
              revoked_at: null,
            },
          ]
        }
        return [
        {
          session_id: SESSION,
          agent_id: 'agent-1',
          robot_id: ROBOT,
          tenant_id: TENANT,
          organization_id: ORG,
          ended_at: null,
          agent_status: 'enrolled',
        },
        ]
      }),
    }),
  }
  return { container: { resolve: () => em }, auth: null } as never
}

function raport(reportedPolicyVersionId: string | null) {
  const timestamp = new Date().toISOString()
  return {
    organizationId: ORG,
    agentSessionId: SESSION,
    reportedState: 'running' as const,
    reportedPolicyVersionId,
    timestamp,
    signature: sign('running', timestamp),
  }
}

const rozjazd = () => raport('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
const zgodnosc = () => raport(VERSION)

describe('wyzwalanie zboczem w raportach stanu', () => {
  it('pierwszy raport rozjazdu ogłasza zdarzenie', async () => {
    const seen = captureEvents()
    const result = await reportCommand.execute(rozjazd(), makeCtx(null))
    expect(result.reconciliation).toBe('drift')
    expect(seen.map((e) => e.id)).toEqual(['deployment.state.drift_detected'])
    expect(seen[0].payload).toMatchObject({ previousReconciliation: null, robotId: ROBOT })
  })

  it('drugi raport tego samego rozjazdu nie ogłasza już niczego', async () => {
    // Bez tego zdarzenie wracałoby co kilkadziesiąt sekund przez cały czas
    // trwania awarii i przestałoby cokolwiek znaczyć.
    const seen = captureEvents()
    const result = await reportCommand.execute(rozjazd(), makeCtx('drift'))
    expect(result.reconciliation).toBe('drift')
    expect(seen).toEqual([])
  })

  it('powrót do zgodności jest ogłaszany, bo domyka rozjazd', async () => {
    // Bez tego odbiorca wie, kiedy się zepsuło, i nigdy — kiedy naprawiło.
    const seen = captureEvents()
    const result = await reportCommand.execute(zgodnosc(), makeCtx('drift'))
    expect(result.reconciliation).toBe('converged')
    expect(seen.map((e) => e.id)).toEqual(['deployment.state.converged'])
    expect(seen[0].payload).toMatchObject({ previousReconciliation: 'drift' })
  })

  it('kolejny raport zgodności milczy', async () => {
    const seen = captureEvents()
    await reportCommand.execute(zgodnosc(), makeCtx('converged'))
    expect(seen).toEqual([])
  })

  it('pierwszy raport zgodności też jest zdarzeniem — brak poprzednika to zmiana', async () => {
    const seen = captureEvents()
    await reportCommand.execute(zgodnosc(), makeCtx(null))
    expect(seen.map((e) => e.id)).toEqual(['deployment.state.converged'])
  })
})
