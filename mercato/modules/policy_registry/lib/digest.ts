import { createHash } from 'node:crypto'

/**
 * Tożsamość wersji polityki liczona z jej artefaktów.
 *
 * Reguła jest jedna: **wersja to komplet bitów, a nie moment wgrania**. Ten
 * sam komplet wgrany dwa razy jest jedną wersją, bo fizycznie jest jedną
 * polityką i wszystkie statystyki liczone per wersja muszą się na nim zgadzać.
 *
 * Czysta funkcja bez bazy, bo to ona rozstrzyga o powstaniu albo niepowstaniu
 * rekordu - a takie reguły mają być testowalne w każdym wariancie bez kontenera.
 */

export type ArtifactInput = {
  role: string
  digest: string
  /** Rozmiar i adres nie wchodzą do skrótu - patrz komentarz przy `canonicalArtifactForm`. */
  sizeBytes?: number | null
  uri?: string
  mediaType?: string | null
}

/** Wagi są obowiązkowe. Polityka bez wag jest konfiguracją, nie polityką. */
export const REQUIRED_ROLES = ['weights'] as const

const KNOWN_ROLES = new Set(['weights', 'config', 'preprocessor', 'normalizer', 'metadata'])

const DIGEST_PATTERN = /^[0-9a-f]{64}$/

/**
 * Postać kanoniczna kompletu: role posortowane, każda jako `role:digest`.
 *
 * Do skrótu **nie** wchodzą `uri` ani `sizeBytes`. To jest decyzja, nie
 * przeoczenie: ten sam plik przeniesiony z jednego magazynu do drugiego jest
 * wciąż tym samym plikiem, a polityka nie zmienia zachowania od zmiany adresu.
 * Alternatywa - skrót po adresie - odrzucona, bo migracja magazynu obiektów
 * rozmnożyłaby całą historię wersji bez zmiany choćby jednego bitu wag.
 */
export function canonicalArtifactForm(artifacts: ArtifactInput[]): string {
  const seen = new Set<string>()
  const parts: string[] = []

  for (const artifact of artifacts) {
    const role = artifact.role.trim().toLowerCase()
    if (seen.has(role)) {
      // Dwa pliki w tej samej roli uzależniłyby skrót od kolejności wgrywania,
      // czyli od rzeczy, która nie jest własnością polityki.
      throw new Error(`Rola artefaktu ${role} powtarza się w komplecie - komplet ma jedną rolę raz.`)
    }
    seen.add(role)
    parts.push(`${role}:${artifact.digest.trim().toLowerCase()}`)
  }

  return parts.sort().join('\n')
}

export function computeContentDigest(artifacts: ArtifactInput[]): string {
  return createHash('sha256').update(canonicalArtifactForm(artifacts), 'utf8').digest('hex')
}

export type ArtifactSetVerdict = {
  ok: boolean
  /** Powód odmowy gotowy do pokazania człowiekowi. Pusty, gdy `ok`. */
  reason?: string
  normalized: ArtifactInput[]
}

/**
 * Kontrola kompletu przed policzeniem skrótu.
 *
 * Odrzucamy skróty w złym formacie zamiast je przepuszczać: skrót, którego nikt
 * nie sprawdził przy wejściu, jest łańcuchem znaków udającym gwarancję.
 * Robot, który go potem nie potwierdzi, dowie się o tym po załadowaniu wag.
 */
export function validateArtifactSet(artifacts: ArtifactInput[]): ArtifactSetVerdict {
  if (!artifacts.length) {
    return { ok: false, reason: 'komplet artefaktów jest pusty', normalized: [] }
  }

  const normalized: ArtifactInput[] = []
  for (const artifact of artifacts) {
    const role = artifact.role.trim().toLowerCase()
    if (!KNOWN_ROLES.has(role)) {
      return {
        ok: false,
        reason: `nieznana rola artefaktu: ${role}; dozwolone: ${[...KNOWN_ROLES].sort().join(', ')}`,
        normalized: [],
      }
    }
    const digest = artifact.digest.trim().toLowerCase()
    if (!DIGEST_PATTERN.test(digest)) {
      return {
        ok: false,
        reason: `skrót artefaktu ${role} nie jest sha256 w hex (64 znaki): ${artifact.digest}`,
        normalized: [],
      }
    }
    if (!artifact.uri || !artifact.uri.trim()) {
      return { ok: false, reason: `artefakt ${role} nie ma adresu w magazynie obiektów`, normalized: [] }
    }
    normalized.push({ ...artifact, role, digest, uri: artifact.uri.trim() })
  }

  for (const required of REQUIRED_ROLES) {
    if (!normalized.some((a) => a.role === required)) {
      return { ok: false, reason: `w komplecie brakuje artefaktu w roli ${required}`, normalized: [] }
    }
  }

  try {
    canonicalArtifactForm(normalized)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), normalized: [] }
  }

  return { ok: true, normalized }
}
