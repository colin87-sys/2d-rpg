// Battle screen entry point (integrator-owned, BATTLE_CONTRACT "Entry point").
//
// Query params:
//   ?variant=hall|highland   which arena/enemy ships (default 'hall')
//   ?freeze=firaga           choreo advances to the burst peak and holds, so the
//                            screenshot harness lands a deterministic instant
//
// Construction order is the contract's, verbatim:
//   engine/renderer → createArena → sheets ×4 + enemy art → createUnits →
//   createVFX → createTimeline → createPanels → createCallouts →
//   createChoreography → createBattlePost
//
// Per-frame order is the contract's "Integration notes", verbatim:
//   arena.update(t, camera) → choreo.update(dt) → units.update(dt, camera) →
//   vfx.update(dt, camera) → timeline.update(dt) → panels.update(dt) →
//   callouts.update(dt) → post.render(dt, vfx.impulses)

import * as THREE from 'three'
import { createEngine } from '../core/engine.js'
import { createArena } from './arena.js'
import { makeBattlerSheet } from './art/battlerSheet.js'
import { makeDragonArt, makeSorcererArt } from './art/enemySprite.js'
import { createUnits } from './units.js'
import { createVFX } from './vfx.js'
import { createTimeline } from './ui/timeline.js'
import { createPanels } from './ui/panels.js'
import { createCallouts } from './ui/callouts.js'
import { createChoreography } from './choreo.js'
import { createBattlePost } from './post.js'

const PARTY = ['rain', 'lasswell', 'fina', 'lid']
const DEG = Math.PI / 180

function readVariant() {
  let v = 'hall'
  try {
    const q = new URLSearchParams(window.location.search).get('variant')
    if (q && String(q).toLowerCase().trim() === 'highland') v = 'highland'
  } catch (_) { /* default hall */ }
  return v
}

/** BIBLE §1: fixed proscenium — position, pitch, vFOV, near/far off the arena. */
function applyArenaCamera(camera, spec) {
  if (!spec) return
  if (spec.position) camera.position.copy(spec.position)
  // Yaw 0, pitch `pitchDeg` downward, no roll. YXZ so pitch stays pitch.
  camera.rotation.order = 'YXZ'
  camera.rotation.set(-(spec.pitchDeg || 0) * DEG, 0, 0)
  if (spec.fovDeg) camera.fov = spec.fovDeg
  if (spec.near) camera.near = spec.near
  if (spec.far) camera.far = spec.far
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
}

async function boot() {
  const variant = readVariant()
  document.title = `Aetherbound — Battle (${variant})`

  // ---- engine / renderer --------------------------------------------------
  const engine = createEngine('app')
  const { renderer, scene, camera } = engine

  // ---- arena --------------------------------------------------------------
  const arena = createArena({ renderer, scene, variant })
  scene.add(arena.object3D)
  applyArenaCamera(camera, arena.camera)

  // ---- sheets ×4 + enemy art ----------------------------------------------
  const sheets = {}
  for (const id of PARTY) sheets[id] = makeBattlerSheet(id)
  const enemyArt = variant === 'highland' ? makeSorcererArt() : makeDragonArt()

  // ---- staging ------------------------------------------------------------
  const units = createUnits({ arena, sheets, enemyArt, renderer })
  scene.add(units.object3D)

  // ---- vfx ----------------------------------------------------------------
  const vfx = createVFX({ scene, arena, units, renderer })
  if (vfx.object3D && vfx.object3D.parent !== scene) scene.add(vfx.object3D)

  // ---- UI (DOM in #ui, above the canvas) ----------------------------------
  const uiRoot = document.getElementById('ui')
  const timeline = createTimeline({ units })
  const panels = createPanels({ units })
  const callouts = createCallouts({ units, camera })
  for (const ui of [timeline, panels, callouts]) {
    if (ui && ui.dom && ui.dom.parentNode !== uiRoot) uiRoot.appendChild(ui.dom)
  }

  // ---- turn logic ---------------------------------------------------------
  const choreo = createChoreography({ units, vfx, timeline, panels, callouts })

  // ---- post ---------------------------------------------------------------
  const post = createBattlePost({ renderer, scene, camera, variant })

  engine.onResize((w, h) => {
    post.setSize(w, h)
    applyArenaCamera(camera, arena.camera) // aspect changed; keep the solve
  })

  window.__POC = { ready: false, engine, THREE, variant, arena, units, vfx, choreo, post }

  // A "fully-populated frame" means the whole chain has run at least once and
  // the enemy + party have projected screen anchors the UI could read. On
  // SwiftShader the first couple of frames are still uploading textures, so we
  // hold `ready` until the stage has actually drawn.
  let frames = 0
  const tick = () => {
    requestAnimationFrame(tick)
    const wallDt = engine.clock.getDelta()
    // Clamp sim dt: a 2–4 fps software-GL frame must not tunnel the choreo
    // state machine past the burst. UI/torch presentation runs on wall time.
    const dt = Math.min(wallDt, 1 / 20)
    const t = engine.clock.elapsedTime

    arena.update(t, camera)
    choreo.update(dt)
    units.update(dt, camera)
    vfx.update(dt, camera)
    timeline.update(dt)
    panels.update(dt)
    callouts.update(dt)
    post.render(dt, vfx.impulses)

    if (++frames === 4) {
      document.getElementById('boot')?.classList.add('hidden')
      window.__POC.ready = true
    }
  }
  tick()
}

boot().catch((err) => {
  console.error(err)
  const el = document.getElementById('boot')
  if (el) el.textContent = String(err && err.stack ? err.stack : err)
})
