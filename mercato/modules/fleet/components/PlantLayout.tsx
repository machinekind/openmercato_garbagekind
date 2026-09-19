'use client'

import * as React from 'react'
import { apiFetch } from '@open-mercato/ui/backend/utils/api'
import { boundsOf, fitTransform, toPixels, type Transform } from '../lib/layout'
import {
  DeviationBar,
  HmiTokens,
  MachineTile,
  OverflowTile,
  StatusGlyph,
  StatusLegend,
} from '../../hmi/components/primitives'
import {
  calibrationStatus,
  lifecycleStatus,
  linkStatus,
  worstOf,
  isNotable,
  type LinkState,
  type StatusDescriptor,
} from '../../hmi/lib/status'
import { RADIUS, SEVERITY_PRIORITY, SPACE, STROKE, TILE, TYPE, cssVar } from '../../hmi/lib/tokens'
import { packTiles } from '../../hmi/lib/pack'

/**
 * Rzut hali.
 *
 * Przebudowany na systemie wizualnym `hmi` po tym, jak pierwsza wersja
 * okazała się źle zaprojektowana w konkretny sposób: **kolorowała stan
 * normalny**. Pięć pracujących maszyn dawało ścianę zieleni, w której
 * czerwony sygnał musiał się bić o uwagę zamiast po prostu wyskoczyć z tła.
 * Doktryna wysokowydajnego HMI mówi odwrotnie — norma jest szara, kolor
 * należy wyłącznie do odstępstwa.
 *
 * Druga zmiana: kropka niosła jeden bit. Maszyna ma cztery wymiary
 * (tożsamość, cykl życia, kalibracja, łączność), więc dostaje kafelek
 * z czytelnym numerem seryjnym i opisem stanu słowami.
 */

type Cell = {
  id: string
  code: string
  name: string
  cellClass: string
  riskClass: string
  x: number | null
  y: number | null
  width: number | null
  height: number | null
  robotCount: number
}

type Robot = {
  id: string
  cellId: string | null
  serialNumber: string
  name: string
  state: string
  stateReason: string | null
  embodiment: string | null
  externallyOperated: boolean
  calibrationState: 'valid' | 'expiring' | 'blocked' | 'unknown'
  calibrationDaysLeft: number | null
}

type Site = { id: string; code: string; name: string; floorWidthM: number | null; floorHeightM: number | null }

type LayoutPayload = {
  generatedAt: string
  sites: Site[]
  cells: Cell[]
  unplacedCells: Cell[]
  unassignedRobots: number
  robots: Robot[]
}

type AgentLink = { robotId: string; state: string; silenceSeconds: number | null }
type OrderRow = { cellId: string | null; producedKg: number; targetKg: number; overclaimBatches: number }
type VisionBatch = { cellId: string | null; suspect: string }

/**
 * Klasa ryzyka na obrysie celi.
 *
 * Jedyne miejsce poza stanem maszyn, gdzie wolno użyć koloru — i użyty jest
 * oszczędnie: ogrodzona rysuje się neutralnie, a wyróżnione są te klasy,
 * w których obok maszyny **chodzą ludzie**. To informacja o zagrożeniu,
 * nie o kategorii.
 */
const RISK: Record<string, { stroke: string; dash?: string; label: string }> = {
  fenced: { stroke: 'var(--hmi-outline)', label: 'ogrodzona' },
  shared: { stroke: cssVar('advisory'), dash: '7 4', label: 'dzielona z ludźmi' },
  public: { stroke: cssVar('alarm'), dash: '4 3', label: 'przestrzeń publiczna' },
}

/** Proporcje kadru dobierane do hali, żeby rysunek nie pływał w pustce. */
function viewportFor(bounds: ReturnType<typeof boundsOf>): { width: number; height: number; padding: number } {
  const width = 960
  if (!bounds) return { width, height: 420, padding: SPACE.xxl }
  const ratio = (bounds.maxY - bounds.minY) / Math.max(0.001, bounds.maxX - bounds.minX)
  const height = Math.round(Math.min(620, Math.max(300, width * ratio)))
  return { width, height, padding: SPACE.xxl }
}

export default function PlantLayout() {
  const [layout, setLayout] = React.useState<LayoutPayload | null>(null)
  const [agents, setAgents] = React.useState<Record<string, AgentLink> | null | undefined>(undefined)
  const [orders, setOrders] = React.useState<OrderRow[] | null>(null)
  const [batches, setBatches] = React.useState<VisionBatch[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [selected, setSelected] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      const response = await apiFetch('/api/fleet/layout')
      if (!response.ok) {
        const body = (await response.json()) as { error?: string }
        setError(body?.error ?? `Błąd ${response.status}`)
        return
      }
      setLayout((await response.json()) as LayoutPayload)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return
    } finally {
      setLoading(false)
    }

    // Warstwy opcjonalne — brak którejkolwiek odejmuje informację,
    // a nie wywraca rysunku.
    try {
      const r = await apiFetch('/api/edge/agents')
      setAgents(r.ok ? ((await r.json()) as { byRobot: Record<string, AgentLink> }).byRobot : null)
    } catch {
      setAgents(null)
    }
    try {
      const r = await apiFetch('/api/work_orders/panel')
      setOrders(r.ok ? ((await r.json()) as { orders: OrderRow[] }).orders : null)
    } catch {
      setOrders(null)
    }
    try {
      const r = await apiFetch('/api/vision/panel')
      setBatches(r.ok ? ((await r.json()) as { batches: VisionBatch[] }).batches : null)
    } catch {
      setBatches(null)
    }
  }, [])

  React.useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 15_000)
    return () => clearInterval(timer)
  }, [load])

  const cells = layout?.cells ?? []
  const robots = layout?.robots ?? []
  const site = layout?.sites?.[0] ?? null

  const bounds = React.useMemo(() => {
    const items = cells.map((c) => ({ x: c.x, y: c.y, width: c.width, height: c.height }))
    if (site?.floorWidthM && site?.floorHeightM) {
      items.push({ x: 0, y: 0, width: site.floorWidthM, height: site.floorHeightM })
    }
    return boundsOf(items)
  }, [cells, site])

  const viewport = React.useMemo(() => viewportFor(bounds), [bounds])
  const transform: Transform = React.useMemo(() => fitTransform(bounds, viewport), [bounds, viewport])

  /** Stan łączności maszyny — z rozróżnieniem braku warstwy od braku agenta. */
  const linkFor = React.useCallback(
    (robotId: string): StatusDescriptor => {
      if (agents === undefined) return linkStatus('layer_unavailable')
      if (agents === null) return linkStatus('layer_unavailable')
      const link = agents[robotId]
      if (!link) return linkStatus('absent')
      return linkStatus(link.state as LinkState, link.silenceSeconds)
    },
    [agents],
  )

  const statusFor = React.useCallback(
    (robot: Robot): { dominant: StatusDescriptor; all: StatusDescriptor[] } => {
      const all = [
        lifecycleStatus(robot.state),
        calibrationStatus(robot.calibrationState, robot.calibrationDaysLeft),
        linkFor(robot.id),
      ]
      return { dominant: worstOf(all), all }
    },
    [linkFor],
  )

  const perCell = React.useMemo(() => {
    const map = new Map<string, { producedKg: number; targetKg: number; overclaim: number; visionSuspects: number }>()
    for (const order of orders ?? []) {
      if (!order.cellId) continue
      const current = map.get(order.cellId) ?? { producedKg: 0, targetKg: 0, overclaim: 0, visionSuspects: 0 }
      current.producedKg += order.producedKg
      current.targetKg += order.targetKg ?? 0
      current.overclaim += order.overclaimBatches
      map.set(order.cellId, current)
    }
    for (const batch of batches ?? []) {
      if (!batch.cellId || batch.suspect === 'none' || batch.suspect === 'no_reference') continue
      const current = map.get(batch.cellId) ?? { producedKg: 0, targetKg: 0, overclaim: 0, visionSuspects: 0 }
      current.visionSuspects += 1
      map.set(batch.cellId, current)
    }
    return map
  }, [orders, batches])

  /** Maszyny wymagające uwagi — pas nad rysunkiem, zanim ktokolwiek spojrzy na plan. */
  const attention = React.useMemo(
    () =>
      robots
        .map((robot) => ({ robot, ...statusFor(robot) }))
        .filter((entry) => isNotable(entry.dominant))
        .sort((a, b) => (a.dominant.severity === 'alarm' ? -1 : 1)),
    [robots, statusFor],
  )

  const obecneKody = React.useMemo(() => {
    const kody = new Set<string>()
    for (const robot of robots) for (const d of statusFor(robot).all) if (isNotable(d)) kody.add(d.code)
    return [...kody]
  }, [robots, statusFor])

  const selectedCell = cells.find((c) => c.id === selected) ?? null
  const selectedRobots = robots.filter((r) => r.cellId === selected)

  return (
    <div className="flex flex-col" style={{ gap: SPACE.xl }} data-testid="plant-layout">
      <HmiTokens />

      {error ? (
        <div className="rounded-md px-4 py-3 text-sm" style={{ border: `1px solid ${cssVar('alarm')}`, color: cssVar('alarm') }}>
          {error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <span className="text-sm font-semibold text-foreground">{site?.name ?? 'Hala'}</span>
        <span>{site?.floorWidthM && site?.floorHeightM ? `${site.floorWidthM} × ${site.floorHeightM} m` : 'obrys nieobmierzony'}</span>
        <span>{cells.length} cel · {robots.length} maszyn</span>
        {orders === null ? <span style={{ color: cssVar('suppressed') }}>wynik: warstwa niedostępna</span> : null}
        {layout ? <span>{new Date(layout.generatedAt).toLocaleTimeString('pl-PL')}</span> : null}
      </div>

      {/*
        Pas uwagi nad rysunkiem. Na hali z pięcioma maszynami plan wystarcza;
        przy pięćdziesięciu operator nie skanuje rzutu wzrokiem, tylko czyta
        listę tego, co odbiega od normy — a rzut służy do odpowiedzi „gdzie".
      */}
      {attention.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {attention.map(({ robot, dominant }) => (
            <span
              key={robot.id}
              className="inline-flex items-center gap-1.5 rounded px-2 py-1"
              style={{
                border: `${STROKE.hairline}px solid ${cssVar(dominant.severity)}`,
                borderRadius: RADIUS.badge,
                fontSize: TYPE.status.size + 1,
              }}
              title={dominant.detail}
            >
              <StatusGlyph descriptor={dominant} size={9} />
              <span className="font-medium" style={{ fontVariantNumeric: 'tabular-nums' }}>{robot.serialNumber}</span>
              <span style={{ color: cssVar(dominant.severity) }}>{dominant.label}</span>
            </span>
          ))}
        </div>
      ) : null}

      <div className="rounded-lg border" style={{ background: 'var(--hmi-surface-sunken)' }}>
        <svg
          viewBox={`0 0 ${viewport.width} ${viewport.height}`}
          className="h-auto w-full"
          role="img"
          aria-label="Rzut hali z rozmieszczeniem cel i maszyn"
        >
          {site?.floorWidthM && site?.floorHeightM
            ? (() => {
                const a = toPixels({ x: 0, y: 0 }, transform)
                return (
                  <rect
                    x={a.x}
                    y={a.y}
                    width={site.floorWidthM * transform.scale}
                    height={site.floorHeightM * transform.scale}
                    fill="var(--hmi-surface)"
                    stroke="var(--hmi-outline)"
                    strokeWidth={STROKE.hairline}
                  />
                )
              })()
            : null}

          {cells.map((cell) => {
            const origin = toPixels({ x: cell.x as number, y: cell.y as number }, transform)
            const w = (cell.width as number) * transform.scale
            const h = (cell.height as number) * transform.scale
            const risk = RISK[cell.riskClass] ?? RISK.fenced
            const cellRobots = robots.filter((r) => r.cellId === cell.id)
            const output = perCell.get(cell.id)
            const isSelected = selected === cell.id

            /*
             * Kafelki układane w kolumnę wewnątrz celi, a nie w siatkę:
             * kolumna czyta się z góry na dół jak lista i mieści pełny numer
             * seryjny. Siatka zmuszałaby do skracania identyfikatorów,
             * czyli do odbierania kafelkowi jego głównej zalety.
             */
            const stackTop = origin.y + 34
            // Szerokość paska wyniku liczona z obrysu celi, nie z kafelka:
            // kafelki bywają teraz w kilku kolumnach i żaden z nich nie jest
            // miarą dla czegoś, co dotyczy całej celi.
            const metricWidth = Math.max(72, w - 2 * SPACE.md)

            return (
              <g key={cell.id} onClick={() => setSelected(isSelected ? null : cell.id)} style={{ cursor: 'pointer' }}>
                <rect
                  x={origin.x}
                  y={origin.y}
                  width={w}
                  height={h}
                  rx={RADIUS.cell}
                  fill="currentColor"
                  fillOpacity={isSelected ? 0.045 : 0.015}
                  stroke={risk.stroke}
                  strokeDasharray={risk.dash}
                  strokeWidth={isSelected ? STROKE.emphasis : STROKE.normal}
                />
                <text
                  x={origin.x + SPACE.md}
                  y={origin.y + 16}
                  fontSize={TYPE.identifier.size + 1}
                  fontWeight={TYPE.identifier.weight}
                  fill="currentColor"
                >
                  {cell.code}
                </text>
                <text
                  x={origin.x + SPACE.md}
                  y={origin.y + 27}
                  fontSize={TYPE.caption.size}
                  fill={cell.riskClass === 'fenced' ? 'currentColor' : risk.stroke}
                  fillOpacity={cell.riskClass === 'fenced' ? 0.5 : 1}
                >
                  {risk.label}
                </text>

                {/*
                  Ile kafelków mieści się nad paskiem wyniku. Maszyny, które
                  się nie mieszczą, NIE znikają — dostają kafelek zbiorczy.
                  Pierwsza wersja gubiła je bez śladu, przez co rzut wyglądał
                  na kompletny i nie był. Kolejność jest wg ważności, więc
                  ucięte są zawsze te w normie, nigdy alarmy.
                */}
                {(() => {
                  const pack = packTiles({
                    innerWidth: w - 2 * SPACE.md,
                    innerHeight: h - (stackTop - origin.y) - 26,
                    count: cellRobots.length,
                  })
                  // Kolejność wg ważności: gdy zabraknie miejsca, ucięte są
                  // zawsze maszyny w normie, nigdy alarmy.
                  const posortowane = [...cellRobots].sort(
                    (a, b) =>
                      SEVERITY_PRIORITY[statusFor(b).dominant.severity] -
                      SEVERITY_PRIORITY[statusFor(a).dominant.severity],
                  )
                  const przepelnienie = posortowane.length > pack.capacity
                  const miejsc = przepelnienie ? Math.max(0, pack.capacity - 1) : posortowane.length
                  const widoczne = posortowane.slice(0, miejsc)

                  return (
                    <>
                      {widoczne.map((robot, index) => {
                        const { dominant, all } = statusFor(robot)
                        const pos = pack.positions[index]
                        return (
                          <MachineTile
                            key={robot.id}
                            x={origin.x + SPACE.md + pos.x}
                            y={stackTop + pos.y}
                            width={pack.tileWidth}
                            label={robot.serialNumber}
                            sublabel={dominant.short}
                            status={dominant}
                            selected={isSelected}
                            title={all.map((d) => d.label + (d.detail ? ` (${d.detail})` : '')).join(' · ')}
                          />
                        )
                      })}
                      {przepelnienie && pack.positions[miejsc] ? (
                        <OverflowTile
                          x={origin.x + SPACE.md + pack.positions[miejsc].x}
                          y={stackTop + pack.positions[miejsc].y}
                          width={pack.tileWidth}
                          hidden={posortowane.length - miejsc}
                        />
                      ) : null}
                    </>
                  )
                })()}

                {/* Wynik przy dolnej krawędzi: liczba, pasek i cel — nie zlepek tekstu. */}
                {output ? (
                  <g transform={`translate(${origin.x + SPACE.md}, ${origin.y + h - 18})`}>
                    <text fontSize={TYPE.metric.size} fontWeight={TYPE.metric.weight} fill="currentColor">
                      {output.producedKg.toFixed(0)} kg
                    </text>
                    {output.targetKg > 0 ? (
                      <text
                        x={metricWidth}
                        textAnchor="end"
                        fontSize={TYPE.caption.size}
                        fill="currentColor"
                        fillOpacity={0.5}
                      >
                        cel {output.targetKg.toFixed(0)} kg
                      </text>
                    ) : null}
                    <foreignObject x={0} y={4} width={metricWidth} height={10}>
                      <DeviationBar
                        value={output.producedKg}
                        target={output.targetKg > 0 ? output.targetKg : null}
                        width={metricWidth}
                        severity={output.overclaim > 0 ? 'alarm' : 'normal'}
                      />
                    </foreignObject>
                  </g>
                ) : null}
              </g>
            )
          })}

          {cells.length === 0 && !loading ? (
            <text
              x={viewport.width / 2}
              y={viewport.height / 2}
              textAnchor="middle"
              fontSize={13}
              fill="currentColor"
              fillOpacity={0.55}
            >
              Żadna cela nie ma obmiaru. Uruchom: mercato fleet layout
            </text>
          ) : null}
        </svg>
      </div>

      {/*
        Legenda zawężona do stanów **obecnych na rysunku**. Pełny słownik
        ma kilkanaście pozycji i zamienia legendę w drugi ekran do czytania;
        operator potrzebuje wyjaśnienia tego, co widzi teraz.
      */}
      <StatusLegend codes={obecneKody} />

      {selectedCell ? (
        <div className="rounded-lg border">
          <div className="flex items-baseline justify-between border-b px-4 py-2">
            <span className="text-sm font-medium">{selectedCell.name}</span>
            <span className="text-xs text-muted-foreground">{selectedCell.cellClass}</span>
          </div>
          <div className="divide-y">
            {selectedRobots.map((robot) => {
              const { all } = statusFor(robot)
              return (
                <div key={robot.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-xs">
                  <span className="w-28 font-mono">{robot.serialNumber}</span>
                  <span className="w-36 text-muted-foreground">{robot.embodiment ?? '—'}</span>
                  {/* Wszystkie trzy wymiary wypisane osobno — kafelek pokazuje
                      dominujący, szczegóły pokazują komplet. */}
                  {all.map((d) => (
                    <span key={d.code} className="flex items-center gap-1" style={{ color: isNotable(d) ? cssVar(d.severity) : undefined }}>
                      <StatusGlyph descriptor={d} size={8} />
                      <span className={isNotable(d) ? '' : 'text-muted-foreground'}>
                        {d.label}
                        {d.detail ? ` — ${d.detail}` : ''}
                      </span>
                    </span>
                  ))}
                </div>
              )
            })}
            {selectedRobots.length === 0 ? (
              <div className="px-4 py-3 text-xs text-muted-foreground">Cela bez przypisanych maszyn.</div>
            ) : null}
          </div>
        </div>
      ) : null}

      {(layout?.unplacedCells?.length ?? 0) > 0 || (layout?.unassignedRobots ?? 0) > 0 ? (
        <div
          className="rounded-lg px-4 py-3 text-xs"
          style={{ border: `${STROKE.hairline}px solid ${cssVar('unknown')}` }}
        >
          <div className="mb-1 flex items-center gap-1.5 font-medium" style={{ color: cssVar('unknown') }}>
            <StatusGlyph descriptor={linkStatus('absent')} size={9} />
            Poza rzutem
          </div>
          {layout?.unplacedCells?.map((cell) => (
            <div key={cell.id} className="text-muted-foreground">
              {cell.code} — {cell.name}: brak obmiaru ({cell.robotCount} maszyn)
            </div>
          ))}
          {layout?.unassignedRobots ? (
            <div className="text-muted-foreground">
              {layout.unassignedRobots} maszyn bez przypisanej celi — stoją na hali, rejestr nie wie gdzie.
            </div>
          ) : null}
          <div className="mt-1 text-muted-foreground">
            Współrzędne nadaje się obmiarem, nie domysłem — dlatego te pozycje nie są zgadywane.
          </div>
        </div>
      ) : null}
    </div>
  )
}
