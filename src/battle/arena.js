// ---------------------------------------------------------------------------
// src/battle/arena.js — Aetherbound battle environments (BATTLE_BIBLE §1/§3/§4)
//
//   createArena({ renderer, scene, variant })   variant: 'hall' | 'highland'
//   export const arenaBackdropsReady            resolves when both plates load
//
// ROUND 3 — painted backdrop plates. The camera is a fixed proscenium (§1:
// vFOV 26°, (0, 7, 14), pitch 12° down, never orbits), which is exactly the
// case where a painted plate beats geometry. The procedurally modelled sets
// (hall: walls, fluted columns, arcade arches, brazier columns, podium,
// steps, door, rubble; highland: rock knuckles, crag buttress, conifer
// cards, skyline cards, painted-canvas sky, glow discs) are replaced by two
// pre-lit 1920×1080 painterly plates:
//
//   assets/backdrops/torchlit-stone-hall.png → 'hall'     (frame04 family)
//   assets/backdrops/misty-highland.png      → 'highland' (frame05 family)
//
// What SURVIVES as real geometry / live rig:
//   · the FLOOR — lit, shadow-receiving, spell-light-responsive. §8's light
//     spill ("a burst that does not repaint its surroundings is an instant
//     fail") demands a floor real lights can hit; the plate cannot provide
//     that. The floor is trimmed so its far edge sits exactly on the painted
//     floor/set junction (placement math at makeBackdropPlate).
//   · groundY(x, z) — flat y = 0 for the hall, the 2° shelf for the
//     highland. Every foot and contact blob in units.js plants on it.
//   · the §3/§4 LIGHT RIGS — torch point lights at (∓5.3, 5.4, −10.8) with
//     two-octave flicker + position jitter, hemisphere ambient, the cool
//     front fill (hall, carries the one PCF shadow map) and the backlight
//     key (highland). The visible flames are painted into the plate now, but
//     the sprites must still take the warm brazier key — removing these
//     lights would flatten every character.
//   · the rim law + addSpellLight parenting (units.js / vfx.js contracts).
//   · the highland's LIVING atmosphere — three drifting fog cards, ground
//     mist blobs and motes — which all sit in FRONT of the plate and keep
//     the frozen painting breathing.
//
// The plate itself is UNLIT: it is pre-lit in paint (its torch pools, door
// glow, fog band and backlight are baked in), so it renders MeshBasicMaterial
// with fog:false and takes no shadows — scene lights on it would
// double-expose. Consequences accepted and noted for the integrator:
//   · flame billboards / embers / door-glow sprite / coals are gone (painted,
//     static); the torch light flicker still animates the real floor pools.
//   · the plates' own painted floors (their bottom ~40 %) are occluded by the
//     real lit floor — by design, so VFX spill and contact shadows work.
//
// Rim-law convention (unchanged — units.js consumes):
//   rim.dir      [x, y] normalized SCREEN-space direction from a unit TOWARD
//                its rim light, y positive DOWN (CSS/px sense).
//   rim.color    '#rrggbb' string.  rim.strength  0..1.
//   rim.sources  live world-space light anchors ({x,y,z,kind}).
// ---------------------------------------------------------------------------

import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

// ===========================================================================
// 1. Small utilities (house idiom — see src/world/props.js)
// ===========================================================================

const TAU = Math.PI * 2
const HPI = Math.PI / 2

function clamp(v, a, b) { return v < a ? a : v > b ? b : v }
function lerp(a, b, t) { return a + (b - a) * t }

function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function rgb(hex) { return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255] }
function css(c) { return 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')' }
function mixc(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}
function shade(c, s) {
  return [Math.min(255, c[0] * s), Math.min(255, c[1] * s), Math.min(255, c[2] * s)]
}

// --- 1D smooth value noise (torch flicker) ---------------------------------
function hash1(i) {
  let h = (i | 0) * 0x27d4eb2d
  h = (h ^ (h >>> 15)) * 0x85ebca6b
  h = h ^ (h >>> 13)
  return ((h >>> 0) / 4294967296) * 2 - 1
}
function vnoise1(x) {
  const i = Math.floor(x)
  const f = x - i
  const u = f * f * (3 - 2 * f)
  return hash1(i) * (1 - u) + hash1(i + 1) * u
}
// Two-octave flicker per BIBLE §3: base band 7–9 Hz.
function flicker2(t, hz, phase) {
  return 0.72 * vnoise1(t * hz + phase) + 0.35 * vnoise1(t * hz * 2.13 + phase * 1.7 + 11.7)
}

// --- 2D lattice value noise + fbm (texture painters) -----------------------
function makeNoise2(seed) {
  const S = 256
  const perm = new Uint8Array(S * 2)
  const grad = new Float32Array(S)
  const rnd = mulberry32(seed)
  for (let i = 0; i < S; i++) { perm[i] = i; grad[i] = rnd() * 2 - 1 }
  for (let i = S - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0
    const tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp
  }
  for (let i = 0; i < S; i++) perm[i + S] = perm[i]
  function lat(ix, iy) { return grad[perm[(ix & 255) + perm[iy & 255]]] }
  function n2(x, y) {
    const ix = Math.floor(x)
    const iy = Math.floor(y)
    const fx = x - ix
    const fy = y - iy
    const ux = fx * fx * (3 - 2 * fx)
    const uy = fy * fy * (3 - 2 * fy)
    const a = lat(ix, iy)
    const b = lat(ix + 1, iy)
    const c = lat(ix, iy + 1)
    const d = lat(ix + 1, iy + 1)
    return lerp(lerp(a, b, ux), lerp(c, d, ux), uy)
  }
  function fbm(x, y, oct) {
    let v = 0
    let amp = 0.5
    let f = 1
    for (let o = 0; o < oct; o++) {
      v += n2(x * f, y * f) * amp
      amp *= 0.5
      f *= 2.03
    }
    return v
  }
  return { n2, fbm }
}

// ===========================================================================
// 2. Texture kit — floor maps + atmosphere alphas painted in Canvas2D
// ===========================================================================

function canvasTex(w, h, aniso, painter, opts = {}) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  painter(c.getContext('2d'), w, h)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = opts.clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping
  t.magFilter = opts.smooth ? THREE.LinearFilter : THREE.NearestFilter
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.generateMipmaps = true
  t.anisotropy = aniso
  return t
}

// Soft white radial disc — tinted per-material (contact patches, motes).
function radialTex(size, stops) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  for (const [p, a] of stops) grad.addColorStop(p, 'rgba(255,255,255,' + a + ')')
  g.fillStyle = grad
  g.fillRect(0, 0, size, size)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
  t.magFilter = t.minFilter = THREE.LinearFilter
  t.generateMipmaps = false
  return t
}

// Irregular white fbm blob (ground mist puffs) — alpha only, heavy feather.
function mistBlobTex(seed) {
  const S = 256
  const c = document.createElement('canvas')
  c.width = S
  c.height = S
  const g = c.getContext('2d')
  const N = makeNoise2(seed)
  const img = g.createImageData(S, S)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const nx = x / S - 0.5
      const ny = y / S - 0.5
      const r = Math.hypot(nx * 2, ny * 2.6)
      const n = N.fbm(x / 46, y / 46, 4) * 0.5 + 0.5
      let a = clamp(1 - r, 0, 1)
      a = a * a * (0.35 + 0.65 * n)
      const i = (y * S + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255
      img.data[i + 3] = clamp(a * 255, 0, 255)
    }
  }
  g.putImageData(img, 0, 0)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
  t.magFilter = t.minFilter = THREE.LinearFilter
  t.generateMipmaps = false
  return t
}

// Grass tuft card (§4 dressing) — a fan of blades, GRASS_PALE #77775b tips
// over GROUND_MID-family stems, on transparent. Rendered as alphaTest quads.
function tuftTex(seed) {
  const W = 96
  const H = 64
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')
  const rnd = mulberry32(seed)
  const stem = rgb(0x5e6a48)
  const stemD = rgb(0x47533a)
  const tip = rgb(0x77775b)
  const blades = 12 + (rnd() * 5 | 0)
  for (let i = 0; i < blades; i++) {
    const bx = W * 0.5 + (rnd() - 0.5) * W * 0.55
    const lean = (rnd() - 0.5) * 0.9
    const len = H * (0.45 + rnd() * 0.5)
    const base = mixc(stem, stemD, rnd())
    const seg = 4
    let x = bx
    let y = H
    g.lineWidth = 1.6 + rnd() * 1.2
    for (let s = 0; s < seg; s++) {
      const t0 = s / seg
      const t1 = (s + 1) / seg
      g.strokeStyle = css(mixc(base, tip, t1 * t1))
      g.beginPath()
      g.moveTo(x, y)
      x = bx + lean * len * t1 * t1 * 0.8 + (rnd() - 0.5) * 1.5
      y = H - len * t1
      g.lineTo(x, y)
      g.stroke()
      g.lineWidth *= 0.75
    }
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
  t.magFilter = THREE.LinearFilter
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.generateMipmaps = true
  return t
}

// Horizontally-wrapping fog sheet for the three drifting cards (§4).
function fogCardTex(seed) {
  const W = 512
  const H = 256
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')
  const N = makeNoise2(seed)
  const img = g.createImageData(W, H)
  for (let y = 0; y < H; y++) {
    const vy = y / H
    // fades hard at top and bottom so cards never show a straight edge
    const band = Math.pow(Math.sin(vy * Math.PI), 1.35)
    for (let x = 0; x < W; x++) {
      // wrap in x: sample noise on a cylinder so offset.x scrolling is seamless
      const a0 = (x / W) * TAU
      const nx = Math.cos(a0) * 1.6
      const nz = Math.sin(a0) * 1.6
      const n =
        N.fbm(nx * 1.2 + 3.1, vy * 2.2 + nz * 1.2, 4) * 0.6 +
        N.fbm(nx * 3.1, vy * 5.0 + nz * 3.1, 3) * 0.4
      let a = band * clamp(0.52 + n * 0.9, 0, 1)
      const i = (y * W + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255
      img.data[i + 3] = clamp(a * 255, 0, 255)
    }
  }
  g.putImageData(img, 0, 0)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = THREE.RepeatWrapping
  t.wrapT = THREE.ClampToEdgeWrapping
  t.magFilter = t.minFilter = THREE.LinearFilter
  t.generateMipmaps = false
  return t
}

// ===========================================================================
// 3. Backdrop plates — async load + the solved proscenium placement
// ===========================================================================

const _plateLoader = new THREE.TextureLoader()

function loadPlate(url) {
  let done
  const promise = new Promise((res) => { done = res })
  // TextureLoader.load returns the Texture synchronously and fills it in
  // later — createArena stays synchronous, the promise gates the capture.
  const tex = _plateLoader.load(
    url,
    () => done(tex),
    undefined,
    (err) => {
      console.error('[arena] backdrop failed to load: ' + url, err)
      done(tex) // resolve anyway — never hang the shot harness on a 404
    }
  )
  // Full-frame plate, not an atlas. flipY true matches PlaneGeometry UVs
  // (v = 1 at the top edge → image top at the plate's top edge).
  tex.colorSpace = THREE.SRGBColorSpace
  tex.flipY = true
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  return { tex, promise }
}

const PLATES = {
  hall: loadPlate(new URL('../../assets/backdrops/torchlit-stone-hall.png', import.meta.url).href),
  highland: loadPlate(new URL('../../assets/backdrops/misty-highland.png', import.meta.url).href),
}

// Resolves once both plates have decoded (or errored — see loadPlate). The
// integrator awaits this before signalling the capture harness; without it
// the screenshot fires on a blank plate.
export const arenaBackdropsReady =
  Promise.all([PLATES.hall.promise, PLATES.highland.promise]).then(() => {})

// --- placement math --------------------------------------------------------
// §1 camera: (0, 7, 14), pitch 12° down, vFOV 26°, 16:9 frame. The plate is
// a camera-facing plane at D = 30 m along the view axis (behind the shelf
// far edge at ~26.9 m, behind the z −14 fog card at ~28.5 m, inside far 80).
// A plane exactly filling the frustum maps plate fractions 1:1 to screen
// fractions. With independent scales kx/ky and centre offsets (rC along
// camera-right, uC along camera-up) a painted feature at (pX, pY) of the
// image lands at screen
//   fx = 0.5 + rC/W + (pX − 0.5)·kx
//   fy = 0.5 − uC/H − (0.5 − pY)·ky
// Solving for a feature to land at a target (sX, sY):
//   rC = W · (sX − 0.5 − (pX − 0.5)·kx)
//   uC = H · (0.5 − sY − (0.5 − pY)·ky)
//
// HALL — two binding constraints solved simultaneously (round-4 fix: the
// plate used to sit at k 1.04, which parked the painted flame bowls at
// ~0.24–0.29 fh — the hall read twice as far away as frame04's):
//   1. the painted stair-foot junction (platform meets flagstones, pixel-
//      measured pY 0.598) must stay LOCKED on the live floor's far edge —
//      the z −12 / y 0 line projects to fy 0.6161 under the §1 camera. The
//      seam between live flagstones and paint IS this junction; sliding it
//      would reintroduce the round-2 seam.
//   2. the painted flame bowls (centroids pixel-measured at (0.2517, 0.2343)
//      and (0.7300, 0.2464), mean pY 0.2404) must land on the §3 light
//      anchors: screen (0.235, 0.136) / (0.753, 0.136).
// Vertically: ky = (0.6161 − 0.136) / (0.598 − 0.2404) = 1.3424 — the plate
// is STRETCHED about the junction lock, raising door and wall with the
// flames (per-flame residual ±0.008 fh). Horizontally the painted flame
// separation 0.4783 fw must span 0.518 fw: kx = 1.0829, with rC centering
// the flame midpoint 0.4909 → 0.494. The ~1.24× anisotropy reads as taller
// columns — frame04's towering hall — not as distortion. Coverage after the
// solve: x −0.038…1.045, y −0.187…1.156 fw/fh — no exposed edge.
//
// HIGHLAND — the real 2° shelf's far edge (z −12, y 0.244) projects to fy
// 0.597; the plate's cracked-stone floor runs up to ≈ 0.60–0.65 fh, so the
// authored framing is kept (pY = sY = 0.597, zero net slide): the live turf
// horizon occludes the painted rock-band bottoms. Round-4 fix: k 1.03 left
// a visible plate edge / void strip frame-left and right — coverage is now
// 1.16× (≥ the 1.15 minimum) about the same lock, edges 0.08 fw offscreen,
// and the out-of-plate clear colour is matched to the plate's own edge mean
// at load (see samplePlateEdgeMean) so any spill is invisible.
const PLATE_FIT = {
  hall: { pY: 0.598, sY: 0.6161, ky: 1.3424, pX: 0.4909, sX: 0.494, kx: 1.0829 },
  highland: { pY: 0.597, sY: 0.597, ky: 1.16, pX: 0.5, sX: 0.5, kx: 1.16 },
}
const PLATE_DIST = 30
const PLATE_PITCH = THREE.MathUtils.degToRad(12)
const PLATE_H = 2 * PLATE_DIST * Math.tan(THREE.MathUtils.degToRad(13)) // 13.852 m
const PLATE_W = PLATE_H * (16 / 9) // 24.626 m — the plates are 16:9 like the frame

function makeBackdropPlate(variant, aniso) {
  const { tex } = PLATES[variant]
  if (aniso) tex.anisotropy = aniso
  const { pY, sY, ky, pX, sX, kx } = PLATE_FIT[variant]
  const fwd = new THREE.Vector3(0, -Math.sin(PLATE_PITCH), -Math.cos(PLATE_PITCH))
  const up = new THREE.Vector3(0, Math.cos(PLATE_PITCH), -Math.sin(PLATE_PITCH))
  const uC = PLATE_H * (0.5 - sY - (0.5 - pY) * ky)
  const rC = PLATE_W * (sX - 0.5 - (pX - 0.5) * kx)
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(PLATE_W * kx, PLATE_H * ky),
    // Pre-lit plate: unlit material, no scene fog, no tint — §3/§4 lighting
    // is already painted in. Lighting it again would double-expose.
    new THREE.MeshBasicMaterial({ map: tex, fog: false })
  )
  mesh.position.set(0, 7.0, 14.0)
    .addScaledVector(fwd, PLATE_DIST)
    .addScaledVector(up, uC)
    .add(new THREE.Vector3(rC, 0, 0)) // camera-right is world +X (yaw 0)
  mesh.rotation.x = -PLATE_PITCH // normal (0, sin12°, cos12°): faces the fixed seat
  mesh.castShadow = false
  mesh.receiveShadow = false // pre-lit — must never catch the shadow map
  mesh.frustumCulled = false
  mesh.name = 'arena_backdrop_' + variant
  return mesh
}

// Screen-fraction projection of a world point under the fixed §1 camera —
// used to solder the live floor's UVs to the plate's columns at the seam.
const _projCam = (() => {
  const c = new THREE.PerspectiveCamera(26, 16 / 9, 1, 80)
  c.position.set(0, 7, 14)
  c.rotation.set(-PLATE_PITCH, 0, 0)
  c.updateMatrixWorld(true)
  return c
})()
function screenFrac(x, y, z) {
  const v = _vA.set(x, y, z).project(_projCam)
  return { fx: v.x * 0.5 + 0.5, fy: 0.5 - v.y * 0.5 }
}

// Mean colour of a plate's outer border ring (top/left/right — the bottom is
// occluded by the live floor). Used as the out-of-plate clear colour so any
// spill past the plate edge is invisible.
function samplePlateEdgeMean(tex) {
  const img = tex.image
  if (!img || !img.width) return null
  const c = document.createElement('canvas')
  const W = 128
  const H = 72
  c.width = W
  c.height = H
  const g = c.getContext('2d', { willReadFrequently: true })
  g.drawImage(img, 0, 0, W, H)
  const d = g.getImageData(0, 0, W, H).data
  let r = 0, gg = 0, b = 0, n = 0
  const take = (x, y) => { const i = (y * W + x) * 4; r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++ }
  for (let x = 0; x < W; x++) for (let y = 0; y < 4; y++) take(x, y) // top strip
  for (let y = 0; y < H; y++) for (let x = 0; x < 4; x++) { take(x, y); take(W - 1 - x, y) }
  return new THREE.Color(r / n / 255, gg / n / 255, b / n / 255).convertSRGBToLinear()
}

// ===========================================================================
// 4. Floor painters — the two surfaces that stay real and lit
// ===========================================================================

// Flagstone floor — FLOOR_COOL #3c4049 slate, FLOOR_GROUT #23262e joints.
// Big 1.0 × 0.66 m slabs in running bond; visible coursing is mandatory.
function paintFlagstone(g, S, seed) {
  const rnd = mulberry32(seed)
  const N = makeNoise2(seed + 7)
  // Round-4 lift: the slabs are ALBEDO under a dim rig, so they are authored
  // ~1.25× above the §3 screen samples (FLOOR_COOL #3c4049 / GROUT #23262e)
  // — the rig + post land them back on the samples. Authoring the screen
  // value directly rendered a 0.05-luma void floor.
  const grout = rgb(0x2b2e38)
  const cool = rgb(0x4b505a)
  const coolD = rgb(0x3c414b)
  const warm = rgb(0x58504a) // rare warm slab — mostly light does the warming
  g.fillStyle = css(grout)
  g.fillRect(0, 0, S, S)
  const rows = 9 // 6 m/repeat → 0.66 m courses
  const ch = S / rows
  for (let r = 0; r < rows; r++) {
    const y = r * ch
    let x = -((r % 2) * 74 + rnd() * 22)
    while (x < S) {
      const bw = 86 * (0.7 + rnd() * 0.75)
      let base = mixc(cool, coolD, Math.pow(rnd(), 1.2))
      if (rnd() < 0.12) base = mixc(base, warm, 0.55)
      base = mixc(base, [base[0] - 4, base[1] + 2, base[2] + 7], rnd() * 0.4)
      const draw = (xx) => {
        g.fillStyle = css(base)
        g.fillRect(xx + 2, y + 2, bw - 4, ch - 4)
        // slab mottle
        for (let i = 0; i < 26; i++) {
          const mx = xx + 3 + rnd() * (bw - 6)
          const my = y + 3 + rnd() * (ch - 6)
          const n = N.fbm(mx / 26, my / 26, 3)
          g.globalAlpha = 0.16
          g.fillStyle = css(shade(base, 1 + n * 0.34))
          g.fillRect(mx, my, 2 + rnd() * 4, 1.6 + rnd() * 3)
          g.globalAlpha = 1
        }
        g.fillStyle = css(shade(base, 1.14))
        g.fillRect(xx + 2, y + 2, bw - 4, 1.8) // top edge catches light
        g.fillStyle = css(shade(base, 0.7))
        g.fillRect(xx + 2, y + ch - 3.8, bw - 4, 1.8) // settle shadow
        g.fillStyle = css(shade(base, 0.86))
        g.fillRect(xx + bw - 3.6, y + 2, 1.6, ch - 4)
        if (rnd() < 0.3) { // cracks
          g.strokeStyle = css(shade(base, 0.6))
          g.lineWidth = 1.2
          g.beginPath()
          let cx = xx + bw * (0.25 + rnd() * 0.5)
          let cy = y + 3
          g.moveTo(cx, cy)
          for (let s2 = 0; s2 < 3; s2++) {
            cx += (rnd() - 0.5) * 16
            cy += ch * 0.3
            g.lineTo(cx, cy)
          }
          g.stroke()
        }
        if (rnd() < 0.22) { // chipped corner
          g.fillStyle = css(grout)
          g.beginPath()
          g.moveTo(xx + 2, y + 2)
          g.lineTo(xx + 2 + 6 + rnd() * 8, y + 2)
          g.lineTo(xx + 2, y + 2 + 5 + rnd() * 7)
          g.fill()
        }
      }
      draw(x)
      if (x < 0) draw(x + S)
      if (x + bw > S) draw(x - S)
      x += bw
    }
  }
  // broad dark pooling — the floor is never one value
  for (let i = 0; i < 7; i++) {
    g.globalAlpha = 0.06
    g.fillStyle = i % 3 ? '#10141e' : '#4a453e'
    g.beginPath()
    g.arc(rnd() * S, rnd() * S, S * (0.16 + rnd() * 0.22), 0, TAU)
    g.fill()
    g.globalAlpha = 1
  }
}

// Mossy shelf turf (§4) — round-4 retint. The old painter authored the turf
// two stops below GROUND_FG and trusted the (desaturating) rig + fog + post
// to lift it; the result measured neutral grey #798079 at the party line.
// Now the §4 greens are authored AT their sampled values — GROUND_MID
// #626e57 carries the field, GROUND_FG #4e5a42 the pools — pushed one notch
// up in chroma so the rig's grey-sage key and the post desat land ON the
// olive targets instead of below them. The material runs fog:false (the
// depth falloff is authored in vertex colour instead), so this texture is
// very close to what hits the screen.
function paintHighGround(g, S, seed) {
  const rnd = mulberry32(seed)
  const N = makeNoise2(seed + 11)
  const mid = rgb(0x718046)  // GROUND_MID #626e57 + chroma vs pipeline losses
  const fg = rgb(0x5a6936)   // GROUND_FG #4e5a42, same push
  const moss = rgb(0x3c4928) // deep pools — hue-bearing green, never grey (§11.6)
  const rock = rgb(0x5d6452) // worn stone through turf, ROCK_THRU_FOG family
  const tip = rgb(0x77775b)  // GRASS_PALE tips at the §4 sample
  g.fillStyle = css(mid)
  g.fillRect(0, 0, S, S)
  // macro patches — clumps and voids, never carpet
  for (let i = 0; i < 900; i++) {
    const x = rnd() * S
    const y = rnd() * S
    const n = N.fbm(x / 90, y / 90, 4)
    const n2 = N.fbm(x / 28 + 40, y / 28, 3)
    let c
    if (n > 0.16) c = mixc(mid, rock, clamp((n - 0.16) * 3.4, 0, 1))
    else if (n < -0.14) c = mixc(fg, moss, clamp((-n - 0.14) * 3.2, 0, 1))
    else c = mixc(mid, fg, 0.5 + n2 * 0.5)
    g.globalAlpha = 0.5
    g.fillStyle = css(shade(c, 0.94 + n2 * 0.16))
    const r = 5 + rnd() * 15
    g.beginPath()
    g.arc(x, y, r, 0, TAU)
    g.fill()
    g.globalAlpha = 1
  }
  // blade stipple — short strokes, denser in mossy pools
  for (let i = 0; i < 2600; i++) {
    const x = rnd() * S
    const y = rnd() * S
    const n = N.fbm(x / 90, y / 90, 4)
    if (n > 0.2 && rnd() < 0.6) continue // sparse on worn rock
    const lean = (rnd() - 0.5) * 1.1
    const len = 2.5 + rnd() * 4.5
    const base = n < -0.1 ? moss : mid
    g.strokeStyle = css(shade(base, 0.8 + rnd() * 0.55))
    g.globalAlpha = 0.5 + rnd() * 0.4
    g.lineWidth = 1
    g.beginPath()
    g.moveTo(x, y)
    g.lineTo(x + lean * len * 0.4, y - len)
    g.stroke()
    if (rnd() < 0.11) { // pale seed tip
      g.fillStyle = css(tip)
      g.fillRect(x + lean * len * 0.4 - 0.5, y - len - 1, 1.4, 1.4)
    }
    g.globalAlpha = 1
  }
  // scattered pebbles + worn dirt scuffs
  for (let i = 0; i < 120; i++) {
    const x = rnd() * S
    const y = rnd() * S
    g.globalAlpha = 0.6
    g.fillStyle = css(shade(rock, 0.7 + rnd() * 0.6))
    g.beginPath()
    g.ellipse(x, y, 1 + rnd() * 2.4, 0.8 + rnd() * 1.6, rnd() * TAU, 0, TAU)
    g.fill()
    g.globalAlpha = 1
  }
  // deep moss wells — broad soft darks that break the felt at distance
  for (let i = 0; i < 9; i++) {
    const x = rnd() * S
    const y = rnd() * S
    const r = S * (0.07 + rnd() * 0.13)
    const gr = g.createRadialGradient(x, y, 0, x, y, r)
    gr.addColorStop(0, 'rgba(24,32,20,0.32)')
    gr.addColorStop(1, 'rgba(24,32,20,0)')
    g.fillStyle = gr
    g.beginPath()
    g.arc(x, y, r, 0, TAU)
    g.fill()
  }
}

// One merged mesh of soft dark ellipses — contact darkening that seats
// features into the ground (used for the highland's moss breakup).
function contactPatches(spots, color, opacity) {
  const geos = []
  for (const s of spots) {
    const p = new THREE.PlaneGeometry(s.w, s.h)
    p.rotateX(-HPI)
    if (s.ry) p.rotateY(s.ry)
    p.translate(s.x, s.y, s.z)
    geos.push(p)
  }
  const merged = mergeGeometries(geos, false)
  for (const p of geos) p.dispose()
  const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({
    map: radialTex(64, [[0, 0.85], [0.45, 0.42], [1, 0]]),
    color, transparent: true, opacity, depthWrite: false,
  }))
  mesh.name = 'arena_contact'
  return mesh
}

// ===========================================================================
// 5. HALL build — real flagstone floor in front of the painted plate
// ===========================================================================

function buildHall(env) {
  const { group, aniso } = env

  // The one surviving surface: cool slate flagstones, lit by the rig so the
  // torch pools, cool fill and any spell light repaint it live (§3/§8). The
  // §11.6 blue-dark law rides in a whisper of emissiveMap self-light so
  // off-pool slate drowns blue (#10161f-class), never grey, never black.
  const tFloor = canvasTex(512, 512, aniso, (g, S) => paintFlagstone(g, S, 202))
  const floorMat = new THREE.MeshStandardMaterial({
    map: tFloor, roughness: 0.85, metalness: 0,
    // Round-4: emissive self-light ×2 — this is the §11.6 "blue, never
    // black" base that holds the off-pool slate at a readable ~0.15 luma
    // (the party line target is ~0.2 with the torch pools on top). At the
    // old 1.0 the whole live floor measured 0.05: featureless navy.
    emissive: 0x6f7889, emissiveMap: tFloor, emissiveIntensity: 2.6,
  })
  {
    // Spans z −12…+2: the far edge sits EXACTLY on the back-wall plane so
    // the seam between live flagstones and the plate's painted stair foot is
    // the floor-to-wall junction itself (see PLATE_FIT math). Extending
    // further upstage would paint live slate over the painted platform.
    const geo = new THREE.PlaneGeometry(42, 14, 1, 1)
    geo.rotateX(-HPI)
    const uv = geo.attributes.uv
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (42 / 6), uv.getY(i) * (14 / 6))
    geo.translate(0, 0, -5)
    const floor = new THREE.Mesh(geo, floorMat)
    floor.name = 'arena_floor'
    floor.castShadow = false
    floor.receiveShadow = true
    group.add(floor)
  }

  // Wall-base ambient occlusion: a blue-dark (#0a1420-family, §11.6 — never
  // black) gradient along the floor's far edge, α 0.55 at the z −12 junction
  // fading out ~1.3 m downstage. It seats the painted wall/stair foot ON the
  // live slabs and softens the junction luma step into a contact shadow —
  // the same darkening frame04 shows where flagstones meet the set.
  {
    const c = document.createElement('canvas')
    c.width = 4
    c.height = 64
    const g = c.getContext('2d')
    const grad = g.createLinearGradient(0, 0, 0, 64)
    grad.addColorStop(0, 'rgba(10,20,32,0.55)')
    grad.addColorStop(0.5, 'rgba(10,20,32,0.22)')
    grad.addColorStop(1, 'rgba(10,20,32,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, 4, 64)
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
    tex.magFilter = tex.minFilter = THREE.LinearFilter
    tex.generateMipmaps = false
    const geo = new THREE.PlaneGeometry(42, 1.3)
    geo.rotateX(-HPI) // plane +v edge lands upstage after the rotation
    geo.translate(0, 0.015, -12 + 0.65)
    const ao = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, fog: false,
    }))
    ao.renderOrder = 4
    ao.name = 'arena_wallbase_ao'
    group.add(ao)
  }

  // §3 torch anchors — the flames are painted into the plate now, but these
  // stay the live light positions and the rim/meta anchors.
  const torches = [
    { x: -5.3, y: 5.4, z: -10.8 },
    { x: 5.3, y: 5.4, z: -10.8 },
  ]

  return {
    // BIBLE §1 / task contract: the hall floor is flat y = 0. The stepped
    // platform is paint now — nothing stands on it (no §1 feet anchor is
    // upstage of z −10.5), so groundY is the flat slab.
    groundY() { return 0 },
    torches,
    // clear acting floor: contains every §1 feet anchor and still stops
    // short of the PAINTED stair flight / brazier pedestals / trough dais,
    // which occupy the same screen real estate their geometry did.
    safeStage: { x0: -4.8, x1: 5.5, z0: -10.6, z1: -1.6 },
  }
}

// ===========================================================================
// 6. Torch light rig — §3 lights kept live; the visible fire is painted
// ===========================================================================

function buildTorchRig(env, torches) {
  const { group, rnd } = env
  const rigs = []
  for (const T of torches) {
    // §3 numbers restored (round-4): #ffa64f, intensity 40, distance 14,
    // decay 2. The round-2 33/11 under-tune left the live floor pools
    // invisible against the raised plate. These lights are what keep the
    // SPRITES warm-keyed (§5): deleting them because the flames are painted
    // would flatten the party — and §3's floor must visibly warm toward
    // FLOOR_WARM #5c4c46 inside ~0.11 fw of each pool.
    const light = new THREE.PointLight(0xffa64f, 40, 14, 2)
    light.position.set(T.x, T.y, T.z)
    light.castShadow = false // §3: torch lights cast none (cost)
    group.add(light)
    rigs.push({ T, light, phase: rnd() * 100, hz: 7 + rnd() * 2 }) // §3 7–9 Hz
  }
  function update(t) {
    for (const R of rigs) {
      // two-octave flicker: intensity ±12 %, position jitter ±0.06 m (§3) —
      // the live floor pools shimmer under the plate's static painted flames.
      const n = flicker2(t, R.hz, R.phase)
      R.light.intensity = 40 * (1 + 0.12 * n)
      R.light.position.set(
        R.T.x + 0.06 * vnoise1(t * 5.1 + R.phase),
        R.T.y + 0.06 * vnoise1(t * 6.3 + R.phase + 31),
        R.T.z + 0.06 * vnoise1(t * 5.7 + R.phase + 67)
      )
    }
  }
  return { update }
}

// ===========================================================================
// 7. HIGHLAND build — real 2° turf shelf + living atmosphere over the plate
// ===========================================================================

function buildHighland(env) {
  const { group, aniso, rnd } = env

  // ---- groundY: shelf flat to z −5, then a 2° rise upstage, tiny undulation
  const TAN2 = 0.0349
  function groundY(x, z) {
    let y = z < -5 ? (-5 - z) * TAN2 : 0
    // continuous, gentle undulation — feet and contact blobs plant on this
    y += 0.035 * Math.sin(x * 0.53 + 1.7) * Math.sin(z * 0.41 - 0.6)
    return y
  }

  const tGround = canvasTex(1024, 1024, aniso, (g, S) => paintHighGround(g, S, 121))
  const MAT_ground = new THREE.MeshStandardMaterial({
    // fog:false — the scene fog (#8e978d, a grey-sage) was the main engine
    // of the round-3 grey slab: 25 % fog mix at the party line stripped the
    // olive to neutral. Depth falloff is authored in vertex colour instead;
    // teal-green emissive dark per §11.6 — hue-bearing, never grey.
    map: tGround, vertexColors: true, roughness: 1, metalness: 0,
    emissive: 0x0a190e, emissiveIntensity: 0.6, fog: false,
  })

  // ---- the shelf: displaced plane, far edge on the z −12 junction line ----
  {
    const W = 48
    const D = 19
    const geo = new THREE.PlaneGeometry(W, D, 96, 40)
    geo.rotateX(-HPI)
    geo.translate(0, 0, -12 + D / 2) // z −12 … +7: turf horizon at fy 0.597
    const pos = geo.attributes.position
    const uv = geo.attributes.uv
    // Depth falloff as vertex colour: full GROUND_MID at the party band,
    // easing toward GROUND_FG downstage (frame05's foreground pools), a
    // gentle pull-down at the lateral edges, and a slight drop toward the
    // seam so the live turf darkens INTO the plate's junction band instead
    // of floating brighter than it (the round-3 16 % luma step).
    const ss = (a, b, v) => { v = clamp((v - a) / (b - a), 0, 1); return v * v * (3 - 2 * v) }
    const vcol = new Float32Array(pos.count * 3)
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      pos.setY(i, groundY(x, z))
      uv.setXY(i, x / 11, z / 11)
      let f = lerp(1.0, 0.84, ss(-6.0, -1.0, z))   // party band → mid-stage
      f = lerp(f, 0.72, ss(-1.0, 5.5, z))          // → GROUND_FG at frame bottom
      f = lerp(f, 0.82, ss(-10.4, -12, z))         // darken toward the seam
      f *= 1 - 0.18 * ss(9, 15, Math.abs(x))
      vcol[i * 3] = f
      vcol[i * 3 + 1] = f
      vcol[i * 3 + 2] = f
    }
    geo.setAttribute('color', new THREE.BufferAttribute(vcol, 3))
    geo.computeVertexNormals()
    const shelf = new THREE.Mesh(geo, MAT_ground)
    shelf.name = 'arena_ground'
    shelf.castShadow = false
    shelf.receiveShadow = true
    group.add(shelf)
  }

  // ---- seam blend: gradient-match the live turf into the plate ------------
  // Once the plate has decoded, its own junction-row colours (per column, a
  // band just above pY 0.597) are painted into a strip that drapes over the
  // turf's top ~0.05 fh (z −12 → −9.2), α 0.9 at the seam → 0 downstage.
  // UV.u is soldered per-vertex to the plate column that sits directly above
  // that world x on screen, so the blend follows the painting's own lateral
  // light — the junction stops being a full-width luma step.
  PLATES.highland.promise.then((tex) => {
    const img = tex.image
    const { pY, pX, sX, kx } = PLATE_FIT.highland
    const SW = 512
    const c = document.createElement('canvas')
    c.width = SW
    c.height = 1
    const g = c.getContext('2d', { willReadFrequently: true })
    if (img && img.width) {
      const band = Math.max(2, Math.round(img.height * 0.012))
      g.drawImage(img, 0, Math.round(img.height * pY) - band, img.width, band, 0, 0, SW, 1)
    } else {
      g.fillStyle = '#3f5348' // plate lost: §4 rock-through-fog fallback
      g.fillRect(0, 0, SW, 1)
    }
    const row = g.getImageData(0, 0, SW, 1).data
    const sc = document.createElement('canvas')
    sc.width = SW
    sc.height = 64
    const sg = sc.getContext('2d')
    for (let x = 0; x < SW; x++) {
      const r = row[x * 4], gg = row[x * 4 + 1], b = row[x * 4 + 2]
      const grad = sg.createLinearGradient(0, 0, 0, 64)
      grad.addColorStop(0, `rgba(${r},${gg},${b},0.92)`)
      grad.addColorStop(0.55, `rgba(${r},${gg},${b},0.38)`)
      grad.addColorStop(1, `rgba(${r},${gg},${b},0)`)
      sg.fillStyle = grad
      sg.fillRect(x, 0, 1, 64)
    }
    const stripTex = new THREE.CanvasTexture(sc)
    stripTex.colorSpace = THREE.SRGBColorSpace
    stripTex.wrapS = stripTex.wrapT = THREE.ClampToEdgeWrapping
    stripTex.magFilter = stripTex.minFilter = THREE.LinearFilter
    stripTex.generateMipmaps = false
    const D0 = -12
    const D1 = -9.2
    const geo = new THREE.PlaneGeometry(46, D1 - D0, 92, 8)
    geo.rotateX(-HPI)
    geo.translate(0, 0, (D0 + D1) / 2)
    const pos = geo.attributes.position
    const uvA = geo.attributes.uv
    const rCn = sX - 0.5 - (pX - 0.5) * kx
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      pos.setY(i, groundY(x, z) + 0.03)
      const { fx } = screenFrac(x, groundY(x, z), z)
      const u = 0.5 + (fx - 0.5 - rCn) / kx // screen column → plate column
      // flipY texture: canvas top row (α 0.92) is v = 1 → the seam edge
      uvA.setXY(i, clamp(u, 0, 1), clamp(1 - (z - D0) / (D1 - D0), 0, 1))
    }
    const strip = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: stripTex, transparent: true, depthWrite: false, fog: false,
    }))
    strip.renderOrder = 4 // over the turf, under mist (14) / motes (15)
    strip.name = 'arena_seam_blend'
    group.add(strip)
  })

  // ---- moss breakup — broad soft dark patches strewn across the acting
  //      shelf (near, not under, the §1 anchors) so the turf reads as ground
  //      with history instead of felt; teal-green darks per §11.6 ----------
  {
    const mossSpots = []
    const mossAt = [
      [1.9, -6.4, 2.4], [4.2, -8.9, 2.0], [0.0, -8.0, 1.7], [5.8, -5.8, 1.8],
      [2.8, -3.4, 1.5], [-1.6, -9.6, 2.2], [-3.6, -6.8, 1.9], [6.8, -9.8, 2.3],
      [-0.9, -2.2, 1.6], [4.4, -1.8, 1.4], [-5.4, -3.8, 1.8], [7.6, -3.6, 1.6],
    ]
    for (const [x, z, w] of mossAt) {
      mossSpots.push({ x, y: groundY(x, z) + (z < -5 ? 0.045 : 0.025), z, w, h: w * (0.6 + rnd() * 0.3), ry: rnd() * TAU })
    }
    group.add(contactPatches(mossSpots, 0x1c281a, 0.3))
  }

  // ---- grass tufts (§4: GRASS_PALE #77775b tips) --------------------------
  // ~110 upright cards scattered over the shelf, denser downstage — the
  // dressing the round-3 slab was missing. Kept 0.9 m clear of the §1 feet
  // anchors so nobody stands IN a bush; sunk 0.05 m so bases seat in turf.
  {
    const FEET = [[0.9, -9.2], [2.0, -4.4], [4.9, -10.5], [5.0, -5.0]]
    const texA = tuftTex(211)
    const texB = tuftTex(212)
    const makeBatch = (tex, seedOff) => {
      const geos = []
      let placed = 0
      let guard = 0
      while (placed < 55 && guard++ < 400) {
        const x = -11 + rnd() * 22
        const z = -11.4 + rnd() * 15.4
        if (z > 4.8) continue
        if (FEET.some(([fx, fz]) => (fx - x) ** 2 + (fz - z) ** 2 < 0.82)) continue
        // thin out the exact duel line so VFX ground rings stay clean
        if (Math.abs(x - 0.5) < 1.2 && z > -8 && z < -3 && rnd() < 0.6) continue
        const h = 0.24 + rnd() * 0.24 + (z > 0 ? 0.10 : 0) // taller in the fg
        const w = h * (1.3 + rnd() * 0.5)
        const p = new THREE.PlaneGeometry(w, h)
        p.translate(0, h / 2 - 0.05, 0)
        p.rotateY(rnd() * TAU)
        p.translate(x, groundY(x, z), z)
        // per-tuft tint via vertex colour: ±18 % value swing
        const f = 0.82 + rnd() * 0.34
        const n = p.attributes.position.count
        const vc = new Float32Array(n * 3).fill(f)
        p.setAttribute('color', new THREE.BufferAttribute(vc, 3))
        geos.push(p)
        placed++
      }
      const merged = mergeGeometries(geos, false)
      for (const p of geos) p.dispose()
      const m = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({
        map: tex, alphaTest: 0.45, side: THREE.DoubleSide,
        vertexColors: true, fog: false,
      }))
      m.name = 'arena_tufts_' + seedOff
      return m
    }
    group.add(makeBatch(texA, 1), makeBatch(texB, 2))
  }

  // ---- rock knuckles (§4 / §1: "dressed with rock knuckles") --------------
  // Low faceted lumps at the shelf edges, the far seam and the foreground
  // corners — frame05's boulder grammar. Lit by the rig (they shape the
  // key), moss-seated with contact patches.
  {
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x53614c, roughness: 1, metalness: 0,
      emissive: 0x0a180e, emissiveIntensity: 0.7, fog: false,
      flatShading: true,
    })
    const knuckles = [
      // far-edge cluster reading as "boulders beyond the rise"
      { x: -2.6, z: -11.3, r: 1.05 }, { x: 3.1, z: -11.5, r: 0.85 }, { x: 6.6, z: -11.0, r: 1.25 },
      // laterals, clear of the acting box
      { x: -8.2, z: -8.8, r: 1.5 }, { x: -8.9, z: -3.4, r: 1.1 }, { x: 8.7, z: -6.4, r: 1.45 }, { x: 8.3, z: -1.4, r: 0.95 },
      // foreground corners (frame05's bottom-frame rocks)
      { x: -5.6, z: 2.6, r: 1.35 }, { x: 7.1, z: 3.1, r: 1.15 }, { x: -7.8, z: 0.4, r: 0.9 },
    ]
    const geos = []
    const seats = []
    for (const K of knuckles) {
      const geo = new THREE.IcosahedronGeometry(K.r, 1) // already non-indexed
      const pos = geo.attributes.position
      const jr = mulberry32((K.x * 37.7 + K.z * 91.3) | 0 || 5)
      // jitter shared corners identically: hash by quantized vertex position
      const seen = new Map()
      for (let i = 0; i < pos.count; i++) {
        const key = `${Math.round(pos.getX(i) * 50)},${Math.round(pos.getY(i) * 50)},${Math.round(pos.getZ(i) * 50)}`
        let j = seen.get(key)
        if (!j) {
          j = [1 + (jr() - 0.5) * 0.5, 1 + (jr() - 0.5) * 0.4, 1 + (jr() - 0.5) * 0.5]
          seen.set(key, j)
        }
        pos.setXYZ(i, pos.getX(i) * j[0], pos.getY(i) * j[1] * 0.62, pos.getZ(i) * j[2])
      }
      geo.computeVertexNormals()
      geo.translate(K.x, groundY(K.x, K.z) - K.r * 0.22, K.z)
      geos.push(geo)
      seats.push({ x: K.x, y: groundY(K.x, K.z) + 0.03, z: K.z, w: K.r * 2.6, h: K.r * 1.7, ry: rnd() * TAU })
    }
    const merged = mergeGeometries(geos, false)
    for (const p of geos) p.dispose()
    const rocks = new THREE.Mesh(merged, rockMat)
    rocks.name = 'arena_knuckles'
    rocks.castShadow = false
    rocks.receiveShadow = true
    group.add(rocks)
    group.add(contactPatches(seats, 0x1c281a, 0.26))
  }

  // ---- three drifting fog cards (§4: z −4/−9/−14, α .22/.35/.50) ----------
  // All three sit in FRONT of the plate (z ≥ −14 vs plate at ~30 m along the
  // axis) — the painting stays still, the weather over it does not.
  // Round-4: card widths are oversized past the camera frustum at their
  // depths PLUS their drift amplitude (frustum half-widths ≈ 7.7 / 9.7 /
  // 11.8 m, drift up to ±2.4 m). The old 16/20/24 widths let a card's hard
  // lateral edge wander ~0.13 fw INTO frame — the "hung poster" vertical
  // luma step frame-left/right was these rectangles, not weather.
  const fogCards = []
  const cardSpecs = [
    { z: -4, a: 0.22, w: 22, h: 6.0, y: 1.4, speed: 0.40, seed: 31 },
    { z: -9, a: 0.35, w: 24, h: 7.5, y: 2.0, speed: 0.26, seed: 32 },
    { z: -14, a: 0.50, w: 28, h: 10.0, y: 2.6, speed: 0.15, seed: 33 },
  ]
  for (const S of cardSpecs) {
    const tex = fogCardTex(S.seed)
    const mat = new THREE.MeshBasicMaterial({
      map: tex, color: 0x969d95, transparent: true, opacity: S.a,
      depthWrite: false, fog: false,
    })
    const m = new THREE.Mesh(new THREE.PlaneGeometry(S.w, S.h), mat)
    m.position.set((S.seed % 3 - 1) * 2, S.y, S.z)
    m.frustumCulled = false
    group.add(m)
    fogCards.push({ m, base: S, phase: S.seed * 1.7 })
  }

  // ---- ground mist: 11 low blobs hugging y < 0.6 among the party (§4) -----
  const mists = []
  const mistTexA = mistBlobTex(61)
  const mistTexB = mistBlobTex(62)
  const mistSpots = [
    [1.2, -4.2], [3.4, -5.6], [5.6, -4.8], [2.2, -7.8], [4.8, -9.2], [6.6, -7.2],
    [0.2, -9.8], [-1.8, -6.6], [-3.4, -8.4], [-2.2, -4.9], [1.8, -12.4],
  ]
  for (let i = 0; i < mistSpots.length; i++) {
    const [x, z] = mistSpots[i]
    const w = 2.6 + rnd() * 2.2
    const h = 0.95 + rnd() * 0.6
    const mat = new THREE.MeshBasicMaterial({
      map: i % 2 ? mistTexA : mistTexB, color: 0xb2b8a2, transparent: true,
      opacity: 0.15, depthWrite: false, fog: false,
    })
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
    m.position.set(x, groundY(x, z) + 0.16 + h * 0.5 * 0.5, z)
    m.renderOrder = 14
    group.add(m)
    mists.push({ m, x, z, w, h, phase: rnd() * TAU, drift: 0.05 + rnd() * 0.08 })
  }

  // ---- drifting motes (the pale specks around the units in frame05) -------
  const MOTES = 26
  const mGeo = new THREE.BufferGeometry()
  const mPos = new Float32Array(MOTES * 3)
  const mSeed = []
  for (let i = 0; i < MOTES; i++) {
    mSeed.push({ x: -6 + rnd() * 14, y: 0.4 + rnd() * 3.4, z: -12 + rnd() * 9, s: rnd() * TAU })
    mPos[i * 3 + 1] = -50
  }
  mGeo.setAttribute('position', new THREE.BufferAttribute(mPos, 3))
  const mMat = new THREE.PointsMaterial({
    map: radialTex(32, [[0, 0.9], [0.5, 0.4], [1, 0]]), color: 0xcfd6cb, size: 0.055,
    sizeAttenuation: true, transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  })
  const motes = new THREE.Points(mGeo, mMat)
  motes.frustumCulled = false
  motes.renderOrder = 15
  group.add(motes)

  return {
    groundY,
    torches: [], // no fire in the highland — rim comes from the key (§5.1)
    // z0 pulled downstage of the old −12.0: the shelf now ENDS at z −12 (the
    // plate junction), so the acting box keeps a margin off the seam. Every
    // §1 feet anchor (max upstage −10.5) stays comfortably inside.
    safeStage: { x0: -5.5, x1: 7.5, z0: -11.2, z1: -1.0 },
    fogCards, mists, motes, mSeed, mPos, mGeo,
  }
}

// ===========================================================================
// 8. createArena — the one construction export (BATTLE_CONTRACT)
// ===========================================================================

const _vA = new THREE.Vector3()
const _vB = new THREE.Vector3()

export function createArena({ renderer, scene, variant = 'hall' } = {}) {
  const group = new THREE.Group()
  group.name = 'battleArena_' + variant
  const aniso = renderer && renderer.capabilities ? renderer.capabilities.getMaxAnisotropy() : 4
  const rnd = mulberry32(variant === 'hall' ? 0xa17e04 : 0xa17e05)
  const env = { group, aniso, rnd }

  // The rig carries exactly one PCF shadow map (§3/§4). engine.js already
  // enables renderer shadows; this is a construction-time guard for a bespoke
  // renderer so the grounding shadow never silently vanishes.
  if (renderer && renderer.shadowMap && !renderer.shadowMap.enabled) {
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
  }

  const spellGroup = new THREE.Group()
  spellGroup.name = 'arenaSpellLights'
  group.add(spellGroup)

  // The painted set — pre-lit plate on the solved proscenium plane.
  group.add(makeBackdropPlate(variant, aniso))

  let built
  let fire = null
  const rim = { dir: [0, -1], color: '#cfd6cb', strength: 0.7, sources: [] }

  if (variant === 'hall') {
    // ---- scene atmosphere (§3): the hall drowns, it doesn't haze ----------
    // Fog still shades the live floor and sprites (the far slate edge hazes
    // blue-dark toward the seam); the plate ignores it (fog:false).
    if (scene) {
      scene.fog = new THREE.FogExp2(0x0a1018, 0.012)
      scene.background = new THREE.Color(0x070e18) // blue-black, never #000
    }
    built = buildHall(env)
    fire = buildTorchRig(env, built.torches)

    // hemisphere ambient — sky #2a3448 / ground #1c1410, 0.35 (§3)
    group.add(new THREE.HemisphereLight(0x2a3448, 0x1c1410, 0.35))

    // cool front fill — #4a6a8a, 0.22, from camera-high (+0.2, 0.8, 0.6);
    // carries the single 1024² PCF shadow map (§3) — soft grounding only,
    // sprite grounding itself comes from the units' contact blobs.
    const fill = new THREE.DirectionalLight(0x4a6a8a, 0.22)
    fill.position.set(0.2 * 22, 0.8 * 22, 0.6 * 22 - 6)
    fill.target.position.set(0, 0, -6)
    fill.castShadow = true
    fill.shadow.mapSize.set(1024, 1024)
    fill.shadow.camera.left = -12
    fill.shadow.camera.right = 12
    fill.shadow.camera.top = 12
    fill.shadow.camera.bottom = -6
    fill.shadow.camera.near = 2
    fill.shadow.camera.far = 60
    fill.shadow.bias = -0.0005
    fill.shadow.normalBias = 0.02
    fill.shadow.radius = 4
    group.add(fill, fill.target)

    // rim law (§5.1): #ffb47a at 0.55 from the nearest warm source; boot dir
    // points at torch R from the party block (updated per frame with camera).
    rim.dir = [0.1903, -0.9817]
    rim.color = '#ffb47a'
    rim.strength = 0.55
    rim.sources = built.torches.map((T) => ({ x: T.x, y: T.y, z: T.z, kind: 'torch' }))
  } else {
    // ---- highland (§4) ----------------------------------------------------
    if (scene) {
      scene.fog = new THREE.FogExp2(0x8e978d, 0.028)
      // Boot clear colour, replaced by the plate's own edge mean once it
      // decodes (below): any spill past the oversized plate must be
      // indistinguishable from the plate itself, not a darker void frame.
      scene.background = new THREE.Color(0x10231f)
      PLATES.highland.promise.then((tex) => {
        const edge = samplePlateEdgeMean(tex)
        if (edge) scene.background = edge
      })
    }
    built = buildHighland(env)

    // hemisphere — sky #8a958c / ground #3a4434, 0.55 (§4)
    group.add(new THREE.HemisphereLight(0x8a958c, 0x3a4434, 0.55))

    // key from behind-left-high (−0.4, 0.75, −0.55): a backlight, not a face
    // key — #c9d2c4, 0.9 (§4). Soft shadow map so the units seat visually.
    const key = new THREE.DirectionalLight(0xc9d2c4, 0.9)
    key.position.set(-0.4 * 30, 0.75 * 30, -0.55 * 30 - 8)
    key.target.position.set(0, 0, -8)
    key.castShadow = true
    key.shadow.mapSize.set(1024, 1024)
    key.shadow.camera.left = -15
    key.shadow.camera.right = 15
    key.shadow.camera.top = 14
    key.shadow.camera.bottom = -8
    key.shadow.camera.near = 4
    key.shadow.camera.far = 80
    key.shadow.bias = -0.0005
    key.shadow.normalBias = 0.03
    key.shadow.radius = 4
    group.add(key, key.target)

    // rim law (§5.1): #cfd6cb at 0.70 from above-behind, fixed (0, −1).
    rim.dir = [0, -1]
    rim.color = '#cfd6cb'
    rim.strength = 0.7
    rim.sources = [{ x: 0, y: 26, z: -34, kind: 'key' }]
  }

  // ---- per-frame ----------------------------------------------------------
  let lastT = 0
  const activeSpells = []

  function collectSpellLights() {
    activeSpells.length = 0
    for (const ch of spellGroup.children) {
      if (ch.isPointLight && ch.visible && ch.intensity > 4) activeSpells.push(ch)
    }
    return activeSpells
  }

  function update(t, camera) {
    const dt = clamp(t - lastT, 0, 0.1)
    lastT = t
    void dt
    const spells = collectSpellLights()

    // publish live rim sources: torches (or key) + any active spell lights
    rim.sources.length = built.torches.length ? built.torches.length : 1
    for (const L of spells) {
      rim.sources.push({ x: L.position.x, y: L.position.y, z: L.position.z, kind: 'spell', intensity: L.intensity })
    }

    if (variant === 'hall') {
      fire.update(t)

      // rim.dir: strongest of {torch L, torch R, active spell} as seen from
      // the party block, projected to screen space (y down) — §5.1.
      if (camera) {
        _vA.set(3.2, 1.1, -7.3).project(camera) // party block chest centroid
        let best = null
        let bestW = -1
        for (const T of built.torches) {
          const d2 = (T.x - 3.2) ** 2 + (T.y - 1.1) ** 2 + (T.z + 7.3) ** 2
          const w = 40 / (d2 + 1)
          if (w > bestW) { bestW = w; best = T }
        }
        for (const L of spells) {
          const p = L.position
          const d2 = (p.x - 3.2) ** 2 + (p.y - 1.1) ** 2 + (p.z + 7.3) ** 2
          const w = L.intensity / (d2 + 1)
          if (w > bestW) { bestW = w; best = p }
        }
        if (best) {
          _vB.set(best.x, best.y, best.z).project(camera)
          let dx = _vB.x - _vA.x
          let dy = -(_vB.y - _vA.y) // NDC y-up → screen y-down
          const l = Math.hypot(dx, dy) || 1
          rim.dir[0] = dx / l
          rim.dir[1] = dy / l
        }
      }
    } else {
      // fog-card drift 0.15–0.4 m/s + seamless texture scroll (§4)
      for (let i = 0; i < built.fogCards.length; i++) {
        const F = built.fogCards[i]
        const w = 0.085 + i * 0.021
        const amp = F.base.speed / w
        F.m.position.x = Math.sin(t * w + F.phase) * amp * 0.5
        F.m.material.map.offset.x = t * F.base.speed * 0.02 + F.phase
        // spell light participation: fog receives light too (§8) —
        // +0.08 α for cards within 6 m of an active spell light.
        let boost = 0
        for (const L of spells) {
          const d = Math.hypot(L.position.x - F.m.position.x, L.position.z - F.base.z)
          if (d < 6) boost = Math.max(boost, 0.08 * clamp(L.intensity / 60, 0, 1))
        }
        F.m.material.opacity = F.base.a + boost
      }
      // ground mist churn — slow wander, breathe, camera-facing
      for (const M of built.mists) {
        const px = M.x + Math.sin(t * 0.11 + M.phase) * M.drift * 6
        const pz = M.z + Math.cos(t * 0.09 + M.phase * 1.3) * M.drift * 2.5
        M.m.position.x = px
        M.m.position.z = pz
        if (camera) M.m.rotation.y = Math.atan2(camera.position.x - px, camera.position.z - pz)
        const s = 1 + 0.08 * Math.sin(t * 0.5 + M.phase)
        M.m.scale.set(s, 1 + 0.06 * Math.cos(t * 0.4 + M.phase), 1)
        let o = 0.15 + 0.035 * Math.sin(t * 0.33 + M.phase * 2.1)
        for (const L of spells) {
          const d = Math.hypot(L.position.x - px, L.position.z - pz)
          if (d < 6) o += 0.06 * clamp(L.intensity / 60, 0, 1)
        }
        M.m.material.opacity = o
      }
      // motes drift lazily upward-left, wrapping
      for (let i = 0; i < built.mSeed.length; i++) {
        const s = built.mSeed[i]
        built.mPos[i * 3] = s.x + Math.sin(t * 0.17 + s.s) * 0.9
        built.mPos[i * 3 + 1] = s.y + Math.sin(t * 0.23 + s.s * 2.7) * 0.5
        built.mPos[i * 3 + 2] = s.z + Math.cos(t * 0.13 + s.s) * 0.7
      }
      built.mGeo.attributes.position.needsUpdate = true
      built.motes.material.opacity = 0.45 + 0.15 * Math.sin(t * 0.7)
    }
  }

  return {
    object3D: group,
    groundY: built.groundY,
    // BIBLE §1 camera, typed in — main applies these to the scene camera.
    camera: {
      position: new THREE.Vector3(0, 7.0, 14.0),
      pitchDeg: 12.0,
      fovDeg: 26,
      near: 1,
      far: 80,
    },
    rim,
    addSpellLight(light) { spellGroup.add(light) },
    update,
    meta: {
      variant,
      torches: built.torches,
      safeStage: built.safeStage,
    },
  }
}
