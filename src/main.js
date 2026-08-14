import * as THREE from 'three'
import { createEngine, createInput } from './core/engine.js'
import { makeVegetationAtlas } from './art/atlas.js'
import { makeHeroSheet } from './art/characterSprite.js'
import { createTerrain } from './world/terrain.js'
import { createWater } from './world/water.js'
import { createScatter } from './world/scatter.js'
import { createProps } from './world/props.js'
import { createSkyAndLights } from './gfx/sky.js'
import { createPostFX } from './gfx/post.js'
import { createPlayer, createCameraRig } from './game/player.js'
import { createHUD } from './ui/hud.js'

const WORLD = 512
const SEED = 20260802

async function boot() {
  const engine = createEngine('app')
  const { renderer, scene, camera } = engine
  const input = createInput()

  const atlas = makeVegetationAtlas(renderer)
  const heroSheet = makeHeroSheet()

  const terrain = createTerrain({ size: WORLD, seed: SEED, renderer })
  scene.add(terrain.object3D)

  const sky = createSkyAndLights({ scene, renderer, terrain })
  if (sky.object3D) scene.add(sky.object3D)

  const water = createWater({ terrain, renderer, sky })
  scene.add(water.object3D)

  const scatter = createScatter({ terrain, atlas, renderer })
  scene.add(scatter.object3D)

  const props = createProps({ terrain, atlas, renderer })
  scene.add(props.object3D)

  const player = createPlayer({ terrain, sheet: heroSheet, renderer })
  scene.add(player.object3D)

  const rig = createCameraRig({ camera, player, terrain })
  const post = createPostFX({ renderer, scene, camera })
  const hud = createHUD({ terrain, player })

  engine.onResize((w, h) => post.setSize(w, h))

  window.__POC = { ready: false, engine, terrain, post, sky, scatter, player, rig, THREE }

  // ---- asset gate ---------------------------------------------------------
  // characterSprite.js now loads PNGs instead of drawing them. TextureLoader
  // returns a Texture synchronously and fills the image in later, which is what
  // keeps the contract's factories synchronous — but the first frames then draw
  // with empty textures, and the capture harness waits on __POC.ready. Without
  // this gate the screenshot lands before the hero exists.
  //
  // Deliberately does not consume the module's readiness promise: it walks the
  // live scene graph and waits for every texture actually bound to a material
  // or shader uniform to hold a decoded image. A promise wired to the wrong
  // texture would still resolve; this checks the thing that matters.
  const collectTextures = (root) => {
    const found = new Set()
    root.traverse((o) => {
      const mats = !o.material ? [] : Array.isArray(o.material) ? o.material : [o.material]
      for (const m of mats) {
        if (!m) continue
        for (const k of ['map', 'emissiveMap', 'alphaMap']) {
          if (m[k] && m[k].isTexture) found.add(m[k])
        }
        if (m.uniforms) {
          for (const u of Object.values(m.uniforms)) {
            if (u && u.value && u.value.isTexture) found.add(u.value)
          }
        }
      }
    })
    return [...found]
  }
  const decoded = (tex) => {
    const img = tex.image
    if (!img) return false
    if (img.width === 0 && img.height === 0) return false
    return img.complete === undefined ? true : img.complete
  }
  const waitForAssets = async (timeoutMs = 20000) => {
    const t0 = Date.now()
    for (;;) {
      const texes = collectTextures(scene)
      const pending = texes.filter((t) => !decoded(t))
      if (!pending.length) return { total: texes.length, waitedMs: Date.now() - t0 }
      if (Date.now() - t0 > timeoutMs) {
        console.warn(`asset gate: ${pending.length}/${texes.length} textures still undecoded after ${timeoutMs}ms — capturing anyway`)
        return { total: texes.length, pending: pending.length, waitedMs: Date.now() - t0 }
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  let frames = 0
  const tick = () => {
    requestAnimationFrame(tick)
    // Simulation dt is clamped so a slow frame can never tunnel the player or
    // spike the wind. The HUD is *presentation* — its nameplate timeline has to
    // run on the wall clock, or on a software-GL box (2–4 fps) the plate never
    // finishes its intro before a screenshot lands.
    const wallDt = engine.clock.getDelta()
    const dt = Math.min(wallDt, 1 / 20)
    const t = engine.clock.elapsedTime
    const inp = input.poll()

    sky.update(t)
    terrain.update(t, camera)
    water.update(t, camera)
    scatter.update(t, camera)
    props.update(t, camera)
    player.update(dt, inp, camera)
    rig.update(dt, inp)
    hud.update(wallDt)
    post.render(dt)

    frames++
  }
  tick()

  // Four drawn frames sufficed while every texture was drawn synchronously
  // into a canvas. The hero and mount now arrive over the network, so wait for
  // both: the pipeline having run, and the pixels having landed.
  const gate = await waitForAssets()
  await new Promise((r) => {
    const spin = () => (frames >= 4 ? r() : requestAnimationFrame(spin))
    spin()
  })
  console.log(`asset gate: ${gate.total} textures decoded in ${gate.waitedMs}ms` +
    (gate.pending ? ` (${gate.pending} TIMED OUT)` : ''))
  document.getElementById('boot')?.classList.add('hidden')
  window.__POC.ready = true
  window.__POC.assetGate = gate
}

boot().catch((err) => {
  console.error(err)
  const boot = document.getElementById('boot')
  if (boot) boot.textContent = String(err && err.stack ? err.stack : err)
})
