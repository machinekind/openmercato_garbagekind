import { LegacyRpcClient, LegacyRpcError, RPC_OK } from '../legacyRpc'

/**
 * Klient XML-RPC rozmawia z systemem, którego nie da się poprawić.
 * Każde odstępstwo od tego, co naprawdę wysyła i przyjmuje webERP, kończy się
 * awarią dopiero na produkcji - dlatego ramka i ścieżki błędów są tu opisane
 * wprost, a nie sprawdzane „przy okazji".
 */

type FakeResponse = {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}

function xmlResponse(body: string, init: { status?: number; setCookie?: string } = {}): FakeResponse {
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'set-cookie' ? (init.setCookie ?? null) : null),
    },
    text: async () => body,
  }
}

function methodResponse(inner: string): string {
  return `<?xml version="1.0"?><methodResponse><params><param>${inner}</param></params></methodResponse>`
}

const ENDPOINT = 'http://legacy.test/api/api_xml-rpc.php'

describe('LegacyRpcClient - ramka żądania', () => {
  let calls: Array<{ url: string; init: RequestInit }>

  beforeEach(() => {
    calls = []
    globalThis.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return xmlResponse(methodResponse('<value><int>0</int></value>'), { setCookie: 'PHPSESSID=abc123; Path=/; HttpOnly' })
    }) as unknown as typeof fetch
  })

  it('wysyła methodCall z nazwą metody i argumentami w kolejności webERP', async () => {
    const client = new LegacyRpcClient(ENDPOINT)
    await client.login('demo', 'demo', 'weberpdemo')

    expect(calls).toHaveLength(1)
    const body = String(calls[0].init.body)
    expect(body).toContain('<methodName>weberp.xmlrpc_Login</methodName>')
    expect(body.indexOf('demo')).toBeLessThan(body.indexOf('weberpdemo'))
    expect(calls[0].init.headers).toMatchObject({ 'content-type': 'text/xml; charset=utf-8' })
  })

  it('dokleja ciasteczko sesji do kolejnych wywołań, nigdy do pierwszego', async () => {
    const client = new LegacyRpcClient(ENDPOINT)
    await client.login('demo', 'demo', 'weberpdemo')

    globalThis.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return xmlResponse(methodResponse('<value><array><data></data></array></value>'))
    }) as unknown as typeof fetch

    await client.getLocationList()

    expect((calls[0].init.headers as Record<string, string>).cookie).toBeUndefined()
    expect((calls[1].init.headers as Record<string, string>).cookie).toBe('PHPSESSID=abc123')
  })

  it('escapuje znaki specjalne w argumentach, żeby ramka pozostała poprawna', async () => {
    const client = new LegacyRpcClient(ENDPOINT)
    await client.login('demo', 'demo', 'weberpdemo')
    globalThis.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return xmlResponse(methodResponse('<value><int>-2</int></value>'))
    }) as unknown as typeof fetch

    await client.getCustomer('D&<001>')

    expect(String(calls[1].init.body)).toContain('D&amp;&lt;001&gt;')
  })
})

describe('LegacyRpcClient - logowanie', () => {
  it('zwraca kod 0 i zapamiętuje sesję', async () => {
    globalThis.fetch = jest.fn(async () =>
      xmlResponse(methodResponse('<value><int>0</int></value>'), { setCookie: 'PHPSESSID=s1; Path=/' }),
    ) as unknown as typeof fetch

    const client = new LegacyRpcClient(ENDPOINT)
    await expect(client.login('demo', 'demo', 'weberpdemo')).resolves.toBe(RPC_OK)
  })

  it('oddaje kod odmowy bez rzucania - kody 3 i 4 to odpowiedź, nie awaria', async () => {
    globalThis.fetch = jest.fn(async () =>
      xmlResponse(methodResponse('<value><int>4</int></value>')),
    ) as unknown as typeof fetch

    const client = new LegacyRpcClient(ENDPOINT)
    await expect(client.login('demo', 'demo', 'zla-firma')).resolves.toBe(4)
  })

  it('traktuje sukces bez ciasteczka jako błąd - inaczej kolejne wywołania dostałyby -1', async () => {
    globalThis.fetch = jest.fn(async () =>
      xmlResponse(methodResponse('<value><int>0</int></value>')),
    ) as unknown as typeof fetch

    const client = new LegacyRpcClient(ENDPOINT)
    await expect(client.login('demo', 'demo', 'weberpdemo')).rejects.toThrow(/ciasteczka sesji/)
  })
})

describe('LegacyRpcClient - parsowanie odpowiedzi', () => {
  async function respondWith(inner: string) {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        xmlResponse(methodResponse('<value><int>0</int></value>'), { setCookie: 'PHPSESSID=s1' }),
      )
      .mockResolvedValue(xmlResponse(methodResponse(inner))) as unknown as typeof fetch
    const client = new LegacyRpcClient(ENDPOINT)
    await client.login('demo', 'demo', 'weberpdemo')
    return client
  }

  it('czyta tablicę struktur (GetLocationList)', async () => {
    const client = await respondWith(
      '<value><array><data>' +
        '<value><struct>' +
        '<member><name>loccode</name><value><string>PRZYJ</string></value></member>' +
        '<member><name>locationname</name><value><string>Plac przyjec</string></value></member>' +
        '</struct></value>' +
        '<value><struct>' +
        '<member><name>loccode</name><value><string>BOKS1</string></value></member>' +
        '<member><name>locationname</name><value><string>Boks 1</string></value></member>' +
        '</struct></value>' +
        '</data></array></value>',
    )

    await expect(client.getLocationList()).resolves.toEqual([
      { loccode: 'PRZYJ', locationname: 'Plac przyjec' },
      { loccode: 'BOKS1', locationname: 'Boks 1' },
    ])
  })

  it('czyta liczby zmiennoprzecinkowe ze stanu magazynowego', async () => {
    const client = await respondWith(
      '<value><struct>' +
        '<member><name>stockid</name><value><string>20 01 01</string></value></member>' +
        '<member><name>quantity</name><value><double>4685.98</double></value></member>' +
        '</struct></value>',
    )

    await expect(client.getStockBalance('20 01 01', 'BOKS1')).resolves.toBeCloseTo(4685.98, 2)
  })

  it('zamienia -2 na brak rekordu, a nie na wyjątek', async () => {
    const client = await respondWith('<value><int>-2</int></value>')
    await expect(client.getCustomer('D999')).resolves.toBeNull()
  })

  it('zgłasza brak sesji (-1) jako błąd z kodem - to pierwsza ścieżka, która wywraca klienta', async () => {
    const client = await respondWith('<value><int>-1</int></value>')
    await expect(client.getLocationList()).rejects.toMatchObject({
      name: 'LegacyRpcError',
      code: -1,
    })
  })

  it('zamienia <fault> na LegacyRpcError z kodem serwera', async () => {
    globalThis.fetch = jest.fn(async () =>
      xmlResponse(
        '<?xml version="1.0"?><methodResponse><fault><value><struct>' +
          '<member><name>faultCode</name><value><int>-32601</int></value></member>' +
          '<member><name>faultString</name><value><string>Nieznana metoda</string></value></member>' +
          '</struct></value></fault></methodResponse>',
      ),
    ) as unknown as typeof fetch

    const client = new LegacyRpcClient(ENDPOINT)
    await expect(client.login('demo', 'demo', 'weberpdemo')).rejects.toBeInstanceOf(LegacyRpcError)
  })

  it('dekoduje encje XML w tekście', async () => {
    const client = await respondWith(
      '<value><struct>' +
        '<member><name>loccode</name><value><string>BOKS1</string></value></member>' +
        '<member><name>locationname</name><value><string>Boks &amp; Plac &lt;1&gt;</string></value></member>' +
        '</struct></value>',
    )

    await expect(client.getLocationDetails('BOKS1')).resolves.toMatchObject({
      locationname: 'Boks & Plac <1>',
    })
  })
})
