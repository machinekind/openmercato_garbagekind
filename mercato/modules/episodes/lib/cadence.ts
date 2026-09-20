/**
 * Kadencja autonomii: ile epizodów mija między interwencjami człowieka.
 *
 * To jest jedyna liczba, która naprawdę mówi, czy wdrożenie idzie do przodu.
 * Skuteczność pojedynczego chwytu rośnie od pierwszego dnia i przestaje coś
 * znaczyć w drugim tygodniu; liczba epizodów między przerwaniami rośnie albo
 * nie rośnie, i to widać.
 *
 * Wszystko poniżej jest czystą funkcją, bo to ona jest treścią raportu, który
 * ma się zgadzać **co do sztuki** z księgą epizodów. Reguła wyliczana w SQL-u
 * raportu byłaby nieweryfikowalna inaczej niż drugim SQL-em.
 */

export type EpisodeEntry = {
  id: string
  /** Kolejność w obrębie robota. Raport zakłada, że wejście jest już posortowane. */
  sequence: number
  outcome: EpisodeOutcome
  /** Ile interwencji przypadło na ten epizod. Zero znaczy „przeszedł sam". */
  interventionCount: number
}

export type EpisodeOutcome = 'success' | 'failure' | 'aborted' | 'timeout'

export type CadenceReport = {
  episodes: number
  interventions: number
  /** Epizody, w których człowiek przerwał choć raz. */
  intervenedEpisodes: number
  /** Epizody, które przeszły bez udziału człowieka. */
  cleanEpisodes: number
  successes: number
  /**
   * Średnia liczba epizodów przypadająca na jedną interwencję.
   *
   * `null`, gdy interwencji nie było wcale - i to **nie** jest to samo, co
   * nieskończoność ani co bardzo duża liczba. Brak interwencji w serii
   * pięciu epizodów nie jest dowodem autonomii, tylko brakiem danych,
   * i raport ma to mówić wprost zamiast wypisywać imponujący ułamek.
   */
  meanEpisodesBetweenInterventions: number | null
  /** Długość bieżącej serii bez interwencji, licząc od końca. */
  currentStreak: number
  /** Najdłuższa seria bez interwencji w całym okresie. */
  longestStreak: number
  /** Długości wszystkich serii czystych epizodów, w kolejności występowania. */
  streaks: number[]
  /** Udział epizodów przeprowadzonych bez człowieka. */
  autonomyRate: number
  /** Udział sukcesów - osobno, bo epizod bywa nieudany bez żadnej interwencji. */
  successRate: number
}

/**
 * Raport dla jednej uporządkowanej serii epizodów.
 *
 * Niezmiennik, którego trzyma się cała reszta: `cleanEpisodes` równa się sumie
 * długości serii, a `intervenedEpisodes + cleanEpisodes` równa się liczbie
 * epizodów. Bez tego raport byłby osobną opowieścią obok księgi - a księga
 * epizodów ma być jedynym źródłem.
 */
export function cadence(entries: EpisodeEntry[]): CadenceReport {
  let interventions = 0
  let intervenedEpisodes = 0
  let successes = 0
  const streaks: number[] = []
  let run = 0

  for (const entry of entries) {
    if (entry.outcome === 'success') successes += 1

    if (entry.interventionCount > 0) {
      interventions += entry.interventionCount
      intervenedEpisodes += 1
      // Seria kończy się na epizodzie z interwencją, a sam ten epizod do niej
      // nie należy. Zaliczenie go do serii zawyżałoby wynik o jeden przy
      // każdym przerwaniu - czyli najbardziej tam, gdzie wdrożenie idzie źle.
      if (run > 0) streaks.push(run)
      run = 0
    } else {
      run += 1
    }
  }
  if (run > 0) streaks.push(run)

  const episodes = entries.length
  const cleanEpisodes = episodes - intervenedEpisodes

  return {
    episodes,
    interventions,
    intervenedEpisodes,
    cleanEpisodes,
    successes,
    meanEpisodesBetweenInterventions: interventions > 0 ? episodes / interventions : null,
    currentStreak: run,
    longestStreak: streaks.length ? Math.max(...streaks) : 0,
    streaks,
    autonomyRate: episodes ? cleanEpisodes / episodes : 0,
    successRate: episodes ? successes / episodes : 0,
  }
}

/**
 * Kontrola spójności raportu z księgą.
 *
 * Wydzielona jako osobna funkcja, bo ma być wołana także **w produkcji**,
 * a nie tylko w teście: raport, który rozjedzie się z księgą, ma o tym
 * powiedzieć na ekranie, a nie zostać zauważony po kwartale. Czerwony wynik
 * jest informacją, nie przeszkodą.
 */
export function verifyAgainstLedger(
  report: CadenceReport,
  ledger: { episodes: number; interventions: number },
): { consistent: boolean; problems: string[] } {
  const problems: string[] = []

  if (report.episodes !== ledger.episodes) {
    problems.push(`liczba epizodów: raport ${report.episodes}, księga ${ledger.episodes}`)
  }
  if (report.interventions !== ledger.interventions) {
    problems.push(`liczba interwencji: raport ${report.interventions}, księga ${ledger.interventions}`)
  }
  if (report.intervenedEpisodes + report.cleanEpisodes !== report.episodes) {
    problems.push('epizody z interwencją i bez nie sumują się do całości')
  }
  const streakSum = report.streaks.reduce((a, b) => a + b, 0)
  if (streakSum !== report.cleanEpisodes) {
    problems.push(`sumy serii ${streakSum} nie zgadzają się z epizodami bez interwencji ${report.cleanEpisodes}`)
  }
  if (report.interventions < report.intervenedEpisodes) {
    problems.push('interwencji mniej niż epizodów z interwencją - to niemożliwe')
  }

  return { consistent: problems.length === 0, problems }
}

/**
 * Grupowanie po dowolnym kluczu (polityka, cela) z zachowaniem kolejności.
 *
 * Kolejność wejścia jest tu znacząca i dlatego nie sortujemy tu ponownie:
 * seria epizodów jest własnością czasu, a nie identyfikatora. Wywołujący
 * podaje księgę już uporządkowaną i bierze za to odpowiedzialność.
 */
export function cadenceBy<T extends EpisodeEntry>(
  entries: T[],
  key: (entry: T) => string | null,
): Map<string, CadenceReport> {
  const groups = new Map<string, T[]>()
  for (const entry of entries) {
    const k = key(entry)
    if (k === null) continue
    const list = groups.get(k) ?? []
    list.push(entry)
    groups.set(k, list)
  }
  const out = new Map<string, CadenceReport>()
  for (const [k, list] of groups) out.set(k, cadence(list))
  return out
}

/**
 * Czy wdrożenie idzie do przodu.
 *
 * Porównanie dwóch okresów, nie jednej liczby. Pojedyncza średnia nie mówi
 * niczego o kierunku, a kierunek jest jedyną rzeczą, o którą pyta ktoś
 * płacący za wdrożenie.
 */
export function trend(
  earlier: CadenceReport,
  later: CadenceReport,
): { direction: 'up' | 'flat' | 'down' | 'unknown'; reason: string } {
  const a = earlier.meanEpisodesBetweenInterventions
  const b = later.meanEpisodesBetweenInterventions

  if (a === null && b === null) {
    return { direction: 'unknown', reason: 'w żadnym okresie nie było interwencji - brak podstawy do porównania' }
  }
  if (a === null) {
    return { direction: 'down', reason: 'wcześniej nie było interwencji, teraz są' }
  }
  if (b === null) {
    return { direction: 'up', reason: 'w nowszym okresie nie było ani jednej interwencji' }
  }

  const change = (b - a) / a
  // Pięć procent jako próg szumu: przy kilkudziesięciu epizodach mniejsza
  // różnica to jedna interwencja w tę lub w tamtą stronę.
  if (Math.abs(change) < 0.05) {
    return { direction: 'flat', reason: `zmiana ${(change * 100).toFixed(1)}% mieści się w szumie` }
  }
  return {
    direction: change > 0 ? 'up' : 'down',
    reason: `${a.toFixed(1)} → ${b.toFixed(1)} epizodów na interwencję (${(change * 100).toFixed(1)}%)`,
  }
}
