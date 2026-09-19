import { packTiles } from '../lib/pack'
import { TILE } from '../lib/tokens'

/**
 * Upakowanie kafelków w celi.
 *
 * Testy istnieją, bo ta arytmetyka siedziała wcześniej w JSX i przez to
 * nikt jej nie sprawdził — a mieściła dwie maszyny z pięciu w celi mającej
 * miejsce na wszystkie.
 */

describe('packTiles', () => {
  it('korzysta z szerokości: szeroka cela daje dwie kolumny', () => {
    const wynik = packTiles({ innerWidth: 268, innerHeight: 146, count: 5 })
    expect(wynik.columns).toBe(2)
    expect(wynik.capacity).toBeGreaterThanOrEqual(5)
    expect(wynik.positions).toHaveLength(5)
  })

  it('wąska cela spada do jednej kolumny', () => {
    const wynik = packTiles({ innerWidth: 90, innerHeight: 200, count: 3 })
    expect(wynik.columns).toBe(1)
  })

  it('CELA WĘŻSZA NIŻ CZYTELNY KAFELEK ZGŁASZA TO, zamiast po cichu ścinać', () => {
    /*
     * Nie ściskamy kafelka poniżej obrysu celi — wystawałby poza celę,
     * do której należy. Nie udajemy też, że wszystko jest w porządku:
     * przy tym obmiarze opis stanu będzie ucięty i ma to być widać.
     */
    const ciasna = packTiles({ innerWidth: 90, innerHeight: 200, count: 3 })
    expect(ciasna.constrained).toBe(true)
    expect(ciasna.tileWidth).toBeLessThanOrEqual(90)

    const swobodna = packTiles({ innerWidth: 268, innerHeight: 200, count: 3 })
    expect(swobodna.constrained).toBe(false)
    expect(swobodna.tileWidth).toBeGreaterThanOrEqual(TILE.minWidth)
  })

  it('NIE ROBI WIĘCEJ NIŻ TRZECH KOLUMN — kafelek węższy niż numer seryjny jest bezużyteczny', () => {
    const wynik = packTiles({ innerWidth: 2000, innerHeight: 200, count: 20 })
    expect(wynik.columns).toBe(3)
  })

  it('zwraca pojemność mniejszą niż liczba maszyn, gdy naprawdę się nie mieszczą', () => {
    // Wtedy komponent ma czym uzasadnić kafelek zbiorczy — zamiast po cichu
    // uciąć listę.
    const wynik = packTiles({ innerWidth: 120, innerHeight: 40, count: 9 })
    expect(wynik.capacity).toBeLessThan(9)
    expect(wynik.positions).toHaveLength(wynik.capacity)
  })

  it('zerowa wysokość daje zero miejsc, a nie ujemne', () => {
    const wynik = packTiles({ innerWidth: 200, innerHeight: 0, count: 4 })
    expect(wynik.rows).toBe(0)
    expect(wynik.capacity).toBe(0)
    expect(wynik.positions).toHaveLength(0)
  })

  it('kafelki nie nachodzą na siebie', () => {
    const wynik = packTiles({ innerWidth: 268, innerHeight: 200, count: 6 })
    const klucze = new Set(wynik.positions.map((p) => `${p.x}:${p.y}`))
    expect(klucze.size).toBe(wynik.positions.length)
  })

  it('kolejne kolumny odsunięte o szerokość kafelka i odstęp', () => {
    const wynik = packTiles({ innerWidth: 268, innerHeight: 200, count: 2 })
    expect(wynik.positions[1].x - wynik.positions[0].x).toBeCloseTo(wynik.tileWidth + TILE.gap, 5)
  })
})
