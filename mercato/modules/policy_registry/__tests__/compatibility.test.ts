import { checkEmbodimentCompatibility, mayBeDeployed, type EmbodimentContract } from '../lib/compatibility'

const CONTRACT: EmbodimentContract = {
  id: 'rev-1',
  embodimentKey: 'ur10e-pick',
  revision: 3,
  specDigest: 'demo:ur10e-pick:r3',
  dofCount: 6,
}

describe('checkEmbodimentCompatibility', () => {
  it('przepuszcza zgodny kontrakt', () => {
    const verdict = checkEmbodimentCompatibility(CONTRACT, {
      policyEmbodimentKey: 'ur10e-pick',
      declaredSpecDigest: 'demo:ur10e-pick:r3',
      trainedDofCount: 6,
    })
    expect(verdict.compatible).toBe(true)
    expect(verdict.reason).toBeUndefined()
  })

  it('odmawia, gdy rewizji w ogóle nie ma - i mówi dlaczego', () => {
    const verdict = checkEmbodimentCompatibility(null, {
      policyEmbodimentKey: 'ur10e-pick',
      declaredSpecDigest: 'cokolwiek',
    })
    expect(verdict.compatible).toBe(false)
    expect(verdict.code).toBe('no_embodiment')
    // Powód musi być zdaniem, nie kodem - to on ląduje w komunikacie operatora.
    expect(verdict.reason).toContain('bez zadeklarowanej rewizji embodimentu')
  })

  it('odmawia przy innej rodzinie sprzętu', () => {
    const verdict = checkEmbodimentCompatibility(CONTRACT, {
      policyEmbodimentKey: 'fr3-assembly',
      declaredSpecDigest: 'demo:ur10e-pick:r3',
    })
    expect(verdict.compatible).toBe(false)
    expect(verdict.code).toBe('embodiment_key_mismatch')
    expect(verdict.reason).toContain('fr3-assembly')
    expect(verdict.reason).toContain('ur10e-pick')
  })

  it('odmawia przy innym odcisku kontraktu i wypisuje obie wartości', () => {
    const verdict = checkEmbodimentCompatibility(CONTRACT, {
      policyEmbodimentKey: 'ur10e-pick',
      declaredSpecDigest: 'demo:ur10e-pick:r2',
    })
    expect(verdict.compatible).toBe(false)
    expect(verdict.code).toBe('spec_digest_mismatch')
    // Obie strony w komunikacie: bez nich operator nie wie, którą poprawić.
    expect(verdict.reason).toContain('demo:ur10e-pick:r3')
    expect(verdict.reason).toContain('demo:ur10e-pick:r2')
  })

  it('rodzina sprzętu jest sprawdzana przed odciskiem kontraktu', () => {
    // Kolejność niesie sens komunikatu: „to inny robot" jest informacją
    // użyteczniejszą niż „skróty się nie zgadzają".
    const verdict = checkEmbodimentCompatibility(CONTRACT, {
      policyEmbodimentKey: 'fr3-assembly',
      declaredSpecDigest: 'zupełnie-co-innego',
    })
    expect(verdict.code).toBe('embodiment_key_mismatch')
  })

  it('odmawia przy niezgodnej liczbie stopni swobody', () => {
    const verdict = checkEmbodimentCompatibility(CONTRACT, {
      policyEmbodimentKey: 'ur10e-pick',
      declaredSpecDigest: 'demo:ur10e-pick:r3',
      trainedDofCount: 7,
    })
    expect(verdict.compatible).toBe(false)
    expect(verdict.code).toBe('dof_mismatch')
  })

  it('nie wymusza DOF, gdy któraś strona go nie deklaruje', () => {
    expect(
      checkEmbodimentCompatibility(CONTRACT, {
        policyEmbodimentKey: 'ur10e-pick',
        declaredSpecDigest: 'demo:ur10e-pick:r3',
      }).compatible,
    ).toBe(true)
    expect(
      checkEmbodimentCompatibility(
        { ...CONTRACT, dofCount: null },
        { policyEmbodimentKey: 'ur10e-pick', declaredSpecDigest: 'demo:ur10e-pick:r3', trainedDofCount: 7 },
      ).compatible,
    ).toBe(true)
  })
})

describe('mayBeDeployed', () => {
  it('dopuszcza wyłącznie wersję wypuszczoną', () => {
    expect(mayBeDeployed('released')).toBe(true)
    expect(mayBeDeployed('registered')).toBe(false)
    expect(mayBeDeployed('deprecated')).toBe(false)
  })
})
