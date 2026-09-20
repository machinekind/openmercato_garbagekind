import {
  composition,
  contentDigest,
  diff,
  roleFor,
  verifyLoop,
  warnings,
  type DatasetMember,
  type EpisodeCandidate,
} from '../lib/lineage'

/**
 * Testy pochodzenia.
 *
 * Najważniejszy jest tu `roleFor`: to on decyduje, czy epizod z interwencją
 * trafi do modelu jako wzór do naśladowania. Błąd w tym miejscu psuje następną
 * wersję polityki po cichu i wychodzi dopiero na hali.
 */

function ep(over: Partial<EpisodeCandidate> = {}): EpisodeCandidate {
  return {
    episodeId: 'e1',
    outcome: 'success',
    interventionCount: 0,
    policyVersionId: 'v-1',
    cellClass: 'fenced-pick-place',
    ...over,
  }
}

describe('roleFor', () => {
  it('epizod udany bez interwencji to demonstracja', () => {
    expect(roleFor(ep())).toBe('demo')
  })

  it('epizod z interwencją to demonstracja KOREKCYJNA, nawet gdy zakończył się sukcesem', () => {
    // To jest najczęstszy sposób, w jaki zbiór po cichu psuje następną wersję:
    // epizod, w którym człowiek poprawił chwyt, wrzucony do `demo` uczy model,
    // że tak właśnie ma wyglądać poprawny przebieg.
    expect(roleFor(ep({ outcome: 'success', interventionCount: 1 }))).toBe('correction')
  })

  it('interwencja wygrywa z wynikiem także przy niepowodzeniu', () => {
    expect(roleFor(ep({ outcome: 'failure', interventionCount: 2 }))).toBe('correction')
  })

  it('epizod nieudany bez interwencji to przykład negatywny', () => {
    expect(roleFor(ep({ outcome: 'failure' }))).toBe('failure')
    expect(roleFor(ep({ outcome: 'timeout' }))).toBe('failure')
    expect(roleFor(ep({ outcome: 'aborted' }))).toBe('failure')
  })
})

describe('contentDigest', () => {
  const a: DatasetMember[] = [
    { episodeId: 'e1', role: 'demo' },
    { episodeId: 'e2', role: 'correction' },
  ]

  it('nie zależy od kolejności dodania epizodów', () => {
    // Kolejność nie jest własnością zbioru - kolejność losowania w treningu
    // i tak jest inna.
    expect(contentDigest(a)).toBe(contentDigest([...a].reverse()))
  })

  it('zmienia się, gdy dojdzie epizod', () => {
    expect(contentDigest(a)).not.toBe(contentDigest([...a, { episodeId: 'e3', role: 'demo' }]))
  })

  it('zmienia się, gdy epizod zmieni rolę', () => {
    // Ten sam zestaw epizodów z innym podziałem na role to inny zbiór:
    // model zobaczy co innego.
    const rerolled: DatasetMember[] = [
      { episodeId: 'e1', role: 'holdout' },
      { episodeId: 'e2', role: 'correction' },
    ]
    expect(contentDigest(a)).not.toBe(contentDigest(rerolled))
  })

  it('daje sha256 w hex', () => {
    expect(contentDigest(a)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('composition i warnings', () => {
  const build = (counts: { demo: number; correction: number; failure: number; holdout: number }) => {
    const members: DatasetMember[] = []
    let index = 0
    for (const [role, count] of Object.entries(counts)) {
      for (let i = 0; i < count; i += 1) {
        members.push({ episodeId: `e${index++}`, role: role as DatasetMember['role'] })
      }
    }
    return members
  }

  it('liczy skład i udział korekcyjnych', () => {
    const comp = composition(build({ demo: 60, correction: 20, failure: 10, holdout: 10 }))
    expect(comp.total).toBe(100)
    expect(comp.byRole.correction).toBe(20)
    expect(comp.correctionRate).toBeCloseTo(0.2)
  })

  it('ostrzega o zbiorze bez demonstracji korekcyjnych', () => {
    const codes = warnings(composition(build({ demo: 90, correction: 0, failure: 5, holdout: 30 }))).map(
      (w) => w.code,
    )
    expect(codes).toContain('no_corrections')
  })

  it('ostrzega o zbiorze przeładowanym korekcjami', () => {
    const codes = warnings(composition(build({ demo: 10, correction: 80, failure: 5, holdout: 30 }))).map(
      (w) => w.code,
    )
    expect(codes).toContain('correction_heavy')
  })

  it('ostrzega o braku części ewaluacyjnej', () => {
    const codes = warnings(composition(build({ demo: 100, correction: 20, failure: 5, holdout: 0 }))).map(
      (w) => w.code,
    )
    expect(codes).toContain('no_holdout')
  })

  it('zdrowy zbiór nie generuje ostrzeżeń', () => {
    expect(warnings(composition(build({ demo: 120, correction: 30, failure: 20, holdout: 40 })))).toEqual([])
  })

  it('pusty zbiór daje jedno ostrzeżenie i nie dzieli przez zero', () => {
    const comp = composition([])
    expect(comp.correctionRate).toBe(0)
    expect(warnings(comp)).toEqual([{ code: 'empty', message: 'zbiór jest pusty' }])
  })
})

describe('verifyLoop', () => {
  const links = [
    {
      datasetVersionId: 'dv-1',
      datasetKey: 'ds',
      datasetVersion: 1,
      policyVersionId: 'pv-1',
      trainingRunRef: 'run-1',
    },
  ]

  it('pętla zamknięta, gdy polityka ma zbiór, a zbiór epizody', () => {
    const result = verifyLoop({
      policyVersionIds: ['pv-1'],
      datasetVersions: [{ id: 'dv-1', memberCount: 100 }],
      links,
    })
    expect(result.closed).toBe(true)
  })

  it('wskazuje politykę bez zbioru po nazwie, nie po liczbie', () => {
    const result = verifyLoop({
      policyVersionIds: ['pv-1', 'pv-2'],
      datasetVersions: [{ id: 'dv-1', memberCount: 100 }],
      links,
    })
    expect(result.closed).toBe(false)
    expect(result.policiesWithoutDataset).toEqual(['pv-2'])
  })

  it('wskazuje zbiór bez epizodów', () => {
    const result = verifyLoop({
      policyVersionIds: ['pv-1'],
      datasetVersions: [{ id: 'dv-1', memberCount: 100 }, { id: 'dv-2', memberCount: 0 }],
      links,
    })
    expect(result.closed).toBe(false)
    expect(result.datasetsWithoutEpisodes).toEqual(['dv-2'])
  })

  it('zbiór, na którym nic się nie uczyło, NIE łamie pętli', () => {
    // Pętla jest zamknięta, gdy każda polityka ma skąd pochodzić i każdy zbiór
    // ma z czego się składać. Świeżo zbudowany zbiór jest normalnym stanem.
    const result = verifyLoop({
      policyVersionIds: ['pv-1'],
      datasetVersions: [{ id: 'dv-1', memberCount: 100 }, { id: 'dv-2', memberCount: 50 }],
      links,
    })
    expect(result.closed).toBe(true)
    expect(result.datasetsWithoutPolicy).toEqual(['dv-2'])
  })

  it('rozróżnia dwie dziury zamiast zliczać je razem', () => {
    const result = verifyLoop({
      policyVersionIds: ['pv-1', 'pv-9'],
      datasetVersions: [{ id: 'dv-1', memberCount: 100 }, { id: 'dv-9', memberCount: 0 }],
      links,
    })
    expect(result.policiesWithoutDataset).toEqual(['pv-9'])
    expect(result.datasetsWithoutEpisodes).toEqual(['dv-9'])
  })
})

describe('diff', () => {
  const before: DatasetMember[] = [
    { episodeId: 'e1', role: 'demo' },
    { episodeId: 'e2', role: 'demo' },
    { episodeId: 'e3', role: 'correction' },
  ]

  it('wskazuje dodane i usunięte epizody', () => {
    const result = diff(before, [
      { episodeId: 'e2', role: 'demo' },
      { episodeId: 'e3', role: 'correction' },
      { episodeId: 'e4', role: 'demo' },
    ])
    expect(result.added).toEqual(['e4'])
    expect(result.removed).toEqual(['e1'])
  })

  it('wskazuje epizody, którym zmieniła się rola', () => {
    // Ten sam epizod raz jako demonstracja, raz jako część ewaluacyjna to
    // realna różnica między dwoma zbiorami - i najczęstsza przyczyna wyniku,
    // którego nie da się powtórzyć.
    const result = diff(before, [
      { episodeId: 'e1', role: 'holdout' },
      { episodeId: 'e2', role: 'demo' },
      { episodeId: 'e3', role: 'correction' },
    ])
    expect(result.rerolled).toEqual([{ episodeId: 'e1', from: 'demo', to: 'holdout' }])
    expect(result.added).toEqual([])
    expect(result.removed).toEqual([])
  })

  it('identyczne wersje nie dają różnicy', () => {
    const result = diff(before, [...before].reverse())
    expect(result).toEqual({ added: [], removed: [], rerolled: [] })
  })
})
