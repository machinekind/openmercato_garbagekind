import {
  allowedTargets,
  checkTransition,
  isActive,
  isTerminal,
  mayRunPolicy,
  transitionKey,
} from '../lib/lifecycle'

/**
 * Cykl życia rozstrzyga, czy tonowa maszyna w hali może się ruszyć. Testy
 * pilnują trzech rzeczy, których naruszenie kończy się ruchem, którego nikt
 * nie autoryzował: grafu przejść, asymetrii człowiek/system i bramek.
 */

describe('graf przejść', () => {
  it('robot zaczyna w rejestrze i idzie przez uruchomienie', () => {
    expect(allowedTargets('registered')).toContain('commissioning')
    expect(checkTransition('registered', 'commissioning', 'human').allowed).toBe(true)
  })

  it('nie da się przeskoczyć uruchomienia i od razu pracować', () => {
    const check = checkTransition('registered', 'operational', 'human')
    expect(check.allowed).toBe(false)
    expect(check.reason).toContain('dozwolone')
  })

  it('stan wycofany jest końcowy - robot nie wraca', () => {
    expect(isTerminal('decommissioned')).toBe(true)
    expect(checkTransition('decommissioned', 'ready', 'human').allowed).toBe(false)
  })

  it('przejście w ten sam stan nie jest przejściem', () => {
    const check = checkTransition('operational', 'operational', 'human')
    expect(check.allowed).toBe(false)
    expect(check.reason).toContain('już w stanie')
  })

  it('nieznany stan wyjściowy odrzuca, zamiast przepuszczać', () => {
    const check = checkTransition('bzdura' as never, 'ready', 'human')
    expect(check.allowed).toBe(false)
    expect(check.reason).toContain('nieznany stan')
  })
})

describe('asymetria człowiek / system', () => {
  it.each([
    ['ready', 'quarantined'],
    ['operational', 'quarantined'],
    ['commissioning', 'quarantined'],
    ['maintenance', 'quarantined'],
  ] as const)('system może kwarantannować z %s', (from, to) => {
    expect(checkTransition(from, to, 'system').allowed).toBe(true)
  })

  it('system NIE może dopuścić robota do pracy', () => {
    // To jest cała asymetria projektu w jednym teście: zatrzymać wolno
    // automatowi, dopuścić - wyłącznie człowiekowi.
    const check = checkTransition('quarantined', 'ready', 'system')
    expect(check.allowed).toBe(false)
    expect(check.reason).toContain('wyłącznie kwarantannować')
  })

  it('system nie wyprowadza robota z kwarantanny do serwisu ani nie wycofuje', () => {
    expect(checkTransition('quarantined', 'maintenance', 'system').allowed).toBe(false)
    expect(checkTransition('operational', 'decommissioning', 'system').allowed).toBe(false)
  })

  it('zatrzymanie jest tanie - kwarantanna nie wymaga podpisu', () => {
    // Gdyby wymagała, ludzie przestaliby jej używać i sięgali po wyłącznik.
    const check = checkTransition('operational', 'quarantined', 'human')
    expect(check.allowed).toBe(true)
    expect(check.requiresApproval).toBe(false)
  })
})

describe('bramki wymagające podpisu', () => {
  it.each([
    ['commissioning', 'ready'],
    ['quarantined', 'ready'],
    ['quarantined', 'maintenance'],
    ['maintenance', 'ready'],
    ['operational', 'decommissioning'],
  ] as const)('%s → %s wymaga człowieka z uzasadnieniem', (from, to) => {
    expect(checkTransition(from, to, 'human')).toMatchObject({
      allowed: true,
      requiresApproval: true,
    })
  })

  it('wyjście z kwarantanny zawsze wymaga podpisu - obiema drogami', () => {
    // Automatyczne wyjście po ustąpieniu objawu maskuje przyczynę, a przyczyna
    // jest tu jedyną rzeczą, która ma znaczenie.
    expect(checkTransition('quarantined', 'ready', 'human').requiresApproval).toBe(true)
    expect(checkTransition('quarantined', 'maintenance', 'human').requiresApproval).toBe(true)
  })

  it('rutynowe przejścia w ruchu nie wymagają podpisu', () => {
    expect(checkTransition('ready', 'operational', 'human').requiresApproval).toBe(false)
    expect(checkTransition('operational', 'ready', 'human').requiresApproval).toBe(false)
    expect(checkTransition('operational', 'maintenance', 'human').requiresApproval).toBe(false)
  })
})

describe('bramki dla wdrożeń i zestawień', () => {
  it('politykę wolno uruchomić wyłącznie na robocie w ruchu', () => {
    expect(mayRunPolicy('operational')).toBe(true)
    for (const state of ['ready', 'maintenance', 'quarantined', 'registered'] as const) {
      expect(mayRunPolicy(state)).toBe(false)
    }
  })

  it('robot w kwarantannie nie liczy się jako czynny, choć bywa sprawny', () => {
    expect(isActive('operational')).toBe(true)
    expect(isActive('ready')).toBe(true)
    expect(isActive('quarantined')).toBe(false)
    expect(isActive('maintenance')).toBe(false)
  })
})

describe('transitionKey', () => {
  it('składa klucz w postaci, której używają zbiory bramek', () => {
    expect(transitionKey('commissioning', 'ready')).toBe('commissioning->ready')
  })
})
