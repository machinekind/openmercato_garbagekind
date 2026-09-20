import { cadence, cadenceBy, trend, verifyAgainstLedger, type EpisodeEntry } from '../lib/cadence'

/**
 * Testy reguły kadencji.
 *
 * Najważniejsze są tu przypadki brzegowe serii: to one decydują o tym, czy
 * liczba „epizodów na interwencję" mówi prawdę, czy pochlebia. Test
 * sprawdzający tylko szczęśliwą ścieżkę przeszedłby również dla funkcji,
 * która liczy serie o jeden za długie - czyli zawyża wynik dokładnie tam,
 * gdzie wdrożenie idzie źle.
 */

function ep(sequence: number, interventionCount = 0, outcome: EpisodeEntry['outcome'] = 'success'): EpisodeEntry {
  return { id: `e${sequence}`, sequence, outcome, interventionCount }
}

describe('cadence - serie', () => {
  it('epizod z interwencją NIE należy do serii, którą kończy', () => {
    // Zaliczenie go zawyżałoby wynik o jeden przy każdym przerwaniu.
    const report = cadence([ep(1), ep(2), ep(3, 1), ep(4), ep(5)])
    expect(report.streaks).toEqual([2, 2])
    expect(report.cleanEpisodes).toBe(4)
  })

  it('interwencja na pierwszym epizodzie nie tworzy serii zerowej', () => {
    const report = cadence([ep(1, 1), ep(2), ep(3)])
    expect(report.streaks).toEqual([2])
    expect(report.currentStreak).toBe(2)
  })

  it('interwencja na ostatnim epizodzie zeruje bieżącą serię', () => {
    const report = cadence([ep(1), ep(2), ep(3, 1)])
    expect(report.currentStreak).toBe(0)
    expect(report.longestStreak).toBe(2)
  })

  it('dwie interwencje pod rząd nie dają serii między nimi', () => {
    const report = cadence([ep(1), ep(2, 1), ep(3, 1), ep(4)])
    expect(report.streaks).toEqual([1, 1])
  })

  it('kilka interwencji w jednym epizodzie liczy się jako jeden epizod przerwany', () => {
    // Człowiek, który poprawił coś trzy razy w jednym podejściu, nie przerwał
    // trzech epizodów - ale przerwał trzy razy i liczniki mają to rozdzielać.
    const report = cadence([ep(1), ep(2, 3), ep(3)])
    expect(report.interventions).toBe(3)
    expect(report.intervenedEpisodes).toBe(1)
    expect(report.cleanEpisodes).toBe(2)
  })

  it('pusta księga nie wywraca się i nie udaje autonomii', () => {
    const report = cadence([])
    expect(report.episodes).toBe(0)
    expect(report.autonomyRate).toBe(0)
    expect(report.meanEpisodesBetweenInterventions).toBeNull()
  })
})

describe('cadence - epizody na interwencję', () => {
  it('liczy stosunek epizodów do interwencji', () => {
    const report = cadence([ep(1), ep(2), ep(3, 1), ep(4), ep(5), ep(6, 1)])
    expect(report.meanEpisodesBetweenInterventions).toBe(3)
  })

  it('brak interwencji daje null, a nie nieskończoność ani wielką liczbę', () => {
    // Brak interwencji w serii pięciu epizodów nie jest dowodem autonomii,
    // tylko brakiem danych - i raport ma to mówić wprost.
    const report = cadence([ep(1), ep(2), ep(3)])
    expect(report.meanEpisodesBetweenInterventions).toBeNull()
    expect(Number.isFinite(report.meanEpisodesBetweenInterventions as number)).toBe(false)
  })

  it('autonomia i skuteczność to dwie różne liczby', () => {
    // Epizod bywa nieudany bez żadnej interwencji - i to jest dobra wiadomość.
    const report = cadence([ep(1, 0, 'failure'), ep(2, 0, 'failure'), ep(3, 0, 'success')])
    expect(report.autonomyRate).toBe(1)
    expect(report.successRate).toBeCloseTo(1 / 3)
  })
})

describe('verifyAgainstLedger', () => {
  const entries = [ep(1), ep(2, 1), ep(3)]

  it('potwierdza zgodność z księgą', () => {
    const check = verifyAgainstLedger(cadence(entries), { episodes: 3, interventions: 1 })
    expect(check.consistent).toBe(true)
    expect(check.problems).toEqual([])
  })

  it('wykrywa rozjazd liczby epizodów i nazywa obie wartości', () => {
    const check = verifyAgainstLedger(cadence(entries), { episodes: 5, interventions: 1 })
    expect(check.consistent).toBe(false)
    expect(check.problems[0]).toContain('raport 3')
    expect(check.problems[0]).toContain('księga 5')
  })

  it('wykrywa rozjazd liczby interwencji', () => {
    const check = verifyAgainstLedger(cadence(entries), { episodes: 3, interventions: 4 })
    expect(check.consistent).toBe(false)
    expect(check.problems.join(' ')).toContain('interwencji')
  })

  it('wykrywa niespójny raport nawet przy zgodnych sumach', () => {
    // Ręcznie zepsuty raport: sumy się zgadzają, ale serie już nie.
    const broken = { ...cadence(entries), streaks: [5] }
    const check = verifyAgainstLedger(broken, { episodes: 3, interventions: 1 })
    expect(check.consistent).toBe(false)
    expect(check.problems.join(' ')).toContain('sumy serii')
  })
})

describe('cadenceBy', () => {
  type Row = EpisodeEntry & { policy: string | null }
  const rows: Row[] = [
    { ...ep(1), policy: 'A v1' },
    { ...ep(2, 1), policy: 'A v1' },
    { ...ep(3), policy: 'B v1' },
    { ...ep(4), policy: null },
  ]

  it('grupuje i liczy osobno dla każdego klucza', () => {
    const map = cadenceBy(rows, (r) => r.policy)
    expect(map.get('A v1')!.episodes).toBe(2)
    expect(map.get('A v1')!.interventions).toBe(1)
    expect(map.get('B v1')!.episodes).toBe(1)
  })

  it('pomija wpisy bez klucza zamiast wrzucać je do wspólnego worka', () => {
    // Epizod bez polityki (teleoperacja) nie należy do żadnej polityki
    // i zaliczenie go do którejkolwiek fałszowałoby jej kadencję.
    const map = cadenceBy(rows, (r) => r.policy)
    expect(map.size).toBe(2)
    expect([...map.keys()]).not.toContain('null')
  })

  it('nie zmienia kolejności wejścia', () => {
    // Seria jest własnością czasu; przesortowanie tutaj skleiłoby serie,
    // których żadna maszyna nigdy nie osiągnęła.
    const map = cadenceBy(
      [
        { ...ep(1, 1), policy: 'A' },
        { ...ep(2), policy: 'A' },
        { ...ep(3), policy: 'A' },
      ],
      (r) => r.policy,
    )
    expect(map.get('A')!.streaks).toEqual([2])
    expect(map.get('A')!.currentStreak).toBe(2)
  })
})

describe('trend', () => {
  const okres = (episodes: number, interventions: number) =>
    cadence([
      ...Array.from({ length: episodes - interventions }, (_, i) => ep(i + 1)),
      ...Array.from({ length: interventions }, (_, i) => ep(episodes - interventions + i + 1, 1)),
    ])

  it('wykrywa poprawę', () => {
    expect(trend(okres(20, 4), okres(20, 2)).direction).toBe('up')
  })

  it('wykrywa pogorszenie', () => {
    expect(trend(okres(20, 2), okres(20, 5)).direction).toBe('down')
  })

  it('drobna różnica mieści się w szumie', () => {
    const result = trend(okres(100, 10), okres(102, 10))
    expect(result.direction).toBe('flat')
  })

  it('brak interwencji w obu okresach to brak podstawy, a nie sukces', () => {
    const result = trend(okres(10, 0), okres(10, 0))
    expect(result.direction).toBe('unknown')
    expect(result.reason).toContain('brak podstawy')
  })

  it('zniknięcie interwencji to poprawa, pojawienie się - pogorszenie', () => {
    expect(trend(okres(20, 3), okres(20, 0)).direction).toBe('up')
    expect(trend(okres(20, 0), okres(20, 3)).direction).toBe('down')
  })
})
