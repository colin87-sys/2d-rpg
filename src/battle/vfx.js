// ---------------------------------------------------------------------------
// src/battle/vfx.js — Aetherbound battle spell VFX (BATTLE_BIBLE §8)
//
//   createVFX({ scene, arena, units, renderer })
//     → { object3D, cast(name, casterId, targetId, opts?) => Promise<void>,
//         update(dt, camera), impulses: { shake, flash } }
//
// Owns every spell effect on the battle stage. The centrepiece is the frame04
// Firaga column burst: a dusty-magenta sheath around a warm white-cream core,
// 2.0 m wide, 3.0 m tall, sparks to 1.4 m above the column — and, decisively,
// a travelling THREE.PointLight registered through arena.addSpellLight() so
// the burst genuinely repaints the set and the sprites (§8: "a burst that
// does not repaint its surroundings is an instant fail"). Additive geometry
// alone reads as a decal pasted on top; the light is what makes it a spell.
//
// Effects shipped:
//   'firaga'   — the mandatory §8 column burst (windup 250 ms → burst 400 ms,
//                peak +100 ms → decay 700 ms, total 1.35 s), with a caster
//                glyph, an incoming comet that carries the light caster →
//                target, 3 rippled sheath shells, 12 core streaks, ground
//                ring + shock ring, and 90 pooled sparks over 0.45 s.
//   'cure'     — frame05's soft rose beam over a unit: gentle rising column,
//                floating motes, small warm light, no impulses.
//   'slash'    — physical impact: two crossed arc swipes at the chest, a
//                radial spark bite, a brief cool light spike, small shake.
//   'stonera'  — frame05's banner spell: amber rock shards erupt from a
//                cracked ring, dust puffs, gold motes, heavy short shake.
//   aliases    — fire/fira → firaga family, cura/curaga/heal → cure,
//                attack/hit/strike → slash, stone/stonega/quake → stonera.
//                Unknown names fall back to 'slash' and still resolve, so
//                choreo can never dead-lock on a typo.
//
// Budgets (§8, enforced here): ≤ 180 particles alive in the one shared pool,
// ≤ 1 shake + 1 flash per cast, impulses written as 0..1 decaying envelopes
// (post maps 1.0 to its own §8 ceilings: flash 15 %, shake 7 px / 220 ms —
// firaga writes 0.80 flash ≈ 12 % and 0.86 shake ≈ 6 px / 180 ms).
//
// Freeze: if the page URL carries ?freeze=<effect> (the harness runs
// ?freeze=firaga), a cast of that effect advances to its burst-peak hold
// point and then clamps its local clock — the column, spill light and spark
// churn keep living (torches/fog keep animating elsewhere) but the effect
// never decays and its Promise intentionally never resolves, so an awaiting
// choreo holds mid-burst for deterministic capture. Real-time impulse
// envelopes still decay to zero, so the captured frame is never mid-flash.
// opts.freeze (boolean) overrides the URL either way.
//
// Draw ordering is deliberate: no renderOrder anywhere. All materials are
// transparent + depthWrite:false, so three's back-to-front transparent sort
// arranges the sandwich by depth — the column centre (chest height) sorts
// nearer than the victim's billboard centre and washes over him (frame04:
// Rain blown out inside the burst), while units standing nearer the camera
// (Lasswell at z −4.4) sort nearer still and stay cleanly in front of the
// glow. Ground decals sort under the sprites the same way. The spark Points
// object is re-anchored to the live cast's column base every frame so the
// sort treats the whole spray as part of the column.
// ---------------------------------------------------------------------------

import * as THREE from 'three'

// ===========================================================================
// 1. Small utilities (house idiom — see src/battle/arena.js)
// ===========================================================================

const TAU = Math.PI * 2
const HPI = Math.PI / 2

function clamp(v, a, b) { return v < a ? a : v > b ? b : v }
function lerp(a, b, t) { return a + (b - a) * t }
function env01(t, a, b) { return clamp((t - a) / (b - a), 0, 1) }
function ss(t, a, b) { const u = env01(t, a, b); return u * u * (3 - 2 * u) }
function easeOutCubic(u) { const v = 1 - u; return 1 - v * v * v }
function backOut(u) { const s = 1.70158; const v = u - 1; return v * v * ((s + 1) * v + s) + 1 }

function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// linear-space [r,g,b] from a hex int (matches how lights/uniform colors
// resolve under r169 ColorManagement — particles use these raw)
const _c = new THREE.Color()
function lin3(hex) {
  _c.set(hex)
  return [_c.r, _c.g, _c.b]
}

// ===========================================================================
// 2. Texture kit — every VFX map painted in Canvas2D at runtime, no assets
// ===========================================================================

function makeCanvas(w, h) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}
function toTex(c, opts = {}) {
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = opts.wrapX ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping
  t.wrapT = opts.wrapY ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping
  t.magFilter = t.minFilter = THREE.LinearFilter
  t.generateMipmaps = false
  return t
}

// Soft round dot with a hot core — comet head, generic glow sprite.
function dotTex() {
  const S = 64
  const c = makeCanvas(S, S)
  const g = c.getContext('2d')
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2)
  grad.addColorStop(0.0, 'rgba(255,252,244,0.95)')
  grad.addColorStop(0.25, 'rgba(255,235,238,0.55)')
  grad.addColorStop(0.6, 'rgba(255,220,235,0.16)')
  grad.addColorStop(1.0, 'rgba(255,210,235,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, S, S)
  return toTex(c)
}

// Ground contact glow — §8 "additive disc r 1.3 m, #c190b0 → transparent,
// 45 % feather": hot cream centre, magenta body, feather from 55 % out.
function groundGlowTex() {
  const S = 256
  const c = makeCanvas(S, S)
  const g = c.getContext('2d')
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2)
  grad.addColorStop(0.0, 'rgba(255,240,207,0.85)') // #fff0cf core
  grad.addColorStop(0.2, 'rgba(231,182,207,0.58)')
  grad.addColorStop(0.45, 'rgba(193,144,176,0.34)') // #c190b0
  grad.addColorStop(0.55, 'rgba(193,144,176,0.24)') // feather begins
  grad.addColorStop(1.0, 'rgba(160,110,160,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, S, S)
  return toTex(c)
}

// Thin soft annulus — expanding shockwave ring / stonera crack ring.
function ringTex() {
  const S = 128
  const c = makeCanvas(S, S)
  const g = c.getContext('2d')
  const img = g.createImageData(S, S)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x - S / 2) / (S / 2)
      const dy = (y - S / 2) / (S / 2)
      const r = Math.hypot(dx, dy)
      const a = Math.exp(-Math.pow((r - 0.72) / 0.10, 2)) * 0.9
      const i = (y * S + x) * 4
      img.data[i] = 255
      img.data[i + 1] = 245
      img.data[i + 2] = 250
      img.data[i + 3] = clamp(a * 255, 0, 255)
    }
  }
  g.putImageData(img, 0, 0)
  return toTex(c)
}

// Caster rune circle — the §9 glyph (r 0.9 m under the caster). Diamonds,
// not circles, per the UI grammar; painted white, tinted by material.
function glyphTex() {
  const S = 256
  const c = makeCanvas(S, S)
  const g = c.getContext('2d')
  const cx = S / 2
  g.strokeStyle = 'rgba(255,255,255,0.9)'
  g.lineWidth = 2.5
  g.beginPath()
  g.arc(cx, cx, S * 0.46, 0, TAU)
  g.stroke()
  g.lineWidth = 1.2
  g.globalAlpha = 0.55
  g.beginPath()
  g.arc(cx, cx, S * 0.395, 0, TAU)
  g.stroke()
  g.globalAlpha = 1
  // 8 diamond studs on the outer band
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU
    const x = cx + Math.cos(a) * S * 0.43
    const y = cx + Math.sin(a) * S * 0.43
    g.save()
    g.translate(x, y)
    g.rotate(a + HPI / 2)
    g.fillStyle = 'rgba(255,255,255,0.85)'
    g.fillRect(-4.5, -4.5, 9, 9)
    g.restore()
  }
  // 24 tick dashes on a middle band
  g.strokeStyle = 'rgba(255,255,255,0.5)'
  g.lineWidth = 2
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU
    g.beginPath()
    g.moveTo(cx + Math.cos(a) * S * 0.335, cx + Math.sin(a) * S * 0.335)
    g.lineTo(cx + Math.cos(a) * S * 0.36, cx + Math.sin(a) * S * 0.36)
    g.stroke()
  }
  // runic dash ring
  const rnd = mulberry32(0xf1a6)
  g.lineWidth = 3
  for (let i = 0; i < 20; i++) {
    const a0 = rnd() * TAU
    const a1 = a0 + 0.06 + rnd() * 0.16
    g.globalAlpha = 0.3 + rnd() * 0.4
    g.beginPath()
    g.arc(cx, cx, S * 0.26, a0, a1)
    g.stroke()
  }
  g.globalAlpha = 1
  // inner rotated square (diamond)
  g.save()
  g.translate(cx, cx)
  g.rotate(HPI / 2)
  g.strokeStyle = 'rgba(255,255,255,0.65)'
  g.lineWidth = 1.6
  g.strokeRect(-S * 0.14, -S * 0.14, S * 0.28, S * 0.28)
  g.restore()
  return toTex(c)
}

// Vertical core streak — §8 core: #f3c9d8 edge → #fff0cf hot centre, soft
// gaussian width, tapered tips, brighter in the lower third.
function coreStreakTex() {
  const W = 64
  const H = 256
  const c = makeCanvas(W, H)
  const g = c.getContext('2d')
  const img = g.createImageData(W, H)
  const edge = [243, 201, 216] // #f3c9d8
  const core = [255, 240, 207] // #fff0cf
  for (let y = 0; y < H; y++) {
    const v = 1 - y / H // 0 bottom → 1 top (canvas y down, flipY on)
    const tip = ss(v, 0.0, 0.10) * (1 - ss(v, 0.72, 1.0))
    const boost = 1.12 - 0.34 * v
    for (let x = 0; x < W; x++) {
      const dx = (x - W / 2) / (W / 2)
      const gauss = Math.exp(-dx * dx * 5.5)
      const mixv = ss(Math.abs(dx), 0.12, 0.8)
      const i = (y * W + x) * 4
      img.data[i] = lerp(core[0], edge[0], mixv)
      img.data[i + 1] = lerp(core[1], edge[1], mixv)
      img.data[i + 2] = lerp(core[2], edge[2], mixv)
      img.data[i + 3] = clamp(gauss * tip * boost * 255, 0, 255)
    }
  }
  g.putImageData(img, 0, 0)
  return toTex(c)
}

// Tiling sheath streak-noise (R channel). Periodic in both axes so the
// shader can scroll it upward at 4 m/s forever: columns from wrapped
// gaussian streak seeds, vertical life from integer-frequency harmonics.
function sheathNoiseTex(seed) {
  const S = 256
  const c = makeCanvas(S, S)
  const g = c.getContext('2d')
  const rnd = mulberry32(seed)
  const col = new Float32Array(S)
  for (let k = 0; k < 44; k++) {
    const cx = rnd() * S
    const w = 1.5 + rnd() * 6.5
    const amp = 0.28 + rnd() * 0.8
    const span = Math.ceil(w * 3.5)
    for (let dx = -span; dx <= span; dx++) {
      const x = ((Math.round(cx) + dx) % S + S) % S
      col[x] += amp * Math.exp(-(dx * dx) / (2 * w * w))
    }
  }
  const p1 = new Float32Array(S)
  const p2 = new Float32Array(S)
  for (let x = 0; x < S; x++) { p1[x] = rnd() * TAU; p2[x] = rnd() * TAU }
  const img = g.createImageData(S, S)
  for (let y = 0; y < S; y++) {
    const vy = y / S
    for (let x = 0; x < S; x++) {
      const wob =
        0.5 + 0.5 * Math.sin(vy * TAU * 2 + p1[x]) * 0.6 +
        0.5 * Math.sin(vy * TAU * 5 + p2[x]) * 0.4
      const v = clamp(col[x] * (0.45 + 0.75 * wob), 0, 1)
      const i = (y * S + x) * 4
      img.data[i] = clamp(v * 255, 0, 255)
      img.data[i + 1] = img.data[i + 2] = img.data[i]
      img.data[i + 3] = 255
    }
  }
  g.putImageData(img, 0, 0)
  return toTex(c, { wrapX: true, wrapY: true })
}

// Crescent swipe arc for physical hits — cyan-edged white sweep.
function slashTex() {
  const W = 256
  const H = 128
  const c = makeCanvas(W, H)
  const g = c.getContext('2d')
  const passes = [
    { w: 30, col: 'rgba(159,216,255,0.34)' }, // #9fd8ff halo
    { w: 16, col: 'rgba(223,245,255,0.6)' },  // #dff5ff body
    { w: 7, col: 'rgba(255,255,255,0.95)' },  // hot core
  ]
  for (const p of passes) {
    for (let i = 0; i <= 64; i++) {
      const t = i / 64 * 2 - 1 // −1..1 along the arc
      const ang = Math.PI * (0.5 + t * 0.40)
      const x = W / 2 + Math.cos(ang - HPI) * 108
      const y = H + 34 - Math.sin(ang - HPI + HPI) * 118
      const w = p.w * Math.pow(1 - t * t, 0.75)
      if (w < 0.4) continue
      g.fillStyle = p.col
      g.beginPath()
      g.ellipse(x, y, w * 0.62, w * 0.45, ang, 0, TAU)
      g.fill()
    }
  }
  return toTex(c)
}

// Angular rock shard atlas (4 variants) — stonera. Painterly-lit crystal
// wedges on the hall stone ramp (#6a5952 → #997962 → #c9b088, glint
// #e8d19b), dark edge, transparent outside. Normal blending — it's matter.
function shardTex() {
  const FW = 96
  const FH = 128
  const c = makeCanvas(FW * 4, FH)
  const g = c.getContext('2d')
  const rnd = mulberry32(0x570e)
  for (let f = 0; f < 4; f++) {
    const ox = f * FW
    const bx0 = ox + 16 + rnd() * 8
    const bx1 = ox + FW - 16 - rnd() * 8
    const tx = ox + FW * (0.38 + rnd() * 0.24)
    const ty = 8 + rnd() * 14
    const midL = ox + FW * (0.22 + rnd() * 0.1)
    const midR = ox + FW * (0.68 + rnd() * 0.1)
    const midY = FH * (0.42 + rnd() * 0.12)
    // silhouette
    g.fillStyle = '#6a5952'
    g.beginPath()
    g.moveTo(bx0, FH - 4)
    g.lineTo(midL, midY)
    g.lineTo(tx, ty)
    g.lineTo(midR, midY * 0.92)
    g.lineTo(bx1, FH - 4)
    g.closePath()
    g.fill()
    // lit facet (left of apex)
    g.fillStyle = '#997962'
    g.beginPath()
    g.moveTo(midL, midY)
    g.lineTo(tx, ty)
    g.lineTo(tx - (tx - midL) * 0.1, FH - 6)
    g.lineTo(bx0 + 6, FH - 5)
    g.closePath()
    g.fill()
    // bright facet strip
    g.fillStyle = '#c9b088'
    g.beginPath()
    g.moveTo(tx, ty)
    g.lineTo(tx + (midR - tx) * 0.45, midY * 0.8)
    g.lineTo(tx + (midR - tx) * 0.2, FH - 8)
    g.lineTo(tx - 4, FH - 8)
    g.closePath()
    g.fill()
    // apex glint
    g.strokeStyle = '#e8d19b'
    g.lineWidth = 2.5
    g.beginPath()
    g.moveTo(tx, ty + 2)
    g.lineTo(tx - (tx - midL) * 0.42, midY * 0.75)
    g.stroke()
    // cool shadow face + dark edge glaze (hue-bearing, never black)
    g.fillStyle = 'rgba(42,36,44,0.55)'
    g.beginPath()
    g.moveTo(midR, midY * 0.92)
    g.lineTo(bx1, FH - 4)
    g.lineTo(tx + (midR - tx) * 0.35, FH - 6)
    g.closePath()
    g.fill()
    g.strokeStyle = 'rgba(48,40,46,0.9)'
    g.lineWidth = 2
    g.beginPath()
    g.moveTo(bx0, FH - 4)
    g.lineTo(midL, midY)
    g.lineTo(tx, ty)
    g.lineTo(midR, midY * 0.92)
    g.lineTo(bx1, FH - 4)
    g.stroke()
  }
  return toTex(c)
}

// Soft grey-warm dust puff (stonera) — irregular accumulation of soft dabs.
function puffTex() {
  const S = 128
  const c = makeCanvas(S, S)
  const g = c.getContext('2d')
  const rnd = mulberry32(0xd057)
  for (let i = 0; i < 26; i++) {
    const a = rnd() * TAU
    const r = rnd() * S * 0.26
    const x = S / 2 + Math.cos(a) * r
    const y = S / 2 + Math.sin(a) * r * 0.8
    const rad = S * (0.10 + rnd() * 0.16)
    const grad = g.createRadialGradient(x, y, 0, x, y, rad)
    grad.addColorStop(0, 'rgba(168,159,147,0.16)') // #a89f93 warm-grey
    grad.addColorStop(1, 'rgba(160,150,140,0)')
    g.fillStyle = grad
    g.beginPath()
    g.arc(x, y, rad, 0, TAU)
    g.fill()
  }
  return toTex(c)
}

function buildKit() {
  return {
    dot: dotTex(),
    groundGlow: groundGlowTex(),
    ring: ringTex(),
    glyph: glyphTex(),
    coreStreak: coreStreakTex(),
    sheathNoise: sheathNoiseTex(0xbead),
    slash: slashTex(),
    shard: shardTex(),
    puff: puffTex(),
  }
}

// ===========================================================================
// 3. Shared spark pool — ONE THREE.Points, hard cap 180 alive (§8 budget)
// ===========================================================================

const POOL_CAP = 180

function makeSparkPool() {
  const geo = new THREE.BufferGeometry()
  const aPos = new Float32Array(POOL_CAP * 3)
  const aCol = new Float32Array(POOL_CAP * 3)
  const aAlpha = new Float32Array(POOL_CAP)
  const aSize = new Float32Array(POOL_CAP)
  const posAttr = new THREE.BufferAttribute(aPos, 3).setUsage(THREE.DynamicDrawUsage)
  const colAttr = new THREE.BufferAttribute(aCol, 3).setUsage(THREE.DynamicDrawUsage)
  const alphaAttr = new THREE.BufferAttribute(aAlpha, 1).setUsage(THREE.DynamicDrawUsage)
  const sizeAttr = new THREE.BufferAttribute(aSize, 1).setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute('position', posAttr)
  geo.setAttribute('aCol', colAttr)
  geo.setAttribute('aAlpha', alphaAttr)
  geo.setAttribute('aSize', sizeAttr)

  const mat = new THREE.ShaderMaterial({
    uniforms: { uPxScale: { value: 1500 } },
    vertexShader: [
      'attribute vec3 aCol;',
      'attribute float aAlpha;',
      'attribute float aSize;',
      'uniform float uPxScale;',
      'varying vec3 vCol;',
      'varying float vAlpha;',
      'void main() {',
      '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
      '  gl_PointSize = clamp(aSize * uPxScale / max(0.5, -mv.z), 1.0, 26.0);',
      '  vCol = aCol;',
      '  vAlpha = aAlpha;',
      '  gl_Position = projectionMatrix * mv;',
      '}',
    ].join('\n'),
    fragmentShader: [
      'varying vec3 vCol;',
      'varying float vAlpha;',
      'void main() {',
      '  vec2 d = gl_PointCoord - 0.5;',
      '  float r = length(d) * 2.0;',
      '  float core = exp(-r * r * 6.0);',
      '  float halo = exp(-r * r * 2.2) * 0.35;',
      '  float a = (core + halo) * vAlpha;',
      '  if (a < 0.004) discard;',
      '  gl_FragColor = vec4(vCol * a, a);',
      '}',
    ].join('\n'),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
  })

  const points = new THREE.Points(geo, mat)
  points.name = 'vfxSparks'
  points.frustumCulled = false

  const P = []
  for (let i = 0; i < POOL_CAP; i++) {
    P.push({
      alive: false, x: 0, y: -100, z: 0, vx: 0, vy: 0, vz: 0,
      age: 0, life: 1, size: 0.03, drag: 0, grav: 0,
      c0: [1, 1, 1], c1: [1, 1, 1], cMid: 0.5,
      twF: 10, twP: 0, fadeIn: 0.05, seek: null, pow: 1.2,
    })
  }
  let alive = 0
  const anchor = new THREE.Vector3(0, 1, -7)

  function spawn(o) {
    if (alive >= POOL_CAP) return false
    for (let i = 0; i < POOL_CAP; i++) {
      const p = P[i]
      if (p.alive) continue
      p.alive = true
      alive++
      p.x = o.x; p.y = o.y; p.z = o.z
      p.vx = o.vx || 0; p.vy = o.vy || 0; p.vz = o.vz || 0
      p.age = 0
      p.life = o.life || 1
      p.size = o.size || 0.03
      p.drag = o.drag || 0
      p.grav = o.grav === undefined ? 0 : o.grav
      p.c0 = o.c0 || p.c0
      p.c1 = o.c1 || o.c0 || p.c1
      p.cMid = o.cMid === undefined ? 0.5 : o.cMid
      p.twF = o.twF === undefined ? 10 : o.twF
      p.twP = Math.random() * TAU
      p.fadeIn = o.fadeIn === undefined ? 0.05 : o.fadeIn
      p.seek = o.seek || null
      p.pow = o.pow === undefined ? 1.2 : o.pow
      return true
    }
    return false
  }

  function update(dt, t) {
    for (let i = 0; i < POOL_CAP; i++) {
      const p = P[i]
      if (!p.alive) {
        aAlpha[i] = 0
        continue
      }
      p.age += dt
      if (p.age >= p.life) {
        p.alive = false
        alive--
        aAlpha[i] = 0
        aPos[i * 3 + 1] = -100
        continue
      }
      if (p.seek) {
        // converging windup motes — accelerate toward the gather point
        const dx = p.seek.x - p.x
        const dy = p.seek.y - p.y
        const dz = p.seek.z - p.z
        const d = Math.hypot(dx, dy, dz) + 1e-4
        const pull = 26 * dt
        p.vx += (dx / d) * pull
        p.vy += (dy / d) * pull
        p.vz += (dz / d) * pull
      }
      if (p.drag > 0) {
        const k = Math.exp(-p.drag * dt)
        p.vx *= k; p.vy *= k; p.vz *= k
      }
      p.vy += p.grav * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt
      const u = p.age / p.life
      const cm = ss(u, p.cMid * 0.4, p.cMid * 1.6)
      aCol[i * 3] = lerp(p.c0[0], p.c1[0], cm)
      aCol[i * 3 + 1] = lerp(p.c0[1], p.c1[1], cm)
      aCol[i * 3 + 2] = lerp(p.c0[2], p.c1[2], cm)
      let al = Math.pow(1 - u, p.pow) * ss(p.age, 0, p.fadeIn)
      if (p.twF > 0) al *= 0.78 + 0.22 * Math.sin(t * p.twF * TAU * 0.5 + p.twP)
      aAlpha[i] = al
      aSize[i] = p.size * (1 - 0.35 * u)
      aPos[i * 3] = p.x - anchor.x
      aPos[i * 3 + 1] = p.y - anchor.y
      aPos[i * 3 + 2] = p.z - anchor.z
    }
    points.position.copy(anchor)
    posAttr.needsUpdate = true
    colAttr.needsUpdate = true
    alphaAttr.needsUpdate = true
    sizeAttr.needsUpdate = true
  }

  return {
    points, mat, spawn, update, anchor,
    get alive() { return alive },
  }
}

// ===========================================================================
// 4. Impulse mixer — { shake, flash } as 0..1 decaying envelopes (§8)
// ===========================================================================
// Post owns the oscillation and the px/percent mapping; we own the envelope.
// Events combine by MAX (never sum) so overlapping casts cannot break the
// "≤ 15 % flash / ≤ 7 px shake" ceilings, and each cast fires at most one of
// each (guarded per-instance).

function makeImpulseMixer() {
  const events = []
  const impulses = { shake: 0, flash: 0 }
  function fire(kind, peak, dur, tNow) {
    events.push({ kind, peak: clamp(peak, 0, 1), dur, t0: tNow })
  }
  function update(tNow) {
    let shake = 0
    let flash = 0
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      const u = (tNow - e.t0) / e.dur
      if (u >= 1) {
        events.splice(i, 1)
        continue
      }
      let v
      if (e.kind === 'flash') {
        // fast rise (15 %), then smooth fall — reads as a 60 ms pop
        v = e.peak * (u < 0.15 ? u / 0.15 : 1 - ss(u, 0.15, 1))
      } else {
        v = e.peak * Math.pow(1 - u, 1.6)
      }
      if (e.kind === 'flash') flash = Math.max(flash, v)
      else shake = Math.max(shake, v)
    }
    impulses.shake = clamp(shake, 0, 1)
    impulses.flash = clamp(flash, 0, 1)
  }
  return { impulses, fire, update }
}

// ===========================================================================
// 5. Sheath shader — scrolling streak-noise inside a rippled-rim envelope
// ===========================================================================
// The §8 sheath: noise scrolls upward at 4 m/s while the top rim ripples at
// λ ≈ 0.5 m. Eruption is a SHADER reveal (uGrow sweeps the rim up from the
// floor) rather than a scale.y animation — the mesh transform never moves,
// so its transparent-sort depth stays planted at column mid-height and the
// painter's order keeps the wash correctly over the victim / under nearer
// party sprites for the whole life of the effect.

function makeSheathMaterial(noiseTex, tintHex, o) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: noiseTex },
      uTint: { value: new THREE.Color(tintHex) },
      uOpacity: { value: 0 },
      uTime: { value: 0 },
      uGrow: { value: 0 },                // 0 hidden → 1 fully risen
      uScroll: { value: o.scroll },       // uv units / s (1 uv unit = full height)
      uRepeat: { value: new THREE.Vector2(o.rx, o.ry) },
      uRipple: { value: new THREE.Vector3(o.rippleFreq, o.rippleAmp, o.ripplePhase || 0) },
      uRim: { value: o.rim },             // top-fade centre in uv.y
      uBaseBoost: { value: o.baseBoost === undefined ? 0.5 : o.baseBoost },
    },
    vertexShader: [
      'varying vec2 vUv;',
      'void main() {',
      '  vUv = uv;',
      '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
      '}',
    ].join('\n'),
    fragmentShader: [
      'varying vec2 vUv;',
      'uniform sampler2D uMap;',
      'uniform vec3 uTint;',
      'uniform vec3 uRipple;',
      'uniform vec2 uRepeat;',
      'uniform float uOpacity, uTime, uGrow, uScroll, uRim, uBaseBoost;',
      'void main() {',
      '  vec2 uv = vec2(vUv.x * uRepeat.x, vUv.y * uRepeat.y - uTime * uScroll);',
      '  float n = texture2D(uMap, uv).r;',
      '  float n2 = texture2D(uMap, uv * 1.7 + vec2(0.31, uTime * uScroll * 0.35)).r;',
      '  float streak = clamp(n * 0.8 + n2 * 0.45, 0.0, 1.15);',
      '  float rim = uRim',
      '    + uRipple.y * sin(vUv.x * uRipple.x * 6.28318 + uRipple.z + uTime * 2.4)',
      '    + uRipple.y * 0.6 * sin(vUv.x * uRipple.x * 12.9 - uTime * 3.1);',
      '  rim -= (1.0 - uGrow) * 1.5;', // eruption: the rim sweeps up from the floor
      '  float env = smoothstep(0.0, 0.055, vUv.y) * (1.0 - smoothstep(rim - 0.38, rim, vUv.y));',
      '  env *= 1.0 + uBaseBoost * (1.0 - vUv.y);',
      '  float a = streak * env * uOpacity;',
      '  if (a < 0.003) discard;',
      '  gl_FragColor = vec4(uTint * a, a);',
      '}',
    ].join('\n'),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
}

function basicAdd(map, colorHex, opacity) {
  return new THREE.MeshBasicMaterial({
    map, color: colorHex, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  })
}

// ===========================================================================
// 6. Rig builders — reusable mesh kits, pooled per effect type
// ===========================================================================

// Shared unit geometries. Sort note: three sorts transparents by each
// mesh's WORLD-MATRIX position, so vertical column pieces use CENTERED
// geometry with mesh.position.y = h/2 — their sort depth lands at column
// mid-height (chest-ish), nearer the camera than the victim's billboard
// centre, so the additive wash draws over him exactly like frame04, while
// party members standing metres nearer still sort in front of the glow.
// Ground decals keep y ≈ 0 and therefore sort under every sprite.
function unitPlaneBase() { // base-anchored (stonera shards grow from soil)
  const g = new THREE.PlaneGeometry(1, 1)
  g.translate(0, 0.5, 0)
  return g
}
function unitPlaneC() { // centred (streaks, beams, arcs, aura)
  return new THREE.PlaneGeometry(1, 1)
}
function unitCylinder() {
  // slight base flare like the plate column; open-ended, centred
  return new THREE.CylinderGeometry(0.93, 1.07, 1, 26, 1, true)
}
function flatPlane() {
  const g = new THREE.PlaneGeometry(1, 1)
  g.rotateX(-HPI)
  return g
}

const GEO = { plane: null, planeC: null, cyl: null, flat: null }
function geoKit() {
  if (!GEO.plane) {
    GEO.plane = unitPlaneBase()
    GEO.planeC = unitPlaneC()
    GEO.cyl = unitCylinder()
    GEO.flat = flatPlane()
  }
  return GEO
}

// ---- FIRAGA rig (§8, the frame04 burst) -----------------------------------
// Sheath pairing r → h per §8 (outer is tallest): 0.55/2.2, 0.75/2.6,
// 0.95/3.0. Brightness falls outward: #c190b0 hugging the core, #a56f87 mid,
// #664071 deep violet fringe — the plate's outermost wisps are the darkest.
function buildFiragaRig(kit) {
  const G = geoKit()
  const group = new THREE.Group()
  group.name = 'vfx_firaga'
  group.visible = false
  const rnd = mulberry32(0xf19a)

  const shellSpec = [
    { r: 0.55, h: 2.2, tint: 0xc190b0, op: 0.46, freq: 7, rim: 0.80 },
    { r: 0.75, h: 2.6, tint: 0xa56f87, op: 0.36, freq: 9, rim: 0.76 },
    { r: 0.95, h: 3.0, tint: 0x664071, op: 0.30, freq: 12, rim: 0.72 },
  ]
  const shells = shellSpec.map((s, i) => {
    const mat = makeSheathMaterial(kit.sheathNoise, s.tint, {
      scroll: 4.0 / s.h,          // §8: noise rises 4 m/s regardless of height
      rx: (TAU * s.r) / 1.2,      // ~1.2 m of pattern per wrap
      ry: 1,
      rippleFreq: s.freq,         // λ ≈ 0.5 m at this circumference
      rippleAmp: 0.045,
      ripplePhase: i * 2.1,
      rim: s.rim,
      baseBoost: 0.55,
    })
    const m = new THREE.Mesh(G.cyl, mat)
    m.scale.set(s.r, s.h, s.r)
    m.position.y = s.h / 2 // fixed transform; eruption happens in-shader
    group.add(m)
    return { m, mat, spec: s }
  })

  // 12 core streak quads, 0.15–0.4 m wide, 2.4–3.2 m tall (§8). Three carry
  // the plate's chroma accents: pale gold, pale cyan, rose.
  const accents = [0xffe9b8, 0xbfeadf, 0xf6b8d8]
  const streaks = []
  for (let i = 0; i < 12; i++) {
    const w = 0.15 + rnd() * 0.25
    const h = 2.4 + rnd() * 0.8
    const tint = i < 3 ? accents[i] : 0xffffff
    const mat = basicAdd(kit.coreStreak, tint, 0)
    mat.side = THREE.DoubleSide
    const m = new THREE.Mesh(G.planeC, mat)
    const a = (i / 12) * TAU + rnd() * 0.5
    const rr = 0.06 + rnd() * 0.32
    m.position.set(Math.cos(a) * rr, h / 2, Math.sin(a) * rr)
    m.rotation.y = (rnd() - 0.5) * 1.4
    m.scale.set(w, h, 1)
    group.add(m)
    streaks.push({
      m, mat, h, w,
      appear: 0.02 + rnd() * 0.07,
      die0: 0.62 + rnd() * 0.28,   // staggered deaths through the decay
      flickF: 9 + rnd() * 7,
      flickP: rnd() * TAU,
      op: i < 3 ? 0.55 : 0.85,
    })
  }

  // wide soft aura behind everything — the pre-bloom haze glueing the column
  const aura = new THREE.Mesh(G.planeC, basicAdd(kit.coreStreak, 0xb073a4, 0))
  aura.material.side = THREE.DoubleSide
  aura.scale.set(2.9, 3.6, 1)
  aura.position.y = 1.8
  group.add(aura)

  // ground: contact glow (r 1.3 m disc), expanding shock ring, caster glyph
  const glow = new THREE.Mesh(G.flat, basicAdd(kit.groundGlow, 0xffffff, 0))
  glow.position.y = 0.02
  glow.scale.set(2.6, 1, 2.6)
  group.add(glow)

  const ring = new THREE.Mesh(G.flat, basicAdd(kit.ring, 0xee9ad8, 0))
  ring.position.y = 0.035
  group.add(ring)

  // glyph + comet live in scene space (they sit at the CASTER / travel),
  // parented to the rig group but positioned in group-local offsets.
  const glyph = new THREE.Mesh(G.flat, basicAdd(kit.glyph, 0xe08ad8, 0))
  glyph.position.y = 0.03
  glyph.scale.set(1.8, 1, 1.8)
  group.add(glyph)

  const comet = new THREE.Sprite(new THREE.SpriteMaterial({
    map: kit.dot, color: 0xffd9ee, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  }))
  comet.scale.set(0.55, 0.55, 1)
  group.add(comet)

  return { group, shells, streaks, aura, glow, ring, glyph, comet, busy: false }
}

// ---- CURE rig (frame05's rose beam) ---------------------------------------
function buildCureRig(kit) {
  const G = geoKit()
  const group = new THREE.Group()
  group.name = 'vfx_cure'
  group.visible = false

  const sheathMat = makeSheathMaterial(kit.sheathNoise, 0xdf9dbd, {
    scroll: 1.1, rx: 2.6, ry: 1, rippleFreq: 6, rippleAmp: 0.05,
    ripplePhase: 0.7, rim: 0.86, baseBoost: 0.25,
  })
  const sheath = new THREE.Mesh(G.cyl, sheathMat)
  sheath.scale.set(0.42, 2.3, 0.42)
  sheath.position.y = 2.3 / 2
  group.add(sheath)

  const beam = new THREE.Mesh(G.planeC, basicAdd(kit.coreStreak, 0xffe8f1, 0))
  beam.material.side = THREE.DoubleSide
  beam.scale.set(0.5, 2.4, 1)
  beam.position.y = 2.4 / 2
  group.add(beam)

  const beam2 = new THREE.Mesh(G.planeC, basicAdd(kit.coreStreak, 0xf6c3da, 0))
  beam2.material.side = THREE.DoubleSide
  beam2.scale.set(0.9, 2.1, 1)
  beam2.position.y = 2.1 / 2
  group.add(beam2)

  const glow = new THREE.Mesh(G.flat, basicAdd(kit.groundGlow, 0xf6bcd6, 0))
  glow.position.y = 0.02
  glow.scale.set(1.6, 1, 1.6)
  group.add(glow)

  const glyph = new THREE.Mesh(G.flat, basicAdd(kit.glyph, 0xf2b9d5, 0))
  glyph.position.y = 0.03
  glyph.scale.set(1.5, 1, 1.5)
  group.add(glyph)

  return { group, sheath, sheathMat, beam, beam2, glow, glyph, busy: false }
}

// ---- SLASH rig (physical impact) ------------------------------------------
function buildSlashRig(kit) {
  const G = geoKit()
  const group = new THREE.Group()
  group.name = 'vfx_slash'
  group.visible = false

  const arcs = []
  for (let i = 0; i < 2; i++) {
    const mat = basicAdd(kit.slash, 0xdff5ff, 0)
    mat.side = THREE.DoubleSide
    const m = new THREE.Mesh(G.planeC, mat)
    m.scale.set(1.7, 0.9, 1)
    group.add(m)
    arcs.push({ m, mat })
  }
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({
    map: kit.dot, color: 0xeaf6ff, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  }))
  flash.scale.set(1.1, 1.1, 1)
  group.add(flash)

  return { group, arcs, flash, busy: false }
}

// ---- STONERA rig (frame05 banner spell — earth burst) ---------------------
function buildStoneraRig(kit) {
  const G = geoKit()
  const group = new THREE.Group()
  group.name = 'vfx_stonera'
  group.visible = false
  const rnd = mulberry32(0x5709)

  const shards = []
  for (let i = 0; i < 7; i++) {
    const v = i % 4
    const geo = G.plane.clone()
    const uv = geo.attributes.uv
    for (let k = 0; k < uv.count; k++) uv.setXY(k, (uv.getX(k) + v) * 0.25, uv.getY(k))
    const mat = new THREE.MeshBasicMaterial({
      map: kit.shard, transparent: true, opacity: 0,
      depthWrite: false, side: THREE.DoubleSide, fog: true,
    })
    const m = new THREE.Mesh(geo, mat)
    const a = (i / 7) * TAU + rnd() * 0.6
    const rr = 0.35 + rnd() * 0.55
    m.position.set(Math.cos(a) * rr, 0, Math.sin(a) * rr)
    m.rotation.y = rnd() * TAU
    m.rotation.z = (rnd() - 0.5) * 0.42 // tilted outward eruption
    const w = 0.5 + rnd() * 0.45
    const h = 0.9 + rnd() * 0.8
    group.add(m)
    shards.push({
      m, mat, w, h,
      appear: rnd() * 0.14,
      spinP: rnd() * TAU,
    })
  }

  const puffs = []
  for (let i = 0; i < 6; i++) {
    const mat = new THREE.SpriteMaterial({
      map: kit.puff, color: 0xa89f93, transparent: true, opacity: 0,
      depthWrite: false, fog: true,
    })
    const s = new THREE.Sprite(mat)
    const a = (i / 6) * TAU + rnd()
    s.position.set(Math.cos(a) * 0.7, 0.25, Math.sin(a) * 0.7)
    puffs.push({ s, mat, a, phase: rnd() * TAU })
    group.add(s)
  }

  const ring = new THREE.Mesh(G.flat, basicAdd(kit.ring, 0xd9b36a, 0))
  ring.position.y = 0.03
  group.add(ring)

  const glow = new THREE.Mesh(G.flat, basicAdd(kit.groundGlow, 0xd9b36a, 0))
  glow.position.y = 0.02
  glow.scale.set(1.8, 1, 1.8)
  group.add(glow)

  return { group, shards, puffs, ring, glow, busy: false }
}

// ===========================================================================
// 7. Effect definitions — timing curves per BIBLE §8/§9, IMAGES-first shapes
// ===========================================================================
// Each def: { dur, hold, build, begin(inst), tick(inst, tl, dt, ctx) }.
// tick runs with tl = local seconds (clamped at `hold` when frozen); ctx
// carries { t, pool, mixer, camera, lin }. Instances hold their per-cast
// randoms and one pooled PointLight.

const FIRAGA_COL = {
  spark0: lin3(0xfff6f0),
  spark1: lin3(0xdca9c8),   // §8 spark ramp white → #dca9c8
  gather: lin3(0xe9a4d8),
  light: 0xee86d2,          // §8 spell light
}

const firagaDef = {
  dur: 1.35,                // §8: windup .25 → burst .40 (peak +.10) → decay .70
  hold: 0.52,               // freeze here: full column, sparks mid-flight
  lightDist: 11,
  build: buildFiragaRig,
  begin(inst) {
    const R = inst.rig
    const W = 0.25
    inst.W = W
    inst.PK = W + 0.10
    // comet path: caster mouth → apex → target base (arrives exactly at W)
    const from = inst.casterPos
    const to = inst.base
    inst.cometFrom = from
      ? new THREE.Vector3(from.x, from.y + (inst.casterEnemy ? 2.0 : 1.15), from.z)
      : new THREE.Vector3(to.x, to.y + 3.4, to.z)
    inst.cometApex = new THREE.Vector3(
      (inst.cometFrom.x + to.x) / 2,
      Math.max(inst.cometFrom.y, to.y) + 1.5,
      (inst.cometFrom.z + to.z) / 2
    )
    // glyph sits under the caster (skip if unknown); group-local offset
    if (from) {
      R.glyph.position.set(from.x - to.x, (from.y - to.y) + 0.03, from.z - to.z)
      R.glyph.visible = true
    } else {
      R.glyph.visible = false
    }
    inst.emitAcc = 0
    inst.gatherAcc = 0
    inst.trailAcc = 0
  },
  tick(inst, tl, dt, ctx) {
    const R = inst.rig
    const W = inst.W
    const t = ctx.t
    const rnd = inst.rnd
    const bx = inst.base.x
    const by = inst.base.y
    const bz = inst.base.z

    // ---- windup: glyph, comet, gathering glow (250 ms) --------------------
    const glyA = 0.45 * ss(tl, 0.03, 0.18) * (1 - ss(tl, W, W + 0.16))
    R.glyph.material.opacity = glyA
    R.glyph.rotation.z = t * 0.55
    if (tl < W + 0.05) {
      const u = env01(tl, 0.02, W)
      const e = easeOutCubic(u)
      const a = inst.cometFrom
      const b = inst.cometApex
      const c = inst.base
      // quadratic bezier
      const x = (1 - e) * (1 - e) * a.x + 2 * (1 - e) * e * b.x + e * e * c.x
      const y = (1 - e) * (1 - e) * a.y + 2 * (1 - e) * e * b.y + e * e * (c.y + 0.25)
      const z = (1 - e) * (1 - e) * a.z + 2 * (1 - e) * e * b.z + e * e * c.z
      R.comet.position.set(x - bx, y - by, z - bz)
      R.comet.material.opacity = 0.85 * ss(tl, 0.02, 0.10) * (1 - ss(tl, W - 0.02, W + 0.04))
      // comet trail from the shared pool
      inst.trailAcc += dt * 70
      while (inst.trailAcc >= 1) {
        inst.trailAcc -= 1
        ctx.pool.spawn({
          x: x + (rnd() - 0.5) * 0.1, y: y + (rnd() - 0.5) * 0.1, z: z + (rnd() - 0.5) * 0.1,
          vx: (rnd() - 0.5) * 0.5, vy: (rnd() - 0.5) * 0.5 - 0.3, vz: (rnd() - 0.5) * 0.5,
          life: 0.2 + rnd() * 0.15, size: 0.02 + rnd() * 0.02,
          c0: FIRAGA_COL.spark0, c1: FIRAGA_COL.gather, cMid: 0.4, twF: 0, fadeIn: 0.01,
        })
      }
      // gathering motes spiral into the base
      if (tl > 0.04 && tl < W - 0.03) {
        inst.gatherAcc += dt * 55
        while (inst.gatherAcc >= 1) {
          inst.gatherAcc -= 1
          const a2 = rnd() * TAU
          const rr = 0.9 + rnd() * 0.6
          ctx.pool.spawn({
            x: bx + Math.cos(a2) * rr, y: by + 0.05 + rnd() * 0.5, z: bz + Math.sin(a2) * rr,
            vx: -Math.sin(a2) * 1.6, vy: 0.3, vz: Math.cos(a2) * 1.6,
            life: 0.22 + rnd() * 0.1, size: 0.024 + rnd() * 0.014,
            c0: FIRAGA_COL.gather, c1: FIRAGA_COL.spark0, cMid: 0.6,
            seek: { x: bx, y: by + 0.35, z: bz }, twF: 12, fadeIn: 0.04, pow: 0.8,
          })
        }
      }
    } else {
      R.comet.material.opacity = 0
    }

    // ---- ground glow: gathers in windup, spikes at burst, dies last -------
    const glowIn = 0.30 * ss(tl, 0.05, W)
    const glowBurst = 0.62 * ss(tl, W, W + 0.09) * (1 - ss(tl, 0.85, 1.28))
    R.glow.material.opacity = Math.min(0.85, glowIn + glowBurst)
    const gs = 2.6 * (0.55 + 0.45 * ss(tl, 0.05, W + 0.1))
    R.glow.scale.set(gs, 1, gs)

    // ---- impulses + impact callback, once, as the column erupts (§8) ------
    if (!inst.impulsed && tl >= W + 0.02) {
      inst.impulsed = true
      // 12 % of the 15 % flash budget, 60 ms; 6 px of 7 px shake, 180 ms
      ctx.mixer.fire('flash', 0.80, 0.11, t)
      ctx.mixer.fire('shake', 0.86, 0.18, t)
      if (inst.onImpact) { inst.onImpact(); inst.onImpact = null }
    }

    // ---- shock ring -------------------------------------------------------
    const ru = env01(tl, W, W + 0.5)
    if (ru > 0 && ru < 1) {
      const rs = 0.5 + 3.8 * easeOutCubic(ru)
      R.ring.scale.set(rs, 1, rs)
      R.ring.material.opacity = 0.5 * Math.pow(1 - ru, 1.6)
    } else {
      R.ring.material.opacity = 0
    }

    // ---- sheath shells: staggered shader eruption, staggered decay --------
    const dies = [[0.74, 1.02], [0.88, 1.18], [1.00, 1.34]] // inner first
    for (let i = 0; i < R.shells.length; i++) {
      const S = R.shells[i]
      const st = W + i * 0.035
      S.mat.uniforms.uGrow.value = backOut(env01(tl, st, st + 0.15))
      S.mat.uniforms.uTime.value = t
      S.mat.uniforms.uOpacity.value =
        S.spec.op * ss(tl, st, st + 0.10) * (1 - ss(tl, dies[i][0], dies[i][1]))
    }

    // ---- core streaks: individual lives inside the burst ------------------
    for (const S2 of R.streaks) {
      const st = W + S2.appear
      const grow = backOut(env01(tl, st, st + 0.11))
      S2.m.scale.y = Math.max(0.001,
        S2.h * (0.12 + 0.88 * grow) * (1 + 0.16 * ss(tl, 0.65, 1.3)))
      const flick = 0.8 + 0.2 * Math.sin(t * S2.flickF + S2.flickP)
      S2.mat.opacity =
        S2.op * flick * ss(tl, st, st + 0.07) * (1 - ss(tl, S2.die0, S2.die0 + 0.22))
    }

    // ---- aura haze, yaw-billboarded ---------------------------------------
    R.aura.material.opacity = 0.16 * ss(tl, W, W + 0.14) * (1 - ss(tl, 0.9, 1.3))
    if (ctx.camera) {
      const yaw = Math.atan2(ctx.camera.position.x - bx, ctx.camera.position.z - bz)
      R.aura.rotation.y = yaw
    }

    // ---- sparks: 90 over 0.45 s from inside the column (§8). A frozen
    // burst keeps churning, throttled so steady-state ≈ the ~70-alive peak.
    if (tl >= W && tl <= 0.70) {
      inst.emitAcc += dt * (inst.frozenNow ? 76 : 200)
      while (inst.emitAcc >= 1) {
        inst.emitAcc -= 1
        const a = rnd() * TAU
        const rr = rnd() * 0.5
        ctx.pool.spawn({
          x: bx + Math.cos(a) * rr, y: by + 0.1 + rnd() * 1.3, z: bz + Math.sin(a) * rr,
          vx: (rnd() * 2 - 1) * 0.8,                      // §8 v0 (±0.8, 3.5–6.5, ±0.8)
          vy: 3.5 + rnd() * 3.0,
          vz: (rnd() * 2 - 1) * 0.8,
          grav: -1.5, drag: 1.05,                         // drag caps apex ≈ 1.4 m over the column
          life: 0.7 + rnd() * 0.5,                        // §8 life 0.7–1.2 s
          size: 0.022 + rnd() * 0.038,                    // 2–6 px @1080p
          c0: FIRAGA_COL.spark0, c1: FIRAGA_COL.spark1, cMid: 0.5,
          twF: 8 + rnd() * 6, fadeIn: 0.03,
        })
      }
    }

    // ---- the travelling light: THE §8 mandate -----------------------------
    // Windup: rides the comet at gentle intensity. Burst: snaps to the
    // column, 0→60 into the +100 ms peak, holds warm through the body of the
    // burst, then dies with the decay. Position climbs the column and
    // jitters ±0.06 m so the spill shimmers on the flagstones.
    const L = inst.light
    if (L) {
      if (tl < W) {
        L.position.copy(R.comet.position).add(inst.groupPos)
        L.intensity = 14 * ss(tl, 0.02, 0.12)
      } else {
        const rise = 60 * ss(tl, W, inst.PK)
        const body = 1 - 0.27 * env01(tl, inst.PK, 0.65)
        const tail = 1 - ss(tl, 0.65, 1.30)
        L.intensity = rise * body * tail
        const ly = by + 1.3 * ss(tl, W, W + 0.12) + 0.55 * ss(tl, W + 0.1, 0.9)
        L.position.set(
          bx + (vnoiseS(t * 7.1) - 0.5) * 0.12,
          ly + (vnoiseS(t * 6.3 + 9.7) - 0.5) * 0.12,
          bz + (vnoiseS(t * 7.9 + 4.2) - 0.5) * 0.12
        )
      }
    }
  },
}

// tiny smooth 1-D noise for light jitter (independent of arena's)
function hash1S(i) {
  let h = (i | 0) * 0x27d4eb2d
  h = (h ^ (h >>> 15)) * 0x85ebca6b
  h = h ^ (h >>> 13)
  return (h >>> 0) / 4294967296
}
function vnoiseS(x) {
  const i = Math.floor(x)
  const f = x - i
  const u = f * f * (3 - 2 * f)
  return hash1S(i) * (1 - u) + hash1S(i + 1) * u
}

const CURE_COL = {
  m0: lin3(0xfff4f8),
  m1: lin3(0xf2c4dc),
  light: 0xf2a8cc,
}

const cureDef = {
  dur: 1.7,
  hold: 0.9,
  lightDist: 7,
  build: buildCureRig,
  begin(inst) {
    inst.emitAcc = 0
  },
  tick(inst, tl, dt, ctx) {
    const R = inst.rig
    const t = ctx.t
    const rnd = inst.rnd
    const bx = inst.base.x
    const by = inst.base.y
    const bz = inst.base.z

    R.glyph.material.opacity = 0.4 * ss(tl, 0.02, 0.2) * (1 - ss(tl, 1.1, 1.5))
    R.glyph.rotation.z = -t * 0.4

    const on = ss(tl, 0.2, 0.55)
    const off = 1 - ss(tl, 1.0, 1.62)
    R.sheathMat.uniforms.uTime.value = t
    R.sheathMat.uniforms.uOpacity.value = 0.30 * on * off
    R.sheathMat.uniforms.uGrow.value = backOut(env01(tl, 0.18, 0.5))

    const breathe = 1 + 0.05 * Math.sin(t * 2.2)
    R.beam.material.opacity = 0.5 * on * off * (0.85 + 0.15 * Math.sin(t * 5.2))
    R.beam.scale.y = 2.4 * (0.3 + 0.7 * backOut(env01(tl, 0.2, 0.55))) * breathe
    R.beam2.material.opacity = 0.26 * on * off
    R.beam2.scale.y = 2.1 * (0.3 + 0.7 * backOut(env01(tl, 0.24, 0.6)))
    if (ctx.camera) {
      const yaw = Math.atan2(ctx.camera.position.x - bx, ctx.camera.position.z - bz)
      R.beam.rotation.y = yaw
      R.beam2.rotation.y = yaw + 0.5
    }

    R.glow.material.opacity = 0.42 * on * off

    // gentle rising motes — no gravity, they float
    if (tl > 0.25 && tl < 1.2) {
      inst.emitAcc += dt * 22
      while (inst.emitAcc >= 1) {
        inst.emitAcc -= 1
        const a = rnd() * TAU
        const rr = 0.15 + rnd() * 0.45
        ctx.pool.spawn({
          x: bx + Math.cos(a) * rr, y: by + 0.05 + rnd() * 0.4, z: bz + Math.sin(a) * rr,
          vx: (rnd() - 0.5) * 0.24, vy: 0.75 + rnd() * 0.8, vz: (rnd() - 0.5) * 0.24,
          grav: 0.25, drag: 0.4,
          life: 0.9 + rnd() * 0.5, size: 0.02 + rnd() * 0.022,
          c0: CURE_COL.m0, c1: CURE_COL.m1, cMid: 0.55,
          twF: 6 + rnd() * 5, fadeIn: 0.12, pow: 1.5,
        })
      }
    }
    if (inst.onImpact && tl >= 0.55) { inst.onImpact(); inst.onImpact = null }

    const L = inst.light
    if (L) {
      L.intensity = 22 * ss(tl, 0.2, 0.5) * (1 - ss(tl, 1.0, 1.6))
      L.position.set(bx, by + 1.1 + 0.25 * Math.sin(t * 1.8), bz)
    }
  },
}

const SLASH_COL = {
  s0: lin3(0xeaf6ff),
  s1: lin3(0x9fc6e8),
  light: 0xcfe2ff,
}

const slashDef = {
  dur: 0.5,
  hold: 0.12,
  lightDist: 6,
  build: buildSlashRig,
  begin(inst) {
    // arcs swing at chest height: party ≈ +0.9 m, the big enemy ≈ +1.5 m
    inst.chest = inst.targetEnemy ? 1.5 : 0.9
    inst.burstDone = false
  },
  tick(inst, tl, dt, ctx) {
    const R = inst.rig
    const t = ctx.t
    const rnd = inst.rnd
    const bx = inst.base.x
    const by = inst.base.y + inst.chest
    const bz = inst.base.z
    const yaw = ctx.camera
      ? Math.atan2(ctx.camera.position.x - bx, ctx.camera.position.z - bz)
      : 0

    for (let i = 0; i < 2; i++) {
      const A = R.arcs[i]
      const st = i * 0.07
      const u = env01(tl, st, st + 0.22)
      A.m.position.y = inst.chest
      A.m.rotation.y = yaw
      A.m.rotation.z = (i === 0 ? -0.5 : 2.6) + (i === 0 ? 1 : -1) * 1.1 * easeOutCubic(u)
      const sc = (0.5 + 0.9 * easeOutCubic(u)) * (inst.targetEnemy ? 1.6 : 1.0)
      A.m.scale.set(1.7 * sc, 0.9 * sc, 1)
      A.mat.opacity = 0.9 * ss(u, 0, 0.18) * (1 - ss(u, 0.45, 1))
    }
    R.flash.position.y = inst.chest
    R.flash.material.opacity = 0.7 * ss(tl, 0.04, 0.07) * (1 - ss(tl, 0.1, 0.3))

    if (!inst.burstDone && tl >= 0.06) {
      inst.burstDone = true
      for (let i = 0; i < 16; i++) {
        const a = rnd() * TAU
        const sp = 2.2 + rnd() * 2.4
        ctx.pool.spawn({
          x: bx, y: by + (rnd() - 0.5) * 0.3, z: bz,
          vx: Math.cos(a) * sp, vy: 0.6 + rnd() * 1.8, vz: Math.sin(a) * sp * 0.6,
          grav: -6, drag: 1.6,
          life: 0.28 + rnd() * 0.2, size: 0.02 + rnd() * 0.024,
          c0: SLASH_COL.s0, c1: SLASH_COL.s1, cMid: 0.4, twF: 0, fadeIn: 0.0, pow: 1.0,
        })
      }
      if (!inst.impulsed) {
        inst.impulsed = true
        ctx.mixer.fire('shake', 0.35, 0.13, t)
        ctx.mixer.fire('flash', 0.16, 0.07, t)
      }
      if (inst.onImpact) { inst.onImpact(); inst.onImpact = null }
    }

    const L = inst.light
    if (L) {
      L.intensity = 26 * ss(tl, 0.04, 0.08) * (1 - ss(tl, 0.12, 0.34))
      L.position.set(bx, by, bz)
    }
  },
}

const STONE_COL = {
  s0: lin3(0xf0dca8),
  s1: lin3(0xc1a631),   // olive-gold tips (dragon palette kinship)
  light: 0xd9b36a,
}

const stoneraDef = {
  dur: 1.35,
  hold: 0.45,
  lightDist: 8,
  build: buildStoneraRig,
  begin(inst) {
    inst.emitAcc = 0
  },
  tick(inst, tl, dt, ctx) {
    const R = inst.rig
    const t = ctx.t
    const rnd = inst.rnd
    const bx = inst.base.x
    const by = inst.base.y
    const bz = inst.base.z
    const E = 0.15 // eruption start

    R.glow.material.opacity = 0.4 * ss(tl, 0.03, E + 0.15) * (1 - ss(tl, 0.85, 1.25))

    const ru = env01(tl, E, E + 0.55)
    if (ru > 0 && ru < 1) {
      const rs = 0.6 + 3.4 * easeOutCubic(ru)
      R.ring.scale.set(rs, 1, rs)
      R.ring.material.opacity = 0.45 * Math.pow(1 - ru, 1.5)
    } else {
      R.ring.material.opacity = 0
    }

    for (const S of R.shards) {
      const st = E + S.appear
      const up = backOut(env01(tl, st, st + 0.16))
      const sink = 0.45 * ss(tl, 0.9, 1.3)
      S.m.scale.set(S.w, Math.max(0.001, S.h * up), 1)
      S.m.position.y = -S.h * 0.12 - sink
      S.mat.opacity = ss(tl, st, st + 0.06) * (1 - ss(tl, 1.0, 1.32))
    }

    for (let i = 0; i < R.puffs.length; i++) {
      const P = R.puffs[i]
      const u = env01(tl, E + 0.02, E + 0.8)
      const drift = 0.7 + u * 1.1
      P.s.position.set(Math.cos(P.a) * drift, 0.2 + u * 0.5, Math.sin(P.a) * drift)
      const sc = 0.7 + u * 1.5 + 0.05 * Math.sin(t * 2 + P.phase)
      P.s.scale.set(sc, sc * 0.8, 1)
      P.mat.opacity = 0.34 * ss(u, 0, 0.2) * (1 - ss(u, 0.45, 1))
    }

    if (!inst.impulsed && tl >= E + 0.10) {
      inst.impulsed = true
      ctx.mixer.fire('shake', 0.55, 0.20, t)
      ctx.mixer.fire('flash', 0.10, 0.08, t)
      if (inst.onImpact) { inst.onImpact(); inst.onImpact = null }
    }

    // gold grit thrown up with the shards
    if (tl >= E && tl <= E + 0.4) {
      inst.emitAcc += dt * 70
      while (inst.emitAcc >= 1) {
        inst.emitAcc -= 1
        const a = rnd() * TAU
        const rr = 0.3 + rnd() * 0.7
        ctx.pool.spawn({
          x: bx + Math.cos(a) * rr, y: by + 0.05, z: bz + Math.sin(a) * rr,
          vx: Math.cos(a) * (0.5 + rnd()), vy: 2.0 + rnd() * 2.4, vz: Math.sin(a) * (0.5 + rnd()),
          grav: -5.5, drag: 0.6,
          life: 0.5 + rnd() * 0.4, size: 0.018 + rnd() * 0.024,
          c0: STONE_COL.s0, c1: STONE_COL.s1, cMid: 0.5, twF: 9, fadeIn: 0.02,
        })
      }
    }

    const L = inst.light
    if (L) {
      L.intensity = 30 * ss(tl, E, E + 0.15) * (1 - ss(tl, 0.7, 1.15))
      L.position.set(bx, by + 0.9, bz)
    }
  },
}

const EFFECTS = {
  firaga: firagaDef,
  cure: cureDef,
  slash: slashDef,
  stonera: stoneraDef,
}

const ALIASES = {
  fire: 'firaga', fira: 'firaga', firaja: 'firaga',
  cura: 'cure', curaga: 'cure', curaja: 'cure', heal: 'cure',
  attack: 'slash', hit: 'slash', strike: 'slash', melee: 'slash',
  stone: 'stonera', stonega: 'stonera', stoneja: 'stonera', quake: 'stonera',
}

// ===========================================================================
// 8. createVFX — the one export (BATTLE_CONTRACT)
// ===========================================================================

export function createVFX({ scene, arena, units, renderer } = {}) {
  const group = new THREE.Group()
  group.name = 'battleVFX'
  if (scene) scene.add(group) // idempotent if main also adds object3D

  const kit = buildKit()
  const pool = makeSparkPool()
  group.add(pool.points)
  const mixer = makeImpulseMixer()

  // ?freeze=<effect> — the harness's deterministic mid-burst capture
  let FREEZE = null
  try {
    FREEZE = new URLSearchParams(window.location.search).get('freeze')
  } catch (e) { FREEZE = null }

  // ---- pooled point lights, parented into the set via arena.addSpellLight
  // so the spill drives arena rim/fog participation and units' +35 % law.
  const lights = []
  function acquireLight(colorHex, dist) {
    for (const L of lights) {
      if (!L.userData.vfxBusy) {
        L.userData.vfxBusy = true
        L.color.set(colorHex)
        L.distance = dist
        L.intensity = 0
        L.visible = true
        return L
      }
    }
    const L = new THREE.PointLight(colorHex, 0, dist, 2) // decay 2 (§8)
    L.castShadow = false
    L.userData.vfxBusy = true
    if (arena && typeof arena.addSpellLight === 'function') arena.addSpellLight(L)
    else group.add(L)
    lights.push(L)
    return L
  }
  function releaseLight(L) {
    if (!L) return
    L.intensity = 0
    L.visible = false
    L.userData.vfxBusy = false
  }

  // ---- rig pools ----------------------------------------------------------
  const rigPools = {}
  function acquireRig(key, def) {
    const poolArr = rigPools[key] || (rigPools[key] = [])
    for (const r of poolArr) {
      if (!r.busy) {
        r.busy = true
        r.group.visible = true
        return r
      }
    }
    const r = def.build(kit)
    group.add(r.group)
    poolArr.push(r)
    r.busy = true
    r.group.visible = true
    return r
  }
  function releaseRig(r) {
    r.busy = false
    r.group.visible = false
  }

  // ---- unit lookups (defensive: never throw mid-battle) -------------------
  function unitPos(id) {
    try {
      const u = units && units.get ? units.get(id) : null
      if (u && u.anchor) return { p: u.anchor, enemy: !!u.isEnemy }
    } catch (e) { /* fall through */ }
    return null
  }
  function groundAt(x, z, fallbackY) {
    try {
      if (arena && typeof arena.groundY === 'function') return arena.groundY(x, z)
    } catch (e) { /* fall through */ }
    return fallbackY || 0
  }

  const active = []
  let castCounter = 0
  let t = 0
  const _v2 = new THREE.Vector2()

  // -------------------------------------------------------------------------
  // cast(name, casterId, targetId, opts?) → Promise resolving on completion.
  // opts: { freeze?: boolean, onImpact?: () => void }
  // -------------------------------------------------------------------------
  function cast(name, casterId, targetId, opts = {}) {
    let key = String(name || '').toLowerCase().trim()
    key = EFFECTS[key] ? key : (ALIASES[key] || 'slash')
    const def = EFFECTS[key]

    const target = unitPos(targetId)
    const caster = unitPos(casterId)
    // snapshot the base at cast time: the column must not slide with recoil.
    const base = target
      ? new THREE.Vector3(target.p.x, target.p.y, target.p.z)
      : new THREE.Vector3(0.9, 0, -9.2) // §1 Rain anchor — the plate's victim
    base.y = groundAt(base.x, base.z, base.y)

    const rig = acquireRig(key, def)
    rig.group.position.copy(base)
    const light = acquireLight(
      key === 'firaga' ? FIRAGA_COL.light
        : key === 'cure' ? CURE_COL.light
          : key === 'stonera' ? STONE_COL.light : SLASH_COL.light,
      def.lightDist
    )

    const inst = {
      key, def, rig, light,
      base,
      groupPos: base, // alias for tick readability
      casterPos: caster ? new THREE.Vector3(caster.p.x, caster.p.y, caster.p.z) : null,
      casterEnemy: caster ? caster.enemy : false,
      targetEnemy: target ? target.enemy : false,
      t0: t,
      rnd: mulberry32(0xc4a7 + (castCounter++) * 7919),
      impulsed: false,
      onImpact: typeof opts.onImpact === 'function' ? opts.onImpact : null,
      freeze: opts.freeze !== undefined ? !!opts.freeze : FREEZE === key,
      resolve: null,
      done: false,
    }
    if (def.begin) def.begin(inst)

    return new Promise((resolve) => {
      inst.resolve = resolve
      active.push(inst)
    })
  }

  // -------------------------------------------------------------------------
  // update(dt, camera) — advance effects, particles, light and impulses.
  // -------------------------------------------------------------------------
  function update(dt, camera) {
    dt = clamp(dt || 0, 0, 0.1)
    t += dt

    // point sizing: world metres → device px through the §1 lens
    if (camera && renderer && renderer.getDrawingBufferSize) {
      renderer.getDrawingBufferSize(_v2)
      const fov = (camera.fov || 26) * Math.PI / 180
      pool.mat.uniforms.uPxScale.value = _v2.y / (2 * Math.tan(fov / 2))
    }

    const ctx = { t, pool, mixer, camera }

    for (let i = active.length - 1; i >= 0; i--) {
      const inst = active[i]
      let tl = t - inst.t0
      inst.frozenNow = false
      if (inst.freeze && tl >= inst.def.hold) {
        // hold at the burst peak: clamp the effect clock, keep living motion
        tl = inst.def.hold
        inst.frozenNow = true
      } else if (tl >= inst.def.dur) {
        // finished: park the rig, kill the light, resolve for choreo
        releaseRig(inst.rig)
        releaseLight(inst.light)
        active.splice(i, 1)
        if (!inst.done) {
          inst.done = true
          if (inst.resolve) inst.resolve()
        }
        continue
      }
      inst.def.tick(inst, tl, dt, ctx)
    }

    // the spark cloud sorts with the newest live column, at chest height,
    // so the spray composites over the victim like the plate
    if (active.length) {
      const b = active[active.length - 1].base
      pool.anchor.set(b.x, b.y + 1.2, b.z)
    }

    pool.update(dt, t)
    mixer.update(t)
  }

  return {
    object3D: group,
    cast,
    update,
    impulses: mixer.impulses,
  }
}
