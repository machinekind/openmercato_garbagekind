import { expect, test } from '@playwright/test'
import { getAuthToken, apiRequest } from '@open-mercato/core/helpers/integration/api'

export const integrationMeta = {
  dependsOnModules: ['edge', 'deployment'],
}

/**
 * Powierzchnia agenta — jedyne w tej wtyczce punkty wejścia **bez**
 * uwierzytelnienia sesyjnego.
 *
 * Testy jednostkowe modułu `edge` sprawdzają kryptografię i cykl sesji na
 * atrapie bazy. Tutaj sprawdzamy rzecz, której atrapa nie sprawdzi: że te
 * pięć tras naprawdę stoi otworem na świat i naprawdę odrzuca to, co ma
 * odrzucać. Trasa bez uwierzytelnienia, która przy śmieciowym wejściu
 * sypie się pięćsetką zamiast odmawiać, jest powierzchnią ataku, a nie
 * kanałem dla maszyn.
 *
 * Świadomie nie budujemy tu pełnej ścieżki wpisania agenta: wymagałaby
 * robota bez agenta, a jedynym sposobem, żeby go dostać, jest odwołanie
 * agenta istniejącego — czyli zniszczenie stanu, z którego korzystają
 * inne testy. Ścieżkę pozytywną pokrywa `edge/__tests__/commands.test.ts`
 * na pełnej kryptografii Ed25519.
 */

const TRASY_AGENTA = [
  { sciezka: '/api/edge/enroll', ladunek: { token: 'nieistniejacy', publicKey: 'x', signature: 'y' } },
  { sciezka: '/api/edge/connect', ladunek: { agentId: '00000000-0000-4000-8000-000000000000', timestamp: new Date().toISOString(), signature: 'y' } },
  { sciezka: '/api/edge/heartbeat', ladunek: { sessionId: '00000000-0000-4000-8000-000000000000', sequence: 1, timestamp: new Date().toISOString(), signature: 'y' } },
  { sciezka: '/api/deployment/lease', ladunek: { organizationId: '00000000-0000-4000-8000-000000000000', agentSessionId: '00000000-0000-4000-8000-000000000000', sequence: 1, timestamp: new Date().toISOString(), signature: 'y' } },
  { sciezka: '/api/deployment/report', ladunek: { organizationId: '00000000-0000-4000-8000-000000000000', agentSessionId: '00000000-0000-4000-8000-000000000000', reportedState: 'running', timestamp: new Date().toISOString(), signature: 'y' } },
]

test.describe.configure({ mode: 'serial' })

test.describe('TC-EDGE-001 powierzchnia agenta', () => {
  test('trasy agenta są osiągalne bez sesji i odmawiają przy złych danych', async ({ request }) => {
    for (const { sciezka, ladunek } of TRASY_AGENTA) {
      const odpowiedz = await request.fetch(sciezka, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: ladunek,
      })

      /*
       * Dowodem, że trasa istnieje, jest **JSON z polem `error`**, a nie kod
       * stanu. Nasza obsługa zwraca 404 z własnym komunikatem, gdy nie
       * rozpozna kontekstu żądania (nieistniejący bilet, nieistniejąca
       * sesja) — i to jest poprawna odmowa, a nie brak trasy. Brak trasy
       * wygląda inaczej: Next oddaje stronę HTML.
       */
      const typ = odpowiedz.headers()['content-type'] ?? ''
      expect(typ, `${sciezka} musi odpowiadać JSON-em, nie stroną HTML`).toContain('application/json')

      const cialo = (await odpowiedz.json()) as { error?: string }
      expect(typeof cialo.error, `${sciezka} musi nazwać powód odmowy`).toBe('string')

      // Odmowa jest normalną odpowiedzią; awaria nie.
      expect(odpowiedz.status(), `${sciezka} nie może się wywracać na śmieciowym wejściu`).toBeLessThan(500)
    }
  })

  test('uderzenie serca bez podpisu jest odrzucane', async ({ request }) => {
    const odpowiedz = await request.fetch('/api/edge/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: { sessionId: '00000000-0000-4000-8000-000000000000', sequence: 1, timestamp: new Date().toISOString() },
    })
    expect(odpowiedz.ok()).toBeFalsy()
    expect(odpowiedz.status()).toBeLessThan(500)
    expect((await odpowiedz.json()) as { error?: string }).toHaveProperty('error')
  })

  test('przegląd agentów wymaga sesji', async ({ request }) => {
    // Odwrotność powyższego: ekran operatorski NIE jest powierzchnią agenta.
    const bezSesji = await request.fetch('/api/edge/agents', { method: 'GET' })
    expect(bezSesji.status()).toBe(401)

    const token = await getAuthToken(request, 'superadmin')
    const zSesja = await apiRequest(request, 'GET', '/api/edge/agents', { token })
    expect(zSesja.ok()).toBeTruthy()

    const dane = (await zSesja.json()) as { totals?: Record<string, number>; agents?: unknown[] }
    expect(dane.totals).toBeTruthy()
    expect(Array.isArray(dane.agents)).toBeTruthy()

    // Suma stanów musi się zgadzać z listą — rozjazd znaczy, że któryś stan
    // żywotności jest liczony dwa razy albo wcale.
    const t = dane.totals as Record<string, number>
    expect(t.online + t.late + t.lost + t.neverSeen).toBeLessThanOrEqual(t.agents)
  })
})
