import { arrangeInCell, boundsOf, fitTransform, isPlaced, splitPlaced, toPixels } from '../lib/layout'

/**
 * Geometria rzutu hali.
 *
 * Testy pilnują przede wszystkim jednej rzeczy: że **brak współrzędnych nie
 * zamienia się cicho w jakieś współrzędne**. Plan hali czyta się po to, żeby
 * wiedzieć, gdzie iść - zmyślona pozycja jest gorsza niż jej brak.
 */

const CELA = { x: 10, y: 5, width: 8, height: 6 }

describe('isPlaced', () => {
  it('komplet czterech liczb to rozmieszczenie', () => {
    expect(isPlaced(CELA)).toBe(true)
  })

  it('TRZY Z CZTERECH TO BRAK, nie „prawie"', () => {
    expect(isPlaced({ x: 10, y: 5, width: 8 })).toBe(false)
    expect(isPlaced({ x: 10, y: 5, height: 6 })).toBe(false)
    expect(isPlaced({ x: 10, width: 8, height: 6 })).toBe(false)
  })

  it('zerowy wymiar to brak rozmieszczenia, a nie cela o zerowej powierzchni', () => {
    expect(isPlaced({ ...CELA, width: 0 })).toBe(false)
  })

  it('null nie udaje zera', () => {
    expect(isPlaced({ x: null, y: null, width: null, height: null })).toBe(false)
  })
})

describe('splitPlaced', () => {
  it('rozdziela rozmieszczone od nierozmieszczonych, zamiast zgadywać', () => {
    const wynik = splitPlaced([CELA, { x: null, y: null }, { ...CELA, x: 30 }])
    expect(wynik.placed).toHaveLength(2)
    expect(wynik.unplaced).toHaveLength(1)
  })
})

describe('boundsOf', () => {
  it('obejmuje całą powierzchnię, nie same punkty zaczepienia', () => {
    const b = boundsOf([CELA, { x: 30, y: 2, width: 4, height: 20 }])!
    expect(b).toEqual({ minX: 10, minY: 2, maxX: 34, maxY: 22 })
  })

  it('pomija nierozmieszczone', () => {
    expect(boundsOf([CELA, { x: null, y: null }])).toEqual({ minX: 10, minY: 5, maxX: 18, maxY: 11 })
  })

  it('PUSTE WEJŚCIE DAJE null, nie zerowy prostokąt', () => {
    // Zerowy prostokąt przeszedłby dalej i dał dzielenie przez zero.
    expect(boundsOf([])).toBeNull()
    expect(boundsOf([{ x: null, y: null }])).toBeNull()
  })
})

describe('fitTransform', () => {
  const viewport = { width: 1000, height: 600, padding: 20 }

  it('mieści plan w kadrze', () => {
    const bounds = boundsOf([{ x: 0, y: 0, width: 40, height: 20 }])!
    const t = fitTransform(bounds, viewport)
    const rog = toPixels({ x: 40, y: 20 }, t)
    expect(rog.x).toBeLessThanOrEqual(viewport.width)
    expect(rog.y).toBeLessThanOrEqual(viewport.height)
  })

  it('SKALA JEST JEDNA DLA OBU OSI - prostokąt zostaje prostokątem', () => {
    // Osobne skale wypełniłyby kadr lepiej i zniekształciły proporcje.
    // Na planie hali cela ma wyglądać tak, jak wygląda na miejscu.
    const bounds = boundsOf([{ x: 0, y: 0, width: 100, height: 10 }])!
    const t = fitTransform(bounds, viewport)
    const a = toPixels({ x: 0, y: 0 }, t)
    const b = toPixels({ x: 10, y: 0 }, t)
    const c = toPixels({ x: 0, y: 10 }, t)
    expect(b.x - a.x).toBeCloseTo(c.y - a.y, 6)
  })

  it('wyśrodkowuje plan w kadrze', () => {
    const bounds = boundsOf([{ x: 0, y: 0, width: 100, height: 10 }])!
    const t = fitTransform(bounds, viewport)
    const gora = toPixels({ x: 0, y: 0 }, t).y
    const dol = toPixels({ x: 0, y: 10 }, t).y
    expect(gora - 0).toBeCloseTo(viewport.height - dol, 1)
  })

  it('uwzględnia przesunięty początek planu', () => {
    // Hala opisana od x=500 ma się pokazać, a nie wyjechać poza kadr.
    const bounds = boundsOf([{ x: 500, y: 300, width: 40, height: 20 }])!
    const t = fitTransform(bounds, viewport)
    const lewyGorny = toPixels({ x: 500, y: 300 }, t)
    expect(lewyGorny.x).toBeGreaterThanOrEqual(0)
    expect(lewyGorny.y).toBeGreaterThanOrEqual(0)
  })

  it('brak obwiedni nie wywraca przeliczenia', () => {
    const t = fitTransform(null, viewport)
    expect(Number.isFinite(t.scale)).toBe(true)
    expect(t.scale).toBeGreaterThan(0)
  })
})

describe('arrangeInCell', () => {
  it('rozstawia roboty wewnątrz obrysu celi', () => {
    const pozycje = arrangeInCell(CELA, 4)
    expect(pozycje).toHaveLength(4)
    for (const p of pozycje) {
      expect(p.x).toBeGreaterThan(CELA.x)
      expect(p.x).toBeLessThan(CELA.x + CELA.width)
      expect(p.y).toBeGreaterThan(CELA.y)
      expect(p.y).toBeLessThan(CELA.y + CELA.height)
    }
  })

  it('jeden robot ląduje na środku celi', () => {
    expect(arrangeInCell(CELA, 1)).toEqual([{ x: 14, y: 8 }])
  })

  it('zero robotów daje pustą listę, nie punkt w rogu', () => {
    expect(arrangeInCell(CELA, 0)).toEqual([])
  })

  it('pozycje się nie pokrywają', () => {
    const pozycje = arrangeInCell(CELA, 9)
    const klucze = new Set(pozycje.map((p) => `${p.x}:${p.y}`))
    expect(klucze.size).toBe(9)
  })
})
