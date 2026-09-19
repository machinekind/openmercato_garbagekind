import { robotTransitionSchema } from '../../../commands/robots'
import { executeCommandRoute } from '../../../lib/commandRoute'

/**
 * Zmiana stanu robota przez człowieka.
 *
 * Osobne uprawnienie od `fleet.manage`, bo konsekwencja jest innej wagi:
 * to przejście zatrzymuje maszynę albo dopuszcza ją do ruchu. Technik
 * rejestrujący nowy robot nie musi mieć prawa wypuszczenia go na halę.
 *
 * Bramek nie ma tutaj i nie będzie: graf przejść, wymóg podpisu i kontrola
 * kalibracji siedzą w komendzie, więc obowiązują tak samo wołane z ekranu,
 * z wiersza poleceń i z obcego systemu. Trasa, która dokłada własne warunki,
 * po pół roku ma ich inny zestaw niż reszta.
 */
export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['fleet.transition'] },
}

export async function POST(request: Request): Promise<Response> {
  return executeCommandRoute({
    request,
    routePath: 'fleet/robots/transition',
    inputSchema: robotTransitionSchema,
    commandId: 'fleet.robots.transition',
    describeResource: (input) => ({ resourceKind: 'fleet.robot', resourceId: input.robotId }),
    mapSuccess: (result: { robotId: string; fromState: string; toState: string }) => ({
      robotId: result.robotId,
      fromState: result.fromState,
      toState: result.toState,
    }),
  })
}
