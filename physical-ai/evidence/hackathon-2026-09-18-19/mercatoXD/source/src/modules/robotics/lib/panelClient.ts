/**
 * Read-only client for an arm's web panel.
 *
 * Deliberately read-only. Motion commands travel over the panel's WebSocket so
 * that the panel's "last operator tab closed -> auto-disengage" rule covers the
 * mover; a stateless HTTP request from a Next.js server cannot be covered that
 * way. Open Mercato therefore reads state and posts notes; the bridge process
 * (bridge/om_bridge) is the only thing that moves the arm.
 */

export type ArmState = {
  /** Joint angles in radians; 7 values on the A1X (6 arm joints + gripper). */
  q: number[]
  engaged: boolean
  /** 'operator' | 'agent' | 'none' */
  engagedVia: string
  goalReached: boolean
  moving: boolean
  raw: Record<string, unknown>
}

export type PanelPreset = { name: string; desc: string; qDeg: number[] }

export class PanelError extends Error {}

const DEFAULT_TIMEOUT_MS = 4000

async function getJson(url: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' })
    if (!res.ok) throw new PanelError(`${url} -> HTTP ${res.status}`)
    return (await res.json()) as Record<string, unknown>
  } catch (err) {
    if (err instanceof PanelError) throw err
    throw new PanelError(`${url} unreachable: ${(err as Error).message}`)
  } finally {
    clearTimeout(timer)
  }
}

export class PanelClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {
    if (!/^https?:\/\//.test(baseUrl)) throw new PanelError(`panel URL must be http(s): ${baseUrl}`)
  }

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`
  }

  /** Live joint state. `GET /api/state` on the panel. */
  async state(): Promise<ArmState> {
    const raw = await getJson(this.url('/api/state'), this.timeoutMs)
    const q = Array.isArray(raw.q) ? (raw.q as unknown[]).map((v) => Number(v)) : []
    return {
      q,
      engaged: Boolean(raw.engaged),
      engagedVia: String(raw.engaged_via ?? 'none'),
      goalReached: Boolean(raw.goal_reached),
      moving: Boolean(raw.moving),
      raw,
    }
  }

  /** Whitelisted poses the arm may be sent to. `GET /api/presets`. */
  async presets(): Promise<PanelPreset[]> {
    const raw = await getJson(this.url('/api/presets'), this.timeoutMs)
    const presets = (raw.presets ?? {}) as Record<string, { desc?: string; q_deg?: number[] }>
    return Object.entries(presets).map(([name, value]) => ({
      name,
      desc: String(value?.desc ?? ''),
      qDeg: Array.isArray(value?.q_deg) ? value.q_deg.map(Number) : [],
    }))
  }

  /** Camera + arm diagnostics. `GET /health`. */
  async health(): Promise<Record<string, unknown>> {
    return getJson(this.url('/health'), this.timeoutMs)
  }

  /** True when the panel answers and its CAN feedback is fresh. */
  async isReachable(): Promise<boolean> {
    try {
      await this.state()
      return true
    } catch {
      return false
    }
  }

  /** MJPEG stream URL for embedding a camera view in the admin UI. */
  streamUrl(camera: string = 'robot'): string {
    return this.url(`/stream/${encodeURIComponent(camera)}`)
  }

  /**
   * Post a line into the panel's event feed, so the operator standing at the
   * arm sees what the business system just asked for. `POST /api/event`.
   */
  async say(text: string, kind: 'chat' | 'status' | 'alert' | 'log' = 'status'): Promise<void> {
    const res = await fetch(this.url('/api/event'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'mercato', kind, text }),
    })
    if (!res.ok) throw new PanelError(`POST /api/event -> HTTP ${res.status}`)
  }
}
