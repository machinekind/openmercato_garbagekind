/**
 * Minimalny klient XML-RPC dla systemu legacy sortowni.
 *
 * Open Mercato rozmawia tu protokołem z 1998 roku bezpośrednio - bez pośrednika,
 * bez pliku pośredniego, bez zależności. Powierzchnia jest dokładnie taka, jaką
 * wystawia prawdziwy webERP, więc podmiana adresu w konfiguracji integracji
 * przestawia moduł na produkcyjną instancję.
 *
 * Zakres jest świadomie wąski: tyle XML-RPC, ile potrzeba do sześciu metod,
 * których używamy. Struktury zagnieżdżone poza <struct>/<array> nie występują
 * w tym API i nie są obsługiwane.
 */

export type RpcValue = string | number | boolean | null | RpcValue[] | { [key: string]: RpcValue }

export const SESSION_COOKIE = 'PHPSESSID'

/** Kody zwrotne w konwencji webERP. */
export const RPC_OK = 0
export const RPC_NOT_AUTHENTICATED = -1
export const RPC_NOT_FOUND = -2

export class LegacyRpcError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message)
    this.name = 'LegacyRpcError'
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function encodeValue(value: RpcValue): string {
  if (value === null || value === undefined) return '<value><string></string></value>'
  if (typeof value === 'boolean') return `<value><boolean>${value ? 1 : 0}</boolean></value>`
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? `<value><int>${value}</int></value>`
      : `<value><double>${value}</double></value>`
  }
  if (Array.isArray(value)) {
    return `<value><array><data>${value.map(encodeValue).join('')}</data></array></value>`
  }
  if (typeof value === 'object') {
    const members = Object.entries(value)
      .map(([key, item]) => `<member><name>${escapeXml(key)}</name>${encodeValue(item)}</member>`)
      .join('')
    return `<value><struct>${members}</struct></value>`
  }
  return `<value><string>${escapeXml(String(value))}</string></value>`
}

function buildRequest(method: string, params: RpcValue[]): string {
  const body = params.map((param) => `<param>${encodeValue(param)}</param>`).join('')
  return `<?xml version="1.0"?><methodCall><methodName>${escapeXml(method)}</methodName><params>${body}</params></methodCall>`
}

/** Prosty parser XML-RPC: wystarczający dla odpowiedzi tego API. */
class ResponseParser {
  private pos = 0

  constructor(private readonly xml: string) {}

  parse(): RpcValue {
    const faultAt = this.xml.indexOf('<fault>')
    if (faultAt !== -1) {
      this.pos = faultAt
      const fault = this.readNextValue() as Record<string, RpcValue>
      const message = typeof fault?.faultString === 'string' ? fault.faultString : 'Błąd XML-RPC'
      const code = typeof fault?.faultCode === 'number' ? fault.faultCode : undefined
      throw new LegacyRpcError(message, code)
    }
    return this.readNextValue()
  }

  private readNextValue(): RpcValue {
    const open = this.xml.indexOf('<value>', this.pos)
    if (open === -1) throw new LegacyRpcError('Odpowiedź XML-RPC bez wartości')
    this.pos = open + '<value>'.length
    return this.readValueBody()
  }

  private readValueBody(): RpcValue {
    const rest = this.xml.slice(this.pos)
    const typeMatch = rest.match(/^\s*<(\w+)>/)
    if (!typeMatch) {
      // <value>tekst</value> bez typu = string
      const end = this.xml.indexOf('</value>', this.pos)
      const text = this.xml.slice(this.pos, end)
      this.pos = end + '</value>'.length
      return decodeText(text)
    }

    const tag = typeMatch[1]
    this.pos += typeMatch[0].length

    if (tag === 'struct') return this.readStruct()
    if (tag === 'array') return this.readArray()

    const closeAt = this.xml.indexOf(`</${tag}>`, this.pos)
    const raw = this.xml.slice(this.pos, closeAt)
    this.pos = closeAt + tag.length + 3
    const valueEnd = this.xml.indexOf('</value>', this.pos)
    if (valueEnd !== -1) this.pos = valueEnd + '</value>'.length

    if (tag === 'int' || tag === 'i4') return Number.parseInt(raw, 10)
    if (tag === 'double') return Number.parseFloat(raw)
    if (tag === 'boolean') return raw.trim() === '1'
    if (tag === 'nil') return null
    return decodeText(raw)
  }

  private readStruct(): Record<string, RpcValue> {
    const out: Record<string, RpcValue> = {}
    for (;;) {
      const memberAt = this.xml.indexOf('<member>', this.pos)
      const structEnd = this.xml.indexOf('</struct>', this.pos)
      if (memberAt === -1 || (structEnd !== -1 && structEnd < memberAt)) break
      const nameOpen = this.xml.indexOf('<name>', memberAt) + '<name>'.length
      const nameClose = this.xml.indexOf('</name>', nameOpen)
      const key = decodeText(this.xml.slice(nameOpen, nameClose))
      this.pos = nameClose
      out[key] = this.readNextValue()
    }
    const structEnd = this.xml.indexOf('</struct>', this.pos)
    if (structEnd !== -1) this.pos = structEnd + '</struct>'.length
    const valueEnd = this.xml.indexOf('</value>', this.pos)
    if (valueEnd !== -1) this.pos = valueEnd + '</value>'.length
    return out
  }

  private readArray(): RpcValue[] {
    const out: RpcValue[] = []
    const dataAt = this.xml.indexOf('<data>', this.pos)
    if (dataAt !== -1) this.pos = dataAt + '<data>'.length
    for (;;) {
      const valueAt = this.xml.indexOf('<value>', this.pos)
      const dataEnd = this.xml.indexOf('</data>', this.pos)
      if (valueAt === -1 || (dataEnd !== -1 && dataEnd < valueAt)) break
      out.push(this.readNextValue())
    }
    const dataEnd = this.xml.indexOf('</data>', this.pos)
    if (dataEnd !== -1) this.pos = dataEnd + '</data>'.length
    const arrayEnd = this.xml.indexOf('</array>', this.pos)
    if (arrayEnd !== -1) this.pos = arrayEnd + '</array>'.length
    const valueEnd = this.xml.indexOf('</value>', this.pos)
    if (valueEnd !== -1) this.pos = valueEnd + '</value>'.length
    return out
  }
}

function decodeText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/&amp;/g, '&')
}

export type LegacyCustomer = {
  debtorno: string
  name: string
  address1: string
  address2: string
  debtortype: string
  currcode: string
  clientsince: string
}

export type LegacyLocation = {
  loccode: string
  locationname: string
  deladd1?: string
}

/**
 * Klient trzymający sesję dokładnie tak, jak wymaga tego webERP: logowanie
 * zwraca kod liczbowy, a autoryzacja jedzie dalej ciasteczkiem PHPSESSID.
 */
export class LegacyRpcClient {
  private cookie: string | null = null

  constructor(
    private readonly endpoint: string,
    private readonly timeoutMs = 15_000,
  ) {}

  private async call(method: string, params: RpcValue[] = []): Promise<RpcValue> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const headers: Record<string, string> = { 'content-type': 'text/xml; charset=utf-8' }
      if (this.cookie) headers.cookie = `${SESSION_COOKIE}=${this.cookie}`

      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: buildRequest(method, params),
        signal: controller.signal,
      })

      const setCookie = response.headers.get('set-cookie')
      if (setCookie?.startsWith(`${SESSION_COOKIE}=`)) {
        this.cookie = setCookie.split(';', 1)[0].split('=')[1]
      }

      if (!response.ok && response.status !== 200) {
        throw new LegacyRpcError(`System legacy odpowiedział ${response.status}`, response.status)
      }
      return new ResponseParser(await response.text()).parse()
    } finally {
      clearTimeout(timer)
    }
  }

  /** Zwraca kod webERP: 0 = sukces. Ustawia sesję na kliencie. */
  async login(user: string, password: string, company: string): Promise<number> {
    const code = await this.call('weberp.xmlrpc_Login', [user, password, company])
    if (typeof code !== 'number') throw new LegacyRpcError('Login zwrócił nieoczekiwaną wartość')
    if (code === RPC_OK && !this.cookie) {
      throw new LegacyRpcError('Login zwrócił 0, ale serwer nie ustawił ciasteczka sesji')
    }
    return code
  }

  private ensureAuthorized<T>(result: RpcValue, method: string): T {
    if (result === RPC_NOT_AUTHENTICATED) {
      throw new LegacyRpcError(`${method}: brak ważnej sesji (-1)`, RPC_NOT_AUTHENTICATED)
    }
    return result as T
  }

  async getCustomer(debtorno: string): Promise<LegacyCustomer | null> {
    const result = this.ensureAuthorized<RpcValue>(
      await this.call('weberp.xmlrpc_GetCustomer', [debtorno]),
      'GetCustomer',
    )
    if (result === RPC_NOT_FOUND) return null
    return result as unknown as LegacyCustomer
  }

  async getLocationList(): Promise<LegacyLocation[]> {
    return this.ensureAuthorized<LegacyLocation[]>(
      await this.call('weberp.xmlrpc_GetLocationList'),
      'GetLocationList',
    )
  }

  async getLocationDetails(loccode: string): Promise<LegacyLocation | null> {
    const result = this.ensureAuthorized<RpcValue>(
      await this.call('weberp.xmlrpc_GetLocationDetails', [loccode]),
      'GetLocationDetails',
    )
    if (result === RPC_NOT_FOUND) return null
    return result as unknown as LegacyLocation
  }

  async getStockBalance(stockid: string, loccode: string): Promise<number> {
    const result = this.ensureAuthorized<Record<string, RpcValue>>(
      await this.call('weberp.xmlrpc_GetStockBalance', [stockid, loccode]),
      'GetStockBalance',
    )
    const quantity = result?.quantity
    return typeof quantity === 'number' ? quantity : Number.parseFloat(String(quantity ?? 0)) || 0
  }

  async getSalesOrderHeader(orderno: number): Promise<Record<string, RpcValue> | null> {
    const result = this.ensureAuthorized<RpcValue>(
      await this.call('weberp.xmlrpc_GetSalesOrderHeader', [orderno]),
      'GetSalesOrderHeader',
    )
    if (result === RPC_NOT_FOUND) return null
    return result as Record<string, RpcValue>
  }
}
