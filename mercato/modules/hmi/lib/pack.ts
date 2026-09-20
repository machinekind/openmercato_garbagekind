import { TILE } from './tokens'

/**
 * Upakowanie kafelków maszyn w obrysie celi.
 *
 * Rachunek wydzielony z komponentu, bo to arytmetyka, a arytmetyka w JSX
 * jest arytmetyką, której nikt nie przetestuje. Pierwsza wersja rzutu
 * mieściła dwie maszyny z pięciu i chowała resztę za „+3", bo układała
 * kafelki w jedną kolumnę w celi mającej miejsce na dwie.
 */

export type PackResult = {
  columns: number
  rows: number
  tileWidth: number
  /** Ile kafelków zmieści się bez kafelka zbiorczego. */
  capacity: number
  /**
   * Cela jest węższa niż czytelny kafelek.
   *
   * Nie ściskamy kafelka poniżej obrysu celi - wystawałby poza celę, do której
   * należy, i rzut zacząłby kłamać o przynależności. Nie rozciągamy też celi.
   * Zamiast tego mówimy wprost, że przy tym obmiarze opis stanu będzie ucięty,
   * i niech to będzie widać, zamiast tłumaczyć potem, czemu etykiety się urywają.
   */
  constrained: boolean
  positions: Array<{ x: number; y: number }>
}

export function packTiles(options: {
  innerWidth: number
  innerHeight: number
  count: number
  maxTileWidth?: number
}): PackResult {
  const { innerWidth, innerHeight, count } = options
  const maxTileWidth = options.maxTileWidth ?? 150

  /*
   * Liczba kolumn brana z szerokości, ale ograniczona do trzech: cztery
   * kolumny przy tej szerokości dałyby kafelki węższe niż numer seryjny,
   * czyli wróciłyby do skracania identyfikatora - a to jedyna rzecz,
   * dla której kafelek zastąpił kropkę.
   */
  const maxColumns = Math.max(1, Math.floor((innerWidth + TILE.gap) / (TILE.minWidth + TILE.gap)))
  const columns = Math.max(1, Math.min(3, maxColumns))
  const tileWidth = Math.min(maxTileWidth, (innerWidth - TILE.gap * (columns - 1)) / columns)
  const constrained = tileWidth < TILE.minWidth
  const rows = Math.max(0, Math.floor((innerHeight + TILE.gap) / (TILE.height + TILE.gap)))
  const capacity = columns * rows

  const positions: Array<{ x: number; y: number }> = []
  for (let index = 0; index < Math.min(count, capacity); index += 1) {
    const column = index % columns
    const row = Math.floor(index / columns)
    positions.push({
      x: column * (tileWidth + TILE.gap),
      y: row * (TILE.height + TILE.gap),
    })
  }

  return { columns, rows, tileWidth, capacity, constrained, positions }
}
