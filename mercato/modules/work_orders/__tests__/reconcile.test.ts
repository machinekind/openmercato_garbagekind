import { aggregateDrift, DEFAULT_TOLERANCE_RATIO, reconcile } from '../lib/reconcile'

/**
 * Uzgodnienie deklaracji robota z wagą.
 *
 * To jest jedyne miejsce w całym projekcie, w którym zdanie robota o własnej
 * pracy jest konfrontowane z czymś spoza robota. Testy pilnują przede wszystkim
 * **niesymetryczności**: brak materiału i nadmiar materiału to dwa różne
 * zjawiska i nie wolno im wyglądać tak samo.
 */

const PET = 30 // gramów na butelkę

describe('reconcile', () => {
  it('zgodność w granicach tolerancji jest po prostu zgodnością', () => {
    const result = reconcile({ claimedPieces: 1000, nominalPieceGrams: PET, weighedGrams: 29_000 })
    expect(result.verdict).toBe('ok')
    expect(result.driftGrams).toBe(-1000)
    expect(result.requiresReview).toBe(false)
  })

  it('granica tolerancji jest domknięta', () => {
    // Dokładnie −10% przy domyślnej tolerancji 10%.
    const naGranicy = reconcile({ claimedPieces: 1000, nominalPieceGrams: PET, weighedGrams: 27_000 })
    expect(naGranicy.verdict).toBe('ok')
    const tuzZa = reconcile({ claimedPieces: 1000, nominalPieceGrams: PET, weighedGrams: 26_999 })
    expect(tuzZa.verdict).toBe('overclaim')
  })

  it('KIERUNEK GROŹNY: brak materiału to nadmiarowa deklaracja i wymaga człowieka', () => {
    // Robot zgłosił 1000 chwytów, przyniósł materiał na 800. W jego własnej
    // telemetrii te 200 sztuk wygląda identycznie jak praca udana.
    const result = reconcile({ claimedPieces: 1000, nominalPieceGrams: PET, weighedGrams: 24_000 })
    expect(result.verdict).toBe('overclaim')
    expect(result.driftGrams).toBe(-6000)
    expect(result.requiresReview).toBe(true)
    expect(result.reason).toMatch(/nie przyniósł/)
  })

  it('KIERUNEK ŁAGODNY: nadmiar materiału nie blokuje przyjęcia', () => {
    const result = reconcile({ claimedPieces: 1000, nominalPieceGrams: PET, weighedGrams: 40_000 })
    expect(result.verdict).toBe('underclaim')
    // Nadwyżka jest sygnałem o masie nominalnej albo o zanieczyszczeniu,
    // a nie o gubieniu materiału - nie ma powodu wstrzymywać przyjęcia.
    expect(result.requiresReview).toBe(false)
  })

  it('brak masy nominalnej daje jawny brak odniesienia, a nie zgadywanie', () => {
    const result = reconcile({ claimedPieces: 1000, nominalPieceGrams: null, weighedGrams: 30_000 })
    expect(result.verdict).toBe('no_reference')
    expect(result.expectedGrams).toBeNull()
    expect(result.driftRatio).toBeNull()
  })

  it('zerowa masa nominalna jest traktowana jak brak, nie jak zero', () => {
    expect(reconcile({ claimedPieces: 10, nominalPieceGrams: 0, weighedGrams: 100 }).verdict).toBe('no_reference')
  })

  it('materiał bez zgłoszonych chwytów jest sygnałem, nie dzieleniem przez zero', () => {
    const result = reconcile({ claimedPieces: 0, nominalPieceGrams: PET, weighedGrams: 5_000 })
    expect(result.verdict).toBe('underclaim')
    expect(result.driftRatio).toBeNull()
    expect(result.requiresReview).toBe(true)
  })

  it('pusty pojemnik przy zerowej deklaracji jest zgodny', () => {
    const result = reconcile({ claimedPieces: 0, nominalPieceGrams: PET, weighedGrams: 0 })
    expect(result.verdict).toBe('ok')
    expect(result.requiresReview).toBe(false)
  })

  it('tolerancja da się zacieśnić dla frakcji o powtarzalnej masie', () => {
    const luzna = reconcile({ claimedPieces: 100, nominalPieceGrams: 1000, weighedGrams: 95_000 })
    expect(luzna.verdict).toBe('ok')
    const scisla = reconcile({
      claimedPieces: 100,
      nominalPieceGrams: 1000,
      weighedGrams: 95_000,
      toleranceRatio: 0.02,
    })
    expect(scisla.verdict).toBe('overclaim')
  })

  it('domyślna tolerancja jest jawna i wynosi 10%', () => {
    expect(DEFAULT_TOLERANCE_RATIO).toBe(0.1)
    expect(reconcile({ claimedPieces: 1, nominalPieceGrams: 100, weighedGrams: 100 }).toleranceRatio).toBe(0.1)
  })
})

describe('aggregateDrift', () => {
  it('sumuje gramy, a nie uśrednia procenty', () => {
    /*
     * Dwie partie: wielka z małym rozjazdem i mała z wielkim. Średnia
     * z procentów dałaby ~25% i sugerowała katastrofę. Rachunek na gramach
     * pokazuje prawdę: −1,5% całego materiału.
     */
    const duza = reconcile({ claimedPieces: 10_000, nominalPieceGrams: 100, weighedGrams: 990_000 })
    const mala = reconcile({ claimedPieces: 10, nominalPieceGrams: 100, weighedGrams: 500 })
    const suma = aggregateDrift([duza, mala])

    expect(suma.counted).toBe(2)
    expect(suma.expectedGrams).toBe(1_001_000)
    expect(suma.driftGrams).toBe(-10_500)
    expect(suma.driftRatio).toBeCloseTo(-0.0105, 4)
  })

  it('partie bez odniesienia są pomijane i policzone osobno', () => {
    const zOdniesieniem = reconcile({ claimedPieces: 100, nominalPieceGrams: 50, weighedGrams: 5_000 })
    const bez = reconcile({ claimedPieces: 100, nominalPieceGrams: null, weighedGrams: 5_000 })
    const suma = aggregateDrift([zOdniesieniem, bez])

    // Pominięte muszą być widoczne, inaczej zbiorczy wskaźnik milcząco
    // dotyczyłby tylko części materiału.
    expect(suma.counted).toBe(1)
    expect(suma.skipped).toBe(1)
  })

  it('brak partii z odniesieniem daje null, a nie zero', () => {
    const bez = reconcile({ claimedPieces: 10, nominalPieceGrams: null, weighedGrams: 100 })
    expect(aggregateDrift([bez]).driftRatio).toBeNull()
  })
})
