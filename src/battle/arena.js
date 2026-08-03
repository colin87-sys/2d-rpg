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
// fractions, so a painted feature at pF fh of the image lands at screen
//   fy = 0.5 − uC/H − (0.5 − pF)·k
// (H = frustum height at D, k = oversize scale, uC = centre offset along
// camera-up). Solving for the feature to land at target sF:
//   uC = H · (0.5 − sF − (0.5 − pF)·k)
//
// HALL — pixel-measured: the painted stair-foot junction (where the stepped
// platform meets the flagstones, centre band x 900–1020 of the 1920×1080
// plate) sits at pF = 0.598 fh; the painted flame centroids at (0.252, 0.24)
// and (0.732, 0.25), midpoint 0.492 fw — matching the §3 torch-anchor screen
// midpoint 0.494, so the plate stays horizontally centred. The geometry's
// floor-to-wall junction (back wall z = −12, y = 0) projects to fy 0.6161
// under the §1 camera. The plate is therefore shifted 0.196 m DOWN along
// camera-up (uC = 13.852·(0.5 − 0.6161 − (0.5 − 0.598)·1.04) = −0.196) so
// the painted junction lands exactly on the z −12 line, and the real floor
// is trimmed to end at z = −12: the real/painted seam IS the junction, and
// no painted floor shows above the live one. k = 1.04 keeps full coverage
// after the shift (top edge 0.506·H > 0.500·H, bottom 0.534·H).
//
// HIGHLAND — the real 2° shelf's far edge (z −12, y 0.244 — same wall-plane
// anchor as the hall per §1) projects to fy 0.597. The plate's cracked-stone
// floor runs up to ≈ 0.60–0.65 fh with the mid-ground rock band above, so
// the plate keeps its authored framing (pF = sF = 0.597 → zero net shift,
// uC = +0.04 m is pure oversize compensation): the real turf horizon at
// 0.597 occludes the painted rock-band bottoms (0.60–0.65), which reads as
// boulders beyond a rise — nothing painted floats above live ground.
const PLATE_FIT = {
  hall: { pF: 0.598, sF: 0.6161, k: 1.04 },
  highland: { pF: 0.597, sF: 0.597, k: 1.03 },
}
const PLATE_DIST = 30

function makeBackdropPlate(variant, aniso) {
  const { tex } = PLATES[variant]
  if (aniso) tex.anisotropy = aniso
  const { pF, sF, k } = PLATE_FIT[variant]
  const pitch = THREE.MathUtils.degToRad(12)
  const fwd = new THREE.Vector3(0, -Math.sin(pitch), -Math.cos(pitch))
  const up = new THREE.Vector3(0, Math.cos(pitch), -Math.sin(pitch))
  const H = 2 * PLATE_DIST * Math.tan(THREE.MathUtils.degToRad(13)) // 13.852 m
  const W = H * (16 / 9) // 24.626 m — the plates are 16:9 like the frame
  const uC = H * (0.5 - sF - (0.5 - pF) * k)
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(W * k, H * k),
    // Pre-lit plate: unlit material, no scene fog, no tint — §3/§4 lighting
    // is already painted in. Lighting it again would double-expose.
    new THREE.MeshBasicMaterial({ map: tex, fog: false })
  )
  mesh.position.set(0, 7.0, 14.0).addScaledVector(fwd, PLATE_DIST).addScaledVector(up, uC)
  mesh.rotation.x = -pitch // normal (0, sin12°, cos12°): faces the fixed seat
  mesh.castShadow = false
  mesh.receiveShadow = false // pre-lit — must never catch the shadow map
  mesh.frustumCulled = false
  mesh.name = 'arena_backdrop_' + variant
  return mesh
}

// ===========================================================================
// 4. Floor painters — the two surfaces that stay real and lit
// ===========================================================================

// Flagstone floor — FLOOR_COOL #3c4049 slate, FLOOR_GROUT #23262e joints.
// Big 1.0 × 0.66 m slabs in running bond; visible coursing is mandatory.
function paintFlagstone(g, S, seed) {
  const rnd = mulberry32(seed)
  const N = makeNoise2(seed + 7)
  const grout = rgb(0x23262e) // FLOOR_GROUT
  const cool = rgb(0x3c4049)  // FLOOR_COOL — authored at the sample, not above it
  const coolD = rgb(0x30343c)
  const warm = rgb(0x46403a) // rare warm slab — mostly light does the warming
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

// Mossy shelf turf (§4) — authored below GROUND_FG so the rig lifts it;
// deep moss pools + worn rock keep the shelf from reading as felt.
function paintHighGround(g, S, seed) {
  const rnd = mulberry32(seed)
  const N = makeNoise2(seed + 11)
  const mid = rgb(0x46523c)
  const fg = rgb(0x39452f)
  const moss = rgb(0x2a3424)
  const rock = rgb(0x424d46)
  const tip = rgb(0x6e6e54) // GRASS_PALE, dimmed to the key
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
    emissive: 0x4a5464, emissiveMap: tFloor, emissiveIntensity: 1.0,
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
    // §3 colour/decay; 33/11 is the round-2 image-over-bible tune that holds
    // each pool at ~0.11 fw of strong influence — kept, because the plate's
    // painted wall pools have that radius and the live floor pools must
    // match them. These lights are what keep the SPRITES warm-keyed (§5):
    // deleting them because the flames are painted would flatten the party.
    const light = new THREE.PointLight(0xffa64f, 33, 11, 2)
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
      R.light.intensity = 33 * (1 + 0.12 * n)
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
    // vertexColors carries the authored downstage falloff (below);
    // teal-green emissive dark per §11.6 — hue-bearing, never grey
    map: tGround, vertexColors: true, roughness: 1, metalness: 0,
    emissive: 0x05170f, emissiveIntensity: 0.8,
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
    // Foreground falloff baked as vertex colour: the plate's world is bright
    // only in the fog band; the live shelf falls dark toward the camera.
    // Full albedo upstage → ~0.55 at the front rank → ~0.34 at the frame
    // bottom, with a pull-down toward the lateral edges.
    const ss = (a, b, v) => { v = clamp((v - a) / (b - a), 0, 1); return v * v * (3 - 2 * v) }
    const vcol = new Float32Array(pos.count * 3)
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      pos.setY(i, groundY(x, z))
      uv.setXY(i, x / 11, z / 11)
      let f = lerp(1.0, 0.52, ss(-8.5, -2.5, z))
      f = lerp(f, 0.34, ss(-2.5, 4, z))
      f *= 1 - 0.22 * ss(8, 14, Math.abs(x))
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

  // ---- three drifting fog cards (§4: z −4/−9/−14, α .22/.35/.50) ----------
  // All three sit in FRONT of the plate (z ≥ −14 vs plate at ~30 m along the
  // axis) — the painting stays still, the weather over it does not.
  const fogCards = []
  const cardSpecs = [
    { z: -4, a: 0.22, w: 16, h: 4.6, y: 1.6, speed: 0.40, seed: 31 },
    { z: -9, a: 0.35, w: 20, h: 6.0, y: 2.2, speed: 0.26, seed: 32 },
    { z: -14, a: 0.50, w: 24, h: 7.5, y: 2.8, speed: 0.15, seed: 33 },
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
      map: i % 2 ? mistTexA : mistTexB, color: 0xb2bcae, transparent: true,
      opacity: 0.17, depthWrite: false, fog: false,
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
      scene.background = new THREE.Color(0x10231f)
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
        let o = 0.17 + 0.035 * Math.sin(t * 0.33 + M.phase * 2.1)
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
