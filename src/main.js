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

  let frames = 0
  const tick = () => {
    requestAnimationFrame(tick)
    const dt = Math.min(engine.clock.getDelta(), 1 / 20)
    const t = engine.clock.elapsedTime
    const inp = input.poll()

    sky.update(t)
    terrain.update(t, camera)
    water.update(t, camera)
    scatter.update(t, camera)
    props.update(t, camera)
    player.update(dt, inp, camera)
    rig.update(dt, inp)
    hud.update(dt)
    post.render(dt)

    if (++frames === 4) {
      document.getElementById('boot')?.classList.add('hidden')
      window.__POC.ready = true
    }
  }
  tick()
}

boot().catch((err) => {
  console.error(err)
  const boot = document.getElementById('boot')
  if (boot) boot.textContent = String(err && err.stack ? err.stack : err)
})
