/**
 * Brama między etapami wdrożenia.
 *
 * Trzy zasady, które ta funkcja wymusza i które są całą treścią fazy:
 *
 * 1. **Brama odwołuje się do liczb z księgi epizodów, nie do opinii.**
 *    Nie ma tu pola „zatwierdził kierownik". Jest liczba epizodów, liczba
 *    interwencji i próg. Człowiek może zatrzymać wdrożenie w każdej chwili,
 *    ale nie może go przepchnąć obok liczb - bo to jedyne, co odróżnia
 *    wdrożenie etapowe od wdrożenia na raz z dodatkowym spotkaniem.
 *
 * 2. **Wycofanie jest tańsze niż diagnoza, więc jest domyślne.** Przy
 *    przekroczeniu progu nie wstrzymujemy do wyjaśnienia - wycofujemy
 *    i wyjaśniamy potem. Odwrotna kolejność oznacza maszyny pracujące
 *    na podejrzanej polityce przez czas trwania dochodzenia.
 *
 * 3. **Za mało danych to nie jest zgoda.** Etap bez wymaganej liczby epizodów
 *    dostaje `hold`, nie `advance`. Zero interwencji na trzech epizodach nie
 *    jest dowodem niczego i najgorsze, co można zrobić, to potraktować to
 *    jako lepszy wynik niż dwie interwencje na dwustu.
 */

export type GateDecision = 'advance' | 'hold' | 'rollback'

export type GateThresholds = {
  /** Minimalna liczba epizodów, zanim brama w ogóle ma o czym orzekać. */
  minEpisodes: number
  /** Maksymalny dopuszczalny udział epizodów z interwencją. */
  maxInterventionRate: number
  /**
   * Maksymalny udział interwencji ciężkich (`estop`, `abort`).
   *
   * Osobny próg, bo wdrożenie z samymi poprawkami otoczenia i wdrożenie
   * z samymi zatrzymaniami awaryjnymi mają identyczny udział interwencji
   * i nie są tym samym wdrożeniem. Jeden próg na wszystko zrównuje
   * dojrzałość z zagrożeniem.
   */
  maxSevereRate: number
  /** Minimalny udział epizodów udanych. Osobno od interwencji - patrz niżej. */
  minSuccessRate: number
}

export const DEFAULT_THRESHOLDS: GateThresholds = {
  minEpisodes: 50,
  maxInterventionRate: 0.1,
  maxSevereRate: 0.02,
  minSuccessRate: 0.8,
}

export type StageStats = {
  episodes: number
  intervenedEpisodes: number
  severeInterventions: number
  successes: number
}

export type GateVerdict = {
  decision: GateDecision
  /** Powód gotowy do wpisania do dziennika wdrożenia, nie kod błędu. */
  reason: string
  /** Wszystkie policzone wskaźniki - żeby dziennik nie wymagał przeliczania. */
  measured: {
    episodes: number
    interventionRate: number
    severeRate: number
    successRate: number
  }
  /** Które progi zostały przekroczone. Puste przy `advance` i `hold`. */
  breached: string[]
}

/**
 * Jedna decyzja bramy dla jednego etapu.
 *
 * Kolejność pytań jest znacząca: najpierw czy jest o czym mówić (dane),
 * potem czy coś się pali (progi). Odwrócenie dawałoby wycofania na podstawie
 * trzech epizodów, czyli hałas zamiast sygnału.
 */
export function evaluateGate(stats: StageStats, thresholds: GateThresholds = DEFAULT_THRESHOLDS): GateVerdict {
  const episodes = stats.episodes
  const interventionRate = episodes ? stats.intervenedEpisodes / episodes : 0
  const severeRate = episodes ? stats.severeInterventions / episodes : 0
  const successRate = episodes ? stats.successes / episodes : 0
  const measured = { episodes, interventionRate, severeRate, successRate }

  /**
   * Zatrzymanie awaryjne wycofuje etap natychmiast, przed kontrolą liczebności.
   *
   * To jedyny wyjątek od zasady „najpierw dane". Powód: `estop` nie jest
   * wskaźnikiem jakości, tylko zdarzeniem - jedno wystarczy. Czekanie na
   * pięćdziesiąty epizod po pierwszym zatrzymaniu awaryjnym byłoby statystyką
   * zamiast decyzji.
   */
  if (stats.severeInterventions > 0 && episodes < thresholds.minEpisodes) {
    return {
      decision: 'rollback',
      reason: `interwencja ciężka na etapie o ${episodes} epizodach - wycofanie bez czekania na komplet danych`,
      measured,
      breached: ['severeInterventions'],
    }
  }

  if (episodes < thresholds.minEpisodes) {
    return {
      decision: 'hold',
      reason: `za mało danych: ${episodes} z wymaganych ${thresholds.minEpisodes} epizodów`,
      measured,
      breached: [],
    }
  }

  const breached: string[] = []
  if (interventionRate > thresholds.maxInterventionRate) breached.push('maxInterventionRate')
  if (severeRate > thresholds.maxSevereRate) breached.push('maxSevereRate')
  if (successRate < thresholds.minSuccessRate) breached.push('minSuccessRate')

  if (breached.length) {
    const opis = [
      breached.includes('maxInterventionRate')
        ? `interwencje ${(interventionRate * 100).toFixed(1)}% > ${(thresholds.maxInterventionRate * 100).toFixed(1)}%`
        : null,
      breached.includes('maxSevereRate')
        ? `interwencje ciężkie ${(severeRate * 100).toFixed(1)}% > ${(thresholds.maxSevereRate * 100).toFixed(1)}%`
        : null,
      breached.includes('minSuccessRate')
        ? `skuteczność ${(successRate * 100).toFixed(1)}% < ${(thresholds.minSuccessRate * 100).toFixed(1)}%`
        : null,
    ]
      .filter(Boolean)
      .join('; ')

    return {
      decision: 'rollback',
      reason: `próg przekroczony - ${opis}`,
      measured,
      breached,
    }
  }

  return {
    decision: 'advance',
    reason: `${episodes} epizodów, interwencje ${(interventionRate * 100).toFixed(1)}%, skuteczność ${(successRate * 100).toFixed(1)}% - w granicach`,
    measured,
    breached: [],
  }
}

/** Rodzaje interwencji liczone jako ciężkie. Poza `episodes` nie ma o nich wiedzy nikt inny. */
export const SEVERE_KINDS = ['estop', 'abort'] as const

export type RolloutMode = 'shadow' | 'active'

/**
 * Ograniczenie trybu cieniowego, zapisane jako kod, a nie jako akapit w dokumentacji.
 *
 * Cień **nie dowodzi bezpieczeństwa** dla polityki, która zmienia stan świata.
 * Dowodzi wyłącznie zgodności predykcji z polityką odniesienia. Polityka
 * sterująca manipulatorem zmienia stan świata z definicji, więc etap cieniowy
 * zakończony sukcesem jest przesłanką do uruchomienia etapu czynnego na małej
 * populacji - a nie do pominięcia go.
 *
 * Funkcja istnieje po to, żeby ktoś, kto zechce przejść z cienia prosto na
 * flotę, musiał ten warunek jawnie obejść i zostawić po tym ślad.
 */
export function shadowProves(mode: RolloutMode, policyChangesWorldState: boolean): { proves: boolean; reason: string } {
  if (mode !== 'shadow') {
    return { proves: true, reason: 'etap czynny - polityka faktycznie sterowała maszyną' }
  }
  if (policyChangesWorldState) {
    return {
      proves: false,
      reason:
        'tryb cieniowy dowodzi wyłącznie zgodności predykcji; dla polityki zmieniającej stan świata nie jest dowodem bezpieczeństwa i nie zastępuje etapu czynnego',
    }
  }
  return { proves: true, reason: 'polityka nie zmienia stanu świata - cień wystarcza' }
}

/**
 * Które etapy mają zostać zatrzymane po decyzji o wycofaniu.
 *
 * Wszystkie następne, nie tylko kolejny: wdrożenie pięcioetapowe, w którym
 * po wycofaniu etapu pierwszego rusza etap trzeci, jest wdrożeniem
 * jednoetapowym z opóźnieniem.
 */
export function stagesToHalt<T extends { ordinal: number; status: string }>(
  stages: T[],
  failedOrdinal: number,
): T[] {
  return stages.filter((stage) => stage.ordinal > failedOrdinal && stage.status !== 'halted')
}
