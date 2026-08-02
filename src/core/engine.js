import * as THREE from 'three'

export function createEngine(mountId = 'app') {
  const mount = document.getElementById(mountId)

  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    powerPreference: 'high-performance',
    stencil: false,
    alpha: false,
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.NoToneMapping // post stack owns tone mapping
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  mount.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(28, window.innerWidth / window.innerHeight, 1, 4000)
  camera.position.set(60, 90, 120)
  camera.lookAt(0, 0, 0)

  const clock = new THREE.Clock()
  const listeners = []
  const onResize = () => {
    const w = window.innerWidth
    const h = window.innerHeight
    renderer.setSize(w, h)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    for (const fn of listeners) fn(w, h)
  }
  window.addEventListener('resize', onResize)

  return {
    renderer,
    scene,
    camera,
    clock,
    onResize: (fn) => listeners.push(fn),
    get size() {
      return { w: window.innerWidth, h: window.innerHeight }
    },
  }
}

const KEYMAP = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  ShiftLeft: 'run', ShiftRight: 'run',
  KeyQ: 'rotL', KeyE: 'rotR',
  Equal: 'zoomIn', Minus: 'zoomOut',
}

export function createInput() {
  const down = new Set()
  window.addEventListener('keydown', (e) => {
    const k = KEYMAP[e.code]
    if (k) { down.add(k); e.preventDefault() }
  })
  window.addEventListener('keyup', (e) => {
    const k = KEYMAP[e.code]
    if (k) down.delete(k)
  })
  window.addEventListener('blur', () => down.clear())

  const state = { x: 0, y: 0, run: false, zoom: 0, rotate: 0 }
  return {
    state,
    poll() {
      state.x = (down.has('right') ? 1 : 0) - (down.has('left') ? 1 : 0)
      state.y = (down.has('down') ? 1 : 0) - (down.has('up') ? 1 : 0)
      state.run = down.has('run')
      state.rotate = (down.has('rotR') ? 1 : 0) - (down.has('rotL') ? 1 : 0)
      state.zoom = (down.has('zoomIn') ? 1 : 0) - (down.has('zoomOut') ? 1 : 0)
      return state
    },
  }
}
