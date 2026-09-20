/**
 * Dopuszczenie polityki do klasy celi.
 *
 * To jest warstwa, która odpowiada regulatorowi. Odniesienia, które rządzą
 * kształtem tych reguł:
 *
 * - **rozporządzenie (UE) 2023/1230** (maszynowe), stosowane od 20 stycznia
 *   2027. Konsekwencja, która wyprzedza wszystkie architektoniczne: uczona
 *   polityka **nie może** być funkcją bezpieczeństwa, bo wpycha produkt
 *   klienta w Annex I część A, czyli w obowiązkową ocenę przez jednostkę
 *   notyfikowaną - dla której nie istnieje ustalona metoda wykazania
 *   zgodności. Platforma ma to wymuszać i dokumentować, a nie zakładać.
 * - **AI Act art. 6 ust. 1** - klasyfikacja wysokiego ryzyka przez
 *   przynależność do komponentu bezpieczeństwa maszyny.
 * - **ISO 10218-1/-2:2025** - wymagania dla robotów przemysłowych i ich
 *   integracji.
 * - **ISO/TS 15066:2016** - współpraca człowiek-robot, limity siły i nacisku.
 *
 * Rozstrzygnięcie nośne: **dopuszczenie dotyczy klasy celi, nie pojedynczej
 * celi.** Inaczej każda nowa cela o tej samej, niezmienionej konfiguracji
 * wymagałaby osobnego uzasadnienia - a to jest koszt, którego nikt nie
 * poniesie i który w praktyce kończy się dopuszczeniami udzielanymi hurtem
 * bez czytania.
 *
 * Wszystko poniżej jest czystą funkcją: to ona odmawia wdrożenia.
 */

export type RiskClass = 'fenced' | 'shared' | 'public'

export type SafetyCaseStatus = 'draft' | 'approved' | 'withdrawn' | 'expired'

export type EvalResult = 'pass' | 'fail' | 'error'

export type SafetyCaseRef = {
  cellClass: string
  status: SafetyCaseStatus
  /** Wersja polityki, której dotyczy uzasadnienie. */
  policyVersionId: string
  validUntil?: Date | null
  /** Czy polityka została zadeklarowana jako funkcja bezpieczeństwa. */
  declaredAsSafetyFunction: boolean
}

export type SuiteRequirement = {
  suiteKey: string
  /** Klasy ryzyka, dla których ten zestaw jest obowiązkowy. */
  requiredFor: RiskClass[]
}

export type EvalRun = {
  suiteKey: string
  policyVersionId: string
  result: EvalResult
  ranAt: Date
  /** Odcisk kontraktu embodimentu, na którym zestaw przebiegł. */
  embodimentSpecDigest?: string | null
}

export type ClearanceInput = {
  policyVersionId: string
  /** Odcisk kontraktu wersji polityki - porównywany z tym z przebiegu ewaluacji. */
  policyEmbodimentSpecDigest?: string | null
  cellClass: string
  riskClass: RiskClass
  requirements: SuiteRequirement[]
  runs: EvalRun[]
  safetyCases: SafetyCaseRef[]
  now?: Date
}

export type ClearanceVerdict = {
  cleared: boolean
  /** Lista powodów odmowy. Pusta przy dopuszczeniu. */
  reasons: string[]
  /** Zestawy wymagane, ale bez zaliczonego przebiegu. */
  missingSuites: string[]
  /** Zestawy z przebiegiem zakończonym niepowodzeniem. */
  failedSuites: string[]
  /** Uzasadnienie użyte do dopuszczenia, gdy istnieje. */
  usedCase: SafetyCaseRef | null
}

/**
 * Najnowszy przebieg zestawu dla tej wersji polityki.
 *
 * Bierzemy najnowszy po `ranAt`, a nie „jakikolwiek zaliczony": zestaw
 * przebiegnięty ponownie po zmianie w celi i zakończony niepowodzeniem
 * unieważnia poprzedni sukces. Szukanie „czy kiedykolwiek przeszedł"
 * dawałoby dopuszczenia na podstawie wyniku sprzed roku.
 */
function latestRun(runs: EvalRun[], suiteKey: string, policyVersionId: string): EvalRun | null {
  let best: EvalRun | null = null
  for (const run of runs) {
    if (run.suiteKey !== suiteKey) continue
    if (run.policyVersionId !== policyVersionId) continue
    if (!best || run.ranAt.getTime() > best.ranAt.getTime()) best = run
  }
  return best
}

export function evaluateClearance(input: ClearanceInput): ClearanceVerdict {
  const now = input.now ?? new Date()
  const reasons: string[] = []
  const missingSuites: string[] = []
  const failedSuites: string[] = []

  /**
   * Kontrola pierwsza i nieprzekraczalna: polityka jako funkcja bezpieczeństwa.
   *
   * Sprawdzana przed wszystkim innym i nie do obejścia żadnym kompletem
   * ewaluacji. Uczona polityka umieszczona w łańcuchu bezpieczeństwa wpycha
   * produkt klienta w ocenę przez jednostkę notyfikowaną, dla której nie
   * istnieje ustalona metoda wykazania zgodności - więc komplet zaliczonych
   * testów nie tylko nie pomaga, ale jest mylący.
   *
   * Pod uwagę biorą się wyłącznie uzasadnienia **nie wycofane**. Deklaracja wycofana przestaje blokować i to jest decyzja, nie przeoczenie:
   * inaczej jedna pomyłka w polu wyboru unieruchamiałaby wersję polityki na
   * zawsze, bez żadnej drogi wyjścia poza ręcznym DELETE w bazie. Reguła,
   * która nie ma legalnej drogi odwrotu, uczy obchodzenia systemu - a wtedy
   * przestaje chronić cokolwiek. Ślad po wycofanej deklaracji zostaje w tabeli
   * razem z powodem wycofania.
   */
  const asSafetyFunction = input.safetyCases.find(
    (c) => c.declaredAsSafetyFunction && c.status !== 'withdrawn',
  )
  if (asSafetyFunction) {
    return {
      cleared: false,
      reasons: [
        'uzasadnienie deklaruje uczoną politykę jako funkcję bezpieczeństwa - to wpycha maszynę w Annex I część A rozporządzenia 2023/1230, czyli w ocenę przez jednostkę notyfikowaną; bezpieczeństwo egzekwuje osobna warstwa deterministyczna',
      ],
      missingSuites: [],
      failedSuites: [],
      usedCase: null,
    }
  }

  // 1. Uzasadnienie dla KLASY celi, nie dla celi.
  const forClass = input.safetyCases.filter(
    (c) => c.cellClass === input.cellClass && c.policyVersionId === input.policyVersionId,
  )
  const approved = forClass.find((c) => {
    if (c.status !== 'approved') return false
    if (c.validUntil && c.validUntil.getTime() <= now.getTime()) return false
    return true
  })

  if (!approved) {
    const draft = forClass.find((c) => c.status === 'draft')
    const expired = forClass.find(
      (c) => c.status === 'approved' && c.validUntil && c.validUntil.getTime() <= now.getTime(),
    )
    reasons.push(
      expired
        ? `uzasadnienie bezpieczeństwa dla klasy celi ${input.cellClass} wygasło`
        : draft
          ? `uzasadnienie bezpieczeństwa dla klasy celi ${input.cellClass} jest w wersji roboczej i nie zostało zatwierdzone`
          : `brak zatwierdzonego uzasadnienia bezpieczeństwa dla klasy celi ${input.cellClass}`,
    )
  }

  // 2. Komplet zestawów ewaluacyjnych wymaganych dla tej klasy ryzyka.
  const required = input.requirements.filter((r) => r.requiredFor.includes(input.riskClass))
  for (const requirement of required) {
    const run = latestRun(input.runs, requirement.suiteKey, input.policyVersionId)
    if (!run) {
      missingSuites.push(requirement.suiteKey)
      continue
    }
    if (run.result !== 'pass') {
      failedSuites.push(requirement.suiteKey)
      continue
    }
    /**
     * Przebieg policzony na innym sprzęcie nie liczy się.
     *
     * Zestaw zaliczony na rewizji embodimentu A nie mówi niczego o rewizji B,
     * choćby polityka była ta sama - a to jest najczęstsza droga do
     * dopuszczenia „na podstawie testów", których nikt nie powtórzył po
     * wymianie chwytaka.
     */
    if (
      input.policyEmbodimentSpecDigest &&
      run.embodimentSpecDigest &&
      run.embodimentSpecDigest !== input.policyEmbodimentSpecDigest
    ) {
      failedSuites.push(requirement.suiteKey)
      reasons.push(
        `zestaw ${requirement.suiteKey} przebiegł na innym odcisku kontraktu embodimentu (${run.embodimentSpecDigest})`,
      )
    }
  }

  if (missingSuites.length) {
    reasons.push(`brak przebiegu zestawów wymaganych dla klasy ryzyka ${input.riskClass}: ${missingSuites.join(', ')}`)
  }
  if (failedSuites.length) {
    reasons.push(`zestawy zakończone niepowodzeniem: ${[...new Set(failedSuites)].join(', ')}`)
  }

  return {
    cleared: reasons.length === 0,
    reasons,
    missingSuites,
    failedSuites: [...new Set(failedSuites)],
    usedCase: approved ?? null,
  }
}

/**
 * Klasyfikacja incydentu.
 *
 * Dwa wymiary, nie jeden: **czy ktoś ucierpiał** i **czy zawiodła warstwa
 * bezpieczeństwa**. Pojedyncza skala „ciężkości" skleja te pytania i gubi
 * najważniejszy przypadek: zdarzenie bez żadnych skutków, w którym warstwa
 * deterministyczna zadziałała na ostatniej linii. Takie zdarzenie ma
 * priorytet wyższy niż stłuczka bez udziału bezpieczeństwa, mimo że jego
 * skutek był zerowy.
 */
export type IncidentClass = {
  harm: 'none' | 'near_miss' | 'first_aid' | 'lost_time' | 'serious'
  safetyLayerEngaged: boolean
  policyImplicated: boolean
}

export type IncidentPriority = 'informacyjny' | 'do_analizy' | 'pilny' | 'wstrzymanie_wdrożenia'

export function classifyIncident(incident: IncidentClass): {
  priority: IncidentPriority
  haltDeployment: boolean
  reason: string
} {
  if (incident.harm === 'serious' || incident.harm === 'lost_time') {
    return {
      priority: 'wstrzymanie_wdrożenia',
      haltDeployment: true,
      reason: 'zdarzenie ze skutkiem dla człowieka - wdrożenie wstrzymane do czasu wyjaśnienia',
    }
  }

  if (incident.safetyLayerEngaged) {
    /**
     * Zadziałanie warstwy bezpieczeństwa jest zawsze pilne, nawet bez skutków.
     *
     * Warstwa deterministyczna jest ostatnią linią. Jeśli zadziałała, to
     * znaczy, że wszystko przed nią zawiodło - a zerowy skutek był kwestią
     * tego, że ostatnia linia akurat zadziałała, a nie że nic się nie stało.
     */
    return {
      priority: incident.policyImplicated ? 'wstrzymanie_wdrożenia' : 'pilny',
      haltDeployment: incident.policyImplicated,
      reason: incident.policyImplicated
        ? 'warstwa bezpieczeństwa zadziałała przeciwko polityce - wdrożenie wstrzymane'
        : 'warstwa bezpieczeństwa zadziałała - ostatnia linia nie jest miejscem na rutynę',
    }
  }

  if (incident.harm === 'near_miss' || incident.harm === 'first_aid') {
    return { priority: 'do_analizy', haltDeployment: false, reason: 'zdarzenie bez skutku trwałego' }
  }

  return { priority: 'informacyjny', haltDeployment: false, reason: 'zdarzenie bez skutku i bez udziału bezpieczeństwa' }
}

/**
 * Zestawy wymagane per klasa ryzyka - domyślny katalog.
 *
 * Rosnąco: cela ogrodzona wymaga najmniej, przestrzeń publiczna najwięcej.
 * Katalog jest danymi w bazie; ta stała jest punktem wyjścia zasiewu i
 * dokumentacją intencji.
 */
export const DEFAULT_SUITES: SuiteRequirement[] = [
  { suiteKey: 'reach-envelope', requiredFor: ['fenced', 'shared', 'public'] },
  { suiteKey: 'grasp-release-integrity', requiredFor: ['fenced', 'shared', 'public'] },
  { suiteKey: 'out-of-distribution-halt', requiredFor: ['shared', 'public'] },
  // ISO/TS 15066: limity siły i nacisku mają sens wyłącznie tam, gdzie kontakt
  // z człowiekiem jest możliwy. W celi ogrodzonej wymaganie ich byłoby rytuałem.
  { suiteKey: 'force-pressure-limits', requiredFor: ['shared', 'public'] },
  { suiteKey: 'bystander-detection', requiredFor: ['public'] },
]
