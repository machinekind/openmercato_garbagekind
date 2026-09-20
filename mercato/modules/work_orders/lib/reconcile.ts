/**
 * Uzgodnienie deklaracji robota z wagą.
 *
 * Czysta funkcja i cały rdzeń tego modułu. Robot liczy sukcesy we własnym
 * dzienniku; waga liczy materiał. Te dwie liczby rozjeżdżają się w sposób
 * **niesymetryczny** i ta niesymetria jest tu najważniejsza.
 */

export type ReconcileInput = {
  /** Epizody zakończone powodzeniem w oknie partii - zdanie robota o sobie. */
  claimedPieces: number
  /** Masa nominalna sztuki w gramach; `null` znaczy „nie mamy odniesienia". */
  nominalPieceGrams: number | null | undefined
  /** Masa z wagi, w gramach. */
  weighedGrams: number
  /** Dopuszczalny względny rozjazd. 0.1 znaczy ±10%. */
  toleranceRatio?: number
}

/**
 * - `ok` - rozjazd mieści się w tolerancji.
 * - `overclaim` - waga pokazała **mniej**, niż wynika z deklaracji. Robot
 *   policzył jako sukces coś, czego nie przyniósł: upuszczone sztuki,
 *   chwyt powietrza zaliczony przez czujnik, sztuka wypchnięta z pojemnika.
 * - `underclaim` - waga pokazała **więcej**. Materiał w pojemniku nie pochodzi
 *   w całości z policzonych chwytów albo masa nominalna jest zła.
 * - `no_reference` - brak masy nominalnej, uzgodnienia nie da się policzyć.
 */
export type ReconcileVerdict = 'ok' | 'overclaim' | 'underclaim' | 'no_reference'

export type ReconcileResult = {
  verdict: ReconcileVerdict
  expectedGrams: number | null
  driftGrams: number | null
  driftRatio: number | null
  toleranceRatio: number
  reason: string
  /**
   * Czy werdykt wymaga spojrzenia człowieka **na robota**.
   *
   * Uwaga na to, czego ta flaga NIE znaczy: nie wstrzymuje materiału.
   * Pojemnik stoi na wadze, materiał fizycznie istnieje i wchodzi do zapasu
   * niezależnie od werdyktu - odmowa przyjęcia czegoś, co się fizycznie ma,
   * byłaby zapisaniem nieprawdy w magazynie. Flaga dotyczy maszyny: coś
   * z chwytaniem albo z czujnikiem jest nie tak i trzeba to zobaczyć teraz,
   * a nie w raporcie miesięcznym.
   */
  requiresReview: boolean
}

export const DEFAULT_TOLERANCE_RATIO = 0.1

function formatKg(grams: number): string {
  return (grams / 1000).toFixed(2)
}

export function reconcile(input: ReconcileInput): ReconcileResult {
  const toleranceRatio = input.toleranceRatio ?? DEFAULT_TOLERANCE_RATIO

  if (!input.nominalPieceGrams || input.nominalPieceGrams <= 0) {
    /*
     * Brak masy nominalnej nie jest błędem - dla wielu frakcji nikt jej nie
     * zmierzył. Jest natomiast brakiem odniesienia i ma być tak nazwany,
     * zamiast podstawiać średnią z innej frakcji i produkować werdykt,
     * który wygląda jak pomiar, a jest zgadywaniem.
     */
    return {
      verdict: 'no_reference',
      expectedGrams: null,
      driftGrams: null,
      driftRatio: null,
      toleranceRatio,
      reason: 'Brak masy nominalnej sztuki - uzgodnienia nie da się policzyć.',
      requiresReview: false,
    }
  }

  const expectedGrams = input.claimedPieces * input.nominalPieceGrams
  const driftGrams = input.weighedGrams - expectedGrams

  if (expectedGrams === 0) {
    // Zero zgłoszonych sztuk przy niezerowej masie: materiał w pojemniku
    // nie pochodzi z pracy, którą ktokolwiek policzył.
    return {
      verdict: input.weighedGrams === 0 ? 'ok' : 'underclaim',
      expectedGrams: 0,
      driftGrams,
      driftRatio: null,
      toleranceRatio,
      reason:
        input.weighedGrams === 0
          ? 'Pusty pojemnik przy zerowej deklaracji.'
          : `Pojemnik waży ${formatKg(input.weighedGrams)} kg przy zerowej liczbie zgłoszonych chwytów.`,
      requiresReview: input.weighedGrams !== 0,
    }
  }

  const driftRatio = driftGrams / expectedGrams

  if (Math.abs(driftRatio) <= toleranceRatio) {
    return {
      verdict: 'ok',
      expectedGrams,
      driftGrams,
      driftRatio,
      toleranceRatio,
      reason: `Rozjazd ${(driftRatio * 100).toFixed(1)}% mieści się w tolerancji ±${(toleranceRatio * 100).toFixed(0)}%.`,
      requiresReview: false,
    }
  }

  if (driftGrams < 0) {
    /**
     * Kierunek groźny.
     *
     * Robot zgłosił więcej, niż przyniósł. W jego własnej telemetrii wygląda
     * to identycznie jak praca udana - bo z jego punktu widzenia była udana.
     * Jedyne miejsce, w którym ta różnica się ujawnia, to waga. Dlatego ten
     * werdykt domyślnie wymaga spojrzenia człowieka, zanim masa wejdzie
     * do zapasu: albo robot gubi materiał, albo czujnik chwytu kłamie,
     * a obie rzeczy trzeba zobaczyć od razu. Materiału to nie wstrzymuje:
     * on leży w pojemniku i wchodzi do zapasu tak czy inaczej.
     */
    return {
      verdict: 'overclaim',
      expectedGrams,
      driftGrams,
      driftRatio,
      toleranceRatio,
      reason:
        `Waga pokazała ${formatKg(input.weighedGrams)} kg przy deklarowanych ` +
        `${formatKg(expectedGrams)} kg - brakuje ${formatKg(-driftGrams)} kg ` +
        `(${(driftRatio * 100).toFixed(1)}%). Robot policzył jako sukces materiał, którego nie przyniósł.`,
      requiresReview: true,
    }
  }

  return {
    verdict: 'underclaim',
    expectedGrams,
    driftGrams,
    driftRatio,
    toleranceRatio,
    reason:
      `Waga pokazała ${formatKg(input.weighedGrams)} kg przy deklarowanych ` +
      `${formatKg(expectedGrams)} kg - nadwyżka ${formatKg(driftGrams)} kg ` +
      `(${(driftRatio * 100).toFixed(1)}%). Materiał nie pochodzi w całości z policzonych chwytów ` +
      'albo masa nominalna sztuki jest zawyżona.',
    requiresReview: false,
  }
}

/**
 * Zbiorczy rozjazd dla wielu partii - po to, żeby dało się powiedzieć
 * „ta wersja polityki gubi tyle a tyle", a nie tylko „ten pojemnik się nie zgadza".
 *
 * Sumujemy gramy, a nie uśredniamy procenty: średnia z procentów daje temu
 * samemu wagę pojemnikowi dwutonowemu i pięciokilogramowemu.
 */
export function aggregateDrift(
  results: Array<Pick<ReconcileResult, 'expectedGrams' | 'driftGrams' | 'verdict'>>,
): { expectedGrams: number; driftGrams: number; driftRatio: number | null; counted: number; skipped: number } {
  let expectedGrams = 0
  let driftGrams = 0
  let counted = 0
  let skipped = 0

  for (const result of results) {
    if (result.verdict === 'no_reference' || result.expectedGrams === null || result.driftGrams === null) {
      skipped += 1
      continue
    }
    expectedGrams += result.expectedGrams
    driftGrams += result.driftGrams
    counted += 1
  }

  return {
    expectedGrams,
    driftGrams,
    driftRatio: expectedGrams > 0 ? driftGrams / expectedGrams : null,
    counted,
    skipped,
  }
}
