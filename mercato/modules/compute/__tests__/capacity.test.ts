import {
  checkNodeRoles,
  estimateDecode,
  estimateVision,
  FORBIDDEN_NODE_ROLES,
  type NodeCapability,
} from '../lib/capacity'

/**
 * Planowanie obciążeń na węźle obliczeniowym.
 *
 * Testy pilnują jednej rzeczy przede wszystkim: że rachunek idzie za
 * **przepustowością pamięci**, a nie za nagłówkowym petaflopem - i że przy
 * małych modelach wizyjnych wąskie gardło poprawnie się odwraca. Funkcja,
 * która zawsze odpowiada „ograniczeniem jest pamięć", myli się w połowie
 * przypadków i każe kupować nie to, co trzeba.
 */

/** DGX Spark w precyzji FP4: 128 GB LPDDR5X, 273 GB/s, ~1 PFLOPS. */
const SPARK: NodeCapability = {
  memoryGb: 128,
  memoryBandwidthGbs: 273,
  computeTflops: 1000,
}

/**
 * Ten sam sprzęt, ale liczba mocy obliczeniowej **dla precyzji, w której
 * faktycznie liczy detektor wizyjny**.
 *
 * Pierwsza wersja tych testów podstawiała tu nagłówkowy petaflop z FP4
 * i wychodziło, że wąskim gardłem detektora jest przepustowość pamięci.
 * To nieprawda i jest to dokładnie ta pomyłka, przed którą cała ta funkcja
 * ma chronić: modele wizyjne nie liczą w FP4, więc podstawianie liczby
 * marketingowej zmienia werdykt o wąskim gardle na przeciwny.
 *
 * Wartość niżej jest założeniem rzędu wielkości, nie danymi z pomiaru -
 * i tak ma być podpisana, dopóki nikt tego nie zmierzy na sprzęcie.
 */
const SPARK_FP16: NodeCapability = {
  memoryGb: 128,
  memoryBandwidthGbs: 273,
  computeTflops: 125,
}

describe('estimateDecode', () => {
  it('model gęsty 70B w FP8 mieści się, ale jest wolny', () => {
    const wynik = estimateDecode(SPARK, { activeParamsB: 70, totalParamsB: 70, bytesPerParam: 1 })
    expect(wynik.fits).toBe(true)
    expect(wynik.bound).toBe('memory_bandwidth')
    // 273 * 0,45 / 70 GB ≈ 1,8 tok/s. „Mieści się" nie znaczy „nadaje się".
    expect(wynik.estimatedRate).toBeLessThan(3)
  })

  it('MIESZANKA EKSPERTÓW: liczą się parametry aktywne, nie wszystkie', () => {
    /*
     * Model 120B z 5B aktywnymi na token czyta z pamięci dwudziestokrotnie
     * mniej niż gęsty 120B. Rachunek na parametrach łącznych dałby tu ~4 tok/s
     * i kazałby odrzucić rozwiązanie, które w praktyce działa.
     */
    const gesty = estimateDecode(SPARK, { activeParamsB: 120, totalParamsB: 120, bytesPerParam: 0.5 })
    const moe = estimateDecode(SPARK, { activeParamsB: 5.1, totalParamsB: 120, bytesPerParam: 0.5 })

    expect(gesty.requiredMemoryGb).toBe(moe.requiredMemoryGb)
    expect(moe.estimatedRate! / gesty.estimatedRate!).toBeGreaterThan(20)
  })

  it('rząd wielkości zgadza się z pomiarami publicznymi', () => {
    // Dla 120B MoE w FP4 pomiary dają ~39 tok/s. Nasz szacunek ma trafić
    // w ten rząd, nie w dziesiątą część ani w dziesięciokrotność.
    const wynik = estimateDecode(SPARK, { activeParamsB: 5.1, totalParamsB: 120, bytesPerParam: 0.5 })
    expect(wynik.estimatedRate).toBeGreaterThan(20)
    expect(wynik.estimatedRate).toBeLessThan(80)
  })

  it('brak miejsca jest granicą twardą, nie kwestią wydajności', () => {
    const wynik = estimateDecode(SPARK, { activeParamsB: 400, totalParamsB: 400, bytesPerParam: 1 })
    expect(wynik.fits).toBe(false)
    expect(wynik.bound).toBe('capacity')
    expect(wynik.estimatedRate).toBeNull()
    expect(wynik.reason).toMatch(/granica twarda/)
  })

  it('narzut poza wagami wchodzi do rachunku miejsca', () => {
    const bez = estimateDecode(SPARK, { activeParamsB: 60, totalParamsB: 120, bytesPerParam: 1 })
    const z = estimateDecode(SPARK, { activeParamsB: 60, totalParamsB: 120, bytesPerParam: 1, overheadGb: 20 })
    expect(bez.fits).toBe(true)
    expect(z.fits).toBe(false)
  })

  it('sprawność 100% wolno podać, ale trzeba to zrobić świadomie', () => {
    const domyslna = estimateDecode(SPARK, { activeParamsB: 7, totalParamsB: 7, bytesPerParam: 1 })
    const idealna = estimateDecode(
      { ...SPARK, bandwidthEfficiency: 1 },
      { activeParamsB: 7, totalParamsB: 7, bytesPerParam: 1 },
    )
    expect(idealna.estimatedRate!).toBeGreaterThan(domyslna.estimatedRate!)
  })

  it('moc obliczeniowa NIE zmienia wyniku dla dekodowania', () => {
    // To jest sedno: dziesięciokrotnie mocniejszy układ o tej samej pamięci
    // dekoduje tak samo wolno. Petaflop w arkuszu danych nie pomaga.
    const slabszy = estimateDecode({ ...SPARK, computeTflops: 100 }, { activeParamsB: 7, totalParamsB: 7, bytesPerParam: 1 })
    const mocniejszy = estimateDecode({ ...SPARK, computeTflops: 10_000 }, { activeParamsB: 7, totalParamsB: 7, bytesPerParam: 1 })
    expect(slabszy.estimatedRate).toBe(mocniejszy.estimatedRate)
  })
})

describe('estimateVision', () => {
  const detektor = { weightsMb: 120, gflopsPerFrame: 60, streams: 4, targetFps: 30 }

  it('PODSTAWIENIE LICZBY Z INNEJ PRECYZJI ODWRACA WERDYKT', () => {
    // Ten sam detektor, ta sama pamięć - różni się wyłącznie liczba TFLOPS.
    // Przy nagłówkowym FP4 funkcja mówi „ograniczeniem jest pamięć",
    // przy realistycznym FP16 - „ograniczeniem jest moc". Obie odpowiedzi
    // są poprawne dla swoich wejść, więc wejście musi być poprawne.
    expect(estimateVision(SPARK, detektor).bound).toBe('memory_bandwidth')
    expect(estimateVision(SPARK_FP16, detektor).bound).toBe('compute')
  })

  it('WĄSKIE GARDŁO SIĘ ODWRACA: przy małym detektorze liczy się moc, nie pamięć', () => {
    const wynik = estimateVision(SPARK_FP16, detektor)
    expect(wynik.bound).toBe('compute')
  })

  it('cztery strumienie po 30 kl./s mieszczą się na tym węźle', () => {
    const wynik = estimateVision(SPARK_FP16, detektor)
    expect(wynik.fits).toBe(true)
    expect(wynik.estimatedRate).toBeGreaterThanOrEqual(30)
  })

  it('odmawia, gdy strumieni jest za dużo - i mówi, co zmniejszyć', () => {
    const wynik = estimateVision(SPARK_FP16, { ...detektor, streams: 400 })
    expect(wynik.fits).toBe(false)
    expect(wynik.reason).toMatch(/zmniejsz liczbę strumieni/)
  })

  it('cięższy model na klatkę obniża wydajność liniowo', () => {
    const lekki = estimateVision(SPARK_FP16, detektor)
    const ciezki = estimateVision(SPARK_FP16, { ...detektor, gflopsPerFrame: 600 })
    expect(lekki.estimatedRate! / ciezki.estimatedRate!).toBeCloseTo(10, 0)
  })
})

describe('role węzła', () => {
  it('dopuszcza trening i ewaluację', () => {
    expect(checkNodeRoles(['training', 'evaluation']).allowed).toBe(true)
  })

  it('ODMAWIA roli funkcji bezpieczeństwa - na żadnym węźle obliczeniowym', () => {
    // Kuszenie jest realne i przewidywalne: jak już stoi mocna maszyna,
    // wszystko chce na niej wylądować, łącznie z zatrzymaniem awaryjnym.
    for (const rola of FORBIDDEN_NODE_ROLES) {
      const wynik = checkNodeRoles(['training', rola])
      expect(wynik.allowed).toBe(false)
      expect(wynik.reason).toMatch(/deterministyczne i niezależne/)
    }
  })

  it('odmawia ról spoza słownika, zamiast je milcząco przyjąć', () => {
    expect(checkNodeRoles(['training', 'wszystko_inne']).allowed).toBe(false)
  })

  it('wielkość liter nie omija zakazu', () => {
    expect(checkNodeRoles(['Safety_Function']).allowed).toBe(false)
  })
})
