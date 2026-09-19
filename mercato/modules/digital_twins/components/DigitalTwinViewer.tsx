'use client'

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { Button } from '@open-mercato/ui/primitives/button'
import { Checkbox } from '@open-mercato/ui/primitives/checkbox'
import { Input } from '@open-mercato/ui/primitives/input'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { roomManifestSchema, type RoomManifest } from '../data/validators'

type Viewer = {
  dispose(): void
  fit(): void
  setView(mode: 'top' | '3d'): void
  setLayer(id: string, visible: boolean): void
  select(id: string | null, focus?: boolean): void
}
type RendererModule = {
  create(container: HTMLElement, buffer: ArrayBuffer, manifest: RoomManifest, onSelect: (id: string | null) => void, onError: (reason: string) => void): Promise<Viewer>
}
declare global { interface Window { DigitalTwinRenderer?: RendererModule } }
let rendererPromise: Promise<RendererModule> | null = null

function loadRenderer(): Promise<RendererModule> {
  if (window.DigitalTwinRenderer) return Promise.resolve(window.DigitalTwinRenderer)
  if (rendererPromise) return rendererPromise
  rendererPromise = new Promise<RendererModule>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = '/api/digital_twins/assets/viewer.js'
    script.async = true
    script.onload = () => window.DigitalTwinRenderer ? resolve(window.DigitalTwinRenderer) : reject(new Error('renderer_unavailable'))
    script.onerror = () => reject(new Error('renderer_unavailable'))
    document.head.appendChild(script)
  }).catch((error: unknown) => { rendererPromise = null; throw error })
  return rendererPromise
}

export default function DigitalTwinViewer() {
  const t = useT()
  const host = React.useRef<HTMLDivElement>(null)
  const viewer = React.useRef<Viewer | null>(null)
  const [manifest, setManifest] = React.useState<RoomManifest | null>(null)
  const [ready, setReady] = React.useState(false)
  const [error, setError] = React.useState(false)
  const [attempt, setAttempt] = React.useState(0)
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [layers, setLayers] = React.useState<Record<string, boolean>>({})
  const [query, setQuery] = React.useState('')
  const [view, setView] = React.useState<'top' | '3d'>('3d')

  React.useEffect(() => {
    const controller = new AbortController()
    let current: Viewer | null = null
    setReady(false); setError(false); setSelectedId(null); setView('3d')
    async function initialize() {
      try {
        const response = await apiCallOrThrow<RoomManifest>('/api/digital_twins/room', { signal: controller.signal })
        const room = roomManifestSchema.parse(response.result)
        if (controller.signal.aborted) return
        setManifest(room)
        setLayers(Object.fromEntries(room.layers.map((layer) => [layer.id, layer.defaultVisible])))
        const [renderer, model] = await Promise.all([
          loadRenderer(),
          apiCallOrThrow<ArrayBuffer>(room.modelUrl, { signal: controller.signal }, { parse: (response) => response.arrayBuffer() }),
        ])
        if (controller.signal.aborted || !host.current || !model.result) return
        current = await renderer.create(host.current, model.result, room, setSelectedId, () => { setError(true); setReady(false) })
        if (controller.signal.aborted) { current.dispose(); return }
        viewer.current = current
        setReady(true)
      } catch {
        if (!controller.signal.aborted) { current?.dispose(); setError(true) }
      }
    }
    void initialize()
    return () => { controller.abort(); current?.dispose(); viewer.current = null }
  }, [attempt])

  const selected = manifest?.elements.find((element) => element.id === selectedId)
  const visibleElements = manifest?.elements.filter((element) => layers[element.layerId] && element.label.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? []
  const changeView = (mode: 'top' | '3d') => { setView(mode); viewer.current?.setView(mode) }
  const toggleLayer = (id: string, visible: boolean) => { setLayers((previous) => ({ ...previous, [id]: visible })); viewer.current?.setLayer(id, visible) }

  return <Page>
    <PageHeader title={t('digital_twins.title')} description={t('digital_twins.description')}
      actions={<Badge variant="secondary">{t('digital_twins.geometry')}</Badge>} />
    <PageBody>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label={t('digital_twins.controls')}>
          <Button variant={view === '3d' ? 'default' : 'outline'} disabled={!ready} aria-pressed={view === '3d'} onClick={() => changeView('3d')}>{t('digital_twins.view3d')}</Button>
          <Button variant={view === 'top' ? 'default' : 'outline'} disabled={!ready} aria-pressed={view === 'top'} onClick={() => changeView('top')}>{t('digital_twins.top')}</Button>
          <Button variant="outline" disabled={!ready} onClick={() => viewer.current?.fit()}>{t('digital_twins.fit')}</Button>
          {manifest ? <span className="text-sm text-muted-foreground">{(manifest.stats.modelBytes / 1000000).toFixed(2)} MB · {manifest.elements.length} {t('digital_twins.elementsCount')}</span> : null}
        </div>
        <div className="grid gap-4 lg:grid-cols-4">
          <div className="space-y-3 lg:col-span-3">
            <div className="relative aspect-square overflow-hidden rounded-lg border bg-muted sm:aspect-video" onKeyDown={(event) => { if (event.key === 'Escape') viewer.current?.select(null) }}>
              <div ref={host} className="absolute inset-0" role="img" aria-label={t('digital_twins.canvas')} />
              {!ready && manifest ? <img className="absolute inset-0 h-full w-full object-contain" src={manifest.posterUrl} alt={t('digital_twins.poster')} /> : null}
              {!ready && !error ? <div className="absolute inset-x-4 bottom-4" role="status"><LoadingMessage label={t('digital_twins.loading')} /></div> : null}
              {error ? <div className="absolute inset-x-4 bottom-4"><ErrorMessage label={t('digital_twins.error')} description={t('digital_twins.errorHelp')} action={<Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>{t('digital_twins.retry')}</Button>} /></div> : null}
            </div>
            <p className="text-sm text-muted-foreground">{t('digital_twins.help')}</p>
            <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">{t('digital_twins.provenance')}</div>
          </div>
          <aside className="space-y-4" aria-label={t('digital_twins.inspector')}>
            <section className="space-y-3 rounded-lg border bg-card p-4">
              <h2 className="font-medium">{t('digital_twins.layers')}</h2>
              {manifest?.layers.map((layer) => <label key={layer.id} className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox checked={layers[layer.id] ?? false} disabled={!ready} onCheckedChange={(value) => toggleLayer(layer.id, value === true)} />
                <span>{t(`digital_twins.layer.${layer.id}`, layer.label)}</span>
                <span className="ml-auto text-muted-foreground">{layer.objectCount}</span>
              </label>)}
            </section>
            <section className="space-y-3 rounded-lg border bg-card p-4" aria-live="polite">
              <h2 className="font-medium">{t('digital_twins.selected')}</h2>
              {selected ? <>
                <p className="break-words text-sm font-medium">{selected.label}</p>
                <Badge variant="outline">{t(`digital_twins.confidence.${selected.confidence}`)}</Badge>
                <p className="text-sm text-muted-foreground">{t('digital_twins.dimensions')}</p>
                <p className="text-sm tabular-nums">{[0, 2, 1].map((axis) => (selected.bounds.max[axis] - selected.bounds.min[axis]).toFixed(2)).join(' × ')} m</p>
                <Button variant="outline" size="sm" onClick={() => viewer.current?.select(null)}>{t('digital_twins.clear')}</Button>
              </> : <p className="text-sm text-muted-foreground">{t('digital_twins.selectHelp')}</p>}
            </section>
            <section className="space-y-3 rounded-lg border bg-card p-4">
              <h2 className="font-medium">{t('digital_twins.elements')}</h2>
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('digital_twins.search')} aria-label={t('digital_twins.search')} />
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {visibleElements.map((element) => <Button key={element.id} variant={selectedId === element.id ? 'secondary' : 'ghost'} size="sm" className="h-auto w-full justify-start whitespace-normal text-left" disabled={!ready} aria-pressed={selectedId === element.id} onClick={() => viewer.current?.select(element.id, true)}>{element.label}</Button>)}
                {manifest && !visibleElements.length ? <p className="text-sm text-muted-foreground">{t('digital_twins.noResults')}</p> : null}
              </div>
            </section>
          </aside>
        </div>
      </div>
    </PageBody>
  </Page>
}
