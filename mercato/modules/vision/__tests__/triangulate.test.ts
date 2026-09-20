import { contamination, triangulate } from '../lib/triangulate'

/**
 * Triangulacja trzech świadków.
 *
 * Dwóch świadków mówi, ŻE coś się nie zgadza. Trzech zaczyna mówić, GDZIE.
 * Te testy pilnują przede wszystkim jednej rzeczy: że trzeci świadek umie
 * być podejrzanym. Implementacja, która zawsze obwinia robota, przechodzi
 * połowę z nich - i dlatego połowa tu jest.
 */

const PET = 30
const base = { nominalPieceGrams: PET, toleranceRatio: 0.1 }

describe('triangulate', () => {
  it('trzy zgodne pomiary to brak podejrzanego', () => {
    const wynik = triangulate({ ...base, depositedCount: 1000, claimedCount: 1000, weighedGrams: 30_000 })
    expect(wynik.suspect).toBe('none')
    expect(wynik.massImpliedCount).toBe(1000)
    expect(wynik.cannotDistinguish).toHaveLength(0)
  })

  it('wizja i robot zgodni, masa odstaje → winna masa nominalna, nie robot', () => {
    // 1000 sztuk naprawdę wpadło do pojemnika, ale ważą 24 kg zamiast 30.
    // Materiał jest lżejszy, niż zakładano - zgnieciony, inny wsad.
    const wynik = triangulate({ ...base, depositedCount: 1000, claimedCount: 1000, weighedGrams: 24_000 })
    expect(wynik.suspect).toBe('nominal_mass')
    expect(wynik.reason).toMatch(/nie jest usterka robota/)
  })

  it('wizja i masa zgodne, robot zawyża → materiał ginie między chwytem a pojemnikiem', () => {
    const wynik = triangulate({ ...base, depositedCount: 800, claimedCount: 1000, weighedGrams: 24_000 })
    expect(wynik.suspect).toBe('grip_to_bin')
  })

  it('GRANICA METODY jest wypisana, a nie przemilczana', () => {
    // Chwyt powietrza i sztuka upuszczona w drodze dają te same trzy liczby.
    const wynik = triangulate({ ...base, depositedCount: 800, claimedCount: 1000, weighedGrams: 24_000 })
    expect(wynik.cannotDistinguish.join(' ')).toMatch(/kamera na nadgarstku/)
  })

  it('TRZECI ŚWIADEK UMIE BYĆ PODEJRZANYM: robot i masa zgodni, wizja nie widzi', () => {
    // Materiał jest w pojemniku - potwierdza go waga. To kamera go nie widzi.
    // Implementacja obwiniająca zawsze robota oblałaby ten test.
    const wynik = triangulate({ ...base, depositedCount: 800, claimedCount: 1000, weighedGrams: 30_000 })
    expect(wynik.suspect).toBe('vision')
    expect(wynik.reason).toMatch(/to kamera go nie widzi/)
  })

  it('wizja widzi więcej, niż trafiło z pracy robota → obcy materiał albo podwójne liczenie', () => {
    const wynik = triangulate({ ...base, depositedCount: 1300, claimedCount: 1000, weighedGrams: 30_000 })
    expect(wynik.suspect).toBe('foreign_material')
  })

  it('robot zaniża zgłoszenia - materiał jest, brakuje meldunków', () => {
    const wynik = triangulate({ ...base, depositedCount: 1000, claimedCount: 700, weighedGrams: 30_000 })
    expect(wynik.suspect).toBe('under_reporting')
  })

  it('trzy pomiary rozjechane parami → co najmniej dwie usterki, brak punktu odniesienia', () => {
    const wynik = triangulate({ ...base, depositedCount: 600, claimedCount: 1000, weighedGrams: 45_000 })
    expect(wynik.suspect).toBe('inconclusive')
    expect(wynik.reason).toMatch(/co najmniej dwie/)
  })

  it('bez kamery zostaje dwóch świadków i uczciwe „nie wiadomo co"', () => {
    const zgodne = triangulate({ ...base, depositedCount: null, claimedCount: 1000, weighedGrams: 30_000 })
    expect(zgodne.suspect).toBe('none')

    const rozjazd = triangulate({ ...base, depositedCount: null, claimedCount: 1000, weighedGrams: 24_000 })
    expect(rozjazd.suspect).toBe('inconclusive')
    expect(rozjazd.cannotDistinguish.length).toBeGreaterThan(0)
  })

  it('bez masy nominalnej nie ma trzeciego pomiaru i nie udajemy, że jest', () => {
    const wynik = triangulate({
      depositedCount: 1000,
      claimedCount: 1000,
      weighedGrams: 30_000,
      nominalPieceGrams: null,
    })
    expect(wynik.suspect).toBe('no_reference')
    expect(wynik.massImpliedCount).toBeNull()
  })

  it('tolerancja da się zacieśnić i wtedy ten sam zestaw liczb daje inny werdykt', () => {
    const liczby = { depositedCount: 1000, claimedCount: 1050, weighedGrams: 31_500, nominalPieceGrams: PET }
    expect(triangulate({ ...liczby, toleranceRatio: 0.1 }).suspect).toBe('none')
    expect(triangulate({ ...liczby, toleranceRatio: 0.01 }).suspect).not.toBe('none')
  })

  it('pusty pojemnik przy zerowej pracy nie jest usterką', () => {
    const wynik = triangulate({ ...base, depositedCount: 0, claimedCount: 0, weighedGrams: 0 })
    expect(wynik.suspect).toBe('none')
  })
})

describe('contamination', () => {
  it('liczy udział obcych klas w pojemniku', () => {
    const wynik = contamination({ pet: 960, pvc: 40 }, 'pet')
    expect(wynik.total).toBe(1000)
    expect(wynik.foreign).toBe(40)
    expect(wynik.ratio).toBeCloseTo(0.04, 4)
    expect(wynik.byClass).toEqual({ pvc: 40 })
  })

  it('LUDZIE NIE SĄ MATERIAŁEM i nie wchodzą do rachunku składu', () => {
    // Obecność człowieka w kadrze jest sygnałem bezpieczeństwa. Wliczenie go
    // do zanieczyszczenia frakcji byłoby jednocześnie bzdurą i nadużyciem.
    const wynik = contamination({ pet: 960, pvc: 40, person: 2 }, 'pet')
    expect(wynik.total).toBe(1000)
    expect(wynik.byClass).not.toHaveProperty('person')
  })

  it('czysta frakcja daje zero, nie null', () => {
    expect(contamination({ pet: 500 }, 'pet').ratio).toBe(0)
  })

  it('pusty pojemnik daje null, a nie zero procent', () => {
    // Zero procent zanieczyszczenia to twierdzenie o materiale.
    // Pusty pojemnik nie uprawnia do takiego twierdzenia.
    expect(contamination({}, 'pet').ratio).toBeNull()
  })
})
