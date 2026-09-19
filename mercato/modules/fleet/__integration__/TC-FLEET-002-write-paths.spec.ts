import { expect, test } from '@playwright/test'
import { getAuthToken, apiRequest } from '@open-mercato/core/helpers/integration/api'

export const integrationMeta = {
  dependsOnModules: ['fleet', 'safety'],
}

/**
 * Ścieżki zapisu — bramki muszą przeżyć drogę przez HTTP.
 *
 * Reguły cyklu życia i kalibracji mają testy jednostkowe na czystych
 * funkcjach, a komendy mają testy wiązania na atrapie bazy. Ten test pyta
 * o rzecz, której żaden z tamtych nie sprawdzi: czy trasa HTTP **woła** te
 * komendy, czy raczej dorobiła sobie własną, łagodniejszą wersję kontroli.
 *
 * Wszystkie przypadki poniżej to **odmowy**, więc test niczego nie zmienia
 * w bazie. To jest celowe: test integracyjny, który zostawia po sobie robota
 * w innym stanie, psuje każdy kolejny przebieg i w końcu zostaje wyłączony.
 */

test.describe.configure({ mode: 'serial' })

test.describe('TC-FLEET-002 ścieżki zapisu', () => {
  test('zapis bez sesji jest odrzucany', async ({ request }) => {
    // Trasy operatorskie NIE są powierzchnią agenta: tam autoryzacja jest
    // kryptograficzna, tutaj sesyjna i bez niej nie ma rozmowy.
    for (const sciezka of ['/api/fleet/robots/transition', '/api/fleet/calibrations', '/api/safety/incidents']) {
      const odpowiedz = await request.fetch(sciezka, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: {},
      })
      expect(odpowiedz.status(), `${sciezka} musi wymagać sesji`).toBe(401)
    }
  })

  test('BRAMKA KALIBRACJI DZIAŁA PRZEZ HTTP, nie tylko w komendzie', async ({ request }) => {
    const token = await getAuthToken(request, 'superadmin')
    const lista = await apiRequest(request, 'GET', '/api/fleet/robots', { token })
    const dane = (await lista.json()) as {
      robots: Array<{ id: string; state: string; calibrationState: string }>
    }

    const zablokowany = dane.robots.find((r) => r.calibrationState === 'blocked' && r.state !== 'ready')
    test.skip(!zablokowany, 'brak robota z nieważną kalibracją w tej bazie')

    const odpowiedz = await apiRequest(request, 'POST', '/api/fleet/robots/transition', {
      token,
      data: {
        robotId: zablokowany!.id,
        toState: 'ready',
        reason: 'test integracyjny — dopuszczenie mimo nieważnej kalibracji',
        actor: 'human',
        approvedBy: '00000000-0000-4000-8000-000000000001',
      },
    })

    expect(odpowiedz.status()).toBe(422)
    const body = (await odpowiedz.json()) as { error?: string }
    // Powód musi dotrzeć do wołającego w całości: operator ma z niego wiedzieć,
    // którego pomiaru brakuje, a nie że „wystąpił błąd".
    expect(body.error ?? '').toMatch(/kalibracj/i)
  })

  test('przejście wymagające podpisu bez podpisu jest odrzucane', async ({ request }) => {
    const token = await getAuthToken(request, 'superadmin')
    const lista = await apiRequest(request, 'GET', '/api/fleet/robots', { token })
    const dane = (await lista.json()) as { robots: Array<{ id: string; state: string }> }

    // `quarantined -> ready` i `maintenance -> ready` zawsze wymagają podpisu.
    const kandydat = dane.robots.find((r) => r.state === 'quarantined' || r.state === 'maintenance')
    test.skip(!kandydat, 'brak robota w stanie wymagającym podpisu przy dopuszczeniu')

    const odpowiedz = await apiRequest(request, 'POST', '/api/fleet/robots/transition', {
      token,
      data: { robotId: kandydat!.id, toState: 'ready', reason: 'test bez podpisu', actor: 'human' },
    })
    expect(odpowiedz.status()).toBe(422)
    const body = (await odpowiedz.json()) as { error?: string }
    expect(body.error ?? '').toMatch(/approvedBy|podpis/i)
  })

  test('kalibracja bez daty ważności nie przechodzi przez schemat', async ({ request }) => {
    const token = await getAuthToken(request, 'superadmin')
    const lista = await apiRequest(request, 'GET', '/api/fleet/robots', { token })
    const dane = (await lista.json()) as { robots: Array<{ id: string }> }
    test.skip(dane.robots.length === 0, 'pusty rejestr floty')

    const odpowiedz = await apiRequest(request, 'POST', '/api/fleet/calibrations', {
      token,
      data: {
        robotId: dane.robots[0].id,
        kind: 'camera_extrinsics',
        measuredAt: new Date().toISOString(),
        // brak `validUntil` — pole obowiązkowe, bo kalibracja bez terminu
        // to kalibracja, o której nikt nigdy nie przypomni
      },
    })
    expect(odpowiedz.status()).toBe(400)
  })

  test('zdarzenie bezpieczeństwa bez opisu nie przechodzi', async ({ request }) => {
    const token = await getAuthToken(request, 'superadmin')
    const odpowiedz = await apiRequest(request, 'POST', '/api/safety/incidents', {
      token,
      data: { harm: 'near_miss', occurredAt: new Date().toISOString(), description: '' },
    })
    expect(odpowiedz.status()).toBe(400)
  })

  test('szczegóły robota zwracają księgę przejść', async ({ request }) => {
    const token = await getAuthToken(request, 'superadmin')
    const lista = await apiRequest(request, 'GET', '/api/fleet/robots', { token })
    const dane = (await lista.json()) as { robots: Array<{ id: string }> }
    test.skip(dane.robots.length === 0, 'pusty rejestr floty')

    const odpowiedz = await apiRequest(request, 'GET', `/api/fleet/robots/${dane.robots[0].id}`, { token })
    expect(odpowiedz.ok()).toBeTruthy()

    const detal = (await odpowiedz.json()) as {
      robot: { id: string; requiredCalibrations: string[] }
      transitions: Array<{ toState: string; reason: string }>
    }
    expect(detal.robot.id).toBe(dane.robots[0].id)
    // Każdy robot ma co najmniej wpis rejestracyjny — księga jest dopisywana
    // od pierwszej chwili istnienia rekordu.
    expect(detal.transitions.length).toBeGreaterThan(0)
    expect(detal.transitions.every((t) => typeof t.reason === 'string' && t.reason.length > 0)).toBeTruthy()
  })

  test('nieistniejący robot to 404, a nie pusta pięćsetka', async ({ request }) => {
    const token = await getAuthToken(request, 'superadmin')
    const odpowiedz = await apiRequest(request, 'GET', '/api/fleet/robots/00000000-0000-4000-8000-000000000000', { token })
    expect(odpowiedz.status()).toBe(404)
    expect(odpowiedz.headers()['content-type'] ?? '').toContain('application/json')
  })
})
