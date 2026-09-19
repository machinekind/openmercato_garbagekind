import { generateKeyPairSync, sign as signPayload } from 'node:crypto'
import {
  assertSupportedPublicKey,
  canonicalJson,
  fingerprintPublicKey,
  generateEnrollmentToken,
  hashEnrollmentToken,
  payloads,
  selectUsableKeys,
  verifyPayloadSignature,
} from '../lib/crypto'

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: (payload: string) => signPayload(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64'),
  }
}

describe('bilet wpisowy', () => {
  it('jest za każdym razem inny i ma co najmniej 256 bitów entropii', () => {
    const a = generateEnrollmentToken()
    const b = generateEnrollmentToken()
    expect(a).not.toBe(b)
    expect(Buffer.from(a, 'base64url')).toHaveLength(32)
  })

  it('skrót jest deterministyczny i nie da się z niego odtworzyć biletu', () => {
    const token = generateEnrollmentToken()
    expect(hashEnrollmentToken(token)).toBe(hashEnrollmentToken(token))
    expect(hashEnrollmentToken(token)).not.toContain(token)
  })
})

describe('klucze', () => {
  it('odcisk jest stabilny mimo różnic w zapisie PEM', () => {
    const { publicKeyPem } = keypair()
    // Inne końce wierszy, ten sam klucz — operator porównujący odcisk z ekranu
    // robota nie może zobaczyć rozbieżności tam, gdzie jej nie ma.
    const crlf = publicKeyPem.replace(/\n/g, '\r\n')
    expect(fingerprintPublicKey(crlf)).toBe(fingerprintPublicKey(publicKeyPem))
  })

  it('dwa różne klucze mają różne odciski', () => {
    expect(fingerprintPublicKey(keypair().publicKeyPem)).not.toBe(fingerprintPublicKey(keypair().publicKeyPem))
  })

  it('odrzuca klucz innego algorytmu', () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    expect(() => assertSupportedPublicKey(publicKey.export({ type: 'spki', format: 'pem' }).toString())).toThrow(
      /Nieobsługiwany algorytm/,
    )
  })

  it('odrzuca śmieć zamiast klucza', () => {
    expect(() => assertSupportedPublicKey('to nie jest klucz')).toThrow(/nie daje się odczytać/)
  })
})

describe('podpisy', () => {
  it('kanoniczny JSON nie zależy od kolejności kluczy obiektu', () => {
    const a = { wynik: { b: 2, a: 1 }, klasy: ['person', 'robot'] }
    const b = { klasy: ['person', 'robot'], wynik: { a: 1, b: 2 } }
    expect(canonicalJson(a)).toBe(canonicalJson(b))
    expect(payloads.telemetry('sesja-1', 1, '2026-09-19T10:00:00.000Z', 'episode', a)).toBe(
      payloads.telemetry('sesja-1', 1, '2026-09-19T10:00:00.000Z', 'episode', b),
    )
  })

  it('podpis telemetrii wiąże rodzaj i pełną treść rekordu', () => {
    const agent = keypair()
    const original = payloads.telemetry(
      'sesja-1',
      7,
      '2026-09-19T10:00:00.000Z',
      'episode',
      { outcome: 'success', metrics: { pieces: 4 } },
    )
    const changedKind = payloads.telemetry(
      'sesja-1',
      7,
      '2026-09-19T10:00:00.000Z',
      'intervention',
      { outcome: 'success', metrics: { pieces: 4 } },
    )
    const changedBody = payloads.telemetry(
      'sesja-1',
      7,
      '2026-09-19T10:00:00.000Z',
      'episode',
      { outcome: 'success', metrics: { pieces: 5 } },
    )
    const signature = agent.sign(original)
    expect(verifyPayloadSignature(changedKind, signature, agent.publicKeyPem)).toBe(false)
    expect(verifyPayloadSignature(changedBody, signature, agent.publicKeyPem)).toBe(false)
  })

  it('poprawny podpis przechodzi, cudzy nie', () => {
    const alice = keypair()
    const mallory = keypair()
    const payload = payloads.connect('agent-1', '2026-09-19T10:00:00.000Z')
    expect(verifyPayloadSignature(payload, alice.sign(payload), alice.publicKeyPem)).toBe(true)
    expect(verifyPayloadSignature(payload, mallory.sign(payload), alice.publicKeyPem)).toBe(false)
  })

  it('WIĄZANIE KONTEKSTU: podpis heartbeatu nie działa jako podpis wpisu', () => {
    // Gdyby komunikaty nie miały rozłącznych przedrostków, przechwycony podpis
    // z jednego kontekstu dałoby się przedstawić w drugim.
    const agent = keypair()
    const heartbeat = payloads.heartbeat('sesja-1', 7, '2026-09-19T10:00:00.000Z')
    const enroll = payloads.enroll('sesja-1', '7')
    expect(verifyPayloadSignature(enroll, agent.sign(heartbeat), agent.publicKeyPem)).toBe(false)
  })

  it('zmiana numeru kolejnego unieważnia podpis', () => {
    const agent = keypair()
    const original = payloads.heartbeat('sesja-1', 7, '2026-09-19T10:00:00.000Z')
    const tampered = payloads.heartbeat('sesja-1', 8, '2026-09-19T10:00:00.000Z')
    expect(verifyPayloadSignature(tampered, agent.sign(original), agent.publicKeyPem)).toBe(false)
  })

  it('zniekształcony podpis jest nieważny, a nie wyjątkiem', () => {
    const agent = keypair()
    expect(verifyPayloadSignature('cokolwiek', 'nie-base64-@@@', agent.publicKeyPem)).toBe(false)
  })
})

describe('selectUsableKeys', () => {
  const now = new Date('2026-09-19T10:00:00Z')
  const minutes = (n: number) => new Date(now.getTime() + n * 60_000)

  it('OKNO ZAKŁADKOWE: w trakcie rotacji ważne są dwa klucze naraz', () => {
    const stary = { activeFrom: minutes(-600), activeUntil: minutes(15) }
    const nowy = { activeFrom: minutes(0), activeUntil: null }
    expect(selectUsableKeys([stary, nowy], now)).toHaveLength(2)
  })

  it('po zamknięciu okna stary klucz przestaje weryfikować', () => {
    const stary = { activeFrom: minutes(-600), activeUntil: minutes(-1) }
    const nowy = { activeFrom: minutes(-10), activeUntil: null }
    expect(selectUsableKeys([stary, nowy], now)).toEqual([nowy])
  })

  it('odwołanie działa natychmiast, niezależnie od okna', () => {
    const skradziony = { activeFrom: minutes(-600), activeUntil: minutes(60), revokedAt: minutes(-1) }
    expect(selectUsableKeys([skradziony], now)).toHaveLength(0)
  })

  it('klucz z datą startu w przyszłości jeszcze nie działa', () => {
    expect(selectUsableKeys([{ activeFrom: minutes(5), activeUntil: null }], now)).toHaveLength(0)
  })
})
