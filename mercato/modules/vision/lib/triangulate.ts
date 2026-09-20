/**
 * Trzej świadkowie jednej pracy.
 *
 * Do tej pory system miał dwóch: **deklarację robota** (czujnik chwytu) i
 * **wagę** (masa w pojemniku). Dwóch świadków wystarcza, żeby stwierdzić, że
 * coś się nie zgadza. Nie wystarcza, żeby powiedzieć **co**.
 *
 * Kamera nad pojemnikiem jest trzecim, niezależnym pomiarem - i dopiero
 * trzy pomiary zaczynają lokalizować usterkę zamiast ją sygnalizować:
 *
 * | wizja | robot | masa | wniosek |
 * | --- | --- | --- | --- |
 * | 1000 | 1000 | 1000 | zgodne |
 * | 1000 | 1000 |  800 | obiekty lżejsze niż nominał - nie wina robota |
 * |  800 | 1000 |  800 | robot melduje chwyty, które nie doleciały do pojemnika |
 * | 1000 | 1000 |  ... | (wizja zgodna) |
 * |  800 | 1000 | 1000 | **wizja** nie widzi części materiału, a nie robot go gubi |
 *
 * Ostatni wiersz jest powodem, dla którego ta funkcja w ogóle istnieje
 * w tej postaci. Naiwna wersja zawsze obwinia robota. Trzeci świadek musi
 * umieć być podejrzanym, inaczej dokłada pewności zamiast informacji.
 */

export type Witnesses = {
  /** Obiekty, które kamera zobaczyła w pojemniku. */
  depositedCount: number | null | undefined
  /** Chwyty zgłoszone przez robota jako udane. */
  claimedCount: number
  /** Masa z wagi, w gramach. */
  weighedGrams: number
  /** Masa nominalna sztuki, w gramach. */
  nominalPieceGrams: number | null | undefined
  /** Dopuszczalny względny rozjazd przy porównaniach parami. */
  toleranceRatio?: number
}

export type Suspect =
  | 'none'
  | 'nominal_mass'
  | 'grip_to_bin'
  | 'under_reporting'
  | 'vision'
  | 'foreign_material'
  | 'inconclusive'
  | 'no_reference'

export type Triangulation = {
  suspect: Suspect
  /** Liczba sztuk wynikająca z masy; `null` bez masy nominalnej. */
  massImpliedCount: number | null
  agreements: { claimedVsDeposited: boolean | null; depositedVsMass: boolean | null; claimedVsMass: boolean | null }
  reason: string
  /** Czego ta trójka **nie** rozstrzyga - wypisane wprost, nie przemilczane. */
  cannotDistinguish: string[]
}

export const DEFAULT_TOLERANCE_RATIO = 0.1

/** Zgodność dwóch zliczeń w granicach tolerancji, licząc względem większego. */
function agree(a: number, b: number, tolerance: number): boolean {
  const odniesienie = Math.max(Math.abs(a), Math.abs(b))
  if (odniesienie === 0) return true
  return Math.abs(a - b) / odniesienie <= tolerance
}

export function triangulate(input: Witnesses): Triangulation {
  const tolerance = input.toleranceRatio ?? DEFAULT_TOLERANCE_RATIO
  const deposited = input.depositedCount ?? null

  if (!input.nominalPieceGrams || input.nominalPieceGrams <= 0) {
    return {
      suspect: 'no_reference',
      massImpliedCount: null,
      agreements: {
        claimedVsDeposited: deposited === null ? null : agree(input.claimedCount, deposited, tolerance),
        depositedVsMass: null,
        claimedVsMass: null,
      },
      reason: 'Brak masy nominalnej sztuki - masy nie da się przeliczyć na liczbę obiektów.',
      cannotDistinguish: ['wszystko, co wymaga trzeciego pomiaru'],
    }
  }

  const massImpliedCount = Math.round(input.weighedGrams / input.nominalPieceGrams)

  if (deposited === null) {
    /*
     * Dwóch świadków zamiast trzech. To nie jest błąd - kamera nad pojemnikiem
     * bywa niepotrzebna albo zepsuta - ale wynik trzeba nazwać uczciwie:
     * wiadomo, że coś się nie zgadza, nie wiadomo co.
     */
    const zgodne = agree(input.claimedCount, massImpliedCount, tolerance)
    return {
      suspect: zgodne ? 'none' : 'inconclusive',
      massImpliedCount,
      agreements: { claimedVsDeposited: null, depositedVsMass: null, claimedVsMass: zgodne },
      reason: zgodne
        ? 'Deklaracja robota zgodna z masą. Bez kamery nad pojemnikiem to wszystko, co da się stwierdzić.'
        : `Deklaracja ${input.claimedCount} nie zgadza się z masą (${massImpliedCount} szt.), ` +
          'a bez trzeciego świadka nie da się wskazać, po której stronie leży błąd.',
      cannotDistinguish: [
        'błąd czujnika chwytu od błędnej masy nominalnej',
        'materiał zgubiony w drodze od materiału lżejszego, niż zakładano',
      ],
    }
  }

  const claimedVsDeposited = agree(input.claimedCount, deposited, tolerance)
  const depositedVsMass = agree(deposited, massImpliedCount, tolerance)
  const claimedVsMass = agree(input.claimedCount, massImpliedCount, tolerance)
  const agreements = { claimedVsDeposited, depositedVsMass, claimedVsMass }

  if (claimedVsDeposited && depositedVsMass && claimedVsMass) {
    return {
      suspect: 'none',
      massImpliedCount,
      agreements,
      reason: `Trzy pomiary zgodne: wizja ${deposited}, robot ${input.claimedCount}, masa ${massImpliedCount} szt.`,
      cannotDistinguish: [],
    }
  }

  // Robot i wizja zgodni, masa odstaje → materiał waży co innego, niż zakładano.
  if (claimedVsDeposited && !depositedVsMass) {
    return {
      suspect: 'nominal_mass',
      massImpliedCount,
      agreements,
      reason:
        `Wizja (${deposited}) i robot (${input.claimedCount}) zgodni, masa wskazuje ${massImpliedCount} szt. ` +
        'Obiekty ważą co innego niż nominał - zgniecione, mokre albo masa nominalna jest zła. To nie jest usterka robota.',
      cannotDistinguish: ['złą masę nominalną od materiału o innej gęstości niż zwykle'],
    }
  }

  // Wizja i masa zgodne, robot odstaje → robot melduje co innego, niż dotarło.
  if (depositedVsMass && !claimedVsDeposited) {
    if (input.claimedCount > deposited) {
      return {
        suspect: 'grip_to_bin',
        massImpliedCount,
        agreements,
        reason:
          `Robot zgłosił ${input.claimedCount} chwytów, a do pojemnika dotarło ${deposited} ` +
          `(masa potwierdza: ${massImpliedCount}). Materiał ginie między chwytem a pojemnikiem.`,
        /*
         * Granica tej metody, powiedziana wprost. Chwyt powietrza zaliczony
         * przez czujnik i sztuka upuszczona w drodze dają **ten sam** zestaw
         * trzech liczb. Rozróżnia je dopiero kamera na nadgarstku.
         */
        cannotDistinguish: [
          'chwyt powietrza zaliczony przez czujnik od sztuki upuszczonej w drodze - potrzebna kamera na nadgarstku',
        ],
      }
    }
    return {
      suspect: 'under_reporting',
      massImpliedCount,
      agreements,
      reason:
        `Do pojemnika dotarło ${deposited} (masa potwierdza: ${massImpliedCount}), a robot zgłosił tylko ` +
        `${input.claimedCount}. Materiał jest - brakuje zgłoszeń.`,
      cannotDistinguish: ['zaniżanie przez czujnik od pracy wykonanej poza zgłoszonymi epizodami'],
    }
  }

  // Robot i masa zgodne, wizja odstaje → podejrzanym jest trzeci świadek.
  if (claimedVsMass && !claimedVsDeposited) {
    if (deposited < input.claimedCount) {
      return {
        suspect: 'vision',
        massImpliedCount,
        agreements,
        reason:
          `Robot (${input.claimedCount}) i masa (${massImpliedCount}) zgodni, wizja naliczyła ${deposited}. ` +
          'Materiał jest w pojemniku - to kamera go nie widzi: przesłonięcie, kadr albo próg ufności.',
        cannotDistinguish: ['przesłonięcie w kadrze od zbyt wysokiego progu ufności detektora'],
      }
    }
    return {
      suspect: 'foreign_material',
      massImpliedCount,
      agreements,
      reason:
        `Wizja naliczyła ${deposited} przy zgodnych robocie (${input.claimedCount}) i masie (${massImpliedCount}). ` +
        'Kamera widzi w pojemniku więcej obiektów, niż tam trafiło z pracy robota - materiał z innego źródła ' +
        'albo detektor liczy tę samą sztukę wielokrotnie.',
      cannotDistinguish: ['materiał z innego źródła od podwójnego liczenia przez detektor'],
    }
  }

  return {
    suspect: 'inconclusive',
    massImpliedCount,
    agreements,
    reason:
      `Trzy pomiary rozjechane parami: wizja ${deposited}, robot ${input.claimedCount}, masa ${massImpliedCount}. ` +
      'Żadna para się nie zgadza, więc nie ma punktu odniesienia - usterek jest co najmniej dwie.',
    cannotDistinguish: ['cokolwiek - przy dwóch niezależnych usterkach trójka świadków nie wystarcza'],
  }
}

/**
 * Udział obcych klas w pojemniku - zanieczyszczenie frakcji.
 *
 * To jest ta liczba, dla której w sortowni w ogóle stawia się kamerę nad
 * pojemnikiem. Nie „ile sztuk", tylko „ile procent tego, co odbiorca dostanie,
 * jest nie tym, za co płaci". Odbiorca frakcji PET z czterema procentami PCW
 * odeśle transport, a spór będzie o to, czy zanieczyszczenie powstało u nas.
 */
export function contamination(
  counts: Record<string, number>,
  expectedClass: string,
): { total: number; expected: number; foreign: number; ratio: number | null; byClass: Record<string, number> } {
  const byClass: Record<string, number> = {}
  let total = 0
  let expected = 0

  for (const [klasa, liczba] of Object.entries(counts ?? {})) {
    // Ludzie nie są materiałem i nie wchodzą do rachunku składu. Obecność
    // człowieka w kadrze jest sygnałem bezpieczeństwa, nie zanieczyszczeniem.
    if (klasa === 'person') continue
    const wartosc = Number(liczba) || 0
    total += wartosc
    if (klasa === expectedClass) expected += wartosc
    else byClass[klasa] = wartosc
  }

  const foreign = total - expected
  return { total, expected, foreign, ratio: total > 0 ? foreign / total : null, byClass }
}
