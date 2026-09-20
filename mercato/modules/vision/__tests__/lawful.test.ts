import { checkCamera, checkClassVocabulary, deleteAfterFor, MAX_RETENTION_DAYS } from '../lib/lawful'

/**
 * Granice prawne egzekwowane w kodzie.
 *
 * Wartość tych testów polega na tym, że opisują **odmowy**. Moduł, który
 * ostrzega i zapisuje, i moduł, który odmawia zapisu, wyglądają w dokumentacji
 * tak samo - różnią się dopiero w dniu kontroli.
 */

describe('słownik klas detektora', () => {
  it('przepuszcza słownik materiałowy', () => {
    expect(checkClassVocabulary(['pet', 'pvc', 'hdpe', 'paper']).allowed).toBe(true)
  })

  it('ODMAWIA rejestracji detektora rozpoznającego emocje', () => {
    const wynik = checkClassVocabulary(['pet', 'emotion_happy'])
    expect(wynik.allowed).toBe(false)
    expect(wynik.reason).toMatch(/2024\/1689/)
  })

  it('odmawia kategoryzacji biometrycznej wnioskującej cechy wrażliwe', () => {
    for (const klasa of ['ethnicity', 'religion', 'union_membership', 'sexual_orientation']) {
      expect(checkClassVocabulary(['pet', klasa]).allowed).toBe(false)
    }
  })

  it('dopasowuje po rdzeniu, nie po dokładnej nazwie', () => {
    // `emotion`, `facial_emotion` i `emotion_v2` mają odpaść tak samo.
    expect(checkClassVocabulary(['facial_emotion_v2']).allowed).toBe(false)
    expect(checkClassVocabulary(['worker_stress_level']).allowed).toBe(false)
  })

  it('odmawia identyfikacji twarzy', () => {
    expect(checkClassVocabulary(['face_id']).allowed).toBe(false)
    expect(checkClassVocabulary(['face_embedding']).allowed).toBe(false)
  })

  it('człowiek przechodzi, ale wyłącznie jako obecność', () => {
    const wynik = checkClassVocabulary(['pet', 'person'])
    expect(wynik.allowed).toBe(true)
    expect(wynik.presenceOnly).toContain('person')
    expect(wynik.reason).toMatch(/bez identyfikacji i bez śledzenia/)
  })

  it('wielkość liter i spacje nie omijają zakazu', () => {
    expect(checkClassVocabulary(['  EMOTION_Angry ']).allowed).toBe(false)
  })
})

describe('dopuszczalność kamery', () => {
  const dzien = 24 * 60 * 60 * 1000
  const uruchomienie = new Date('2026-09-19T08:00:00Z')

  const poprawna = {
    purpose: 'production_control',
    retentionDays: 30,
    peopleInView: true,
    workforceNotifiedAt: new Date(uruchomienie.getTime() - 20 * dzien),
    areaMarkedAt: new Date(uruchomienie.getTime() - 2 * dzien),
    activationAt: uruchomienie,
  }

  it('kontrola produkcji jest celem z katalogu ustawowego', () => {
    const wynik = checkCamera(poprawna)
    expect(wynik.lawful).toBe(true)
    expect(wynik.warnings).toHaveLength(0)
  })

  it('ODMAWIA celu spoza zamkniętego katalogu', () => {
    const wynik = checkCamera({ ...poprawna, purpose: 'ocena_wydajnosci_pracownikow' })
    expect(wynik.lawful).toBe(false)
    expect(wynik.problems[0]).toMatch(/katalog jest zamknięty|Katalog jest zamknięty/)
  })

  it('ODMAWIA przechowywania dłuższego niż ustawowe trzy miesiące', () => {
    const wynik = checkCamera({ ...poprawna, retentionDays: 365 })
    expect(wynik.lawful).toBe(false)
    expect(wynik.problems[0]).toMatch(/22² § 3/)
  })

  it('krótszy okres przechowywania jest zawsze dopuszczalny', () => {
    expect(checkCamera({ ...poprawna, retentionDays: 7 }).lawful).toBe(true)
  })

  it('brak poinformowania załogi to wada usuwalna, nie unieważniająca', () => {
    // Rozdział na problems i warnings jest treścią: celu spoza katalogu nie
    // naprawi żadna zgoda, a brak poinformowania owszem - byle przed startem.
    const wynik = checkCamera({ ...poprawna, workforceNotifiedAt: null })
    expect(wynik.lawful).toBe(true)
    expect(wynik.warnings.join(' ')).toMatch(/§ 7/)
  })

  it('poinformowanie na tydzień przed jest za późne', () => {
    const wynik = checkCamera({ ...poprawna, workforceNotifiedAt: new Date(uruchomienie.getTime() - 7 * dzien) })
    expect(wynik.warnings.join(' ')).toMatch(/dwa tygodnie/)
  })

  it('kamera bez ludzi w kadrze nie wymaga oznaczenia obszaru', () => {
    const wynik = checkCamera({
      ...poprawna,
      peopleInView: false,
      workforceNotifiedAt: null,
      areaMarkedAt: null,
    })
    expect(wynik.warnings).toHaveLength(0)
  })
})

describe('termin usunięcia', () => {
  it('liczy się z daty nagrania i okresu kamery', () => {
    const nagranie = new Date('2026-09-19T08:00:00Z')
    const termin = deleteAfterFor(nagranie, 30)
    expect(Math.round((termin.getTime() - nagranie.getTime()) / 86_400_000)).toBe(30)
  })

  it('jest twardo ograniczony ustawowym maksimum', () => {
    const nagranie = new Date('2026-09-19T08:00:00Z')
    const termin = deleteAfterFor(nagranie, 10_000)
    expect(Math.round((termin.getTime() - nagranie.getTime()) / 86_400_000)).toBe(MAX_RETENTION_DAYS)
  })
})
