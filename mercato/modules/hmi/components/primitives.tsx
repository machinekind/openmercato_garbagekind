'use client'

import * as React from 'react'
import { cssVar, RADIUS, STROKE, TILE, TYPE, tokensCss } from '../lib/tokens'
import { isNotable, statusVocabulary, type Glyph, type StatusDescriptor } from '../lib/status'

/**
 * Elementy ekranów operatorskich.
 *
 * Wszystkie rysują się na **żetonach**, nie na własnych wartościach — dzięki
 * temu zmiana palety jest zmianą w jednym pliku, a nie polowaniem po
 * komponentach. Kształt niesie znaczenie równolegle do koloru; komponent,
 * który rysowałby sam kolor, nie przeszedłby testu słownika.
 */

/**
 * Skracanie tekstu do szerokości kafelka.
 *
 * SVG nie zawija ani nie przycina tekstu sam — napis po prostu wychodzi poza
 * kształt i nachodzi na sąsiada. Szerokość znaku szacowana, nie mierzona:
 * pomiar wymagałby `getComputedTextLength` po renderze, czyli drugiego
 * przebiegu układu dla każdego kafelka. Przy kroju o stałej szerokości cyfr
 * i etykietach z tego słownika oszacowanie wystarcza, a błąd idzie w stronę
 * skracania za wcześnie, nie za późno.
 */
export function fitText(text: string, widthPx: number, fontSize: number): string {
  const perChar = fontSize * 0.52
  const max = Math.floor(widthPx / perChar)
  if (max <= 1) return ''
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Wstrzyknięcie zmiennych CSS. Raz na stronę, na górze drzewa. */
export function HmiTokens(): React.ReactElement {
  return <style dangerouslySetInnerHTML={{ __html: tokensCss() }} />
}

/**
 * Kształt stanu.
 *
 * Rysowany ścieżkami w układzie 0..1, skalowanymi do żądanego rozmiaru —
 * dzięki temu ten sam glif działa jako znaczek przy kafelku maszyny
 * (8 px) i w legendzie (10 px) bez osobnych definicji.
 */
export function glyphPath(glyph: Glyph, cx: number, cy: number, size: number): React.ReactElement | null {
  const r = size / 2
  switch (glyph) {
    case 'triangle':
      // Ostrzeżenie: trójkąt wierzchołkiem do góry — ten sam kształt,
      // co na znakach drogowych, więc nie wymaga nauki.
      return <path d={`M ${cx} ${cy - r} L ${cx + r} ${cy + r * 0.8} L ${cx - r} ${cy + r * 0.8} Z`} />
    case 'cross':
      // Alarm: krzyż, nie wykrzyknik — wykrzyknik w kółku gubi się przy 8 px.
      return (
        <path
          d={`M ${cx - r} ${cy - r} L ${cx + r} ${cy + r} M ${cx + r} ${cy - r} L ${cx - r} ${cy + r}`}
          strokeWidth={STROKE.emphasis}
          strokeLinecap="round"
          fill="none"
        />
      )
    case 'square':
      return <rect x={cx - r} y={cy - r} width={size} height={size} rx={1} />
    case 'diamond':
      // Niewiedza: romb — kształt, który nie występuje w żadnym innym stanie.
      return <path d={`M ${cx} ${cy - r} L ${cx + r} ${cy} L ${cx} ${cy + r} L ${cx - r} ${cy} Z`} />
    case 'bars':
      return (
        <path
          d={`M ${cx - r} ${cy - r * 0.5} L ${cx + r} ${cy - r * 0.5} M ${cx - r} ${cy + r * 0.5} L ${cx + r} ${cy + r * 0.5}`}
          strokeWidth={STROKE.normal}
          strokeLinecap="round"
          fill="none"
        />
      )
    case 'ring':
      // Milczenie: pierścień przerywany — wizualnie „coś powinno tu pulsować".
      return <circle cx={cx} cy={cy} r={r} fill="none" strokeWidth={STROKE.emphasis} strokeDasharray="2 2" />
    default:
      return null
  }
}

export function StatusGlyph({
  descriptor,
  size = 10,
}: {
  descriptor: StatusDescriptor
  size?: number
}): React.ReactElement | null {
  if (descriptor.glyph === 'none') return null
  const box = size + 4
  return (
    <svg width={box} height={box} viewBox={`0 0 ${box} ${box}`} aria-hidden focusable="false">
      <g fill={cssVar(descriptor.severity)} stroke={cssVar(descriptor.severity)}>
        {glyphPath(descriptor.glyph, box / 2, box / 2, size)}
      </g>
    </svg>
  )
}

/**
 * Kafelek maszyny na rzucie.
 *
 * Zastępuje kropkę z poprzedniej wersji ekranu. Kropka niosła jeden bit
 * (kolor), a maszyna ma cztery wymiary: tożsamość, stan cyklu życia,
 * kalibrację i łączność. Kafelek niesie **identyfikator czytelny wprost**,
 * opis stanu słowami i jeden glif stanu dominującego — reszta trafia
 * do podpowiedzi i do panelu szczegółów.
 *
 * Maszyna w normie rysuje się w barwach neutralnych. Ramka z kolorem
 * pojawia się wyłącznie przy odstępstwie i dlatego rzuca się w oczy.
 */
export function MachineTile({
  x,
  y,
  width,
  label,
  sublabel,
  status,
  selected,
  title,
  onClick,
}: {
  x: number
  y: number
  width: number
  label: string
  sublabel?: string
  status: StatusDescriptor
  selected?: boolean
  title?: string
  onClick?: () => void
}): React.ReactElement {
  const notable = isNotable(status)
  const w = Math.max(TILE.minWidth, width)
  const h = TILE.height
  const stroke = notable ? cssVar(status.severity) : 'var(--hmi-outline)'

  return (
    <g onClick={onClick} style={{ cursor: onClick ? 'pointer' : undefined }}>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={RADIUS.tile}
        fill="var(--hmi-surface)"
        stroke={stroke}
        strokeWidth={notable ? STROKE.emphasis : selected ? STROKE.normal : STROKE.hairline}
      />
      {/*
        Pasek ważności przy lewej krawędzi zamiast wypełnienia całego kafelka:
        kolorowe tło pod tekstem psuje czytelność, a pasek widać z odległości
        i nie konkuruje z etykietą.
      */}
      {notable ? (
        <rect x={x} y={y} width={3} height={h} rx={1} fill={cssVar(status.severity)} />
      ) : null}

      <text
        x={x + 8}
        y={y + 13}
        fontSize={TYPE.identifier.size}
        fontWeight={TYPE.identifier.weight}
        fill="currentColor"
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {fitText(label, w - 8 - (notable ? 22 : 8), TYPE.identifier.size)}
      </text>
      <text x={x + 8} y={y + 24} fontSize={TYPE.status.size} fill="currentColor" fillOpacity={0.62}>
        {/* Miejsce na glif po prawej odjęte z góry — inaczej napis na niego wchodzi. */}
        {fitText(sublabel ?? status.short, w - 8 - (notable ? 24 : 10), TYPE.status.size)}
      </text>

      {notable ? (
        <g fill={cssVar(status.severity)} stroke={cssVar(status.severity)}>
          {glyphPath(status.glyph, x + w - 11, y + h / 2, 9)}
        </g>
      ) : null}

      {title ? <title>{title}</title> : null}
    </g>
  )
}

/**
 * Kafelek informujący, że reszta maszyn się nie zmieściła.
 *
 * Powstał, bo pierwsza wersja rzutu **po cichu gubiła maszyny**, które nie
 * mieściły się w obrysie celi: pięć maszyn, trzy na rysunku, żadnej
 * informacji o dwóch pozostałych. Plan hali, z którego znikają maszyny,
 * jest gorszy niż brak planu — bo wygląda na kompletny.
 */
export function OverflowTile({
  x,
  y,
  width,
  hidden,
  onClick,
}: {
  x: number
  y: number
  width: number
  hidden: number
  onClick?: () => void
}): React.ReactElement {
  const w = Math.max(TILE.minWidth, width)
  return (
    <g onClick={onClick} style={{ cursor: onClick ? 'pointer' : undefined }}>
      <rect
        x={x}
        y={y}
        width={w}
        height={18}
        rx={RADIUS.tile}
        fill="none"
        stroke="var(--hmi-outline)"
        strokeWidth={STROKE.hairline}
        strokeDasharray="3 3"
      />
      <text x={x + 8} y={y + 13} fontSize={TYPE.status.size} fill="currentColor" fillOpacity={0.7}>
        {`+${hidden} — otwórz celę`}
      </text>
    </g>
  )
}

/**
 * Pasek odchylenia od celu.
 *
 * Zastępuje ciąg „320 kg · 7 niedobór · 8 wizja", w którym trzy różne rzeczy
 * wyglądały jak jedno zdanie. Znacznik celu jest osobną kreską, bo „ile
 * zrobiono" i „ile miało być" to dwie liczby, a nie jedna z procentem.
 */
export function DeviationBar({
  value,
  target,
  width = 120,
  severity = 'normal',
}: {
  value: number
  target: number | null
  width?: number
  severity?: StatusDescriptor['severity']
}): React.ReactElement {
  const max = Math.max(value, target ?? 0, 0.001)
  const fill = Math.max(0, Math.min(1, value / max))
  const mark = target ? Math.max(0, Math.min(1, target / max)) : null

  return (
    <svg width={width} height={8} viewBox={`0 0 ${width} 8`} aria-hidden focusable="false">
      <rect x={0} y={2} width={width} height={4} rx={2} fill="var(--hmi-surface-sunken)" />
      <rect
        x={0}
        y={2}
        width={width * fill}
        height={4}
        rx={2}
        fill={severity === 'normal' ? 'currentColor' : cssVar(severity)}
        fillOpacity={severity === 'normal' ? 0.45 : 1}
      />
      {mark !== null ? (
        <rect x={width * mark - 1} y={0} width={2} height={8} rx={1} fill="currentColor" fillOpacity={0.8} />
      ) : null}
    </svg>
  )
}

/**
 * Legenda składana ze słownika stanów.
 *
 * Ręczna rozjechała się w tym projekcie dwa razy — raz nie nadążyła za nowym
 * stanem, raz opisywała kształt, którego na rysunku nie było widać. Ta nie
 * może się rozjechać, bo czyta to samo źródło, co rysunek.
 */
export function StatusLegend({ codes }: { codes?: string[] }): React.ReactElement {
  const items = statusVocabulary()
    .filter(isNotable)
    .filter((d) => !codes || codes.includes(d.code))

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5" style={{ fontSize: TYPE.caption.size + 1 }}>
      {items.map((descriptor) => (
        <span key={descriptor.code} className="flex items-center gap-1.5" title={descriptor.detail}>
          <StatusGlyph descriptor={descriptor} size={9} />
          <span style={{ color: cssVar(descriptor.severity) }}>{descriptor.label}</span>
        </span>
      ))}
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {/* Norma bez glifu i bez koloru — i to też trzeba powiedzieć wprost. */}
        <span className="inline-block h-2.5 w-4 rounded-sm border" style={{ borderColor: 'var(--hmi-outline)' }} />
        praca w normie
      </span>
    </div>
  )
}
