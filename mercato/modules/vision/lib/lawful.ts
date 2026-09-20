/**
 * Granice prawne monitoringu w zakładzie pracy - egzekwowane w kodzie,
 * nie opisane w polityce prywatności.
 *
 * Dwa reżimy stosują się jednocześnie i żaden nie zastępuje drugiego:
 *
 * **Art. 22² Kodeksu pracy** - monitoring wizyjny w zakładzie pracy:
 * zamknięty katalog celów (§1), zakaz obejmowania pomieszczeń sanitarnych,
 * szatni, stołówek, palarni i pomieszczeń związków zawodowych (§1¹),
 * zniszczenie nagrań po trzech miesiącach (§3), poinformowanie załogi na dwa
 * tygodnie przed uruchomieniem (§7) i oznaczenie obszaru najpóźniej dzień
 * przed (§9).
 *
 * **Art. 5 rozporządzenia o sztucznej inteligencji (2024/1689)** - praktyki
 * zakazane: wnioskowanie emocji osoby fizycznej **w miejscu pracy** na
 * podstawie danych biometrycznych (art. 5 ust. 1 lit. f) oraz kategoryzacja
 * biometryczna wnioskująca cechy wrażliwe (lit. g). Zakazy obowiązują od
 * 2 lutego 2025 r., a sankcja sięga 35 mln euro albo 7% obrotu.
 *
 * Konsekwencja projektowa: detektor deklarujący takie klasy **nie daje się
 * zarejestrować**. Nie ostrzeżenie, nie pole „potwierdzam, że rozumiem" -
 * odmowa zapisu.
 */

/** Zamknięty katalog celów z art. 22² § 1 KP. „Inne" nie istnieje. */
export const LAWFUL_PURPOSES = ['safety', 'property', 'production_control', 'trade_secret'] as const
export type LawfulPurpose = (typeof LAWFUL_PURPOSES)[number]

/** Art. 22² § 3 KP: nagrania niszczy się po trzech miesiącach. */
export const MAX_RETENTION_DAYS = 90

/**
 * Klasy, których obecność w słowniku detektora przesądza o odmowie.
 *
 * Lista jest celowo dopasowywana po rdzeniu słowa, nie po dokładnej nazwie:
 * `emotion`, `emotion_happy` i `facial_emotion` mają odpaść tak samo. Fałszywe
 * trafienie kosztuje jedno pytanie do dostawcy modelu; przepuszczenie kosztuje
 * do 7% obrotu.
 */
const PROHIBITED_CLASS_ROOTS = [
  'emotion', 'mood', 'sentiment', 'affect', 'stress_level', 'fatigue_level', 'engagement_score',
  'face_id', 'faceid', 'facial_recognition', 'face_embedding', 'identity',
  'biometric', 'gait_id', 'iris', 'fingerprint',
  'ethnicity', 'race', 'religion', 'political', 'sexual_orientation', 'union_membership',
  'gender', 'age_estimate',
]

export type ClassVerdict = {
  allowed: boolean
  prohibited: string[]
  /** Klasy dopuszczone warunkowo - `person` wyłącznie jako obecność. */
  presenceOnly: string[]
  reason: string
}

export function checkClassVocabulary(vocabulary: string[]): ClassVerdict {
  const prohibited: string[] = []
  const presenceOnly: string[] = []

  for (const raw of vocabulary ?? []) {
    const klasa = String(raw).trim().toLowerCase()
    if (!klasa) continue

    if (PROHIBITED_CLASS_ROOTS.some((root) => klasa.includes(root))) {
      prohibited.push(klasa)
      continue
    }
    /*
     * `person` przechodzi, ale tylko jako obecność. Liczba ludzi w celi jest
     * informacją o bezpieczeństwie (czy ktoś wszedł w obszar pracy maszyny)
     * i nie wymaga wiedzy, kto to jest. Śledzenie osoby, przypisanie do
     * pracownika albo zliczanie jej czasu pracy to już inny system i inna
     * podstawa prawna - ten moduł ich nie obsługuje.
     */
    if (klasa === 'person' || klasa === 'people' || klasa === 'human') presenceOnly.push(klasa)
  }

  if (prohibited.length) {
    return {
      allowed: false,
      prohibited,
      presenceOnly,
      reason:
        `Słownik detektora zawiera klasy zakazane w miejscu pracy: ${prohibited.join(', ')}. ` +
        'Art. 5 ust. 1 lit. f i g rozporządzenia 2024/1689 zakazuje wnioskowania emocji w miejscu pracy ' +
        'oraz kategoryzacji biometrycznej wnioskującej cechy wrażliwe. Rejestracja odmówiona.',
    }
  }

  return {
    allowed: true,
    prohibited: [],
    presenceOnly,
    reason: presenceOnly.length
      ? `Słownik dopuszczony. Klasa ${presenceOnly.join(', ')} wyłącznie jako obecność - bez identyfikacji i bez śledzenia.`
      : 'Słownik dopuszczony.',
  }
}

export type CameraVerdict = { lawful: boolean; problems: string[]; warnings: string[] }

/**
 * Czy kamerę wolno uruchomić.
 *
 * Rozdział na `problems` i `warnings` jest tu treścią, nie kosmetyką: cel spoza
 * katalogu i okres przechowywania ponad ustawowy to wady, których nie da się
 * naprawić zgodą - a brak poinformowania załogi to wada usuwalna, byle przed
 * uruchomieniem.
 */
export function checkCamera(input: {
  purpose: string
  retentionDays: number
  peopleInView: boolean
  workforceNotifiedAt?: Date | null
  areaMarkedAt?: Date | null
  activationAt?: Date | null
}): CameraVerdict {
  const problems: string[] = []
  const warnings: string[] = []

  if (!LAWFUL_PURPOSES.includes(input.purpose as LawfulPurpose)) {
    problems.push(
      `Cel „${input.purpose}" jest spoza katalogu art. 22² § 1 KP (${LAWFUL_PURPOSES.join(', ')}). ` +
        'Katalog jest zamknięty - nie ma pozycji „inne".',
    )
  }

  if (input.retentionDays > MAX_RETENTION_DAYS) {
    problems.push(
      `Okres przechowywania ${input.retentionDays} dni przekracza ustawowe ${MAX_RETENTION_DAYS} ` +
        '(art. 22² § 3 KP). Dłużej wolno wyłącznie nagraniu stanowiącemu dowód w postępowaniu.',
    )
  }
  if (input.retentionDays < 1) problems.push('Okres przechowywania musi być dodatni.')

  if (input.peopleInView) {
    const activation = input.activationAt ?? new Date()
    const DZIEN = 24 * 60 * 60 * 1000

    if (!input.workforceNotifiedAt) {
      warnings.push('Brak daty poinformowania załogi (art. 22² § 7 KP - dwa tygodnie przed uruchomieniem).')
    } else if (activation.getTime() - input.workforceNotifiedAt.getTime() < 14 * DZIEN) {
      warnings.push('Załogę poinformowano później niż dwa tygodnie przed uruchomieniem (art. 22² § 7 KP).')
    }

    if (!input.areaMarkedAt) {
      warnings.push('Brak daty oznaczenia obszaru (art. 22² § 9 KP - najpóźniej dzień przed uruchomieniem).')
    } else if (activation.getTime() - input.areaMarkedAt.getTime() < DZIEN) {
      warnings.push('Obszar oznaczono później niż dzień przed uruchomieniem (art. 22² § 9 KP).')
    }
  }

  return { lawful: problems.length === 0, problems, warnings }
}

/** Termin usunięcia materiału - liczony, nie przyjmowany od wołającego. */
export function deleteAfterFor(recordedAt: Date, retentionDays: number): Date {
  const dni = Math.min(Math.max(1, retentionDays), MAX_RETENTION_DAYS)
  return new Date(recordedAt.getTime() + dni * 24 * 60 * 60 * 1000)
}
