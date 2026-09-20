import {
  DEFAULT_SUITES,
  classifyIncident,
  evaluateClearance,
  type EvalRun,
  type SafetyCaseRef,
  type SuiteRequirement,
} from '../lib/clearance'

/**
 * Testy dopuszczenia.
 *
 * To jest funkcja, która odmawia wdrożenia, więc najważniejsze są tu przypadki,
 * w których **wygląda**, że wszystko jest w porządku: komplet zaliczonych
 * zestawów przy uzasadnieniu roboczym, zaliczenie sprzed roku unieważnione
 * nowszym niepowodzeniem, i zestaw zaliczony na innym sprzęcie.
 */

const VERSION = 'v-1'
const NOW = new Date('2026-09-19T12:00:00.000Z')

const REQUIREMENTS: SuiteRequirement[] = [
  { suiteKey: 'reach-envelope', requiredFor: ['fenced', 'shared', 'public'] },
  { suiteKey: 'force-pressure-limits', requiredFor: ['shared', 'public'] },
  { suiteKey: 'bystander-detection', requiredFor: ['public'] },
]

function run(suiteKey: string, result: 'pass' | 'fail' | 'error', offsetMs = 0, digest?: string): EvalRun {
  return {
    suiteKey,
    policyVersionId: VERSION,
    result,
    ranAt: new Date(NOW.getTime() + offsetMs),
    embodimentSpecDigest: digest ?? 'demo:ur10e-pick:r1',
  }
}

function approvedCase(over: Partial<SafetyCaseRef> = {}): SafetyCaseRef {
  return {
    cellClass: 'fenced-pick-place',
    status: 'approved',
    policyVersionId: VERSION,
    validUntil: new Date(NOW.getTime() + 86_400_000),
    declaredAsSafetyFunction: false,
    ...over,
  }
}

function check(over: Partial<Parameters<typeof evaluateClearance>[0]> = {}) {
  return evaluateClearance({
    policyVersionId: VERSION,
    policyEmbodimentSpecDigest: 'demo:ur10e-pick:r1',
    cellClass: 'fenced-pick-place',
    riskClass: 'fenced',
    requirements: REQUIREMENTS,
    runs: [run('reach-envelope', 'pass')],
    safetyCases: [approvedCase()],
    now: NOW,
    ...over,
  })
}

describe('evaluateClearance - dopuszczenie', () => {
  it('dopuszcza przy zatwierdzonym uzasadnieniu i komplecie zestawów', () => {
    const verdict = check()
    expect(verdict.cleared).toBe(true)
    expect(verdict.reasons).toEqual([])
    expect(verdict.usedCase).not.toBeNull()
  })

  it('cela ogrodzona nie wymaga zestawów przewidzianych dla przestrzeni dzielonej', () => {
    // Limity siły z ISO/TS 15066 mają sens tam, gdzie kontakt jest możliwy.
    // Wymaganie ich za płotem byłoby rytuałem, a rytuały uczą omijania wymagań.
    expect(check({ riskClass: 'fenced' }).cleared).toBe(true)
  })

  it('przestrzeń dzielona wymaga więcej niż ogrodzona', () => {
    const verdict = check({ riskClass: 'shared', cellClass: 'shared-handover', safetyCases: [approvedCase({ cellClass: 'shared-handover' })] })
    expect(verdict.cleared).toBe(false)
    expect(verdict.missingSuites).toContain('force-pressure-limits')
  })

  it('przestrzeń publiczna wymaga najwięcej', () => {
    const verdict = check({
      riskClass: 'public',
      cellClass: 'public-handover',
      safetyCases: [approvedCase({ cellClass: 'public-handover' })],
      runs: [run('reach-envelope', 'pass'), run('force-pressure-limits', 'pass')],
    })
    expect(verdict.missingSuites).toEqual(['bystander-detection'])
  })
})

describe('evaluateClearance - uzasadnienie', () => {
  it('odmawia przy braku uzasadnienia dla tej klasy celi', () => {
    const verdict = check({ safetyCases: [] })
    expect(verdict.cleared).toBe(false)
    expect(verdict.reasons[0]).toContain('brak zatwierdzonego uzasadnienia')
  })

  it('odmawia, gdy uzasadnienie jest tylko robocze - i mówi to wprost', () => {
    // Najgroźniejszy przypadek: komplet zaliczonych zestawów sprawia wrażenie,
    // że wszystko jest gotowe.
    const verdict = check({ safetyCases: [approvedCase({ status: 'draft' })] })
    expect(verdict.cleared).toBe(false)
    expect(verdict.reasons[0]).toContain('wersji roboczej')
  })

  it('odmawia, gdy uzasadnienie wygasło', () => {
    const verdict = check({
      safetyCases: [approvedCase({ validUntil: new Date(NOW.getTime() - 1000) })],
    })
    expect(verdict.cleared).toBe(false)
    expect(verdict.reasons[0]).toContain('wygasło')
  })

  it('uzasadnienie dla innej klasy celi nie dopuszcza tej', () => {
    // To jest cała treść wiązania z klasą: dopuszczenie w celi ogrodzonej
    // nie przenosi się na przestrzeń publiczną.
    const verdict = check({ safetyCases: [approvedCase({ cellClass: 'public-handover' })] })
    expect(verdict.cleared).toBe(false)
  })

  it('uzasadnienie dla innej wersji polityki nie dopuszcza tej', () => {
    const verdict = check({ safetyCases: [approvedCase({ policyVersionId: 'v-2' })] })
    expect(verdict.cleared).toBe(false)
  })

  it('uzasadnienie wycofane nie dopuszcza', () => {
    expect(check({ safetyCases: [approvedCase({ status: 'withdrawn' })] }).cleared).toBe(false)
  })
})

describe('evaluateClearance - polityka jako funkcja bezpieczeństwa', () => {
  it('odmawia bezwarunkowo i nie patrzy na ewaluacje', () => {
    const verdict = check({
      safetyCases: [approvedCase({ declaredAsSafetyFunction: true })],
      runs: [run('reach-envelope', 'pass'), run('force-pressure-limits', 'pass'), run('bystander-detection', 'pass')],
    })
    expect(verdict.cleared).toBe(false)
    expect(verdict.reasons).toHaveLength(1)
    expect(verdict.reasons[0]).toContain('Annex I część A')
    // Komplet testów nie tylko nie pomaga, ale jest mylący - więc nie jest liczony.
    expect(verdict.missingSuites).toEqual([])
    expect(verdict.failedSuites).toEqual([])
  })

  it('deklaracja WYCOFANA przestaje blokować', () => {
    // Inaczej jedna pomyłka w polu wyboru unieruchamiałaby wersję na zawsze,
    // bez legalnej drogi wyjścia - a reguła bez drogi odwrotu uczy obchodzenia
    // systemu i przestaje chronić cokolwiek.
    const verdict = check({
      safetyCases: [
        approvedCase(),
        approvedCase({ cellClass: 'sonda', status: 'withdrawn', declaredAsSafetyFunction: true }),
      ],
    })
    expect(verdict.cleared).toBe(true)
  })

  it('odmawia nawet wtedy, gdy deklaracja jest na uzasadnieniu innej klasy celi', () => {
    // Deklaracja dotyczy natury polityki, nie jednej celi.
    const verdict = check({
      safetyCases: [approvedCase(), approvedCase({ cellClass: 'inna', declaredAsSafetyFunction: true })],
    })
    expect(verdict.cleared).toBe(false)
  })
})

describe('evaluateClearance - przebiegi ewaluacyjne', () => {
  it('bierze NAJNOWSZY przebieg, a nie jakikolwiek zaliczony', () => {
    // Zestaw przebiegnięty ponownie po zmianie w celi i zakończony
    // niepowodzeniem unieważnia poprzedni sukces.
    const verdict = check({
      runs: [run('reach-envelope', 'pass', 0), run('reach-envelope', 'fail', 1000)],
    })
    expect(verdict.cleared).toBe(false)
    expect(verdict.failedSuites).toEqual(['reach-envelope'])
  })

  it('nowszy sukces unieważnia starsze niepowodzenie', () => {
    const verdict = check({
      runs: [run('reach-envelope', 'fail', 0), run('reach-envelope', 'pass', 1000)],
    })
    expect(verdict.cleared).toBe(true)
  })

  it('przebieg zakończony błędem to nie to samo, co zaliczony', () => {
    expect(check({ runs: [run('reach-envelope', 'error')] }).cleared).toBe(false)
  })

  it('przebieg na innym odcisku kontraktu embodimentu nie liczy się', () => {
    // Najczęstsza droga do dopuszczenia „na podstawie testów", których nikt
    // nie powtórzył po wymianie chwytaka.
    const verdict = check({ runs: [run('reach-envelope', 'pass', 0, 'demo:ur10e-pick:r2')] })
    expect(verdict.cleared).toBe(false)
    expect(verdict.reasons.join(' ')).toContain('innym odcisku kontraktu')
  })

  it('przebieg innej wersji polityki nie liczy się', () => {
    const verdict = check({
      runs: [{ ...run('reach-envelope', 'pass'), policyVersionId: 'v-2' }],
    })
    expect(verdict.missingSuites).toEqual(['reach-envelope'])
  })
})

describe('DEFAULT_SUITES', () => {
  it('każdy zestaw obowiązujący w celi ogrodzonej obowiązuje też wyżej', () => {
    // Monotoniczność wymagań: nie może istnieć zestaw wymagany za płotem,
    // a niewymagany w przestrzeni publicznej.
    for (const suite of DEFAULT_SUITES) {
      if (suite.requiredFor.includes('fenced')) {
        expect(suite.requiredFor).toContain('shared')
        expect(suite.requiredFor).toContain('public')
      }
      if (suite.requiredFor.includes('shared')) {
        expect(suite.requiredFor).toContain('public')
      }
    }
  })

  it('przestrzeń publiczna wymaga ściśle więcej niż ogrodzona', () => {
    const fenced = DEFAULT_SUITES.filter((s) => s.requiredFor.includes('fenced')).length
    const publicOnes = DEFAULT_SUITES.filter((s) => s.requiredFor.includes('public')).length
    expect(publicOnes).toBeGreaterThan(fenced)
  })
})

describe('classifyIncident', () => {
  it('zdarzenie ze skutkiem dla człowieka wstrzymuje wdrożenie', () => {
    const verdict = classifyIncident({ harm: 'serious', safetyLayerEngaged: false, policyImplicated: false })
    expect(verdict.haltDeployment).toBe(true)
    expect(verdict.priority).toBe('wstrzymanie_wdrożenia')
  })

  it('niezdolność do pracy traktowana tak samo jak ciężkie', () => {
    expect(
      classifyIncident({ harm: 'lost_time', safetyLayerEngaged: false, policyImplicated: false }).haltDeployment,
    ).toBe(true)
  })

  it('zadziałanie warstwy bezpieczeństwa jest pilne nawet bez skutków', () => {
    // Warstwa deterministyczna jest ostatnią linią. Jeśli zadziałała, wszystko
    // przed nią zawiodło, a zerowy skutek to zasługa ostatniej linii.
    const verdict = classifyIncident({ harm: 'none', safetyLayerEngaged: true, policyImplicated: false })
    expect(verdict.priority).toBe('pilny')
    expect(verdict.haltDeployment).toBe(false)
  })

  it('warstwa zadziałała przeciwko polityce - wdrożenie wstrzymane', () => {
    const verdict = classifyIncident({ harm: 'none', safetyLayerEngaged: true, policyImplicated: true })
    expect(verdict.haltDeployment).toBe(true)
  })

  it('zdarzenie potencjalnie wypadkowe idzie do analizy, nie do kosza', () => {
    const verdict = classifyIncident({ harm: 'near_miss', safetyLayerEngaged: false, policyImplicated: false })
    expect(verdict.priority).toBe('do_analizy')
  })

  it('zdarzenie bez skutku i bez udziału bezpieczeństwa jest informacyjne', () => {
    expect(
      classifyIncident({ harm: 'none', safetyLayerEngaged: false, policyImplicated: false }).priority,
    ).toBe('informacyjny')
  })

  it('zadziałanie warstwy bez skutków ma wyższy priorytet niż stłuczka bez niej', () => {
    // To jest sedno klasyfikacji dwuwymiarowej: pojedyncza skala ciężkości
    // odwróciłaby tę kolejność.
    const zWarstwa = classifyIncident({ harm: 'none', safetyLayerEngaged: true, policyImplicated: false })
    const bezWarstwy = classifyIncident({ harm: 'first_aid', safetyLayerEngaged: false, policyImplicated: false })
    const ranking = ['informacyjny', 'do_analizy', 'pilny', 'wstrzymanie_wdrożenia']
    expect(ranking.indexOf(zWarstwa.priority)).toBeGreaterThan(ranking.indexOf(bezWarstwy.priority))
  })
})
