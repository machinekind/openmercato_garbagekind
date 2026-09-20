import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'

/**
 * Wspólna obsługa endpointów wołanych przez agenta, a nie przez człowieka.
 *
 * Trzy z nich (`enroll`, `connect`, `heartbeat`) dzielą ten sam układ: brak
 * sesji użytkownika, uwierzytelnienie podpisem wewnątrz komendy, a zakres
 * organizacji ustalany po stronie serwera z rekordu, do którego żądanie się
 * odwołuje. To ostatnie jest istotne: gdyby zakres przychodził w treści
 * żądania, byłby parametrem, którym dałoby się sięgnąć poza własnego tenanta.
 */

export function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export type AgentScope = { organizationId: string }

export type ScopeLookup = (em: EntityManager, payload: Record<string, unknown>) => Promise<
  AgentScope | null
>

/**
 * `buildInput` dostaje zakres ustalony przez serwer.
 *
 * Drugi argument nie jest wygodą: komendy `deployment.*` mają
 * `organizationId` w schemacie wejścia, a nie tylko w kontekście. Dopóki route
 * wstawiał tam pustą wartość, każde żądanie agenta kończyło się odmową 401
 * z błędu walidacji UUID - a że własne testy wołają komendę wprost z poprawnym
 * zakresem, nie było tego czym złapać. Znalazł to dopiero niezależny agent
 * uruchomiony przeciwko żywej instancji.
 */
export async function runAgentCommand(
  req: Request,
  commandId: string,
  lookupScope: ScopeLookup,
  buildInput: (payload: Record<string, unknown>, scope: AgentScope) => Record<string, unknown>,
): Promise<Response> {
  let payload: Record<string, unknown>
  try {
    payload = (await req.json()) as Record<string, unknown>
  } catch {
    return json({ error: 'Oczekiwano treści JSON.' }, 400)
  }

  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager

  const scope = await lookupScope(em, payload)
  if (!scope) return json({ error: 'Nie rozpoznano kontekstu żądania.' }, 404)

  const ctx = {
    container,
    auth: null,
    organizationScope: { selectedId: scope.organizationId, filterIds: [scope.organizationId] },
  } as unknown as CommandRuntimeContext

  const bus = container.resolve('commandBus') as CommandBus
  try {
    const envelope = await bus.execute(commandId, { input: buildInput(payload, scope), ctx })
    return json(envelope.result, 200)
  } catch (error) {
    /**
     * 401, nie 400: odrzucony podpis, zużyty bilet i powtórzony numer kolejny
     * to odmowa uwierzytelnienia, a nie błąd składni. Agent ma z tego wyciągnąć
     * jeden wniosek - połącz się na nowo - a nie poprawiać treść żądania.
     */
    return json({ error: error instanceof Error ? error.message : String(error) }, 401)
  }
}
