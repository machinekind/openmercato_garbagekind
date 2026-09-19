'use client'

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { cameraManifestSchema, type CameraDefinition, type CameraManifest } from '../data/validators'

export type WorkerTrack = { id: string; x: number; z: number; confidence: number; speed: number; distance: number; seenAt: number; trail: [number, number][] }
type Tracker = { start(): Promise<void>; pause(): void; dispose(): void }
type TrackerModule = { create(video: HTMLVideoElement, canvas: HTMLCanvasElement, calibration: CameraDefinition['calibration'], callbacks: { onTracks(tracks: WorkerTrack[]): void; onState(state: TrackerState): void; onError(): void }): Promise<Tracker> }
type TrackerState = 'idle' | 'loading' | 'running' | 'paused' | 'error'

declare global { interface Window { PhysicalAiTracker?: TrackerModule } }
let trackerModulePromise: Promise<TrackerModule> | null = null

function loadTracker(): Promise<TrackerModule> {
  if (window.PhysicalAiTracker) return Promise.resolve(window.PhysicalAiTracker)
  if (trackerModulePromise) return trackerModulePromise
  trackerModulePromise = new Promise<TrackerModule>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = '/api/digital_twins/assets/tracker.js'; script.async = true
    script.onload = () => window.PhysicalAiTracker ? resolve(window.PhysicalAiTracker) : reject(new Error('tracker_unavailable'))
    script.onerror = () => reject(new Error('tracker_unavailable'))
    document.head.appendChild(script)
  }).catch((error: unknown) => { trackerModulePromise = null; throw error })
  return trackerModulePromise
}

export default function CameraManagement({ onCamera, onTracks }: { onCamera(camera: CameraDefinition | null): void; onTracks(tracks: WorkerTrack[]): void }) {
  const t = useT()
  const video = React.useRef<HTMLVideoElement>(null)
  const canvas = React.useRef<HTMLCanvasElement>(null)
  const tracker = React.useRef<Tracker | null>(null)
  const objectUrl = React.useRef<string | null>(null)
  const [registry, setRegistry] = React.useState<CameraManifest | null>(null)
  const [camera, setCamera] = React.useState<CameraDefinition | null>(null)
  const [fileName, setFileName] = React.useState('')
  const [state, setState] = React.useState<TrackerState>('idle')
  const [tracks, setTracks] = React.useState<WorkerTrack[]>([])
  const [mediaError, setMediaError] = React.useState(false)

  React.useEffect(() => {
    const controller = new AbortController()
    void apiCallOrThrow<CameraManifest>('/api/digital_twins/cameras', { signal: controller.signal }).then((response) => {
      const parsed = cameraManifestSchema.parse(response.result)
      if (controller.signal.aborted) return
      setRegistry(parsed); setCamera(parsed.cameras[0] ?? null); onCamera(parsed.cameras[0] ?? null)
    }).catch(() => { if (!controller.signal.aborted) setState('error') })
    return () => controller.abort()
  }, [onCamera])

  React.useEffect(() => () => {
    tracker.current?.dispose()
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    onTracks([]); onCamera(null)
  }, [onCamera, onTracks])

  const selectFile = (file?: File) => {
    tracker.current?.dispose(); tracker.current = null; setTracks([]); onTracks([]); setState('idle'); setMediaError(false)
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    objectUrl.current = file ? URL.createObjectURL(file) : null
    setFileName(file?.name ?? '')
    if (video.current) { video.current.src = objectUrl.current ?? ''; video.current.load() }
  }
  const start = async () => {
    if (!camera || !video.current || !canvas.current || !fileName) return
    try {
      tracker.current ||= await (await loadTracker()).create(video.current, canvas.current, camera.calibration, {
        onState: setState,
        onError: () => setState('error'),
        onTracks: (value) => { setTracks(value); onTracks(value) },
      })
      await tracker.current.start()
    } catch { setState('error') }
  }
  const pause = () => tracker.current?.pause()

  return <section className="space-y-4 rounded-lg border bg-card p-4" aria-label={t('digital_twins.cameras.title')}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-lg font-medium">{t('digital_twins.cameras.title')}</h2><p className="text-sm text-muted-foreground">{t('digital_twins.cameras.description')}</p></div>
      <div className="flex gap-2"><Badge variant="secondary">{registry?.cameras.length ?? 0} {t('digital_twins.cameras.count')}</Badge><Badge variant="outline">{t('digital_twins.cameras.private')}</Badge></div>
    </div>
    {camera ? <div className="grid gap-4 xl:grid-cols-3">
      <div className="space-y-3 xl:col-span-2">
        <div className="relative aspect-video overflow-hidden rounded-md bg-black">
          <video ref={video} className="h-full w-full object-contain" controls muted playsInline preload="metadata" onError={() => setMediaError(true)} />
          <canvas ref={canvas} className="pointer-events-none absolute inset-0 h-full w-full object-contain" />
          {!fileName ? <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-white/70">{t('digital_twins.cameras.selectRecording')}</div> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex h-9 cursor-pointer items-center rounded-md border px-3 text-sm font-medium hover:bg-accent">
            {t('digital_twins.cameras.chooseFile')}<input className="sr-only" type="file" accept="video/*,.mov" onChange={(event) => selectFile(event.target.files?.[0])} />
          </label>
          <Button onClick={() => void start()} disabled={!fileName || state === 'loading' || state === 'running'}>{state === 'loading' ? t('digital_twins.cameras.loadingModel') : t('digital_twins.cameras.start')}</Button>
          <Button variant="outline" onClick={pause} disabled={state !== 'running'}>{t('digital_twins.cameras.pause')}</Button>
          {fileName ? <span className="max-w-64 truncate text-sm text-muted-foreground" title={fileName}>{fileName}</span> : null}
        </div>
        {mediaError ? <p className="text-sm text-destructive">{t('digital_twins.cameras.codecError')}</p> : null}
        {state === 'error' ? <p className="text-sm text-destructive">{t('digital_twins.cameras.trackerError')}</p> : null}
      </div>
      <aside className="space-y-3">
        <div className="rounded-md border p-3"><p className="font-medium">{camera.name}</p><p className="text-sm text-muted-foreground">{camera.location}</p><div className="mt-2 flex gap-2"><Badge variant="outline">{camera.source.width}×{camera.source.height}</Badge><Badge variant={camera.calibration.state === 'verified' ? 'secondary' : 'outline'}>{t(`digital_twins.cameras.calibration.${camera.calibration.state}`)}</Badge></div></div>
        <div className="rounded-md border p-3"><p className="text-sm text-muted-foreground">{t('digital_twins.cameras.activeTracks')}</p><p className="text-3xl font-semibold tabular-nums">{tracks.length}</p></div>
        <div className="max-h-52 space-y-2 overflow-y-auto">
          {tracks.map((track) => <div key={track.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"><span className="font-medium">{track.id}</span><span className="tabular-nums text-muted-foreground">{track.speed.toFixed(1)} m/s · {track.distance.toFixed(1)} m</span></div>)}
        </div>
        <p className="text-xs text-muted-foreground">{t('digital_twins.cameras.privacyHelp')}</p>
      </aside>
    </div> : <p className="text-sm text-muted-foreground">{t('digital_twins.cameras.loadingRegistry')}</p>}
  </section>
}
