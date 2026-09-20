import { canonicalArtifactForm, computeContentDigest, validateArtifactSet } from '../lib/digest'

/**
 * Skrót treści jest tożsamością wersji, więc testowane jest przede wszystkim to,
 * co go **nie** zmienia. Test sprawdzający tylko „dwa różne komplety dają różne
 * skróty" przeszedłby też dla funkcji losowej.
 */

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)

describe('canonicalArtifactForm', () => {
  it('nie zależy od kolejności podania artefaktów', () => {
    const one = canonicalArtifactForm([
      { role: 'weights', digest: A },
      { role: 'config', digest: B },
    ])
    const two = canonicalArtifactForm([
      { role: 'config', digest: B },
      { role: 'weights', digest: A },
    ])
    expect(one).toBe(two)
  })

  it('nie zależy od wielkości liter w roli ani w skrócie', () => {
    const lower = canonicalArtifactForm([{ role: 'weights', digest: A }])
    const upper = canonicalArtifactForm([{ role: 'WEIGHTS', digest: A.toUpperCase() }])
    expect(lower).toBe(upper)
  })

  it('odrzuca dwa artefakty w tej samej roli', () => {
    expect(() =>
      canonicalArtifactForm([
        { role: 'weights', digest: A },
        { role: 'weights', digest: B },
      ]),
    ).toThrow(/powtarza się/)
  })
})

describe('computeContentDigest', () => {
  it('nie zmienia się po przeniesieniu pliku do innego magazynu', () => {
    // To jest decyzja, nie przeoczenie: ten sam plik pod innym adresem jest
    // wciąż tym samym plikiem, a polityka nie zmienia zachowania od zmiany URI.
    const s3 = computeContentDigest([{ role: 'weights', digest: A, uri: 's3://a/w.bin', sizeBytes: 10 }])
    const gcs = computeContentDigest([{ role: 'weights', digest: A, uri: 'gs://b/w.bin', sizeBytes: 999 }])
    expect(s3).toBe(gcs)
  })

  it('zmienia się, gdy zmienią się bity choćby jednego artefaktu', () => {
    const before = computeContentDigest([
      { role: 'weights', digest: A },
      { role: 'config', digest: B },
    ])
    const after = computeContentDigest([
      { role: 'weights', digest: A },
      { role: 'config', digest: C },
    ])
    expect(before).not.toBe(after)
  })

  it('zmienia się, gdy do kompletu dojdzie preprocesor', () => {
    // Polityka z preprocesorem i bez niego to dwie różne polityki, choćby wagi
    // były bit w bit te same - preprocesor zmienia przestrzeń obserwacji.
    const bare = computeContentDigest([{ role: 'weights', digest: A }])
    const withPre = computeContentDigest([
      { role: 'weights', digest: A },
      { role: 'preprocessor', digest: B },
    ])
    expect(bare).not.toBe(withPre)
  })

  it('daje skrót sha256 w hex', () => {
    expect(computeContentDigest([{ role: 'weights', digest: A }])).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('validateArtifactSet', () => {
  const ok = { role: 'weights', digest: A, uri: 's3://x/w.bin' }

  it('przepuszcza komplet z wagami', () => {
    const verdict = validateArtifactSet([ok])
    expect(verdict.ok).toBe(true)
    expect(verdict.normalized).toHaveLength(1)
  })

  it('odrzuca komplet bez wag', () => {
    const verdict = validateArtifactSet([{ role: 'config', digest: B, uri: 's3://x/c.json' }])
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('weights')
  })

  it('odrzuca pusty komplet', () => {
    expect(validateArtifactSet([]).ok).toBe(false)
  })

  it('odrzuca skrót, który nie jest sha256 w hex', () => {
    const verdict = validateArtifactSet([{ role: 'weights', digest: 'krótki', uri: 's3://x/w.bin' }])
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('sha256')
  })

  it('odrzuca artefakt bez adresu w magazynie obiektów', () => {
    const verdict = validateArtifactSet([{ role: 'weights', digest: A, uri: '   ' }])
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('adresu')
  })

  it('odrzuca nieznaną rolę', () => {
    const verdict = validateArtifactSet([
      ok,
      { role: 'notatki', digest: B, uri: 's3://x/n.txt' },
    ])
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('nieznana rola')
  })

  it('normalizuje rolę i skrót do małych liter', () => {
    const verdict = validateArtifactSet([{ role: 'WEIGHTS', digest: A.toUpperCase(), uri: ' s3://x/w.bin ' }])
    expect(verdict.normalized[0]).toMatchObject({ role: 'weights', digest: A, uri: 's3://x/w.bin' })
  })
})
