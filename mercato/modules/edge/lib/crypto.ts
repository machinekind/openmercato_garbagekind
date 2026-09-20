import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto'

/**
 * Warstwa kryptograficzna kanału brzegowego.
 *
 * Założenie, które przesądza o kształcie całej reszty: **klucz prywatny nigdy
 * nie opuszcza robota**. Centrala zna wyłącznie klucz publiczny, więc nie da
 * się podszyć pod agenta wykradając bazę - co przy flocie maszyn poruszających
 * się w przestrzeni z ludźmi nie jest rozważaniem akademickim.
 *
 * Konsekwencja praktyczna: heartbeat nie jest deklaracją („jestem agentem X"),
 * tylko dowodem. Endpoint przyjmujący samą deklarację chroniłby dokładnie
 * przed niczym - każdy, kto zna identyfikator, mógłby utrzymywać martwego
 * robota przy życiu na pulpicie.
 */

/** Ed25519 - krótkie klucze, szybka weryfikacja, brak parametrów do pomylenia. */
export const SUPPORTED_ALGORITHM = 'ed25519'

/** Bilet wpisowy: 32 bajty losowe w base64url. Zwracany raz, zapisywany tylko jako skrót. */
export function generateEnrollmentToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashEnrollmentToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * Stabilna reprezentacja JSON używana wyłącznie do podpisu.
 *
 * `JSON.stringify` zachowuje kolejność wstawiania kluczy, więc dwa równoważne
 * obiekty zbudowane przez różne implementacje agenta mogłyby dać inny podpis.
 * Sortowanie kluczy na każdym poziomie usuwa tę przypadkowość; kolejność tablic
 * pozostaje znacząca, bo np. wektor obserwacji jest z definicji uporządkowany.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Podpisywany JSON nie może zawierać NaN ani nieskończoności.')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    return `{${entries.join(',')}}`
  }
  throw new Error(`Nieobsługiwana wartość w podpisywanym JSON: ${typeof value}.`)
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Skrót klucza publicznego liczony z postaci **DER**, nie z tekstu PEM.
 *
 * Ten sam klucz zapisany z innymi końcami wierszy dałby inny skrót tekstowy,
 * a operator porównujący odcisk z ekranu robota zobaczyłby rozbieżność tam,
 * gdzie jej nie ma.
 */
export function fingerprintPublicKey(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(der).digest('hex')
}

export function assertSupportedPublicKey(publicKeyPem: string): void {
  let key
  try {
    key = createPublicKey(publicKeyPem)
  } catch {
    throw new Error('Klucz publiczny nie daje się odczytać - oczekiwano PEM/SPKI.')
  }
  if (key.asymmetricKeyType !== SUPPORTED_ALGORITHM) {
    throw new Error(
      `Nieobsługiwany algorytm klucza: ${key.asymmetricKeyType ?? 'nieznany'}. Kanał brzegowy używa ${SUPPORTED_ALGORITHM}.`,
    )
  }
}

/**
 * Kanoniczne postacie podpisywanych komunikatów.
 *
 * Rozdzielone przedrostkiem celowo: podpis zebrany w jednym kontekście nie
 * może być użyty w innym. Bez przedrostka podpis heartbeatu dałoby się
 * przedstawić jako podpis wpisu - klasyczny błąd wiązania kontekstu.
 */
export const payloads = {
  enroll: (token: string, fingerprint: string): string => `edge.enroll:${token}:${fingerprint}`,
  connect: (agentId: string, timestampIso: string): string => `edge.connect:${agentId}:${timestampIso}`,
  heartbeat: (sessionId: string, sequence: number, timestampIso: string): string =>
    `edge.heartbeat:${sessionId}:${sequence}:${timestampIso}`,
  /**
   * Treść telemetrii wiążemy z sesją, kolejnością, czasem i rodzajem rekordu.
   * Do podpisu trafia skrót kanonicznego JSON-u, więc nie przesyłamy ani nie
   * logujemy drugi raz potencjalnie dużych metryk epizodu.
   */
  telemetry: (
    sessionId: string,
    sequence: number,
    timestampIso: string,
    kind: string,
    payload: unknown,
  ): string =>
    `edge.telemetry:${sessionId}:${sequence}:${timestampIso}:${kind}:${sha256(canonicalJson(payload))}`,
  /** Rotacja podpisywana NOWYM kluczem - dowodem jest posiadanie następcy, nie poprzednika. */
  rotate: (agentId: string, fingerprint: string): string => `edge.rotate:${agentId}:${fingerprint}`,
}

export function verifyPayloadSignature(
  payload: string,
  signatureBase64: string,
  publicKeyPem: string,
): boolean {
  try {
    return verifySignature(
      null,
      Buffer.from(payload, 'utf8'),
      createPublicKey(publicKeyPem),
      Buffer.from(signatureBase64, 'base64'),
    )
  } catch {
    // Zniekształcony podpis jest podpisem nieważnym, nie błędem serwera.
    return false
  }
}

/**
 * Klucz ważny w danej chwili.
 *
 * Okno zakładkowe jest tu obsłużone wprost: klucz z ustawionym `activeUntil`
 * w przyszłości wciąż weryfikuje, bo w trakcie rotacji robot może jeszcze
 * podpisywać starym. Bez tego każda rotacja byłaby zaplanowanym zerwaniem
 * łączności z całą flotą naraz.
 */
export function selectUsableKeys<T extends { activeFrom: Date; activeUntil?: Date | null; revokedAt?: Date | null }>(
  keys: T[],
  now: Date = new Date(),
): T[] {
  return keys.filter((key) => {
    if (key.revokedAt && key.revokedAt.getTime() <= now.getTime()) return false
    if (key.activeFrom.getTime() > now.getTime()) return false
    if (key.activeUntil && key.activeUntil.getTime() <= now.getTime()) return false
    return true
  })
}
