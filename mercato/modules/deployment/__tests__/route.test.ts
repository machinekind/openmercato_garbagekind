import { runAgentCommand, type AgentScope } from '../../edge/api/agentRoute'

/**
 * Regresja: zakres z serwera musi trafić do WEJŚCIA komendy, nie tylko do kontekstu.
 *
 * Historia tego pliku jest jedynym powodem, dla którego istnieje. Endpointy
 * `/api/deployment/lease` i `/api/deployment/report` budowały wejście komendy
 * z `organizationId: ''`, bo zakres wędrował wyłącznie w `ctx`. Schemat komendy
 * wymaga tam UUID, więc **każde** żądanie agenta kończyło się odmową 401
 * z komunikatem o niepoprawnym UUID — czyli endpoint nie działał ani razu.
 *
 * Dlaczego nie złapały tego istniejące testy: wszystkie wołają komendę wprost,
 * podstawiając poprawny zakres. Sprawdzały więc komendę, nigdy sklejenia
 * route ↔ komenda. Znalazł to dopiero niezależny agent uruchomiony przeciwko
 * żywej instancji — i to jest cała nauczka: zgodność z kontraktem sprawdza się
 * klientem, który nie zna naszych skrótów.
 */

type Row = Record<string, unknown>

function makeRequest(body: Row): Request {
  return new Request('http://localhost/api/deployment/lease', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const ORG = '11111111-1111-4111-8111-111111111111'
const SESSION = '55555555-5555-4555-8555-555555555555'

function makeContainer(captured: { input?: Row }) {
  const em = {
    getConnection: () => ({ execute: jest.fn(async () => [{ organization_id: ORG }]) }),
  }
  const commandBus = {
    execute: jest.fn(async (_id: string, call: { input: Row }) => {
      captured.input = call.input
      return { result: { ok: true } }
    }),
  }
  return {
    resolve: (key: string) => (key === 'commandBus' ? commandBus : em),
  }
}

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(),
}))

const { createRequestContainer } = jest.requireMock('@open-mercato/shared/lib/di/container') as {
  createRequestContainer: jest.Mock
}

describe('runAgentCommand — zakres serwera trafia do wejścia komendy', () => {
  it('przekazuje organizationId z wyszukania zakresu, a nie pustą wartość', async () => {
    const captured: { input?: Row } = {}
    createRequestContainer.mockResolvedValue(makeContainer(captured))

    const response = await runAgentCommand(
      makeRequest({ sessionId: SESSION, sequence: 1, timestamp: '2026-09-20T00:00:00.000Z', signature: 'x' }),
      'deployment.leases.issue',
      async () => ({ organizationId: ORG }),
      (payload, scope: AgentScope) => ({
        organizationId: scope.organizationId,
        agentSessionId: payload.sessionId,
      }),
    )

    expect(response.status).toBe(200)
    expect(captured.input?.organizationId).toBe(ORG)
    // Pusty łańcuch przeszedłby przez TypeScript, a wywrócił się dopiero na zodzie.
    expect(captured.input?.organizationId).not.toBe('')
  })

  it('odmawia 404, gdy sesji nie da się rozpoznać — bez wołania komendy', async () => {
    const captured: { input?: Row } = {}
    createRequestContainer.mockResolvedValue(makeContainer(captured))

    const response = await runAgentCommand(
      makeRequest({ sessionId: SESSION }),
      'deployment.leases.issue',
      async () => null,
      (payload, scope: AgentScope) => ({ organizationId: scope.organizationId }),
    )

    expect(response.status).toBe(404)
    expect(captured.input).toBeUndefined()
  })
})
