/**
 * Geometria hali - rzut z góry, w metrach.
 *
 * Jedna zasada rozstrzyga o kształcie całej reszty: **cela bez współrzędnych
 * nie jest rysowana**. Automatyczne rozstawienie „gdzieś sensownie" dałoby
 * obrazek, który wygląda jak plan hali i nim nie jest - a plan hali czyta się
 * po to, żeby wiedzieć, gdzie iść. Zmyślona pozycja jest gorsza niż jej brak,
 * bo brak widać.
 *
 * Cele nierozmieszczone trafiają więc na osobną listę obok rysunku, a nie
 * w losowe miejsce rysunku. Ta sama reguła, co przy `unknown` w opisie
 * embodimentu: niewiedza ma być widoczna w danych.
 *
 * Układ współrzędnych: metry, początek w lewym górnym rogu obiektu, oś X
 * w prawo, oś Y w dół. Wybór osi Y w dół jest podyktowany tym, że rysujemy
 * w SVG - przeliczanie znaku przy każdej transformacji dałoby jeden błąd
 * znaku na miesiąc.
 */

export type Placed = {
  x: number
  y: number
  width: number
  height: number
  rotationDeg?: number | null
}

export type MaybePlaced = {
  x?: number | null
  y?: number | null
  width?: number | null
  height?: number | null
  rotationDeg?: number | null
}

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number }

/** Czy obiekt ma komplet współrzędnych. Trzy z czterech to brak, nie „prawie". */
export function isPlaced(item: MaybePlaced): item is MaybePlaced & Placed {
  return (
    typeof item.x === 'number' &&
    typeof item.y === 'number' &&
    typeof item.width === 'number' &&
    typeof item.height === 'number' &&
    item.width > 0 &&
    item.height > 0
  )
}

export function splitPlaced<T extends MaybePlaced>(items: T[]): { placed: T[]; unplaced: T[] } {
  const placed: T[] = []
  const unplaced: T[] = []
  for (const item of items ?? []) (isPlaced(item) ? placed : unplaced).push(item)
  return { placed, unplaced }
}

/**
 * Obwiednia rozmieszczonych obiektów.
 *
 * `null` przy pustym wejściu, a nie zerowy prostokąt: zerowy prostokąt
 * przeszedłby dalej i dał dzielenie przez zero przy skalowaniu.
 */
export function boundsOf(items: MaybePlaced[]): Bounds | null {
  const placed = (items ?? []).filter(isPlaced)
  if (!placed.length) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const item of placed) {
    minX = Math.min(minX, item.x)
    minY = Math.min(minY, item.y)
    maxX = Math.max(maxX, item.x + item.width)
    maxY = Math.max(maxY, item.y + item.height)
  }
  return { minX, minY, maxX, maxY }
}

export type Viewport = { width: number; height: number; padding?: number }
export type Transform = { scale: number; offsetX: number; offsetY: number }

/**
 * Przeliczenie metrów na piksele tak, żeby wszystko się zmieściło.
 *
 * Skala jest **jedna dla obu osi**. Osobne skale wypełniłyby kadr lepiej
 * i zniekształciły proporcje - a na planie hali prostokątna cela ma wyglądać
 * jak prostokątna cela, bo po tym się ją rozpoznaje na miejscu.
 */
export function fitTransform(bounds: Bounds | null, viewport: Viewport): Transform {
  const padding = viewport.padding ?? 24
  if (!bounds) return { scale: 1, offsetX: padding, offsetY: padding }

  const planWidth = Math.max(0.001, bounds.maxX - bounds.minX)
  const planHeight = Math.max(0.001, bounds.maxY - bounds.minY)
  const usableWidth = Math.max(1, viewport.width - 2 * padding)
  const usableHeight = Math.max(1, viewport.height - 2 * padding)

  const scale = Math.min(usableWidth / planWidth, usableHeight / planHeight)

  // Wyśrodkowanie resztą miejsca - inaczej plan przykleja się do lewego
  // górnego rogu i przy wąskiej hali zostaje pół ekranu pustki po prawej.
  const offsetX = padding + (usableWidth - planWidth * scale) / 2 - bounds.minX * scale
  const offsetY = padding + (usableHeight - planHeight * scale) / 2 - bounds.minY * scale

  return { scale, offsetX, offsetY }
}

export function toPixels(point: { x: number; y: number }, transform: Transform): { x: number; y: number } {
  return { x: point.x * transform.scale + transform.offsetX, y: point.y * transform.scale + transform.offsetY }
}

/**
 * Rozstawienie robotów wewnątrz celi, gdy nie podano im własnej pozycji.
 *
 * To jest **jedyne** miejsce, gdzie wolno coś rozstawić automatycznie, i wolno
 * dlatego, że nie udaje pomiaru: robot jest rysowany wewnątrz swojej celi,
 * a cela ma prawdziwe współrzędne. Twierdzimy „ten robot stoi w tej celi",
 * co jest prawdą, a nie „stoi dokładnie tutaj", czego nikt nie mierzył.
 */
export function arrangeInCell(
  cell: Placed,
  count: number,
): Array<{ x: number; y: number }> {
  if (count <= 0) return []
  const columns = Math.ceil(Math.sqrt(count))
  const rows = Math.ceil(count / columns)

  const positions: Array<{ x: number; y: number }> = []
  for (let index = 0; index < count; index += 1) {
    const column = index % columns
    const row = Math.floor(index / columns)
    positions.push({
      x: cell.x + (cell.width * (column + 0.5)) / columns,
      y: cell.y + (cell.height * (row + 0.5)) / rows,
    })
  }
  return positions
}
