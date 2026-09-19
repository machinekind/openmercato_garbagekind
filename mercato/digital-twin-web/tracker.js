import '@tensorflow/tfjs'
import * as cocoSsd from '@tensorflow-models/coco-ssd'

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

function projectToFloor(point, calibration) {
  const polygon = calibration.imageFloorPolygon
  const floor = calibration.twinFloorPolygon
  const horizon = (polygon[2][1] + polygon[3][1]) / 2
  const foreground = (polygon[0][1] + polygon[1][1]) / 2
  const v = clamp((point[1] - horizon) / Math.max(foreground - horizon, .01), 0, 1)
  const leftImage = polygon[3][0] + (polygon[0][0] - polygon[3][0]) * v
  const rightImage = polygon[2][0] + (polygon[1][0] - polygon[2][0]) * v
  const u = clamp((point[0] - leftImage) / Math.max(rightImage - leftImage, .01), 0, 1)
  const leftWorld = [floor[3][0] + (floor[0][0] - floor[3][0]) * v, floor[3][1] + (floor[0][1] - floor[3][1]) * v]
  const rightWorld = [floor[2][0] + (floor[1][0] - floor[2][0]) * v, floor[2][1] + (floor[1][1] - floor[2][1]) * v]
  return keepOnFloor([leftWorld[0] + (rightWorld[0] - leftWorld[0]) * u, leftWorld[1] + (rightWorld[1] - leftWorld[1]) * u], calibration)
}

function keepOnFloor(world, calibration) {
  let [x, z] = world
  for (const obstacle of calibration.obstacles ?? []) {
    const [sourceMinX, sourceMinZ, sourceMaxX, sourceMaxZ] = obstacle.bounds
    const minX = sourceMinX - obstacle.clearance
    const minZ = sourceMinZ - obstacle.clearance
    const maxX = sourceMaxX + obstacle.clearance
    const maxZ = sourceMaxZ + obstacle.clearance
    if (x < minX || x > maxX || z < minZ || z > maxZ) continue
    const edges = [
      [Math.abs(x - minX), 'minX'], [Math.abs(maxX - x), 'maxX'],
      [Math.abs(z - minZ), 'minZ'], [Math.abs(maxZ - z), 'maxZ'],
    ].sort((a, b) => a[0] - b[0])
    if (edges[0][1] === 'minX') x = minX
    else if (edges[0][1] === 'maxX') x = maxX
    else if (edges[0][1] === 'minZ') z = minZ
    else z = maxZ
  }
  return [x, z]
}

function createTracker(calibration) {
  let nextId = 1
  const tracks = new Map()
  return (detections, time) => {
    const candidates = new Set(tracks.keys())
    for (const detection of detections) {
      let best = null
      let bestDistance = 1.9
      for (const id of candidates) {
        const track = tracks.get(id)
        const distance = Math.hypot(track.x - detection.world[0], track.z - detection.world[1])
        if (distance < bestDistance) { best = id; bestDistance = distance }
      }
      const id = best ?? nextId++
      const previous = tracks.get(id)
      const elapsed = previous ? Math.max((time - previous.seenAt) / 1000, .001) : 0
      const projected = keepOnFloor([
        previous ? previous.x * .58 + detection.world[0] * .42 : detection.world[0],
        previous ? previous.z * .58 + detection.world[1] * .42 : detection.world[1],
      ], calibration)
      const [x, z] = projected
      const segment = previous ? Math.hypot(x - previous.x, z - previous.z) : 0
      tracks.set(id, {
        id: `T-${String(id).padStart(2, '0')}`, x, z,
        confidence: detection.score,
        speed: elapsed ? segment / elapsed : 0,
        distance: (previous?.distance ?? 0) + segment,
        seenAt: time,
        box: detection.box,
        trail: [...(previous?.trail ?? []), [x, z]].slice(-24),
      })
      if (best) candidates.delete(best)
    }
    for (const [id, track] of tracks) if (time - track.seenAt > 2400) tracks.delete(id)
    return [...tracks.values()]
  }
}

export async function create(video, canvas, calibration, callbacks = {}) {
  let disposed = false
  let running = false
  let timer = 0
  let objectModel = null
  const updateTracks = createTracker(calibration)
  const context = canvas.getContext('2d')

  const resize = () => {
    if (!video.videoWidth || !video.videoHeight) return
    if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth
    if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight
  }
  const draw = (tracks) => {
    resize()
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.lineWidth = Math.max(3, canvas.width / 480)
    context.font = `${Math.max(18, canvas.width / 54)}px ui-sans-serif`
    for (const track of tracks) {
      const [x, y, width, height] = track.box
      context.strokeStyle = '#f59e0b'; context.fillStyle = '#f59e0b'
      context.strokeRect(x, y, width, height)
      context.fillText(`${track.id} · ${Math.round(track.confidence * 100)}%`, x, Math.max(24, y - 8))
    }
  }
  const tick = async () => {
    if (!running || disposed || video.paused || video.ended) return
    try {
      const predictions = await objectModel.detect(video, 20, .42)
      const detections = predictions.filter((item) => item.class === 'person').map((item) => {
        const [x, y, width, height] = item.bbox
        const foot = [(x + width / 2) / video.videoWidth, (y + height) / video.videoHeight]
        return { box: item.bbox, score: item.score, world: projectToFloor(foot, calibration) }
      })
      const tracks = updateTracks(detections, performance.now())
      draw(tracks)
      callbacks.onTracks?.(tracks)
    } catch (error) {
      callbacks.onError?.(error)
      running = false
      return
    }
    timer = window.setTimeout(tick, 260)
  }
  return {
    async start() {
      if (disposed || running) return
      callbacks.onState?.('loading')
      objectModel ||= await cocoSsd.load({ base: 'lite_mobilenet_v2', modelUrl: '/api/digital_twins/assets/detector.model.json' })
      if (disposed) return
      running = true
      callbacks.onState?.('running')
      await video.play()
      void tick()
    },
    pause() { running = false; window.clearTimeout(timer); video.pause(); callbacks.onState?.('paused') },
    dispose() { disposed = true; running = false; window.clearTimeout(timer); context.clearRect(0, 0, canvas.width, canvas.height) },
  }
}
