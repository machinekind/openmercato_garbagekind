import {
  CRM_SYNC_SOURCE,
  SUPPLIER_STAGE,
  dealStatusForStage,
  planCrmSync,
  stageForDealStatuses,
  type CrmCompany,
  type CrmDeal,
} from '../crm'

/**
 * Firmy i szanse sprzedaży mają być jedną prawdą. Sprawdzamy regułę, która je
 * spina: klient ma wygraną szansę, potencjalny — otwartą, dostawca — żadnej;
 * a w drugą stronę firma bez etapu dostaje go ze swojej szansy.
 */

function company(overrides: Partial<CrmCompany> = {}): CrmCompany {
  return { id: 'firma-1', displayName: 'PlastMet Sp. z o.o.', lifecycleStage: null, ...overrides }
}

function deal(overrides: Partial<CrmDeal> = {}): CrmDeal {
  return { id: 'szansa-1', status: 'open', source: null, companyIds: ['firma-1'], ...overrides }
}

describe('mapowanie etap ⇄ status', () => {
  it('klient ma szansę wygraną, potencjalny — otwartą', () => {
    expect(dealStatusForStage('customer')).toBe('win')
    expect(dealStatusForStage('subscriber')).toBe('win')
    expect(dealStatusForStage('prospect')).toBe('open')
    expect(dealStatusForStage('lead')).toBe('open')
  })

  it('dostawca, utracony i brak etapu nie wymagają żadnej szansy', () => {
    expect(dealStatusForStage(SUPPLIER_STAGE)).toBeNull()
    expect(dealStatusForStage('churned')).toBeNull()
    expect(dealStatusForStage(null)).toBeNull()
  })

  it('wygrana robi klienta, otwarta — potencjalnego, sama przegrana nic nie przesądza', () => {
    expect(stageForDealStatuses(['lost', 'win'])).toBe('customer')
    expect(stageForDealStatuses(['in_progress'])).toBe('prospect')
    expect(stageForDealStatuses(['lost'])).toBeNull()
    expect(stageForDealStatuses([])).toBeNull()
  })
})

describe('planCrmSync — firma → szansa', () => {
  it('klient bez szansy dostaje wygraną szansę pod swoją nazwą', () => {
    const actions = planCrmSync([company({ lifecycleStage: 'customer' })], [])
    expect(actions).toEqual([
      { kind: 'create-deal', companyId: 'firma-1', status: 'win', title: 'PlastMet Sp. z o.o. — sprzedaż frakcji' },
    ])
  })

  it('potencjalny klient bez szansy dostaje otwartą', () => {
    const actions = planCrmSync([company({ lifecycleStage: 'prospect' })], [])
    expect(actions[0]).toMatchObject({ kind: 'create-deal', status: 'open' })
  })

  it('nic nie robi, gdy pasująca szansa już jest — drugi przebieg nie dubluje', () => {
    const actions = planCrmSync([company({ lifecycleStage: 'customer' })], [deal({ status: 'win' })])
    expect(actions).toEqual([])
  })

  it('własną szansę poprawia zamiast zakładać kolejną', () => {
    const actions = planCrmSync(
      [company({ lifecycleStage: 'customer' })],
      [deal({ status: 'open', source: CRM_SYNC_SOURCE })],
    )
    expect(actions).toEqual([{ kind: 'update-deal', dealId: 'szansa-1', status: 'win' }])
  })

  it('cudzej szansy nie rusza — zakłada obok własną', () => {
    const actions = planCrmSync([company({ lifecycleStage: 'customer' })], [deal({ status: 'open' })])
    expect(actions).toEqual([expect.objectContaining({ kind: 'create-deal', status: 'win' })])
  })

  it('dostawca nie może mieć szansy — istniejąca idzie do kosza', () => {
    const actions = planCrmSync([company({ lifecycleStage: SUPPLIER_STAGE })], [deal({ status: 'win' })])
    expect(actions).toEqual([{ kind: 'delete-deal', dealId: 'szansa-1', reason: expect.any(String) }])
  })

  it('szansę wspólną z inną firmą tylko odpina od dostawcy', () => {
    const actions = planCrmSync(
      [company({ lifecycleStage: SUPPLIER_STAGE })],
      [deal({ companyIds: ['firma-1', 'firma-2'] })],
    )
    expect(actions).toEqual([
      { kind: 'unlink-company', dealId: 'szansa-1', companyId: 'firma-1', companyIds: ['firma-2'] },
    ])
  })

  it('firma bez etapu i bez szans zostaje w spokoju', () => {
    expect(planCrmSync([company()], [])).toEqual([])
  })
})

describe('planCrmSync — szansa → firma', () => {
  it('firma bez etapu dostaje go ze statusu szansy i nie dostaje drugiej szansy', () => {
    const actions = planCrmSync([company()], [deal({ status: 'win' })])
    expect(actions).toEqual([
      { kind: 'set-stage', companyId: 'firma-1', stage: 'customer', reason: expect.any(String) },
    ])
  })

  it('otwarta szansa robi z firmy potencjalnego klienta', () => {
    const actions = planCrmSync([company()], [deal({ status: 'in_progress' })])
    expect(actions[0]).toMatchObject({ kind: 'set-stage', stage: 'prospect' })
  })

  it('wygrana szansa awansuje potencjalnego klienta na klienta — wygrana to fakt', () => {
    const actions = planCrmSync([company({ lifecycleStage: 'prospect' })], [deal({ status: 'win' })])
    expect(actions).toEqual([
      { kind: 'set-stage', companyId: 'firma-1', stage: 'customer', reason: expect.any(String) },
    ])
  })

  it('wygrana szansa nie robi z dostawcy klienta — szansa ma zniknąć', () => {
    const actions = planCrmSync([company({ lifecycleStage: SUPPLIER_STAGE })], [deal({ status: 'win' })])
    expect(actions.map((a) => a.kind)).toEqual(['delete-deal'])
  })

  it('patrzy tylko na szanse tej firmy', () => {
    const actions = planCrmSync([company()], [deal({ status: 'win', companyIds: ['firma-9'] })])
    expect(actions).toEqual([])
  })
})
