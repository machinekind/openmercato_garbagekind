import { createHash } from 'node:crypto'

/**
 * Pochodzenie zbioru danych - zamknięcie pętli.
 *
 * Zdanie, które ten plik ma uczynić prawdziwym: **dla dowolnej wersji polityki
 * da się wskazać zbiór, a dla zbioru - listę epizodów źródłowych, i odwrotnie.**
 *
 * Bez tego regres jakości po treningu jest nie do zdiagnozowania. Polityka
 * v7 zachowuje się gorzej od v6 i pozostają dwie hipotezy - zmiana w danych
 * albo zmiana w treningu - których nie da się rozdzielić, jeśli nie wiadomo,
 * czym się różniły zbiory.
 *
 * Wszystko poniżej jest czystą funkcją: pochodzenie liczone w SQL-u raportu
 * byłoby nieweryfikowalne inaczej niż drugim SQL-em.
 */

/** Rola epizodu w zbiorze. Nie jest etykietą - rządzi tym, co model z niego weźmie. */
export type MemberRole =
  /** Epizod udany, bez interwencji: demonstracja prawidłowego wykonania. */
  | 'demo'
  /** Epizod z interwencją: demonstracja korekcyjna, najcenniejsza i najrzadsza. */
  | 'correction'
  /** Epizod nieudany bez interwencji: przykład negatywny do offline RL. */
  | 'failure'
  /** Epizod przeznaczony do ewaluacji, nie do treningu. */
  | 'holdout'

export type EpisodeCandidate = {
  episodeId: string
  outcome: 'success' | 'failure' | 'aborted' | 'timeout'
  interventionCount: number
  policyVersionId: string | null
  cellClass: string | null
}

/**
 * Przypisanie roli epizodowi.
 *
 * Kolejność pytań jest znacząca: **interwencja wygrywa z wynikiem**. Epizod
 * zakończony sukcesem, w którym człowiek poprawił chwyt, jest demonstracją
 * korekcyjną, a nie demonstracją prawidłowego wykonania - i wrzucenie go do
 * `demo` uczyłoby model, że tak właśnie ma wyglądać poprawny przebieg.
 * To jest najczęstszy sposób, w jaki zbiór po cichu psuje następną wersję.
 */
export function roleFor(candidate: EpisodeCandidate): MemberRole {
  if (candidate.interventionCount > 0) return 'correction'
  if (candidate.outcome === 'success') return 'demo'
  return 'failure'
}

export type DatasetMember = {
  episodeId: string
  role: MemberRole
}

/**
 * Odcisk zawartości zbioru.
 *
 * Liczony z posortowanej listy `episodeId:role`, tak samo jak odcisk kompletu
 * artefaktów w rejestrze polityk i z tego samego powodu: **tożsamością wersji
 * zbioru jest jego zawartość**, a nie moment zbudowania. Dwa przebiegi
 * budowania dające ten sam zestaw epizodów to jedna wersja zbioru, i tylko
 * wtedy zdanie „polityka v7 uczyła się na zbiorze X w wersji 3" cokolwiek znaczy.
 *
 * Kolejność dodawania epizodów nie wchodzi do odcisku, bo nie jest własnością
 * zbioru - kolejność losowania w treningu i tak jest inna.
 */
export function contentDigest(members: DatasetMember[]): string {
  const canonical = members
    .map((m) => `${m.episodeId}:${m.role}`)
    .sort()
    .join('\n')
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export type Composition = {
  total: number
  byRole: Record<MemberRole, number>
  /** Udział demonstracji korekcyjnych - liczba, od której zależy sens zbioru. */
  correctionRate: number
}

export function composition(members: DatasetMember[]): Composition {
  const byRole: Record<MemberRole, number> = { demo: 0, correction: 0, failure: 0, holdout: 0 }
  for (const member of members) byRole[member.role] += 1
  const total = members.length
  return { total, byRole, correctionRate: total ? byRole.correction / total : 0 }
}

export type CompositionWarning = { code: string; message: string }

/**
 * Ostrzeżenia o składzie zbioru.
 *
 * To **nie są** twarde odmowy i celowo nie są. Zbiór z niewłaściwym składem
 * bywa dokładnie tym, czego ktoś potrzebuje - na przykład czysto korekcyjny
 * do dostrojenia jednego etapu. Odmowa zmuszałaby do obchodzenia systemu,
 * a ostrzeżenie zapisane przy wersji zbioru zostaje w dokumentacji i wypływa
 * przy diagnozie regresu.
 */
export function warnings(comp: Composition): CompositionWarning[] {
  const out: CompositionWarning[] = []

  if (comp.total === 0) {
    out.push({ code: 'empty', message: 'zbiór jest pusty' })
    return out
  }

  if (comp.byRole.correction === 0) {
    out.push({
      code: 'no_corrections',
      message:
        'zbiór nie zawiera ani jednej demonstracji korekcyjnej - model nie zobaczy żadnego przykładu wyjścia z sytuacji, w której polityka zawiodła',
    })
  }

  if (comp.correctionRate > 0.5) {
    out.push({
      code: 'correction_heavy',
      message: `demonstracje korekcyjne to ${(comp.correctionRate * 100).toFixed(0)}% zbioru - model uczony głównie na ratowaniu sytuacji bywa gorszy w ich unikaniu`,
    })
  }

  if (comp.byRole.holdout === 0) {
    out.push({
      code: 'no_holdout',
      message: 'zbiór nie ma części wydzielonej na ewaluację - wynik na danych treningowych nie mówi nic o wdrożeniu',
    })
  }

  if (comp.total < 100) {
    out.push({ code: 'small', message: `zbiór liczy ${comp.total} epizodów` })
  }

  return out
}

export type LineageLink = {
  datasetVersionId: string
  datasetKey: string
  datasetVersion: number
  policyVersionId: string
  trainingRunRef: string | null
}

/**
 * Sprawdzenie zamknięcia pętli w obie strony.
 *
 * Funkcja istnieje, bo zdanie „da się wskazać, i odwrotnie" jest twierdzeniem
 * o **dwóch** odwzorowaniach, a nie o jednym. Zbiór, z którego wyszła polityka
 * nie do wskazania, i polityka bez zbioru do wskazania są dwiema różnymi
 * dziurami i obie trzeba umieć nazwać osobno.
 */
export function verifyLoop(input: {
  /** Wersje polityk, które powinny mieć wskazany zbiór. */
  policyVersionIds: string[]
  /** Wersje zbiorów, które powinny mieć epizody źródłowe. */
  datasetVersions: Array<{ id: string; memberCount: number }>
  links: LineageLink[]
}): {
  closed: boolean
  /** Wersje polityk bez wskazanego zbioru - „skąd się wzięła ta polityka". */
  policiesWithoutDataset: string[]
  /** Wersje zbiorów bez epizodów - „z czego powstał ten zbiór". */
  datasetsWithoutEpisodes: string[]
  /** Wersje zbiorów, na których nic się nie uczyło - nie jest to błąd, ale jest informacją. */
  datasetsWithoutPolicy: string[]
} {
  const linkedPolicies = new Set(input.links.map((l) => l.policyVersionId))
  const linkedDatasets = new Set(input.links.map((l) => l.datasetVersionId))

  const policiesWithoutDataset = input.policyVersionIds.filter((id) => !linkedPolicies.has(id))
  const datasetsWithoutEpisodes = input.datasetVersions.filter((d) => d.memberCount === 0).map((d) => d.id)
  const datasetsWithoutPolicy = input.datasetVersions.filter((d) => !linkedDatasets.has(d.id)).map((d) => d.id)

  return {
    // Zbiór, na którym jeszcze nic się nie uczyło, nie łamie pętli - pętla
    // jest zamknięta, gdy każda polityka ma skąd pochodzić i każdy zbiór
    // ma z czego się składać.
    closed: policiesWithoutDataset.length === 0 && datasetsWithoutEpisodes.length === 0,
    policiesWithoutDataset,
    datasetsWithoutEpisodes,
    datasetsWithoutPolicy,
  }
}

/**
 * Różnica składu dwóch wersji zbioru.
 *
 * To jest narzędzie do diagnozy regresu: polityka v7 zachowuje się gorzej od
 * v6, więc pierwsze pytanie brzmi „czym się różniły zbiory". Bez tej funkcji
 * odpowiedź wymaga ręcznego porównania dwóch list identyfikatorów.
 */
export function diff(
  before: DatasetMember[],
  after: DatasetMember[],
): { added: string[]; removed: string[]; rerolled: Array<{ episodeId: string; from: MemberRole; to: MemberRole }> } {
  const beforeMap = new Map(before.map((m) => [m.episodeId, m.role]))
  const afterMap = new Map(after.map((m) => [m.episodeId, m.role]))

  const added: string[] = []
  const removed: string[] = []
  const rerolled: Array<{ episodeId: string; from: MemberRole; to: MemberRole }> = []

  for (const [id, role] of afterMap) {
    const previous = beforeMap.get(id)
    if (previous === undefined) added.push(id)
    else if (previous !== role) rerolled.push({ episodeId: id, from: previous, to: role })
  }
  for (const id of beforeMap.keys()) if (!afterMap.has(id)) removed.push(id)

  return { added: added.sort(), removed: removed.sort(), rerolled }
}
