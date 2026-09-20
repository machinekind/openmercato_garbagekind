import {
  DEFAULT_THRESHOLDS,
  evaluateGate,
  shadowProves,
  stagesToHalt,
  type StageStats,
} from '../lib/gate'

/**
 * Testy bramy.
 *
 * Brama musi umieć **obie** odpowiedzi. Test sprawdzający tylko wycofanie
 * przeszedłby również dla funkcji zwracającej zawsze `rollback` - a taka
 * funkcja jest gorsza od braku bramy, bo nikt jej nie włączy.
 */

const T = DEFAULT_THRESHOLDS

function stats(over: Partial<StageStats> = {}): StageStats {
  return { episodes: 100, intervenedEpisodes: 2, severeInterventions: 0, successes: 95, ...over }
}

describe('evaluateGate - przepuszczenie', () => {
  it('przepuszcza etap w granicach wszystkich progów', () => {
    const verdict = evaluateGate(stats())
    expect(verdict.decision).toBe('advance')
    expect(verdict.breached).toEqual([])
  })

  it('przepuszcza dokładnie na progu, nie odwrotnie', () => {
    // Granice są domknięte po stronie przepuszczenia: próg „maksimum 10%"
    // znaczy, że 10% jeszcze przechodzi. Inaczej próg podany w procentach
    // zachowywałby się inaczej niż brzmi.
    const verdict = evaluateGate(
      stats({ episodes: 100, intervenedEpisodes: 10, successes: 80 }),
      { ...T, maxSevereRate: 1 },
    )
    expect(verdict.decision).toBe('advance')
  })

  it('podaje zmierzone wartości także przy przepuszczeniu', () => {
    // Dziennik z samym werdyktem wymaga przeliczenia księgi wstecz,
    // a księga w międzyczasie rośnie.
    const verdict = evaluateGate(stats())
    expect(verdict.measured.episodes).toBe(100)
    expect(verdict.measured.interventionRate).toBeCloseTo(0.02)
    expect(verdict.measured.successRate).toBeCloseTo(0.95)
  })
})

describe('evaluateGate - za mało danych', () => {
  it('etap bez wymaganej liczby epizodów jest wstrzymany, nie przepuszczony', () => {
    // Zero interwencji na trzech epizodach nie jest lepszym wynikiem
    // niż dwie interwencje na dwustu.
    const verdict = evaluateGate(stats({ episodes: 3, intervenedEpisodes: 0, successes: 3 }))
    expect(verdict.decision).toBe('hold')
    expect(verdict.reason).toContain('za mało danych')
  })

  it('wstrzymanie nie jest wycofaniem', () => {
    const verdict = evaluateGate(stats({ episodes: 3, intervenedEpisodes: 0, successes: 3 }))
    expect(verdict.breached).toEqual([])
  })

  it('pusty etap nie dzieli przez zero', () => {
    const verdict = evaluateGate({ episodes: 0, intervenedEpisodes: 0, severeInterventions: 0, successes: 0 })
    expect(verdict.decision).toBe('hold')
    expect(verdict.measured.interventionRate).toBe(0)
  })
})

describe('evaluateGate - wycofanie', () => {
  it('wycofuje po przekroczeniu progu interwencji', () => {
    const verdict = evaluateGate(stats({ episodes: 100, intervenedEpisodes: 25, successes: 90 }))
    expect(verdict.decision).toBe('rollback')
    expect(verdict.breached).toContain('maxInterventionRate')
    // Komunikat niesie obie liczby, żeby nie trzeba było zaglądać do progów.
    expect(verdict.reason).toContain('25.0%')
    expect(verdict.reason).toContain('10.0%')
  })

  it('wycofuje po spadku skuteczności mimo braku interwencji', () => {
    // Polityka, która nie robi nic złego i nie robi nic dobrego, też ma
    // zostać wycofana - brak interwencji nie jest wynikiem sam w sobie.
    const verdict = evaluateGate(stats({ episodes: 100, intervenedEpisodes: 0, successes: 50 }))
    expect(verdict.decision).toBe('rollback')
    expect(verdict.breached).toEqual(['minSuccessRate'])
  })

  it('wycofuje po przekroczeniu progu interwencji ciężkich przy dobrej reszcie', () => {
    const verdict = evaluateGate(
      stats({ episodes: 100, intervenedEpisodes: 5, severeInterventions: 5, successes: 95 }),
    )
    expect(verdict.decision).toBe('rollback')
    expect(verdict.breached).toEqual(['maxSevereRate'])
  })

  it('wypisuje wszystkie przekroczone progi, nie pierwszy z brzegu', () => {
    const verdict = evaluateGate(
      stats({ episodes: 100, intervenedEpisodes: 40, severeInterventions: 10, successes: 40 }),
    )
    expect(verdict.breached).toEqual(['maxInterventionRate', 'maxSevereRate', 'minSuccessRate'])
  })
})

describe('evaluateGate - interwencja ciężka przed kompletem danych', () => {
  it('jedno zatrzymanie awaryjne wycofuje etap bez czekania na próg liczebności', () => {
    // `estop` nie jest wskaźnikiem jakości, tylko zdarzeniem. Czekanie na
    // pięćdziesiąty epizod po pierwszym zatrzymaniu awaryjnym byłoby
    // statystyką zamiast decyzji.
    const verdict = evaluateGate(
      { episodes: 4, intervenedEpisodes: 1, severeInterventions: 1, successes: 3 },
      T,
    )
    expect(verdict.decision).toBe('rollback')
    expect(verdict.breached).toEqual(['severeInterventions'])
    expect(verdict.reason).toContain('bez czekania')
  })

  it('brak interwencji ciężkich przy małej próbce wciąż daje wstrzymanie', () => {
    const verdict = evaluateGate({ episodes: 4, intervenedEpisodes: 2, severeInterventions: 0, successes: 2 })
    expect(verdict.decision).toBe('hold')
  })
})

describe('shadowProves - ograniczenie trybu cieniowego', () => {
  it('cień nie dowodzi bezpieczeństwa polityki zmieniającej stan świata', () => {
    const verdict = shadowProves('shadow', true)
    expect(verdict.proves).toBe(false)
    expect(verdict.reason).toContain('nie zastępuje etapu czynnego')
  })

  it('cień wystarcza dla polityki, która stanu świata nie zmienia', () => {
    expect(shadowProves('shadow', false).proves).toBe(true)
  })

  it('etap czynny dowodzi zawsze', () => {
    expect(shadowProves('active', true).proves).toBe(true)
  })
})

describe('stagesToHalt', () => {
  const stages = [
    { ordinal: 1, status: 'rolled_back' },
    { ordinal: 2, status: 'pending' },
    { ordinal: 3, status: 'pending' },
    { ordinal: 4, status: 'halted' },
  ]

  it('zatrzymuje WSZYSTKIE etapy następne, nie tylko kolejny', () => {
    // Wdrożenie pięcioetapowe, w którym po wycofaniu etapu 1 rusza etap 3,
    // jest wdrożeniem jednoetapowym z opóźnieniem.
    expect(stagesToHalt(stages, 1).map((s) => s.ordinal)).toEqual([2, 3])
  })

  it('nie rusza etapów wcześniejszych ani bieżącego', () => {
    expect(stagesToHalt(stages, 2).map((s) => s.ordinal)).toEqual([3])
  })

  it('nie zatrzymuje po raz drugi etapu już zatrzymanego', () => {
    expect(stagesToHalt(stages, 1).some((s) => s.ordinal === 4)).toBe(false)
  })
})
