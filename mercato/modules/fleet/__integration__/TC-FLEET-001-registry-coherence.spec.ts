import { expect, test } from '@playwright/test'
import { getAuthToken, apiRequest } from '@open-mercato/core/helpers/integration/api'

export const integrationMeta = {
  dependsOnModules: ['fleet', 'edge', 'safety'],
}

/**
 * Spójność rejestru floty i rejestru zdarzeń.
 *
 * Testy jednostkowe sprawdzają reguły na atrapie bazy; ten test sprawdza to,
 * czego atrapa nie widzi - czy w działającej aplikacji liczby na ekranie
 * zgadzają się z danymi, z których powstały, i czy zdarzenia zadeklarowane
 * w modułach faktycznie docierają do rejestru, z którego korzysta edytor
 * workflow.
 *
 * To drugie jest tu najważniejsze: zdarzenie zadeklarowane i niewidoczne
 * w rejestrze to wyzwalacz, którego nikt nie wybierze, a zdarzenie widoczne
 * bez opisanego ładunku to wyzwalacz, do którego nie da się nic podpiąć.
 */

test.describe.configure({ mode: 'serial' })

test.describe('TC-FLEET-001 spójność rejestru', () => {
  test('liczniki floty zgadzają się z listą robotów', async ({ request }) => {
    const token = await getAuthToken(request, 'superadmin')
    const odpowiedz = await apiRequest(request, 'GET', '/api/fleet/robots', { token })
    expect(odpowiedz.ok()).toBeTruthy()

    const dane = (await odpowiedz.json()) as {
      totals: { robots: number; active: number; quarantined: number; calibrationBlocked: number }
      robots: Array<{ state: string; calibrationState: string }>
    }

    expect(dane.totals.robots).toBe(dane.robots.length)
    expect(dane.totals.active).toBe(
      dane.robots.filter((r) => r.state === 'ready' || r.state === 'operational').length,
    )
    expect(dane.totals.quarantined).toBe(dane.robots.filter((r) => r.state === 'quarantined').length)

    // Maszyna czynna z zablokowaną kalibracją nie może istnieć: bramka
    // dopuszczenia sprawdza kalibrację przy przejściu do `ready`.
    const sprzeczne = dane.robots.filter(
      (r) => r.state === 'ready' && r.calibrationState === 'blocked',
    )
    expect(sprzeczne, 'robot dopuszczony mimo nieważnej kalibracji').toEqual([])
  })

  test('zdarzenia wtyczki są w rejestrze i każde ma opisany ładunek', async ({ request }) => {
    const token = await getAuthToken(request, 'superadmin')
    const MODULY: Record<string, number> = {
      fleet: 8, edge: 7, policy_registry: 5, deployment: 4, episodes: 4,
      rollout: 5, safety: 8, datasets: 4, work_orders: 5, vision: 7, compute: 2,
    }

    for (const [modul, ile] of Object.entries(MODULY)) {
      const odpowiedz = await apiRequest(request, 'GET', `/api/events?module=${modul}`, { token })
      expect(odpowiedz.ok(), `rejestr zdarzeń dla ${modul}`).toBeTruthy()

      const dane = (await odpowiedz.json()) as {
        total: number
        data: Array<{ id: string; payloadSchema?: { fields: unknown[] } }>
      }
      expect(dane.total, `${modul}: liczba zadeklarowanych zdarzeń`).toBe(ile)

      // Zdarzenie bez opisanego ładunku daje autorowi automatyzacji wybór
      // „zrób coś, gdy to padnie" i nic więcej.
      const bezLadunku = dane.data.filter((e) => !e.payloadSchema?.fields?.length)
      expect(bezLadunku.map((e) => e.id), `${modul}: zdarzenia bez ładunku`).toEqual([])
    }
  })

  test('katalog widgetów odpowiada i nie jest pusty', async ({ request }) => {
    /*
     * Świadomie NIE sprawdzamy tu, czy nasze trzy widgety są w katalogu.
     * Katalog jest filtrowany przez `dashboard_role_widgets` - jawną listę
     * dozwolonych widgetów zapisywaną przy inicjalizacji tenanta. Moduł
     * doinstalowany później nie trafia na nią sam; robi to dopiero
     * `mercato <moduł> install-widgets`. Test twierdzący inaczej mówiłby
     * o stanie konfiguracji tej konkretnej bazy, a nie o naszym kodzie -
     * i przechodziłby albo nie zależnie od tego, czy ktoś uruchomił komendę.
     *
     * Sprawdzamy więc to, co jest nasze do sprawdzenia: że trasa żyje
     * i że rejestr widgetów nie jest pusty (pusty znaczy wyścig przy starcie,
     * który platforma sygnalizuje kodem 503).
     */
    const token = await getAuthToken(request, 'superadmin')
    const odpowiedz = await apiRequest(request, 'GET', '/api/dashboards/layout', { token })
    expect(odpowiedz.ok()).toBeTruthy()

    const dane = (await odpowiedz.json()) as { widgets?: unknown[] }
    expect(Array.isArray(dane.widgets)).toBeTruthy()
    expect((dane.widgets ?? []).length, 'pusty rejestr widgetów to wyścig przy starcie').toBeGreaterThan(0)
  })
})
