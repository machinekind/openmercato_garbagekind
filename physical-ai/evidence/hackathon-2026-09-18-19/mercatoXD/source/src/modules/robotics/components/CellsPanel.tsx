"use client"

import * as React from 'react'

type Cell = {
  id: string
  name: string
  panelBaseUrl: string
  homePreset: string
  searchPreset: string
  isActive: boolean
  lastSeenAt: string | null
}

type CellState = {
  cellId: string
  online: boolean
  reason?: string
  streamUrl?: string
  state?: { q: number[]; engaged: boolean; engagedVia: string; moving: boolean }
}

const DEG = 180 / Math.PI

export default function CellsPanel() {
  const [cells, setCells] = React.useState<Cell[]>([])
  const [states, setStates] = React.useState<Record<string, CellState>>({})
  const [form, setForm] = React.useState({ name: '', panelBaseUrl: 'http://10.42.0.1:8080' })
  const [error, setError] = React.useState<string | null>(null)

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch('/api/robotics/cells').then((r) => r.json())
      const items: Cell[] = res.items ?? []
      setCells(items)
      const next: Record<string, CellState> = {}
      await Promise.all(
        items.map(async (cell) => {
          const state = await fetch(`/api/robotics/cells/state?cellId=${cell.id}`).then((r) => r.json())
          next[cell.id] = state
        }),
      )
      setStates(next)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  React.useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => clearInterval(timer)
  }, [refresh])

  async function createCell(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    try {
      const res = await fetch('/api/robotics/cells', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(String(data?.error ?? res.statusText))
      setForm({ name: '', panelBaseUrl: form.panelBaseUrl })
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={createCell} className="flex flex-wrap items-end gap-3 rounded border p-4">
        <label className="flex flex-col gap-1 text-sm">
          <span>Name</span>
          <input
            className="rounded border px-2 py-1"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span>Panel URL</span>
          <input
            className="rounded border px-2 py-1"
            value={form.panelBaseUrl}
            onChange={(e) => setForm({ ...form, panelBaseUrl: e.target.value })}
            required
          />
        </label>
        <button className="rounded bg-black px-3 py-1.5 text-white">Add cell</button>
      </form>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      <div className="grid gap-4 md:grid-cols-2">
        {cells.map((cell) => {
          const live = states[cell.id]
          const arm = live?.state
          return (
            <section key={cell.id} className="rounded border p-4">
              <header className="flex items-center justify-between">
                <h3 className="font-medium">{cell.name}</h3>
                <span className={live?.online ? 'text-green-700 text-sm' : 'text-red-700 text-sm'}>
                  {live?.online ? 'panel online' : 'panel offline'}
                </span>
              </header>
              <p className="text-sm text-muted-foreground">{cell.panelBaseUrl}</p>
              {arm ? (
                <dl className="mt-2 grid grid-cols-2 gap-x-4 text-sm">
                  <dt>Engaged</dt>
                  <dd>{arm.engaged ? `yes (${arm.engagedVia})` : 'no'}</dd>
                  <dt>Moving</dt>
                  <dd>{arm.moving ? 'yes' : 'no'}</dd>
                  <dt>Joints (deg)</dt>
                  <dd>{arm.q.map((v) => (v * DEG).toFixed(1)).join(', ')}</dd>
                </dl>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">{live?.reason ?? 'no state yet'}</p>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                bridge last seen: {cell.lastSeenAt ? new Date(cell.lastSeenAt).toLocaleString() : 'never'}
              </p>
              {live?.online && live.streamUrl ? (
                // The panel serves multipart MJPEG; an <img> is the whole client.
                <img
                  src={live.streamUrl}
                  alt={`${cell.name} camera`}
                  className="mt-3 w-full rounded border"
                />
              ) : null}
            </section>
          )
        })}
        {cells.length === 0 ? <p className="text-sm text-muted-foreground">No cells registered yet.</p> : null}
      </div>
    </div>
  )
}
