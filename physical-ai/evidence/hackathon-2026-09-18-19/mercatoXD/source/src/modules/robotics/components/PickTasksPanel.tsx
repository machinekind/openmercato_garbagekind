"use client"

import * as React from 'react'

type Cell = { id: string; name: string; isActive: boolean }

type Task = {
  id: string
  cellId: string
  instruction: string
  targetLabel: string
  status: string
  stage: string | null
  attempts: number
  maxAttempts: number
  detail: string | null
  createdAt: string
}

const STATUS_TONE: Record<string, string> = {
  queued: 'text-muted-foreground',
  claimed: 'text-blue-600',
  running: 'text-blue-700 font-medium',
  succeeded: 'text-green-700',
  failed: 'text-red-700',
  aborted: 'text-amber-700',
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(String(data?.error ?? res.statusText))
  return data as T
}

export default function PickTasksPanel() {
  const [cells, setCells] = React.useState<Cell[]>([])
  const [tasks, setTasks] = React.useState<Task[]>([])
  const [cellId, setCellId] = React.useState('')
  const [instruction, setInstruction] = React.useState('pick up the can')
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const refresh = React.useCallback(async () => {
    try {
      const [cellRes, taskRes] = await Promise.all([
        fetch('/api/robotics/cells').then((r) => r.json()),
        fetch('/api/robotics/tasks?pageSize=50').then((r) => r.json()),
      ])
      setCells(cellRes.items ?? [])
      setTasks(taskRes.items ?? [])
      setCellId((prev) => prev || (cellRes.items?.[0]?.id ?? ''))
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  // The arm reports stage by stage, so a queued task is worth re-reading for as
  // long as the page is open.
  React.useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 3000)
    return () => clearInterval(timer)
  }, [refresh])

  async function queueTask(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await postJson('/api/robotics/tasks', { cellId, instruction, targetLabel: 'can' })
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function abort(taskId: string) {
    try {
      await postJson('/api/robotics/tasks/abort', { taskId, reason: 'aborted from admin' })
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={queueTask} className="flex flex-wrap items-end gap-3 rounded border p-4">
        <label className="flex flex-col gap-1 text-sm">
          <span>Cell</span>
          <select
            className="rounded border px-2 py-1"
            value={cellId}
            onChange={(e) => setCellId(e.target.value)}
            required
          >
            <option value="">Select a cell</option>
            {cells.map((cell) => (
              <option key={cell.id} value={cell.id} disabled={!cell.isActive}>
                {cell.name}
                {cell.isActive ? '' : ' (inactive)'}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span>Instruction</span>
          <input
            className="rounded border px-2 py-1"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            maxLength={500}
            required
          />
        </label>
        <button className="rounded bg-black px-3 py-1.5 text-white disabled:opacity-50" disabled={busy || !cellId}>
          {busy ? 'Queueing…' : 'Grab the can'}
        </button>
      </form>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      <table className="w-full text-sm">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-1">Queued</th>
            <th>Instruction</th>
            <th>Status</th>
            <th>Stage</th>
            <th>Attempt</th>
            <th>Detail</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.id} className="border-t">
              <td className="py-1">{new Date(task.createdAt).toLocaleTimeString()}</td>
              <td>{task.instruction}</td>
              <td className={STATUS_TONE[task.status] ?? ''}>{task.status}</td>
              <td>{task.stage ?? '—'}</td>
              <td>
                {task.attempts}/{task.maxAttempts}
              </td>
              <td className="max-w-sm truncate" title={task.detail ?? ''}>
                {task.detail ?? '—'}
              </td>
              <td>
                {['queued', 'claimed', 'running'].includes(task.status) ? (
                  <button className="text-amber-700 underline" onClick={() => void abort(task.id)}>
                    abort
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
          {tasks.length === 0 ? (
            <tr>
              <td colSpan={7} className="py-4 text-muted-foreground">
                No pick tasks yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  )
}
