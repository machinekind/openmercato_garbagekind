import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

export async function create(container, buffer, manifest, onSelect, onError) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1
  container.appendChild(renderer.domElement)
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  renderer.domElement.style.touchAction = 'none'
  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight(0xffffff, 0x687078, 1.8))
  const light = new THREE.DirectionalLight(0xffffff, 2)
  light.position.set(-8, 22, 12)
  scene.add(light)
  const perspective = new THREE.PerspectiveCamera(42, 1, .05, 500)
  const top = new THREE.OrthographicCamera(-15, 15, 15, -15, .05, 500)
  let camera = perspective
  let disposed = false
  let frame = 0
  let controls
  let model
  const selection = new THREE.Box3Helper(new THREE.Box3(), 0xec8800)
  selection.visible = false
  scene.add(selection)
  const nodes = new Map()
  const requestRender = () => {
    if (disposed || frame) return
    frame = requestAnimationFrame(() => { frame = 0; renderer.render(scene, camera) })
  }
  const boxFor = (bounds) => new THREE.Box3(new THREE.Vector3(...bounds.min), new THREE.Vector3(...bounds.max))
  const wholeBox = boxFor(manifest.bounds)
  const size = wholeBox.getSize(new THREE.Vector3())
  const center = wholeBox.getCenter(new THREE.Vector3())
  const resetControls = () => {
    controls?.dispose()
    controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = false
    controls.enableRotate = camera === perspective
    controls.minDistance = .3
    controls.maxDistance = 100
    controls.maxPolarAngle = Math.PI * .49
    controls.target.copy(center)
    controls.addEventListener('change', requestRender)
  }
  const resize = () => {
    const width = Math.max(container.clientWidth, 1)
    const height = Math.max(container.clientHeight, 1)
    const aspect = width / height
    renderer.setSize(width, height, false)
    perspective.aspect = aspect
    perspective.updateProjectionMatrix()
    const extent = Math.max(size.z * .6, size.x * .6 / aspect)
    top.left = -extent * aspect; top.right = extent * aspect
    top.top = extent; top.bottom = -extent
    top.updateProjectionMatrix()
    requestRender()
  }
  const fit = () => {
    camera.zoom = 1
    if (camera === top) {
      camera.up.set(0, 0, -1)
      camera.position.set(center.x, manifest.bounds.max[1] + 35, center.z)
    } else {
      const direction = new THREE.Vector3(.85, 1.15, 1.1).normalize()
      const right = new THREE.Vector3().crossVectors(camera.up, direction).normalize()
      const up = new THREE.Vector3().crossVectors(direction, right).normalize()
      const tangent = Math.tan(THREE.MathUtils.degToRad(21))
      let distance = 0
      for (const horizontal of [-1, 1]) for (const vertical of [-1, 1]) for (const depth of [-1, 1]) {
        const corner = new THREE.Vector3(size.x * horizontal / 2, size.y * vertical / 2, size.z * depth / 2)
        distance = Math.max(distance, corner.dot(direction) + Math.max(Math.abs(corner.dot(right)) / (tangent * perspective.aspect), Math.abs(corner.dot(up)) / tangent))
      }
      camera.position.copy(center).add(direction.multiplyScalar(distance * 1.08))
    }
    controls.target.copy(center)
    camera.lookAt(center)
    camera.updateProjectionMatrix()
    controls.update()
    requestRender()
  }
  const select = (id, focus = false) => {
    const element = manifest.elements.find((entry) => entry.id === id)
    selection.visible = Boolean(element && nodes.get(id)?.visible)
    if (element) {
      selection.box.copy(boxFor(element.bounds))
      if (focus) {
        const target = selection.box.getCenter(new THREE.Vector3())
        camera.position.add(target.clone().sub(controls.target))
        controls.target.copy(target)
        controls.update()
      }
    }
    onSelect(element?.id ?? null)
    requestRender()
  }
  const raycaster = new THREE.Raycaster()
  let pointerDown = null
  const down = (event) => { pointerDown = event.button === 0 ? [event.clientX, event.clientY] : null }
  const up = (event) => {
    if (!pointerDown || Math.hypot(event.clientX-pointerDown[0], event.clientY-pointerDown[1]) > 5) return
    pointerDown = null
    const rect = renderer.domElement.getBoundingClientRect()
    raycaster.setFromCamera(new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1, -(event.clientY-rect.top)/rect.height*2+1), camera)
    for (const hit of raycaster.intersectObject(model, true)) {
      let current = hit.object
      let id = null
      let visible = true
      while (current) { visible &&= current.visible; id ||= current.userData.elementId; current = current.parent }
      if (visible && id) { select(id); return }
    }
    select(null)
  }
  const contextLost = (event) => { event.preventDefault(); onError('webgl') }
  const observer = new ResizeObserver(resize)
  const dispose = () => {
    if (disposed) return
    disposed = true
    cancelAnimationFrame(frame)
    observer.disconnect()
    controls?.dispose()
    renderer.domElement.removeEventListener('pointerdown', down)
    renderer.domElement.removeEventListener('pointerup', up)
    renderer.domElement.removeEventListener('webglcontextlost', contextLost)
    scene.traverse((object) => {
      object.geometry?.dispose()
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      materials.forEach((material) => material?.dispose())
    })
    renderer.dispose()
    renderer.forceContextLoss()
    renderer.domElement.remove()
  }
  try {
    model = (await new GLTFLoader().parseAsync(buffer, '')).scene
    scene.add(model)
    model.traverse((object) => { if (object.userData.elementId) nodes.set(object.userData.elementId, object) })
    manifest.elements.forEach((element) => {
      const node = nodes.get(element.id)
      if (!node) throw new Error('Missing element: ' + element.id)
      node.visible = manifest.layers.find((layer) => layer.id === element.layerId).defaultVisible
    })
    resetControls(); resize(); fit()
    observer.observe(container)
    renderer.domElement.addEventListener('pointerdown', down)
    renderer.domElement.addEventListener('pointerup', up)
    renderer.domElement.addEventListener('webglcontextlost', contextLost)
    return {
      dispose, fit, select,
      setView(mode) { camera = mode === 'top' ? top : perspective; resetControls(); resize(); fit() },
      setLayer(id, visible) {
        manifest.elements.filter((element) => element.layerId === id).forEach((element) => { nodes.get(element.id).visible = visible })
        selection.visible = false
        onSelect(null)
        requestRender()
      },
    }
  } catch (error) { dispose(); throw error }
}
