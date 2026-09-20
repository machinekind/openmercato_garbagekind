import { SEVERITY_PRIORITY, type Severity } from './tokens'

/**
 * Słownik stanów: jedno miejsce, w którym fakt z dziedziny zamienia się
 * w coś, co da się narysować.
 *
 * Reguła, której pilnuje test, a nie dobre chęci: **kolor nigdy nie jest
 * jedynym nośnikiem znaczenia**. Każdy stan odbiegający od normy ma
 * dodatkowo kształt i tekst. Operator z zaburzeniem rozróżniania barw,
 * ekran w słońcu i wydruk czarno-biały to trzy różne sytuacje, w których
 * sam kolor nie niesie niczego - a każda z nich zdarza się na hali częściej
 * niż awaria, której ten ekran ma dotyczyć.
 *
 * Druga reguła, równie ważna: **stan normalny nie dostaje glifu**. Ekran,
 * na którym każda maszyna nosi znaczek „w porządku", zużywa całą uwagę na
 * potwierdzanie, że nic się nie dzieje.
 */

/** Kształty - nośnik znaczenia niezależny od barwy. */
export type Glyph = 'none' | 'triangle' | 'cross' | 'square' | 'diamond' | 'bars' | 'ring'

export type StatusDescriptor = {
  /** Klucz stabilny - po nim składa się legendę i testy, nie po etykiecie. */
  code: string
  severity: Severity
  glyph: Glyph
  /** Pełna etykieta: legenda, panel szczegółów, podpowiedź. */
  label: string
  /**
   * Forma krótka dla miejsc ciasnych - kafelka maszyny na rzucie.
   *
   * Osobne pole, a nie skracanie w locie: automatyczne cięcie daje
   * „Agent nigdy się …", z czego nie wynika nic. Człowiek, który pisze
   * etykietę, potrafi skrócić ją tak, żeby zachowała znaczenie. Testowane
   * na długość, żeby nikt nie wstawił tu drugiej wersji pełnej.
   */
  short: string
  detail?: string
}

/** Górna granica formy krótkiej - tyle mieści kafelek przy dwóch kolumnach. */
export const SHORT_LABEL_MAX = 18

/* ------------------------------------------------------------------ */
/* Cykl życia maszyny                                                  */
/* ------------------------------------------------------------------ */

export type RobotLifecycle =
  | 'registered' | 'commissioning' | 'ready' | 'operational'
  | 'maintenance' | 'quarantined' | 'decommissioning' | 'decommissioned'

const LIFECYCLE: Record<RobotLifecycle, StatusDescriptor> = {
  /*
   * „W ruchu" i „gotowy" to stany normalne i **nie mają koloru ani glifu**.
   * To jest najważniejsza zmiana wobec poprzedniej wersji tego ekranu,
   * na której pięć pracujących maszyn dawało ścianę zieleni.
   */
  operational: { code: 'lifecycle.operational', severity: 'normal', glyph: 'none', label: 'W ruchu', short: 'W ruchu' },
  ready: { code: 'lifecycle.ready', severity: 'normal', glyph: 'none', label: 'Gotowy', short: 'Gotowy' },

  commissioning: {
    code: 'lifecycle.commissioning',
    severity: 'action',
    glyph: 'square',
    label: 'Uruchamianie',
    short: 'Uruchamianie',
    detail: 'Czeka na dopuszczenie przez człowieka',
  },
  maintenance: {
    code: 'lifecycle.maintenance',
    severity: 'advisory',
    glyph: 'triangle',
    label: 'Serwis',
    short: 'Serwis',
    detail: 'Wyłączony z ruchu planowo',
  },
  quarantined: {
    code: 'lifecycle.quarantined',
    severity: 'alarm',
    glyph: 'cross',
    label: 'Kwarantanna',
    short: 'Kwarantanna',
    detail: 'Niedopuszczony - bywa mechanicznie sprawny',
  },
  registered: {
    code: 'lifecycle.registered',
    severity: 'suppressed',
    glyph: 'bars',
    label: 'Zarejestrowany',
    short: 'Zarejestrowany',
    detail: 'Jeszcze nie uruchamiany',
  },
  decommissioning: {
    code: 'lifecycle.decommissioning',
    severity: 'suppressed',
    glyph: 'bars',
    label: 'Wycofywanie',
    short: 'Wycofywanie',
  },
  decommissioned: {
    code: 'lifecycle.decommissioned',
    severity: 'suppressed',
    glyph: 'bars',
    label: 'Wycofany',
    short: 'Wycofany',
  },
}

export function lifecycleStatus(state: string): StatusDescriptor {
  return (
    LIFECYCLE[state as RobotLifecycle] ?? {
      code: 'lifecycle.unrecognised',
      severity: 'unknown',
      glyph: 'diamond',
      label: 'Stan nierozpoznany',
      short: 'Nierozpoznany',
      // Stan spoza słownika znaczy, że rejestr wie coś, czego ten ekran nie
      // umie pokazać - i lepiej, żeby to było widać, niż żeby zniknęło.
      detail: `Rejestr podaje „${state}", czego ten ekran nie zna`,
    }
  )
}

/* ------------------------------------------------------------------ */
/* Kalibracja                                                          */
/* ------------------------------------------------------------------ */

export type CalibrationState = 'valid' | 'expiring' | 'blocked' | 'unknown'

export function calibrationStatus(state: CalibrationState, daysLeft?: number | null): StatusDescriptor {
  switch (state) {
    case 'valid':
      return { code: 'calibration.valid', severity: 'normal', glyph: 'none', label: 'Kalibracja ważna', short: 'Kalibracja ok' }
    case 'expiring':
      return {
        code: 'calibration.expiring',
        severity: 'advisory',
        glyph: 'triangle',
        label: 'Kalibracja wygasa',
        short: 'Kalibracja wygasa',
        detail: typeof daysLeft === 'number' ? `zostało ${daysLeft} dni` : undefined,
      }
    case 'blocked':
      return {
        code: 'calibration.blocked',
        severity: 'alarm',
        glyph: 'cross',
        label: 'Kalibracja nieważna',
        short: 'Kal. nieważna',
        detail: 'Maszyna nie ma prawa pracować',
      }
    default:
      /*
       * „Brak wymagań kalibracyjnych" to norma, nie niewiedza: rewizja
       * embodimentu nie deklaruje żadnych pomiarów i to jest kompletna
       * informacja.
       */
      return { code: 'calibration.none', severity: 'normal', glyph: 'none', label: 'Bez wymagań kalibracyjnych', short: 'Bez kalibracji' }
  }
}

/* ------------------------------------------------------------------ */
/* Łączność agenta                                                     */
/* ------------------------------------------------------------------ */

export type LinkState = 'online' | 'late' | 'lost' | 'never_seen' | 'absent' | 'layer_unavailable'

export function linkStatus(state: LinkState, silenceSeconds?: number | null): StatusDescriptor {
  const cisza = typeof silenceSeconds === 'number' ? `cisza ${silenceSeconds} s` : undefined
  switch (state) {
    case 'online':
      return { code: 'link.online', severity: 'normal', glyph: 'none', label: 'Łączność', short: 'Łączność' }
    case 'late':
      return { code: 'link.late', severity: 'advisory', glyph: 'triangle', label: 'Agent spóźniony', short: 'Spóźniony', detail: cisza }
    case 'lost':
      return { code: 'link.lost', severity: 'alarm', glyph: 'ring', label: 'Agent milczy', short: 'Agent milczy', detail: cisza }
    case 'never_seen':
      return {
        code: 'link.never_seen',
        severity: 'action',
        glyph: 'square',
        label: 'Agent nigdy się nie odezwał',
        short: 'Nigdy nie odezwał',
        detail: 'Wpisany, ale nie nawiązał łączności',
      }
    case 'absent':
      /*
       * Brak wpisanego agenta to **niewiedza**, nie awaria - i dlatego ma
       * własną wagę. Poprzednia wersja tego ekranu rysowała go identycznie
       * jak żywą łączność, czyli brak wiedzy udawał dobrą wiadomość.
       */
      return {
        code: 'link.absent',
        severity: 'unknown',
        glyph: 'diamond',
        label: 'Brak wpisanego agenta',
        short: 'Brak agenta',
        detail: 'Centrala nie ma jak się dowiedzieć, co robi ta maszyna',
      }
    default:
      return {
        code: 'link.layer_unavailable',
        severity: 'suppressed',
        glyph: 'bars',
        label: 'Warstwa łączności niedostępna',
        short: 'Łączność nieznana',
        detail: 'Moduł brzegowy nieobecny albo bez uprawnienia',
      }
  }
}

/* ------------------------------------------------------------------ */

/**
 * Stan dominujący spośród kilku.
 *
 * Kafelek maszyny ma miejsce na jeden glif, a maszyna bywa jednocześnie
 * w kwarantannie, bez kalibracji i bez łączności. Pokazujemy najcięższy,
 * a resztę wypisujemy w szczegółach - zamiast nakładać trzy znaczki
 * na obiekt wielkości paznokcia.
 */
export function worstOf(descriptors: StatusDescriptor[]): StatusDescriptor {
  const pool = (descriptors ?? []).filter(Boolean)
  if (!pool.length) {
    return { code: 'none', severity: 'normal', glyph: 'none', label: 'Brak danych o stanie', short: 'Brak danych' }
  }
  return pool.reduce((worst, current) =>
    SEVERITY_PRIORITY[current.severity] > SEVERITY_PRIORITY[worst.severity] ? current : worst,
  )
}

/** Czy stan w ogóle ma być pokazany - norma nie zużywa uwagi. */
export function isNotable(descriptor: StatusDescriptor): boolean {
  return descriptor.severity !== 'normal'
}

/**
 * Pełny słownik stanów, po którym składa się legendę.
 *
 * Legenda generowana, nie pisana ręcznie - bo ręczna już raz w tym projekcie
 * rozjechała się z rysunkiem i trzeba ją było poprawiać dwa razy.
 */
export function statusVocabulary(): StatusDescriptor[] {
  return [
    ...Object.values(LIFECYCLE),
    calibrationStatus('expiring'),
    calibrationStatus('blocked'),
    linkStatus('late'),
    linkStatus('lost'),
    linkStatus('never_seen'),
    linkStatus('absent'),
    linkStatus('layer_unavailable'),
    lifecycleStatus('cokolwiek-spoza-slownika'),
  ]
}
