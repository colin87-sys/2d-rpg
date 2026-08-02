// ---------------------------------------------------------------------------
// src/game/player.js — the hero unit + the diorama camera rig.
//
// Contract (docs/CONTRACT.md — frozen):
//   export function createPlayer({ terrain, sheet, renderer }): Player
//   export function createCameraRig({ camera, player, terrain }): CameraRig
//   Player    = { object3D, position: THREE.Vector3, update(dt, input, camera),
//                 facing: 's'|'n'|'e'|'w' }
//   CameraRig = { update(dt, input), params }
//   input     = { x: -1..1, y: -1..1, run: boolean, zoom: -1..1, rotate: -1..1 }
//
// Art direction (docs/ART_BIBLE.md, read off frame01.png):
//   - Hero body reads EXACTLY 1.60 m (56 px of the 64 px cell → plane 1.829 m).
//   - Y-axis-locked billboard, NearestFilter, alphaTest cutout, no blending.
//   - Sprite is LIT (never MeshBasicMaterial): faux normal = mix(up, toCam, .35),
//     receives the sun's #fff1d0 key + hemisphere + exp2 fog, with a teal-green
//     shade floor so the character never goes muddy (§3 shadow rule: shadows
//     rotate toward teal, never violet, never crushed).
//   - Casts a REAL shadow via a matching customDepthMaterial, plus the bible's
//     mandatory contact blob: #241611 ellipse 1.1 × 0.5 m, α 0.55, 40 % feather,
//     nudged along the sun's shadow azimuth (~70°) exactly like scatter.js does.
//   - Movement facing is chosen in SCREEN space (relative to camera yaw), so
//     'up' always walks up-screen and picks the back-view row for any orbit —
//     the classic HD-2D bug, handled here.
//   - Camera: vFOV 26°, pitch 28° (24–34), distance 53 m (dolly 38–70, never
//     FOV zoom), boots at yaw 0 → position (−38, 36.3, 64.8) look-at
//     (−38, 11.4, 18) so the FIRST FRAME is the hero composition: road under
//     the hero, wheat at his east shoulder, waterfall massif upstage, castle
//     right third, ocean strip frame-left. The no-input screenshot IS the shot.
//   - frame01 shows the unit FACING EAST beside the wheat (bible table said
//     north; the image wins) → boot facing 'e'.
// ---------------------------------------------------------------------------

import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Shared numeric helpers (allocation-free)
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)

/** Wrap an angle to (−π, π]. */
function wrapPi(a) {
  a = a % (Math.PI * 2)
  if (a > Math.PI) a -= Math.PI * 2
  else if (a < -Math.PI) a += Math.PI * 2
  return a
}

/**
 * Critically-damped smoothing (Unity SmoothDamp form). `state` carries the
 * velocity under `velKey`; returns the new value. Settles in ~`time` seconds
 * with zero overshoot — the bible asks for a ≈0.25 s critically-damped follow.
 */
function smoothDamp(cur, target, state, velKey, time, dt) {
  const omega = 2 / Math.max(1e-4, time)
  const x = omega * dt
  const k = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x)
  const change = cur - target
  const temp = (state[velKey] + omega * change) * dt
  state[velKey] = (state[velKey] - omega * temp) * k
  let out = target + (change + temp) * k
  if (change > 0 === out < target) { // overshoot guard
    out = target
    state[velKey] = 0
  }
  return out
}

/** smoothDamp through the shortest angular arc. */
function smoothDampAngle(cur, target, state, velKey, time, dt) {
  return cur + (smoothDamp(0, wrapPi(target - cur), state, velKey, time, dt) - 0)
}

// ---------------------------------------------------------------------------
// Palette + light constants shared with the rest of the stage
// ---------------------------------------------------------------------------

const CONTACT_SHADOW = 0x241611 // bible §3 CONTACT_SHADOW
const FOG_DENSITY = 0.0072      // bible §4 — blob decals attenuate into the haze
const SHADOW_AZ = 70 * DEG      // shadow falls toward az 70° (sun WSW az 250°),
                                // matching scatter.js so all blobs agree

// Biome-tinted footstep dust (authored, slightly desaturated so puffs read as
// kicked-up matter, not confetti — sampled against the §3 terrain ramps).
const DUST_TINTS = {
  road: 0xc9a061,   // ochre road dust (ROAD_LIT lifted)
  field: 0xdcc678,  // wheat chaff
  beach: 0xded0a8,  // pale sand
  grass: 0xa5b578,  // sage-green motes
  forest: 0x93a86b, // darker duff
  rock: 0xbfc6ba,   // limestone powder
  snow: 0xe8eef0,
  ocean: 0xeaf4f2,  // (edge splash fallback)
}
const SPLASH_TINT = 0xeaf4f2 // FOAM

// ---------------------------------------------------------------------------
// Procedural textures (Canvas2D — no assets)
// ---------------------------------------------------------------------------

/**
 * A soft clumped dust puff: one main lobe + three satellites + a wisp, pure
 * white alpha (tinted per spawn via material.color). Deliberately irregular —
 * a perfect radial disc reads as a bokeh sprite, not kicked dust.
 */
function makePuffTexture() {
  const S = 64
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')
  g.clearRect(0, 0, S, S)
  const lobe = (x, y, r, a) => {
    const grad = g.createRadialGradient(x, y, 0, x, y, r)
    grad.addColorStop(0, `rgba(255,255,255,${a})`)
    grad.addColorStop(0.55, `rgba(255,255,255,${a * 0.55})`)
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = grad
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    g.fill()
  }
  lobe(31, 36, 19, 0.85)  // main body
  lobe(19, 40, 12, 0.7)   // low-left clump
  lobe(43, 40, 11, 0.66)  // low-right clump
  lobe(37, 25, 9, 0.55)   // upper wisp
  lobe(23, 27, 7, 0.45)   // small shoulder
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearFilter
  tex.generateMipmaps = false
  return tex
}

// ---------------------------------------------------------------------------
// createPlayer
// ---------------------------------------------------------------------------

export function createPlayer({ terrain, sheet, renderer }) {
  const T = terrain
  const half = (T.meta && T.meta.size ? T.meta.size : 512) / 2

  // ---- tunables (exposed non-contract on the returned object) -------------
  const params = {
    bodyMeters: 1.6,      // bible §5 — the hero IS the scale unit
    liftEps: 0.02,        // tiny lift so the outline row never z-noises
    walkSpeed: 2.35,      // m/s
    runSpeed: 4.9,        // m/s
    accelTime: 0.13,      // exp approach constants (s to ~63 %)
    brakeTime: 0.09,
    slopeSlowStart: 0.12, // slope() value where slowdown begins
    slopeSlowRate: 1.8,
    slopeLimit: 0.45,     // ≈ 40° — steeper is a wall
    stepMax: 1.15,        // max instantaneous height gain per metre stepped
    shadeFloorColor: 0x57635a, // teal-grey emissive floor (never muddy)
    blob: { rx: 0.55, rz: 0.25, alpha: 0.55 }, // bible §8: hero 1.1 × 0.5, α .55
    dustPeakAlpha: 0.4,
    splashPeakAlpha: 0.52,
  }

  // ---- sheet geometry -----------------------------------------------------
  // Body = `bodyPx` texels of the `frameH` cell → plane height that makes the
  // body read exactly `bodyMeters` (56 px of 64 → plane 1.829 m at 1.60 m).
  const meta = sheet.meta || {}
  const bodyPx = meta.bodyPx || 56
  const groundRow = meta.groundRow != null ? meta.groundRow : 60
  const planeH = params.bodyMeters * (sheet.frameH / bodyPx)
  const planeW = planeH * (sheet.frameW / sheet.frameH)
  // Soles rest on `groundRow`; outline row sits below it. Anchor the plane so
  // the sole line lands on the terrain and the outline sinks ~1 texel into
  // contact (bible §6: bases sink into the ground, never float).
  const footBase = planeH * ((sheet.frameH - (groundRow + 1)) / sheet.frameH)

  const tex = sheet.texture
  tex.magFilter = THREE.NearestFilter // pixel-crisp, always
  tex.minFilter = THREE.NearestFilter
  tex.repeat.set(1 / sheet.cols, 1 / sheet.rows)

  // ---- billboard quad -----------------------------------------------------
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(
    [-planeW / 2, 0, 0, planeW / 2, 0, 0, planeW / 2, planeH, 0, -planeW / 2, planeH, 0], 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2))
  // Faux lighting normal (bible §4): mostly up, leaned 35 % toward the viewer
  // — the sprite takes the sun like a rounded mass, not a flat card.
  {
    const n = new THREE.Vector3(0, 1, 0).lerp(new THREE.Vector3(0, 0, 1), 0.35).normalize()
    const na = new Float32Array([n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z])
    geo.setAttribute('normal', new THREE.BufferAttribute(na, 3))
  }
  geo.setIndex([0, 1, 2, 0, 2, 3])

  const mat = new THREE.MeshLambertMaterial({
    map: tex,
    alphaTest: 0.5,
    transparent: false,     // hard cutout — no blending, no sorting artefacts
    side: THREE.DoubleSide, // sun may see the back face during shadow pass
    fog: true,
  })
  // Shade floor: emissiveMap × emissive re-emits the sprite's own colours at a
  // dim teal-grey level, so in full shade the character stays readable and
  // keeps its hues (bible: deep shade holds colour, never crushes to black).
  mat.emissive = new THREE.Color(params.shadeFloorColor)
  mat.emissiveMap = tex

  const spriteMesh = new THREE.Mesh(geo, mat)
  spriteMesh.name = 'hero_billboard'
  spriteMesh.castShadow = true
  // receiveShadow stays OFF — the colour pass faces the camera while the
  // shadow pass faces the sun, so shadow-map self-tests would smear a false
  // terminator across the sprite (scatter.js documents the same call). The
  // hero still CASTS a real silhouette shadow via the depth material below.
  spriteMesh.receiveShadow = false
  spriteMesh.frustumCulled = false // one quad; never let culling drop the hero
  spriteMesh.customDepthMaterial = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    map: tex, // same texture instance → same UV frame in the shadow pass
    alphaTest: 0.5,
    side: THREE.DoubleSide,
  })

  // unit group carries the feet position (this IS the contract `position`)
  const unit = new THREE.Group()
  unit.name = 'hero_unit'
  spriteMesh.position.y = params.liftEps - footBase
  unit.add(spriteMesh)

  // ---- contact blob shadow (matches scatter.js grammar exactly) -----------
  const blobGeo = new THREE.BufferGeometry()
  blobGeo.setAttribute('position', new THREE.Float32BufferAttribute(
    [-1, 0, 1, 1, 0, 1, 1, 0, -1, -1, 0, -1], 3))
  blobGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2))
  blobGeo.setIndex([0, 1, 2, 0, 2, 3])
  const blobMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(CONTACT_SHADOW) },
      uAlpha: { value: params.blob.alpha },
      uFogDensity: { value: FOG_DENSITY },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying float vDist;
      void main() {
        vec4 wp = modelMatrix * vec4( position, 1.0 );
        vDist = distance( cameraPosition, wp.xyz );
        vUv = uv;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uAlpha;
      uniform float uFogDensity;
      varying vec2 vUv;
      varying float vDist;
      void main() {
        vec2 q = vUv * 2.0 - 1.0;
        float d = length( q );
        float a = 1.0 - smoothstep( 0.60, 1.0, d );          // 40 % feather
        a *= 0.82 + 0.18 * ( 1.0 - smoothstep( 0.0, 0.55, d ) ); // denser core
        float fogT = exp( - uFogDensity * uFogDensity * vDist * vDist );
        float outA = a * uAlpha * mix( 0.12, 1.0, fogT );
        if ( outA < 0.004 ) discard;
        gl_FragColor = vec4( uColor, outA );
      }
    `,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  })
  const blobMesh = new THREE.Mesh(blobGeo, blobMat)
  blobMesh.name = 'hero_contact_shadow'
  blobMesh.renderOrder = 2 // over terrain + scatter blobs, under water sheets
  blobMesh.frustumCulled = false
  blobMesh.matrixAutoUpdate = false
  blobMesh.castShadow = false
  blobMesh.receiveShadow = false

  // ---- footstep dust / splash pool ---------------------------------------
  const puffTex = makePuffTexture()
  if (renderer && renderer.capabilities && puffTex.anisotropy !== undefined) {
    puffTex.anisotropy = 1 // soft particle — anisotropy buys nothing
  }
  const POOL = 28
  const puffs = []
  const dustGroup = new THREE.Group()
  dustGroup.name = 'hero_dust'
  for (let i = 0; i < POOL; i++) {
    const m = new THREE.SpriteMaterial({
      map: puffTex,
      transparent: true,
      depthWrite: false,
      fog: true,
      opacity: 0,
      rotation: 0,
    })
    const s = new THREE.Sprite(m)
    s.visible = false
    s.renderOrder = 6
    dustGroup.add(s)
    puffs.push({
      sprite: s, mat: m, alive: false, age: 0, life: 1,
      vx: 0, vy: 0, vz: 0, grow: 0, base: 0.2, peakA: 0.4, gravity: 0, spin: 0,
    })
  }
  let puffCursor = 0

  function spawnPuff(x, y, z, vx, vy, vz, base, grow, life, tint, peakA, gravity) {
    const p = puffs[puffCursor]
    puffCursor = (puffCursor + 1) % POOL
    p.alive = true
    p.age = 0
    p.life = life
    p.vx = vx; p.vy = vy; p.vz = vz
    p.base = base
    p.grow = grow
    p.peakA = peakA
    p.gravity = gravity
    p.spin = (Math.random() - 0.5) * 2.4
    p.sprite.position.set(x, y, z)
    p.sprite.scale.set(base, base * 0.92, 1)
    p.mat.color.setHex(tint)
    p.mat.rotation = Math.random() * Math.PI * 2
    p.mat.opacity = 0
    p.sprite.visible = true
  }

  function updatePuffs(dt) {
    for (let i = 0; i < POOL; i++) {
      const p = puffs[i]
      if (!p.alive) continue
      p.age += dt
      const t = p.age / p.life
      if (t >= 1) {
        p.alive = false
        p.sprite.visible = false
        p.mat.opacity = 0
        continue
      }
      const drag = Math.exp(-3.1 * dt)
      p.vx *= drag; p.vz *= drag
      p.vy = p.vy * drag - p.gravity * dt
      const s = p.sprite.position
      s.x += p.vx * dt; s.y += p.vy * dt; s.z += p.vz * dt
      const sc = p.base + p.grow * p.age * (1 - 0.45 * t)
      p.sprite.scale.set(sc, sc * 0.92, 1)
      p.mat.rotation += p.spin * dt
      // fast attack, long decay
      p.mat.opacity = p.peakA * (t < 0.16 ? t / 0.16 : Math.pow(1 - (t - 0.16) / 0.84, 1.5))
    }
  }

  // ---- assemble -----------------------------------------------------------
  const root = new THREE.Group()
  root.name = 'player'
  root.add(unit)
  root.add(blobMesh)
  root.add(dustGroup)

  // ---- spawn (terrain publishes the audited hero anchor) ------------------
  // The y placement duplicates the update()'s ground-snap (including the
  // slope sink) so the camera rig's boot framing and frame 1 agree exactly.
  const spawn = (T.meta && T.meta.extras && T.meta.extras.heroSpawn) || { x: -38, z: 18 }
  unit.position.set(
    spawn.x,
    T.height(spawn.x, spawn.z) - Math.min(0.1, T.slope(spawn.x, spawn.z) * 0.22),
    spawn.z,
  )

  // ---- state --------------------------------------------------------------
  let facing = 'e'        // frame01: the unit stands FACING EAST beside the wheat
  let state = 'idle'      // 'idle' | 'walk' | 'run'
  let phase = 0           // animation phase in frames (float)
  let lastFrameIdx = -1
  let animKey = 'idle_e'
  let animFrames = sheet.anims[animKey]
  let curFrame = -1
  let contactToggle = 1   // alternates the dust foot
  let splashClock = 0
  let blockedByWater = false

  const vel = new THREE.Vector3()      // horizontal world velocity
  const moveDir = new THREE.Vector3(1, 0, 0) // last commanded direction (unit)

  // scratch
  const _fwd = new THREE.Vector3()
  const _right = new THREE.Vector3()
  const _m4 = new THREE.Matrix4()
  const _n = new THREE.Vector3()
  const _t1 = new THREE.Vector3()
  const _t2 = new THREE.Vector3()
  const _bx = new THREE.Vector3()
  const _by = new THREE.Vector3()
  const _bz = new THREE.Vector3()
  const _bp = new THREE.Vector3()
  const _shadowDir = new THREE.Vector3(Math.sin(SHADOW_AZ), 0, -Math.cos(SHADOW_AZ))

  // screen-space unit vectors per facing (x = screen-right, y = up-screen)
  const FACE_SCREEN = { e: [1, 0], w: [-1, 0], n: [0, 1], s: [0, -1] }

  function setFrame(f) {
    if (f === curFrame) return
    curFrame = f
    const col = f % sheet.cols
    const row = (f / sheet.cols) | 0
    tex.offset.set(col / sheet.cols, 1 - (row + 1) / sheet.rows)
  }
  setFrame(animFrames[0]) // valid frame from the very first render

  function setAnim(nextState, nextFacing) {
    if (nextState === state && nextFacing === facing) return
    const prevLen = animFrames.length
    const carry = phase / prevLen // normalised gait position
    if (nextState !== state) {
      if (nextState === 'idle' || state === 'idle') phase = 0
      else phase = carry * sheet.anims[nextState + '_' + nextFacing].length // walk↔run keeps footfall phase
    }
    state = nextState
    facing = nextFacing
    animKey = state + '_' + facing
    animFrames = sheet.anims[animKey]
    if (phase >= animFrames.length) phase %= animFrames.length
  }

  function passable(x, z) {
    if (x < -half + 2 || x > half - 2 || z < -half + 2 || z > half - 2) return false
    if (T.isWater(x, z)) return false
    if (T.slope(x, z) > params.slopeLimit) return false
    return true
  }

  function biomeTint(x, z) {
    const b = T.biome(x, z)
    return DUST_TINTS[b] !== undefined ? DUST_TINTS[b] : DUST_TINTS.grass
  }

  /** Footfall burst: dust normally, foam when the ground is wet. */
  function footfall(speedRatio, running) {
    const px = unit.position.x, pz = unit.position.z
    const py = unit.position.y
    const wet = T.waterHeight(px, pz) > py - 0.18 &&
      (T.biome(px, pz) === 'beach' || blockedByWater)
    const latX = moveDir.z * contactToggle
    const latZ = -moveDir.x * contactToggle
    contactToggle = -contactToggle
    const n = running ? 2 : 1
    for (let i = 0; i < n; i++) {
      const back = 0.16 + 0.1 * i
      const jx = (Math.random() - 0.5) * 0.08
      const jz = (Math.random() - 0.5) * 0.08
      if (wet) {
        spawnPuff(
          px - moveDir.x * back + latX * 0.09 + jx, py + 0.05, pz - moveDir.z * back + latZ * 0.09 + jz,
          -moveDir.x * 0.25 + latX * 0.3, 0.75 + Math.random() * 0.35, -moveDir.z * 0.25 + latZ * 0.3,
          0.13, 0.5, 0.42, SPLASH_TINT, params.splashPeakAlpha, 2.6,
        )
        // two tiny droplets
        spawnPuff(px + jx * 3, py + 0.1, pz + jz * 3,
          latX * 0.7, 1.3, latZ * 0.7, 0.05, 0.12, 0.32, SPLASH_TINT, 0.6, 4.5)
      } else {
        spawnPuff(
          px - moveDir.x * back + latX * 0.1 + jx, py + 0.06, pz - moveDir.z * back + latZ * 0.1 + jz,
          -moveDir.x * (0.3 + 0.45 * speedRatio) + latX * 0.25,
          0.5 + 0.3 * speedRatio + Math.random() * 0.2,
          -moveDir.z * (0.3 + 0.45 * speedRatio) + latZ * 0.25,
          0.15 + 0.09 * speedRatio, 0.5 + 0.3 * speedRatio, 0.5 + 0.15 * speedRatio,
          biomeTint(px, pz), params.dustPeakAlpha * (0.8 + 0.35 * speedRatio), 0.5,
        )
      }
    }
  }

  // ---- per-frame update ---------------------------------------------------
  function update(dt, input, camera) {
    if (!(dt > 0)) dt = 1 / 60
    const px0 = unit.position.x
    const pz0 = unit.position.z

    // ---- camera-space movement basis (screen-relative — THE fix) ----------
    // Up-screen = camera forward flattened to the ground plane.
    if (camera) {
      camera.getWorldDirection(_fwd)
      _fwd.y = 0
      if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1)
      _fwd.normalize()
    } else {
      _fwd.set(0, 0, -1)
    }
    _right.set(-_fwd.z, 0, _fwd.x) // screen-right on the ground

    // ---- input → desired world direction ----------------------------------
    const ix = input ? clamp(input.x || 0, -1, 1) : 0
    const iy = input ? clamp(input.y || 0, -1, 1) : 0
    const wantRun = !!(input && input.run)
    let mx = _fwd.x * -iy + _right.x * ix
    let mz = _fwd.z * -iy + _right.z * ix
    const mLen = Math.hypot(mx, mz)
    const moving = mLen > 1e-4
    if (moving) {
      mx /= mLen
      mz /= mLen
      moveDir.set(mx, 0, mz)
    }

    // ---- speed model: accel/decel + slope resistance ----------------------
    const slopeHere = T.slope(px0, pz0)
    let speedCap = wantRun ? params.runSpeed : params.walkSpeed
    // omni slope drag
    speedCap *= clamp(1 - Math.max(0, slopeHere - params.slopeSlowStart) * params.slopeSlowRate, 0.3, 1)
    if (moving) {
      // directional grade: climbing slows further, gentle descents ease
      const rise = (T.height(px0 + mx * 0.6, pz0 + mz * 0.6) - T.height(px0 - mx * 0.6, pz0 - mz * 0.6)) / 1.2
      speedCap *= clamp(1 - rise * 1.1, 0.42, 1.08)
    }
    const tvx = moving ? mx * Math.min(1, mLen) * speedCap : 0
    const tvz = moving ? mz * Math.min(1, mLen) * speedCap : 0
    const speeding = tvx * tvx + tvz * tvz > vel.x * vel.x + vel.z * vel.z
    const k = 1 - Math.exp(-dt / (speeding ? params.accelTime : params.brakeTime))
    vel.x += (tvx - vel.x) * k
    vel.z += (tvz - vel.z) * k
    let speed = Math.hypot(vel.x, vel.z)
    if (speed < 0.02 && !moving) {
      vel.x = 0
      vel.z = 0
      speed = 0
    }

    // ---- integrate + collide (axis-separated slide along coasts/cliffs) ---
    blockedByWater = false
    if (speed > 0) {
      const stepX = vel.x * dt
      const stepZ = vel.z * dt
      const aheadX = speed > 0.01 ? (vel.x / speed) * 0.24 : 0
      const aheadZ = speed > 0.01 ? (vel.z / speed) * 0.24 : 0
      const ok = (x, z) =>
        passable(x, z) && passable(x + aheadX, z + aheadZ) &&
        T.height(x, z) - T.height(px0, pz0) < params.stepMax
      let nx = px0 + stepX
      let nz = pz0 + stepZ
      if (ok(nx, nz)) {
        unit.position.x = nx
        unit.position.z = nz
      } else if (ok(nx, pz0)) {
        unit.position.x = nx
        vel.z = 0
        if (T.isWater(nx + aheadX, nz + aheadZ)) blockedByWater = true
      } else if (ok(px0, nz)) {
        unit.position.z = nz
        vel.x = 0
        if (T.isWater(nx + aheadX, nz + aheadZ)) blockedByWater = true
      } else {
        blockedByWater = T.isWater(nx + aheadX, nz + aheadZ)
        vel.x = 0
        vel.z = 0
      }
      speed = Math.hypot(vel.x, vel.z)
    }

    // ---- snap feet to the ground ------------------------------------------
    const px = unit.position.x
    const pz = unit.position.z
    const ground = T.height(px, pz)
    // extra sink on grade so the downhill quad edge never floats
    unit.position.y = ground - Math.min(0.1, T.slope(px, pz) * 0.22)

    // ---- state machine (hysteresis so thresholds never chatter) -----------
    let nextState = state
    if (state === 'idle') {
      if (speed > 0.3) nextState = 'walk'
    } else if (state === 'walk') {
      if (speed < 0.14) nextState = 'idle'
      else if (wantRun && speed > params.runSpeed * 0.56) nextState = 'run'
    } else { // run
      if (speed < params.runSpeed * 0.5) nextState = speed < 0.14 ? 'idle' : 'walk'
    }

    // ---- facing from SCREEN-space motion, with diagonal hysteresis --------
    let nextFacing = facing
    if (moving) {
      const sx = mx * _right.x + mz * _right.z // screen-right component
      const sy = mx * _fwd.x + mz * _fwd.z     // up-screen component
      const ax = Math.abs(sx)
      const ay = Math.abs(sy)
      if (ax > ay * 1.15) nextFacing = sx > 0 ? 'e' : 'w'
      else if (ay > ax * 1.15) nextFacing = sy > 0 ? 'n' : 's'
      else {
        // ambiguous 45° band: hold the current row unless it now opposes motion
        const f = FACE_SCREEN[facing]
        if (f[0] * sx + f[1] * sy < 0.05) {
          nextFacing = ax >= ay ? (sx > 0 ? 'e' : 'w') : (sy > 0 ? 'n' : 's')
        }
      }
    }
    setAnim(nextState, nextFacing)

    // ---- animation clock (sheet.fps exact, speed-scaled gait) -------------
    let rate = 1
    if (state === 'walk') rate = clamp(speed / params.walkSpeed, 0.6, 1.35)
    else if (state === 'run') rate = clamp(speed / params.runSpeed, 0.75, 1.15)
    phase += dt * sheet.fps * rate
    const len = animFrames.length
    if (phase >= len) phase -= len * Math.floor(phase / len) // frame-accurate wrap
    const frameIdx = phase | 0
    setFrame(animFrames[frameIdx])

    // ---- footfall FX on contact frames (0 and mid-cycle) ------------------
    if (state !== 'idle' && frameIdx !== lastFrameIdx) {
      if (frameIdx === 0 || frameIdx === (len >> 1)) {
        if (speed > 0.6) footfall(speed / params.runSpeed, state === 'run')
      }
    }
    lastFrameIdx = frameIdx

    // ---- pressed against a water edge: continuous subtle lapping ----------
    splashClock -= dt
    if (blockedByWater && moving && splashClock <= 0) {
      splashClock = 0.18
      const ex = px + moveDir.x * 0.42
      const ez = pz + moveDir.z * 0.42
      const wy = T.waterHeight(ex, ez)
      spawnPuff(ex, wy + 0.04, ez,
        moveDir.x * 0.2 + (Math.random() - 0.5) * 0.3, 0.55, moveDir.z * 0.2 + (Math.random() - 0.5) * 0.3,
        0.11, 0.4, 0.38, SPLASH_TINT, params.splashPeakAlpha * 0.8, 2.2)
    }

    // ---- billboard: yaw-only turn toward the camera -----------------------
    if (camera) {
      unit.rotation.y = Math.atan2(camera.position.x - px, camera.position.z - pz)
    }

    // ---- contact blob: hug the terrain, keyed to the sun's shadow azimuth -
    T.normal(px, pz, _n)
    if (_n.y < 0.2) _n.set(0, 1, 0)
    _t1.copy(_shadowDir).addScaledVector(_n, -_shadowDir.dot(_n)).normalize()
    _t2.crossVectors(_n, _t1)
    const grounded = clamp(1 - (unit.position.y - ground) * 1.2, 0.35, 1) // proximity scale
    const rx = params.blob.rx * grounded
    const rz = params.blob.rz * grounded
    blobMat.uniforms.uAlpha.value = params.blob.alpha * (0.75 + 0.25 * grounded)
    _bx.copy(_t1).multiplyScalar(rx)
    _by.copy(_n)
    _bz.copy(_t2).multiplyScalar(rz)
    _bp.set(px + _t1.x * rx * 0.16, ground, pz + _t1.z * rx * 0.16).addScaledVector(_n, 0.045)
    _m4.makeBasis(_bx, _by, _bz)
    _m4.setPosition(_bp)
    blobMesh.matrix.copy(_m4)

    // ---- particles --------------------------------------------------------
    updatePuffs(dt)

    api.facing = facing
  }

  const api = {
    object3D: root,
    position: unit.position, // live vector — feet, world space (contract)
    update,
    facing,
    // -- non-contract extras (safe to ignore; the rig + HUD may read them) --
    velocity: vel,
    get speed() { return Math.hypot(vel.x, vel.z) },
    get state() { return state },
    params,
  }
  return api
}

// ---------------------------------------------------------------------------
// createCameraRig — the long-lens diorama camera (bible §2, boot-exact)
// ---------------------------------------------------------------------------

export function createCameraRig({ camera, player, terrain }) {
  const T = terrain

  const params = {
    // projection (bible §2 — never FOV-zoom; dolly only)
    fovDeg: 26,
    near: 4,
    far: 700,
    // orbit geometry
    pitchDeg: 28,       // measured off frame01's foreshortening — NOT 50°
    pitchMinDeg: 24,
    pitchMaxDeg: 34,
    pitchRefDist: 53,   // pitch eases flatter as the dolly pulls out…
    pitchPerMeter: 0.18, // …by this many degrees per metre of distance
    distance: 53,       // camera → hero chest (60 px hero at 921 px frame)
    distMin: 38,
    distMax: 70,
    yawDeg: 0,          // boot due north: ocean left, castle right, massif up
    chestHeight: 1.0,   // look-at = feet + chest (ground 10.4 → 11.4)
    // feel
    followTime: 0.25,   // critically-damped settle (bible: ≈0.25 s)
    yawTime: 0.22,
    distTime: 0.3,
    leadTime: 0.5,
    liftTime: 0.35,
    lookAhead: 2.4,     // metres of lead at full run speed
    yawSpeedDeg: 100,   // Q/E orbit rate
    dollySpeed: 15,     // +/- dolly rate m/s
    clearance: 3.0,     // camera never dips under terrain + this
  }

  // ---- damper state -------------------------------------------------------
  const s = {
    yaw: params.yawDeg * DEG, yawT: params.yawDeg * DEG, yawV: 0,
    dist: params.distance, distT: params.distance, distV: 0,
    fx: 0, fy: 0, fz: 0, fxV: 0, fyV: 0, fzV: 0, // follow point (chest)
    leadX: 0, leadZ: 0, leadXV: 0, leadZV: 0,
    lift: 0, liftV: 0,
  }

  const _look = new THREE.Vector3()
  const _pos = new THREE.Vector3()

  let appliedFov = 0
  let appliedNear = 0
  let appliedFar = 0
  function applyProjection() {
    if (camera.fov !== params.fovDeg || appliedFov !== params.fovDeg ||
        appliedNear !== params.near || appliedFar !== params.far) {
      camera.fov = params.fovDeg
      camera.near = params.near
      camera.far = params.far
      camera.updateProjectionMatrix()
      appliedFov = params.fovDeg
      appliedNear = params.near
      appliedFar = params.far
    }
  }

  function pitchForDist(d) {
    return clamp(
      params.pitchDeg + (params.pitchRefDist - d) * params.pitchPerMeter,
      params.pitchMinDeg, params.pitchMaxDeg,
    ) * DEG
  }

  /** Highest ground under/near the camera footprint (3 probes along the view). */
  function groundNearCamera(cx, cz, lx, lz) {
    let g = T.height(cx, cz)
    const dx = lx - cx
    const dz = lz - cz
    const len = Math.hypot(dx, dz) || 1
    const ux = dx / len
    const uz = dz / len
    const g1 = T.height(cx + ux * 4, cz + uz * 4)
    const g2 = T.height(cx + ux * 9, cz + uz * 9)
    if (g1 > g) g = g1
    if (g2 - 1.5 > g) g = g2 - 1.5 // deeper probe gets a little forgiveness
    return g
  }

  function solve(lookX, lookY, lookZ, yaw, dist, dt) {
    const pitch = pitchForDist(dist)
    const h = dist * Math.cos(pitch)
    const v = dist * Math.sin(pitch)
    _pos.set(lookX + Math.sin(yaw) * h, lookY + v, lookZ + Math.cos(yaw) * h)
    // terrain clearance: raise, never clip. Rising is applied instantly (hard
    // guarantee); easing back down is smoothed so ridge crossings don't pop.
    const g = groundNearCamera(_pos.x, _pos.z, lookX, lookZ)
    const need = Math.max(0, g + params.clearance - _pos.y)
    if (dt <= 0) {
      s.lift = need
      s.liftV = 0
    } else {
      s.lift = smoothDamp(s.lift, need, s, 'liftV', params.liftTime, dt)
      if (need > s.lift) s.lift = need // hard floor
    }
    _pos.y += s.lift
    camera.position.copy(_pos)
    _look.set(lookX, lookY, lookZ)
    camera.lookAt(_look)
  }

  // ---- boot: frame 1 IS the deliverable ----------------------------------
  // Hero (−38, ~10.4, 18) chest 11.4 → camera (−38, 36.3, 64.8) at yaw 0,
  // pitch 28°, dist 53: road under the unit, wheat east, waterfall + massif
  // upstage-centre, castle right third, ocean strip frame-left. No smoothing
  // is allowed to pollute the first rendered frame, so every damper starts
  // converged on the target.
  applyProjection()
  s.fx = player.position.x
  s.fy = player.position.y + params.chestHeight
  s.fz = player.position.z
  solve(s.fx, s.fy, s.fz, s.yaw, s.dist, 0)

  function update(dt, input) {
    if (!(dt > 0)) dt = 1 / 60
    applyProjection()

    // ---- input: Q/E orbit, +/- dolly --------------------------------------
    const rot = input ? clamp(input.rotate || 0, -1, 1) : 0
    const zoom = input ? clamp(input.zoom || 0, -1, 1) : 0
    s.yawT += rot * params.yawSpeedDeg * DEG * dt
    s.distT = clamp(s.distT - zoom * params.dollySpeed * dt, params.distMin, params.distMax)
    s.yaw = smoothDampAngle(s.yaw, s.yawT, s, 'yawV', params.yawTime, dt)
    s.dist = smoothDamp(s.dist, s.distT, s, 'distV', params.distTime, dt)

    // ---- look-ahead in the movement direction -----------------------------
    let tx = 0
    let tz = 0
    if (player.velocity) {
      const spd = Math.hypot(player.velocity.x, player.velocity.z)
      const runSpeed = (player.params && player.params.runSpeed) || 4.9
      if (spd > 0.15) {
        const lead = params.lookAhead * Math.min(1, spd / runSpeed)
        tx = (player.velocity.x / spd) * lead
        tz = (player.velocity.z / spd) * lead
      }
    }
    s.leadX = smoothDamp(s.leadX, tx, s, 'leadXV', params.leadTime, dt)
    s.leadZ = smoothDamp(s.leadZ, tz, s, 'leadZV', params.leadTime, dt)

    // ---- critically-damped follow of the chest point ----------------------
    const ax = player.position.x + s.leadX
    const ay = player.position.y + params.chestHeight
    const az = player.position.z + s.leadZ
    s.fx = smoothDamp(s.fx, ax, s, 'fxV', params.followTime, dt)
    s.fy = smoothDamp(s.fy, ay, s, 'fyV', params.followTime, dt)
    s.fz = smoothDamp(s.fz, az, s, 'fzV', params.followTime, dt)

    solve(s.fx, s.fy, s.fz, s.yaw, s.dist, dt)
  }

  return { update, params }
}
