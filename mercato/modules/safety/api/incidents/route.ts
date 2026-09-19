import { incidentSchema } from '../../commands/safety'
import { executeCommandRoute } from '../../../fleet/lib/commandRoute'

/**
 * Zgłoszenie zdarzenia bezpieczeństwa.
 *
 * Najniższy próg zgłoszenia w całej wtyczce i to jest decyzja projektowa:
 * uprawnienie `safety.incidents.report` dostaje każdy, kto stoi przy maszynie.
 * Zgłoszenie, które wymaga przejścia przez przełożonego, nie powstaje — a
 * zdarzenie potencjalnie wypadkowe niezgłoszone jest zdarzeniem, którego
 * w statystyce nie ma i przez to nie ma go też w analizie przyczyn.
 *
 * Klasyfikacja ciężaru NIE należy do zgłaszającego: `classifyIncident`
 * wylicza priorytet i to, czy incydent wstrzymuje wdrożenia, z samych faktów
 * (skutek, udział warstwy bezpieczeństwa, udział polityki).
 */
export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['safety.incidents.report'] },
}

export async function POST(request: Request): Promise<Response> {
  return executeCommandRoute({
    request,
    routePath: 'safety/incidents',
    inputSchema: incidentSchema,
    commandId: 'safety.incidents.report',
    describeResource: (input) => ({
      resourceKind: 'safety.incident',
      resourceId: input.robotId ?? input.cellId ?? 'nieprzypisany',
    }),
    mapSuccess: (result: { incidentId: string; priority: string; haltDeployment: boolean; reason: string }) => ({
      incidentId: result.incidentId,
      priority: result.priority,
      haltDeployment: result.haltDeployment,
      reason: result.reason,
    }),
  })
}
