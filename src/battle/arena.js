// ---------------------------------------------------------------------------
// src/battle/arena.js — Aetherbound battle environments (BATTLE_BIBLE §1/§3/§4)
//
//   createArena({ renderer, scene, variant })   variant: 'hall' | 'highland'
//
// Owns: the whole set, the scene fog + background, every environment light,
// the sprite rim law (§5.1) that units.js reads, addSpellLight() parenting for
// VFX point lights, groundY(x,z), and per-frame torch flicker / flame boil /
// ember spawn / fog-card drift / ground-mist churn.
//
//   HALL (frame04)     — near-black ashlar hall drowning in blue dark; two
//                        monumental brazier columns at (∓5.3, ·, −10.8) whose
//                        flames at y 5.4 are the only warmth besides the door
//                        glow; splayed side walls with fluted columns and
//                        arcade arches falling to void; a stepped podium and
//                        X-braced double door upstage at z −12; a coursed
//                        flagstone floor that only warms inside torch radius.
//   HIGHLAND (frame05) — a mossy rock shelf ending in a cliff lip at z −14;
//                        conifer silhouettes stage-left, a crag buttress
//                        upper-right, skyline cards and a painted fog-band
//                        backdrop behind; three drifting fog cards, a
//                        backlight glow disc, low ground mist and drifting
//                        motes. Cool, near-monochrome, silhouette-first.
//
// Every number that appears with a bible reference is typed in from
// docs/BATTLE_BIBLE.md — do not "tune" them. Where the reference images and
// the bible disagreed, the images won (noted inline).
//
// Rim-law convention published here (units.js consumes):
//   rim.dir      [x, y] normalized SCREEN-space direction from a unit TOWARD
//                its rim light, y positive DOWN (CSS/px sense). Highland's
//                fixed (0, −1) therefore means "lit from straight above".
//   rim.color    '#rrggbb' string.  rim.strength  0..1.
//   rim.sources  live world-space light anchors ({x,y,z,kind}) — torches plus
//                any active spell lights — so units may refine per-unit.
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
function cssa(c, a) { return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + a + ')' }
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
// 2. Texture kit — every map painted in Canvas2D at runtime, no assets
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

// Soft white radial disc — tinted per-material (glows, halos, discs, mist).
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

// --- torch flame: 3 layers × 3 boil frames, additive teardrops (§3) --------
// Layer palette (BIBLE §3): core #f9f3e3, body #e99648, tongues #af5d21.
function flameAtlasTex(layer, seed) {
  const F = 128
  const c = document.createElement('canvas')
  c.width = F * 3
  c.height = F
  const g = c.getContext('2d')
  const rnd = mulberry32(seed)
  const spec = {
    core: { col: rgb(0xf9f3e3), hot: rgb(0xffffff), w: 0.30, lobes: 2, rag: 0.10 },
    body: { col: rgb(0xe99648), hot: rgb(0xf9f3e3), w: 0.40, lobes: 3, rag: 0.20 },
    tongues: { col: rgb(0xaf5d21), hot: rgb(0xe99648), w: 0.48, lobes: 4, rag: 0.34 },
  }[layer]
  for (let f = 0; f < 3; f++) {
    const ox = f * F
    const cx = ox + F / 2
    const baseY = F * 0.94
    // teardrop body: stacked shrinking blobs with per-frame wobble
    const steps = 22
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1) // 0 base → 1 tip
      const y = baseY - t * F * 0.86
      const wob = Math.sin(t * 9 + f * 2.1 + seed) * spec.rag * (0.3 + t)
      const x = cx + wob * F * 0.30
      const r = F * spec.w * (1 - t * 0.85) * (0.82 + 0.18 * Math.sin(t * 5 + f))
      const a = (1 - t * 0.55) * 0.16
      g.fillStyle = cssa(mixc(spec.col, spec.hot, Math.pow(1 - t, 1.6) * 0.8), a)
      g.beginPath()
      g.ellipse(x, y, Math.max(1.5, r), Math.max(2, r * 1.35), 0, 0, TAU)
      g.fill()
    }
    // side tongues licking upward
    for (let l = 0; l < spec.lobes; l++) {
      const side = l % 2 ? 1 : -1
      const ty = baseY - F * (0.18 + rnd() * 0.34)
      const tx = cx + side * F * spec.w * (0.5 + rnd() * 0.45)
      const th = F * (0.16 + rnd() * 0.22)
      g.fillStyle = cssa(spec.col, 0.30 + rnd() * 0.2)
      g.beginPath()
      g.moveTo(tx - 4, ty)
      g.quadraticCurveTo(tx + side * 7, ty - th * 0.5, tx + side * 2, ty - th)
      g.quadraticCurveTo(tx - side * 5, ty - th * 0.4, tx - 4, ty)
      g.fill()
    }
    // ragged edge erosion — punch transparent bites so the silhouette boils
    g.globalCompositeOperation = 'destination-out'
    const bites = layer === 'core' ? 8 : 16
    for (let i = 0; i < bites; i++) {
      const t = rnd()
      const y = baseY - t * F * 0.9
      const x = cx + (rnd() - 0.5) * F * spec.w * 2.4
      const r = F * (0.02 + rnd() * 0.05) * (0.5 + t)
      g.beginPath()
      g.arc(x, y, r, 0, TAU)
      g.fill()
    }
    g.globalCompositeOperation = 'source-over'
    // hot base seat
    const grad = g.createRadialGradient(cx, baseY - F * 0.04, 0, cx, baseY - F * 0.04, F * spec.w * 0.9)
    grad.addColorStop(0, cssa(spec.hot, layer === 'core' ? 0.9 : 0.5))
    grad.addColorStop(1, cssa(spec.hot, 0))
    g.fillStyle = grad
    g.beginPath()
    g.ellipse(cx, baseY - F * 0.05, F * spec.w, F * 0.13, 0, 0, TAU)
    g.fill()
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
  t.magFilter = t.minFilter = THREE.LinearFilter
  t.generateMipmaps = false
  t.repeat.set(1 / 3, 1)
  return t
}

// ===========================================================================
// 3. Geometry kit — primitives with worldized UVs, merged per material
// ===========================================================================

function worldizeBoxUV(geo, w, h, d, s, u0) {
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]]
  const uv = geo.attributes.uv
  for (let f = 0; f < 6; f++) {
    const dw = dims[f][0] / s
    const dh = dims[f][1] / s
    for (let i = f * 4; i < f * 4 + 4; i++) {
      uv.setXY(i, uv.getX(i) * dw + u0, uv.getY(i) * dh)
    }
  }
}
function autoU(x, y, z) {
  const v = x * 7.31 + z * 3.97 + y * 1.71
  return v - Math.floor(v)
}
function gFinish(geo, x, y, z, o) {
  if (o.rz) geo.rotateZ(o.rz)
  if (o.rx) geo.rotateX(o.rx)
  if (o.ry) geo.rotateY(o.ry)
  geo.translate(x, y, z)
  return geo
}
// Box, base-anchored at y unless o.c (centred). o.uv = metres per repeat.
function gBox(w, h, d, x, y, z, o = {}) {
  const geo = new THREE.BoxGeometry(w, h, d)
  worldizeBoxUV(geo, w, h, d, o.uv || 1.5, o.u0 !== undefined ? o.u0 : autoU(x, y, z))
  return gFinish(geo, x, o.c ? y : y + h / 2, z, o)
}
function gCyl(rT, rB, h, seg, x, y, z, o = {}) {
  const geo = new THREE.CylinderGeometry(rT, rB, h, seg)
  const s = o.uv || 1.5
  const uv = geo.attributes.uv
  const cu = (TAU * (rT + rB)) / 2 / s
  const cv = h / s
  const u0 = autoU(x, y, z)
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * cu + u0, uv.getY(i) * cv)
  return gFinish(geo, x, o.c ? y : y + h / 2, z, o)
}
function gLathe(profile, seg, x, y, z, o = {}) {
  const pts = profile.map((p) => new THREE.Vector2(p[0], p[1]))
  const geo = new THREE.LatheGeometry(pts, seg)
  const s = o.uv || 1.2
  const uv = geo.attributes.uv
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2.2, uv.getY(i) * (2.2 / s))
  return gFinish(geo, x, y, z, o)
}
// Wall slab with a round-top arched hole, front face on +Z (arcades, niches).
function gArchWall(w, h, t, aw, ah, x, y, z, o = {}) {
  const shp = new THREE.Shape()
  shp.moveTo(-w / 2, 0)
  shp.lineTo(w / 2, 0)
  shp.lineTo(w / 2, h)
  shp.lineTo(-w / 2, h)
  shp.closePath()
  const hole = new THREE.Path()
  const r = aw / 2
  hole.moveTo(-r, 0)
  hole.lineTo(-r, ah - r)
  hole.absarc(0, ah - r, r, Math.PI, 0, true)
  hole.lineTo(r, 0)
  hole.closePath()
  shp.holes.push(hole)
  const geo = new THREE.ExtrudeGeometry(shp, { depth: t, bevelEnabled: false, curveSegments: 9 })
  geo.translate(0, 0, -t / 2)
  const s = o.uv || 1.5
  const uv = geo.attributes.uv
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / s, uv.getY(i) / s)
  return gFinish(geo, x, y, z, o)
}
// Sagging chain/rope between two points (parabolic dip).
function gCatTube(ax, ay, az, bx, by, bz, sag, r) {
  const pts = []
  for (let i = 0; i <= 10; i++) {
    const t = i / 10
    pts.push(new THREE.Vector3(
      ax + (bx - ax) * t,
      ay + (by - ay) * t - sag * 4 * t * (1 - t),
      az + (bz - az) * t
    ))
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 12, r, 5, false)
}
// Faceted boulder: jittered icosahedron, flattened, base-anchored, sunk.
function gRock(seed, sx, sy, sz, x, y, z, o = {}) {
  const geo = new THREE.IcosahedronGeometry(0.5, 1)
  const rnd = mulberry32(seed)
  const pos = geo.attributes.position
  const seen = new Map()
  for (let i = 0; i < pos.count; i++) {
    const key = pos.getX(i).toFixed(3) + ',' + pos.getY(i).toFixed(3) + ',' + pos.getZ(i).toFixed(3)
    let s = seen.get(key)
    if (s === undefined) { s = 0.76 + rnd() * 0.52; seen.set(key, s) }
    pos.setXYZ(i, pos.getX(i) * s * sx, pos.getY(i) * s * sy * 0.8, pos.getZ(i) * s * sz)
  }
  geo.computeVertexNormals()
  // base-anchor then sink 15 % for ground contact (no floating rocks)
  geo.translate(0, sy * 0.34, 0)
  return gFinish(geo, x, y - sy * 0.12, z, o)
}
function yawX(ux, uz) { return Math.atan2(-uz, ux) }

// Bucket helpers — one geometry list per material key.
function addG(list, geo) {
  list.push(geo.index ? geo.toNonIndexed() : geo)
}
function mergeBuckets(group, B, MAT, opts = {}) {
  for (const k of Object.keys(B)) {
    if (!B[k].length) continue
    const merged = mergeGeometries(B[k], false)
    if (!merged) continue
    const mesh = new THREE.Mesh(merged, MAT[k])
    mesh.name = 'arena_' + k
    mesh.castShadow = !(opts.noCast && opts.noCast.includes(k))
    mesh.receiveShadow = true
    group.add(mesh)
    for (const g of B[k]) g.dispose()
    B[k].length = 0
  }
}

// ===========================================================================
// 4. HALL painters — BIBLE §3 palette, authored as albedo (lights finish it)
// ===========================================================================

// Coursed ashlar masonry. Authored warm so the torch pools land on the
// sampled WALL_HOT/WALL_LIT ramp; unlit areas fall to WALL_DARK via the rig.
function paintAshlar(g, S, seed) {
  const rnd = mulberry32(seed)
  const mortar = rgb(0x4a4038)
  const lit = rgb(0x93805f)
  const mid = rgb(0x7a6752)
  const dark = rgb(0x5b4c40)
  g.fillStyle = css(mortar)
  g.fillRect(0, 0, S, S)
  const rows = 12 // 6 m/repeat → 0.5 m courses
  const ch = S / rows
  const wrapRect = (x, y, w, h) => {
    g.fillRect(x, y, w, h)
    if (x < 0) g.fillRect(x + S, y, w, h)
    if (x + w > S) g.fillRect(x - S, y, w, h)
  }
  for (let r = 0; r < rows; r++) {
    const y = r * ch
    let x = -((r % 2) * 64 + rnd() * 10)
    while (x < S) {
      const bw = 96 * (0.72 + rnd() * 0.6)
      let base = mixc(lit, mid, Math.pow(rnd(), 1.3))
      if (rnd() < 0.14) base = mixc(mid, dark, 0.4 + rnd() * 0.5)
      base = mixc(base, [base[0] + 9, base[1] + 4, base[2] - 6], rnd() * 0.5)
      g.fillStyle = css(base)
      wrapRect(x + 1.5, y + 1.5, bw - 3, ch - 3)
      g.fillStyle = css(shade(base, 1.13))
      wrapRect(x + 1.5, y + 1.5, bw - 3, 2) // top bevel
      g.fillStyle = css(shade(base, 0.74))
      wrapRect(x + 1.5, y + ch - 4, bw - 3, 2.4) // foot shadow
      g.fillStyle = css(shade(base, 0.87))
      wrapRect(x + bw - 3.6, y + 1.5, 2, ch - 3) // right shade
      if (rnd() < 0.2) { // chip glint
        g.fillStyle = css(shade(base, 1.22))
        wrapRect(x + 3 + rnd() * (bw - 10), y + 2.5, 2.5 + rnd() * 3, 1.8)
      }
      if (rnd() < 0.3) { // soot/grime pooling at block feet
        g.globalAlpha = 0.2 + rnd() * 0.2
        g.fillStyle = css(shade(dark, 0.5))
        wrapRect(x + 2 + rnd() * bw * 0.4, y + ch * 0.5, bw * (0.3 + rnd() * 0.35), ch * 0.46)
        g.globalAlpha = 1
      }
      x += bw
    }
  }
  // large value patches kill the wallpaper read
  for (let i = 0; i < 6; i++) {
    g.globalAlpha = 0.055
    g.fillStyle = i % 2 ? '#000000' : '#ffe8c8'
    g.beginPath()
    g.arc(rnd() * S, rnd() * S, S * (0.18 + rnd() * 0.25), 0, TAU)
    g.fill()
    g.globalAlpha = 1
  }
}

// Flagstone floor — FLOOR_COOL #3c4049 slate, FLOOR_GROUT #23262e joints.
// Big 1.0 × 0.66 m slabs in running bond; visible coursing is mandatory.
function paintFlagstone(g, S, seed) {
  const rnd = mulberry32(seed)
  const N = makeNoise2(seed + 7)
  const grout = rgb(0x23262e)
  const cool = rgb(0x4a4e58)
  const coolD = rgb(0x3a3e47)
  const warm = rgb(0x574f47) // rare warm slab — mostly light does the warming
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
    g.fillStyle = i % 3 ? '#10141e' : '#6b6258'
    g.beginPath()
    g.arc(rnd() * S, rnd() * S, S * (0.16 + rnd() * 0.22), 0, TAU)
    g.fill()
    g.globalAlpha = 1
  }
}

// Dressed stone for trim (columns, steps, podium, plinths, benches).
// Optional flute stripes for the column shafts.
function paintDressed(g, S, seed, base0, flutes) {
  const rnd = mulberry32(seed)
  const N = makeNoise2(seed + 3)
  const base = rgb(base0)
  g.fillStyle = css(base)
  g.fillRect(0, 0, S, S)
  for (let i = 0; i < 900; i++) {
    const x = rnd() * S
    const y = rnd() * S
    const n = N.fbm(x / 40, y / 40, 4)
    g.globalAlpha = 0.12
    g.fillStyle = css(shade(base, 1 + n * 0.36))
    g.fillRect(x, y, 2 + rnd() * 3, 2 + rnd() * 3)
    g.globalAlpha = 1
  }
  // faint sediment banding
  for (let y = 0; y < S; y += 14 + rnd() * 20) {
    g.globalAlpha = 0.08
    g.fillStyle = rnd() < 0.5 ? css(shade(base, 0.82)) : css(shade(base, 1.12))
    g.fillRect(0, y, S, 3 + rnd() * 5)
    g.globalAlpha = 1
  }
  // chips and pocks
  for (let i = 0; i < 60; i++) {
    g.globalAlpha = 0.35
    g.fillStyle = rnd() < 0.6 ? css(shade(base, 0.66)) : css(shade(base, 1.24))
    g.fillRect(rnd() * S, rnd() * S, 1.6, 1.6)
    g.globalAlpha = 1
  }
  if (flutes) {
    // 10 flutes per repeat: dark valley, bright arris — reads as fluting
    const fw = S / 10
    for (let i = 0; i < 10; i++) {
      const x = i * fw
      const grad = g.createLinearGradient(x, 0, x + fw, 0)
      grad.addColorStop(0.0, 'rgba(255,240,220,0.20)')
      grad.addColorStop(0.22, 'rgba(0,0,0,0.0)')
      grad.addColorStop(0.62, 'rgba(0,0,10,0.30)')
      grad.addColorStop(0.86, 'rgba(0,0,10,0.10)')
      grad.addColorStop(1.0, 'rgba(255,240,220,0.20)')
      g.fillStyle = grad
      g.fillRect(x, 0, fw, S)
    }
  }
  // grime foot band (v = 0 is the bottom of most trim boxes)
  const grad = g.createLinearGradient(0, S, 0, S * 0.72)
  grad.addColorStop(0, 'rgba(20,16,12,0.35)')
  grad.addColorStop(1, 'rgba(20,16,12,0)')
  g.fillStyle = grad
  g.fillRect(0, S * 0.72, S, S * 0.28)
}

// X-braced double door — dark oak planks, iron straps, stud bolts.
function paintDoor(g, W, H, seed) {
  const rnd = mulberry32(seed)
  const plank = rgb(0x46311e)
  const plankD = rgb(0x2e2013)
  const iron = rgb(0x241b14)
  const ironHi = rgb(0x54422e)
  g.fillStyle = css(plankD)
  g.fillRect(0, 0, W, H)
  const leafW = W / 2
  for (const leaf of [0, 1]) {
    const ox = leaf * leafW
    const pw = leafW / 4
    for (let p = 0; p < 4; p++) {
      const x = ox + p * pw
      const tone = shade(plank, 0.82 + rnd() * 0.34)
      g.fillStyle = css(tone)
      g.fillRect(x + 1, 2, pw - 2, H - 4)
      for (let i = 0; i < 6; i++) { // grain
        g.globalAlpha = 0.2
        g.strokeStyle = css(shade(tone, rnd() < 0.7 ? 0.66 : 1.24))
        g.lineWidth = 1
        g.beginPath()
        const gx = x + 2 + rnd() * (pw - 4)
        g.moveTo(gx, 0)
        for (let y = 0; y <= H; y += H / 5) g.lineTo(gx + Math.sin(y * 0.04 + rnd() * 6) * 1.5, y)
        g.stroke()
        g.globalAlpha = 1
      }
    }
    // X cross-brace (the frame04 tell) + top/bottom rails
    g.strokeStyle = css(iron)
    g.lineWidth = W * 0.045
    g.lineCap = 'square'
    g.beginPath()
    g.moveTo(ox + leafW * 0.12, H * 0.16)
    g.lineTo(ox + leafW * 0.88, H * 0.84)
    g.moveTo(ox + leafW * 0.88, H * 0.16)
    g.lineTo(ox + leafW * 0.12, H * 0.84)
    g.stroke()
    g.strokeStyle = css(ironHi)
    g.lineWidth = 1.4
    g.beginPath()
    g.moveTo(ox + leafW * 0.12, H * 0.155)
    g.lineTo(ox + leafW * 0.88, H * 0.835)
    g.stroke()
    for (const fy of [0.06, 0.94]) {
      g.fillStyle = css(iron)
      g.fillRect(ox + leafW * 0.06, H * fy - H * 0.022, leafW * 0.88, H * 0.044)
      g.fillStyle = css(ironHi)
      g.fillRect(ox + leafW * 0.06, H * fy - H * 0.022, leafW * 0.88, 1.5)
    }
    // studs
    for (const [sx, sy] of [[0.12, 0.16], [0.88, 0.16], [0.12, 0.84], [0.88, 0.84], [0.5, 0.5]]) {
      g.fillStyle = css(ironHi)
      g.beginPath()
      g.arc(ox + leafW * sx, H * sy, W * 0.014, 0, TAU)
      g.fill()
    }
  }
  // centre meeting gap + hinge edges
  g.fillStyle = 'rgba(8,6,4,0.9)'
  g.fillRect(W / 2 - 1.5, 0, 3, H)
  g.fillRect(0, 0, 2, H)
  g.fillRect(W - 2, 0, 2, H)
}

// ===========================================================================
// 5. HALL build — frame04's torchlit stone hall
// ===========================================================================

function buildHall(env) {
  const { group, aniso, rnd } = env

  // ---- materials ----------------------------------------------------------
  // Emissive floor = the §3 law "deep shadow is blue #060d18-class, never
  // pure black": every stone material glows that value faintly so unlit
  // masonry drowns blue, not black.
  const tWall = canvasTex(512, 512, aniso, (g, S) => paintAshlar(g, S, 101))
  const tFloor = canvasTex(512, 512, aniso, (g, S) => paintFlagstone(g, S, 202))
  const tTrim = canvasTex(256, 256, aniso, (g, S) => paintDressed(g, S, 303, 0x8a7a68, false))
  const tCol = canvasTex(256, 256, aniso, (g, S) => paintDressed(g, S, 404, 0x94826c, true))
  const tRecess = canvasTex(256, 256, aniso, (g, S) => paintDressed(g, S, 505, 0x4e3c28, false)) // DOOR_RECESS
  const tDoor = canvasTex(256, 320, aniso, (g, w, h) => paintDoor(g, w, h, 606), { clamp: true })

  const stdOpts = { roughness: 0.95, metalness: 0, emissive: 0x060d18, emissiveIntensity: 1.0 }
  const MAT = {
    wall: new THREE.MeshStandardMaterial({ map: tWall, ...stdOpts }),
    floor: new THREE.MeshStandardMaterial({ map: tFloor, roughness: 0.85, metalness: 0, emissive: 0x060d18, emissiveIntensity: 1.0 }),
    trim: new THREE.MeshStandardMaterial({ map: tTrim, ...stdOpts }),
    column: new THREE.MeshStandardMaterial({ map: tCol, ...stdOpts }),
    recess: new THREE.MeshStandardMaterial({ map: tRecess, roughness: 0.9, metalness: 0, emissive: 0x2a1a0c, emissiveIntensity: 0.55 }),
    door: new THREE.MeshStandardMaterial({ map: tDoor, roughness: 0.9, metalness: 0, emissive: 0x090909, emissiveIntensity: 0.6 }),
    bronze: new THREE.MeshStandardMaterial({ color: 0x401c0f, roughness: 0.5, metalness: 0.35, emissive: 0x120804, emissiveIntensity: 0.8 }), // BRAZIER_BOWL
    coals: new THREE.MeshStandardMaterial({ color: 0x2a1206, roughness: 1, metalness: 0, emissive: 0xaf5d21, emissiveIntensity: 1.5 }), // FLAME_BASE
    void: new THREE.MeshBasicMaterial({ color: 0x04080e }), // arch voids — blue-black, never #000
    rubble: new THREE.MeshStandardMaterial({ map: tTrim, color: 0x8a8a96, roughness: 1, metalness: 0, emissive: 0x060d18, emissiveIntensity: 1.0 }),
  }
  const B = {}
  for (const k of Object.keys(MAT)) B[k] = []

  // ---- floor --------------------------------------------------------------
  {
    const geo = new THREE.PlaneGeometry(42, 20, 1, 1)
    geo.rotateX(-HPI)
    const uv = geo.attributes.uv
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (42 / 6), uv.getY(i) * (20 / 6))
    geo.translate(0, 0, -8) // spans z −18…+2
    addG(B.floor, geo)
  }

  // ---- back wall (z −12), cornice, string course, flanking niches ---------
  addG(B.wall, gBox(34, 9.6, 0.7, 0, 0, -12.55, { uv: 6 })) // face at z −12.2
  addG(B.trim, gBox(34, 0.38, 0.34, 0, 5.55, -12.1, { uv: 2.2 })) // cornice ledge (ref: line over the door)
  addG(B.trim, gBox(34, 0.22, 0.24, 0, 2.62, -12.12, { uv: 2.2 })) // string course
  for (const s of [-1, 1]) {
    // arched niches flanking the door — arches falling to void (ref left/right dark recesses)
    addG(B.recess, gArchWall(2.7, 3.7, 0.5, 1.8, 2.9, 0.5 + s * 5.7, 0, -12.05, { uv: 1.6 }))
    addG(B.void, gBox(2.2, 3.2, 0.1, 0.5 + s * 5.7, 0, -12.38, { uv: 4 }))
  }

  // ---- splayed side walls with fluted columns + arcade arches -------------
  // Inner face line runs (±6.35, −12.2) → (±11.6, +3.4): the proscenium splay
  // that puts both walls obliquely in frame like the plate.
  for (const s of [-1, 1]) {
    const ax = 6.35 * s
    const az = -12.2
    const bx = 11.6 * s
    const bz = 3.4
    const dx = bx - ax
    const dz = bz - az
    const L = Math.hypot(dx, dz)
    const ux = dx / L
    const uz = dz / L
    const yaw = yawX(ux, uz)
    // inward normal
    let nx = -uz
    let nz = ux
    if (nx * ax + nz * az > 0) { nx = -nx; nz = -nz }
    const at = (t, off) => ({
      x: ax + ux * t * L + nx * (off || 0),
      z: az + uz * t * L + nz * (off || 0),
    })
    // wall pieces: solid — arcade — solid (the arcade sits between columns)
    const seg = (t0, t1) => {
      const c = at((t0 + t1) / 2, -0.34)
      addG(B.wall, gBox((t1 - t0) * L + 0.1, 9.2, 0.65, c.x, 0, c.z, { ry: yaw, uv: 6 }))
    }
    seg(0, 0.115)
    { // arcade arch piece with black void behind
      const c = at(0.185, -0.3)
      addG(B.wall, gArchWall(4.4, 9.2, 0.6, 2.35, 3.7, c.x, 0, c.z, { ry: yaw, uv: 6 }))
      const v = at(0.185, -0.78)
      addG(B.void, gBox(3.4, 4.4, 0.1, v.x, 0, v.z, { ry: yaw, uv: 4 }))
    }
    seg(0.255, 0.42)
    { // second arcade opening (visible only as a dark mass near frame edge)
      const c = at(0.49, -0.3)
      addG(B.wall, gArchWall(4.4, 9.2, 0.6, 2.35, 3.7, c.x, 0, c.z, { ry: yaw, uv: 6 }))
      const v = at(0.49, -0.78)
      addG(B.void, gBox(3.4, 4.4, 0.1, v.x, 0, v.z, { ry: yaw, uv: 4 }))
    }
    seg(0.56, 1)
    // wall string course + cornice ride the inner face
    for (const [yy, hh, dd] of [[2.62, 0.22, 0.2], [5.55, 0.38, 0.3]]) {
      const c = at(0.5, dd * 0.5 - 0.05)
      addG(B.trim, gBox(L, hh, 0.26, c.x, yy, c.z, { ry: yaw, uv: 2.2 }))
    }
    // fluted wall columns on plinths (screen ≈ 0.05 / 0.18 fw and mirrored)
    for (const t of [0.056, 0.30]) {
      const c = at(t, 0.42)
      addG(B.trim, gBox(1.45, 0.62, 1.45, c.x, 0, c.z, { uv: 1.2 })) // plinth
      addG(B.trim, gBox(1.2, 0.24, 1.2, c.x, 0.62, c.z, { uv: 1.2 })) // torus base
      addG(B.column, gCyl(0.46, 0.52, 7.6, 14, c.x, 0.86, c.z, { uv: 3.2 })) // shaft (flutes in map)
      addG(B.trim, gBox(1.25, 0.3, 1.25, c.x, 8.46, c.z, { uv: 1.2 })) // capital
    }
    // stone bench slabs along the wall (ref: left-side sarcophagus blocks)
    for (const [t, len] of [[0.155, 2.1], [0.235, 1.7]]) {
      const c = at(t, 1.15)
      addG(B.trim, gBox(len, 0.55, 1.0, c.x, 0, c.z, { ry: yaw, uv: 1.3 }))
      addG(B.trim, gBox(len + 0.24, 0.16, 1.18, c.x, 0.55, c.z, { ry: yaw, uv: 1.3 }))
    }
  }

  // ---- proscenium arch overhead (dark top-corner masses, frame04 top) -----
  addG(B.wall, gArchWall(30, 10.5, 1.4, 21, 9.6, 0, 0, -1.6, { uv: 6 }))

  // ---- door + podium + steps (BIBLE §1: platform z −10.5→−11.5, 5 × 0.36;
  //      door 3.2 m at (0.534, 0.20) screen) --------------------------------
  const PX = 0.5 // platform centred on x +0.5
  addG(B.trim, gBox(7.6, 1.7, 1.5, PX, 0, -11.65, { uv: 2.0 })) // podium body
  addG(B.trim, gBox(8.0, 0.14, 1.9, PX, 1.7, -11.65, { uv: 2.0 })) // top slab lip
  addG(B.trim, gBox(7.8, 0.2, 1.7, PX, 1.42, -11.68, { uv: 2.0 })) // cornice moulding
  for (let i = 0; i < 5; i++) { // 5 steps × 0.36 rise, 0.2 tread from z −10.5
    const z = -10.6 - i * 0.2
    addG(B.trim, gBox(5.6, 0.36 * (i + 1), 0.24, PX, 0, z, { uv: 1.6 }))
  }
  for (const s of [-1, 1]) { // stair cheek blocks + bronze newels with chain
    addG(B.trim, gBox(0.7, 0.9, 1.15, PX + s * 3.15, 0, -11.0, { uv: 1.3 }))
    addG(B.trim, gBox(0.55, 0.42, 0.7, PX + s * 3.1, 0, -10.35, { uv: 1.3 }))
    const nx = PX + s * 3.05
    addG(B.bronze, gCyl(0.055, 0.075, 0.95, 8, nx, 0.42, -10.3, {}))
    addG(B.bronze, new THREE.SphereGeometry(0.1, 8, 6).translate(nx, 1.45, -10.3))
    addG(B.bronze, gCyl(0.05, 0.06, 0.8, 8, nx, 1.84, -11.5, {}))
    addG(B.bronze, new THREE.SphereGeometry(0.08, 8, 6).translate(nx, 2.7, -11.5))
    addG(B.bronze, gCatTube(nx, 1.38, -10.32, nx, 2.62, -11.5, 0.16, 0.028))
  }
  // door recess: jambs + lintel + leaves set into the back wall
  addG(B.recess, gBox(0.5, 3.5, 0.55, PX - 1.55, 1.8, -11.95, { uv: 1.4 }))
  addG(B.recess, gBox(0.5, 3.5, 0.55, PX + 1.55, 1.8, -11.95, { uv: 1.4 }))
  addG(B.recess, gBox(3.6, 0.45, 0.55, PX, 5.25, -11.95, { uv: 1.4 }))
  addG(B.recess, gBox(3.4, 0.16, 0.8, PX, 1.72, -11.9, { uv: 1.4 })) // threshold
  {
    const geo = new THREE.PlaneGeometry(2.6, 3.2)
    geo.translate(PX, 1.8 + 1.6, -12.14)
    addG(B.door, geo)
  }
  // fluted pilaster columns flanking the door (ref ≈ 0.40 / 0.63 fw giants)
  for (const s of [-1, 1]) {
    const x = PX + s * 2.9
    addG(B.trim, gBox(1.6, 0.6, 1.6, x, 1.84, -11.85, { uv: 1.2 }))
    addG(B.trim, gBox(1.35, 0.26, 1.35, x, 2.44, -11.85, { uv: 1.2 }))
    addG(B.column, gCyl(0.5, 0.57, 6.8, 14, x, 2.7, -11.85, { uv: 3.2 }))
  }

  // ---- brazier columns at (∓5.3, ·, −10.8) — flame centres y 5.4 (§3) -----
  const torches = []
  for (const s of [-1, 1]) {
    const x = 5.3 * s
    const z = -10.8
    addG(B.trim, gBox(2.5, 0.42, 2.5, x, 0, z, { uv: 1.4 })) // stepped plinth
    addG(B.trim, gBox(2.15, 0.3, 2.15, x, 0.42, z, { uv: 1.4 }))
    addG(B.trim, gBox(1.85, 1.1, 1.85, x, 0.72, z, { uv: 1.3 })) // planter box
    addG(B.trim, gBox(2.1, 0.22, 2.1, x, 1.82, z, { uv: 1.3 })) // moulded rim
    addG(B.coals, gBox(1.6, 0.08, 1.6, x, 1.86, z, { uv: 1.3 })) // ember bed in the box
    // goblet brazier: foot → stem → flaring bowl, rim ≈ y 4.95
    addG(B.bronze, gLathe([
      [0.52, 0], [0.5, 0.1], [0.24, 0.28], [0.17, 0.7], [0.15, 1.6], [0.2, 2.1],
      [0.5, 2.42], [0.34, 2.52], [0.3, 2.62], [0.62, 2.78], [0.92, 2.95], [1.0, 3.0], [0.9, 2.98], [0.5, 2.86],
    ], 16, x, 1.95, z, {}))
    addG(B.coals, gCyl(0.78, 0.78, 0.1, 14, x, 4.78, z, {})) // burning bed in the bowl
    torches.push({ x, y: 5.4, z })
  }

  // ---- rubble along wall feet and corners ---------------------------------
  for (let i = 0; i < 16; i++) {
    const s = rnd() < 0.5 ? -1 : 1
    const t = rnd()
    const x = s * (6.6 + t * 3.4) + (rnd() - 0.5) * 1.4
    const z = -11.6 + t * 12 + (rnd() - 0.5) * 1.5
    addG(B.rubble, gRock(900 + i, 0.2 + rnd() * 0.5, 0.16 + rnd() * 0.3, 0.2 + rnd() * 0.5, x, 0, z, { ry: rnd() * TAU }))
  }
  for (let i = 0; i < 6; i++) {
    addG(B.rubble, gRock(950 + i, 0.15 + rnd() * 0.35, 0.12 + rnd() * 0.22, 0.15 + rnd() * 0.35,
      PX + (rnd() - 0.5) * 7.5, 0, -10.1 + rnd() * 0.8, { ry: rnd() * TAU }))
  }

  mergeBuckets(group, B, MAT, { noCast: ['floor', 'void', 'coals'] })

  // ---- groundY: flat floor, then the 5-step flight, then the podium -------
  function groundY(x, z) {
    if (z > -10.5) return 0
    if (Math.abs(x - PX) > 3.0 && z > -11.5) return 0 // beside the stair flight
    if (z <= -11.5) return 1.8
    const step = clamp(Math.floor((-10.5 - z) / 0.2) + 1, 0, 5)
    return step * 0.36
  }

  return {
    groundY,
    torches,
    safeStage: { x0: -4.8, x1: 6.6, z0: -10.2, z1: -1.6 },
  }
}

// ===========================================================================
// 6. Fire rig — 3-layer flame billboards, halo glows, ember points (§3)
// ===========================================================================

function buildFireRig(env, torches) {
  const { group, rnd } = env
  const glowT = radialTex(128, [[0, 0.55], [0.35, 0.28], [1, 0]])
  const layers = [
    // BIBLE §3: core #f9f3e3 0.45 m, body #e99648 0.8 m, tongues #af5d21 1.15 m
    { key: 'core', h: 0.45, tint: 0xfff6e0, y: 0.26, o: 0.95, hz: 9.0 },
    { key: 'body', h: 0.80, tint: 0xffc07a, y: 0.42, o: 0.85, hz: 7.5 },
    { key: 'tongues', h: 1.15, tint: 0xff9a50, y: 0.60, o: 0.7, hz: 6.2 },
  ]
  const texCache = {}
  const rigs = []
  for (let ti = 0; ti < torches.length; ti++) {
    const T = torches[ti]
    const rimY = T.y - 0.52 // bowl rim just under the flame anchor
    const holder = new THREE.Group()
    holder.position.set(T.x, rimY, T.z)
    const quads = []
    for (let li = 0; li < layers.length; li++) {
      const L = layers[li]
      const tex = (texCache[L.key + ti] = flameAtlasTex(L.key, 71 + ti * 13 + li))
      const mat = new THREE.MeshBasicMaterial({
        map: tex, color: L.tint, transparent: true, opacity: L.o,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      })
      const w = L.h * 0.72
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, L.h), mat)
      m.position.y = L.y
      m.position.z = li * 0.012 // layer separation, no z-fight
      // renderOrder stays 0: additive blending is order-independent and the
      // painter's depth sort must keep the enemy quad in front of the fire
      m.frustumCulled = false
      holder.add(m)
      quads.push({ m, L, phase: rnd() * 37, frame: (rnd() * 3) | 0 })
    }
    // seat glow + wide halo (pre-post warm bloom the plate shows)
    const seat = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowT, color: 0xffa64f, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }))
    seat.scale.set(1.7, 1.2, 1)
    seat.position.y = 0.35
    seat.renderOrder = 19
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowT, color: 0xd96830, transparent: true, opacity: 0.17,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }))
    halo.scale.set(5.2, 4.2, 1)
    halo.position.y = 0.7
    halo.renderOrder = 18
    holder.add(seat, halo)
    group.add(holder)

    // point light — BIBLE §3 numbers typed in: #ffa64f, 40, distance 14, decay 2
    const light = new THREE.PointLight(0xffa64f, 40, 14, 2)
    light.position.set(T.x, T.y, T.z)
    light.castShadow = false // §3: torch lights cast none (cost)
    group.add(light)

    rigs.push({
      T, holder, quads, seat, halo, light,
      phase: rnd() * 100, hz: 7 + rnd() * 2, // §3 flicker band 7–9 Hz per torch
      emberAcc: rnd(),
    })
  }

  // ---- embers: 6/s per torch, rise 0.7 m/s, life 1.2 s (§3) ---------------
  const CAP = 26
  const eGeo = new THREE.BufferGeometry()
  const ePos = new Float32Array(CAP * 3)
  const eCol = new Float32Array(CAP * 4)
  eGeo.setAttribute('position', new THREE.BufferAttribute(ePos, 3))
  eGeo.setAttribute('color', new THREE.BufferAttribute(eCol, 4))
  const embers = []
  for (let i = 0; i < CAP; i++) embers.push({ alive: false, x: 0, y: -50, z: 0, vx: 0, vy: 0, vz: 0, life: 0, age: 0 })
  const eMat = new THREE.PointsMaterial({
    map: radialTex(32, [[0, 1], [0.4, 0.6], [1, 0]]), size: 0.075, sizeAttenuation: true,
    transparent: true, vertexColors: true, blending: THREE.AdditiveBlending,
    depthWrite: false, fog: false,
  })
  const ePts = new THREE.Points(eGeo, eMat)
  ePts.frustumCulled = false
  ePts.renderOrder = 22
  group.add(ePts)

  const EMBER = rgb(0xb2512e)
  const EMBER_HOT = rgb(0xf9f3e3)

  function update(t, dt, camera, spellBoost) {
    for (const R of rigs) {
      // cylindrical billboard toward the camera
      R.holder.rotation.y = Math.atan2(camera.position.x - R.T.x, camera.position.z - R.T.z)
      // two-octave flicker: intensity ±12 %, position jitter ±0.06 m (§3)
      const n = flicker2(t, R.hz, R.phase)
      R.light.intensity = 40 * (1 + 0.12 * n)
      R.light.position.set(
        R.T.x + 0.06 * vnoise1(t * 5.1 + R.phase),
        R.T.y + 0.06 * vnoise1(t * 6.3 + R.phase + 31),
        R.T.z + 0.06 * vnoise1(t * 5.7 + R.phase + 67)
      )
      for (const Q of R.quads) {
        // flipbook boil 6–9 Hz + scale flutter + sway
        const fr = (Math.floor(t * Q.L.hz + Q.phase) % 3 + 3) % 3
        Q.m.material.map.offset.x = fr / 3
        const fx = 1 + 0.09 * vnoise1(t * 7.3 + Q.phase)
        const fy = 1 + 0.13 * vnoise1(t * 8.1 + Q.phase + 9) + 0.05 * n
        Q.m.scale.set(fx, fy, 1)
        Q.m.rotation.z = 0.07 * vnoise1(t * 4.2 + Q.phase + 4)
      }
      R.seat.material.opacity = 0.46 + 0.08 * n
      R.halo.material.opacity = 0.15 + 0.035 * n
      // spawn embers
      R.emberAcc += dt * 6
      while (R.emberAcc >= 1) {
        R.emberAcc -= 1
        const e = embers.find((e2) => !e2.alive)
        if (!e) break
        e.alive = true
        e.age = 0
        e.life = 0.9 + rnd() * 0.6
        e.x = R.T.x + (rnd() - 0.5) * 0.5
        e.y = R.T.y - 0.35 + rnd() * 0.25
        e.z = R.T.z + (rnd() - 0.5) * 0.5
        e.vx = (rnd() - 0.5) * 0.34
        e.vy = 0.7 + (rnd() - 0.5) * 0.24 // rise 0.7 m/s
        e.vz = (rnd() - 0.5) * 0.34
      }
    }
    // advance embers
    for (let i = 0; i < CAP; i++) {
      const e = embers[i]
      if (e.alive) {
        e.age += dt
        if (e.age >= e.life) e.alive = false
        e.x += (e.vx + 0.10 * vnoise1(t * 3 + i * 7.7)) * dt
        e.y += e.vy * dt
        e.z += e.vz * dt
      }
      const k = e.alive ? e.age / e.life : 1
      ePos[i * 3] = e.x
      ePos[i * 3 + 1] = e.alive ? e.y : -50
      ePos[i * 3 + 2] = e.z
      const c = mixc(EMBER_HOT, EMBER, clamp(k * 1.8, 0, 1))
      const tw = 0.75 + 0.25 * vnoise1(t * 11 + i * 3.1) // ember twinkle
      eCol[i * 4] = (c[0] / 255) * tw
      eCol[i * 4 + 1] = (c[1] / 255) * tw
      eCol[i * 4 + 2] = (c[2] / 255) * tw
      eCol[i * 4 + 3] = e.alive ? (1 - k) * 0.9 : 0
    }
    eGeo.attributes.position.needsUpdate = true
    eGeo.attributes.color.needsUpdate = true
    void spellBoost
  }

  return { rigs, update }
}

// ===========================================================================
// 7. HIGHLAND painters — BIBLE §4 palette, silhouette-first
// ===========================================================================

// Mossy shelf turf: GROUND_MID #626e57 at the party line, GROUND_FG #4e5a42
// forward, dark moss pools, worn rock patches, blade stipple + pale tips.
function paintHighGround(g, S, seed) {
  const rnd = mulberry32(seed)
  const N = makeNoise2(seed + 11)
  const mid = rgb(0x566349)
  const fg = rgb(0x47523c)
  const moss = rgb(0x39452f)
  const rock = rgb(0x4e5a52)
  const tip = rgb(0x77775b) // GRASS_PALE
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
}

// Teal-grey highland stone for rock knuckles.
function paintHighRock(g, S, seed) {
  const rnd = mulberry32(seed)
  const N = makeNoise2(seed + 5)
  const base = rgb(0x435e57) // ROCK_THRU_FOG near end
  g.fillStyle = css(shade(base, 0.8))
  g.fillRect(0, 0, S, S)
  for (let i = 0; i < 700; i++) {
    const x = rnd() * S
    const y = rnd() * S
    const n = N.fbm(x / 34, y / 34, 4)
    g.globalAlpha = 0.16
    g.fillStyle = css(shade(base, 0.72 + (n * 0.5 + 0.5) * 0.65))
    g.fillRect(x, y, 2 + rnd() * 4, 2 + rnd() * 4)
    g.globalAlpha = 1
  }
  for (let i = 0; i < 5; i++) { // fracture seams
    g.globalAlpha = 0.3
    g.strokeStyle = css(shade(base, 0.5))
    g.lineWidth = 1.4
    g.beginPath()
    let x = rnd() * S
    let y = 0
    g.moveTo(x, y)
    while (y < S) { x += (rnd() - 0.5) * 26; y += 14 + rnd() * 22; g.lineTo(x, y) }
    g.stroke()
    g.globalAlpha = 1
  }
  // mossy top dusting
  for (let i = 0; i < 150; i++) {
    g.globalAlpha = 0.25
    g.fillStyle = css(rgb(0x4a5a40))
    g.fillRect(rnd() * S, rnd() * S * 0.4, 2 + rnd() * 5, 1.5 + rnd() * 2.5)
    g.globalAlpha = 1
  }
}

// Ragged conifer silhouette card — TREE_SILHOUETTE #0a2620, barely-lighter
// interior layering. Alpha-cut; the fog does the rest.
function paintPine(g, W, H, seed) {
  const rnd = mulberry32(seed)
  const dark = rgb(0x0a2620)
  const inner = rgb(0x123129)
  const cx = W / 2
  const tiers = 7 + ((rnd() * 3) | 0)
  const topY = H * 0.03
  const baseY = H * 0.97
  // trunk
  g.fillStyle = css(dark)
  g.fillRect(cx - W * 0.02, H * 0.55, W * 0.04, H * 0.45)
  for (let i = tiers - 1; i >= 0; i--) {
    const t = i / (tiers - 1) // 0 top → 1 bottom
    const y = topY + t * (baseY - topY) * 0.92
    const halfW = W * (0.06 + t * 0.42) * (0.88 + rnd() * 0.24)
    const tH = H * 0.16 * (0.7 + t * 0.5)
    const col = rnd() < 0.3 ? inner : dark
    g.fillStyle = css(col)
    // ragged frond: jagged polygon, droopy tips
    g.beginPath()
    g.moveTo(cx, y)
    const segs2 = 7
    for (let s2 = 0; s2 <= segs2; s2++) {
      const u = s2 / segs2
      const x = cx + halfW * u
      const yy = y + tH * (0.35 + u * 0.65) + (rnd() - 0.5) * tH * 0.3
      g.lineTo(x, yy)
    }
    g.lineTo(cx, y + tH * 1.15)
    for (let s2 = segs2; s2 >= 0; s2--) {
      const u = s2 / segs2
      const x = cx - halfW * u
      const yy = y + tH * (0.35 + u * 0.65) + (rnd() - 0.5) * tH * 0.3
      g.lineTo(x, yy)
    }
    g.closePath()
    g.fill()
  }
  // needle nibble — erode edges so the silhouette is never smooth
  g.globalCompositeOperation = 'destination-out'
  for (let i = 0; i < 90; i++) {
    const x = rnd() * W
    const y = rnd() * H
    g.beginPath()
    g.arc(x, y, rnd() * 2.2, 0, TAU)
    g.fill()
  }
  g.globalCompositeOperation = 'source-over'
}

// Skyline silhouette cards (far crag line / distant peak) — painted with
// their through-fog colour baked, alpha ragged tops.
function paintSkyline(g, W, H, seed, kind, col0) {
  const rnd = mulberry32(seed)
  const N = makeNoise2(seed)
  const col = rgb(col0)
  g.clearRect(0, 0, W, H)
  const pts = []
  const n = 56
  for (let i = 0; i <= n; i++) {
    const u = i / n
    let h
    if (kind === 'peak') {
      // one strong asymmetric peak left-of-centre + rolling shoulders
      const p1 = Math.exp(-Math.pow((u - 0.30) / 0.11, 2)) * 0.72
      const p2 = Math.exp(-Math.pow((u - 0.62) / 0.2, 2)) * 0.3
      h = 0.12 + p1 + p2 + N.fbm(u * 6, 0.5, 3) * 0.1
    } else {
      // blocky mesa/crag line, right-heavy (the ref's stacked buttresses)
      const step = Math.floor(u * 7) / 7
      h = 0.18 + step * 0.28 * (u > 0.55 ? 1.6 : 0.7) + N.fbm(u * 9, 3.5, 3) * 0.16
      if (u > 0.8) h += 0.22
    }
    pts.push([u * W, H - clamp(h, 0.05, 0.98) * H])
  }
  g.fillStyle = css(col)
  g.beginPath()
  g.moveTo(0, H)
  for (const [x, y] of pts) g.lineTo(x, y)
  g.lineTo(W, H)
  g.closePath()
  g.fill()
  // vertical crag striations
  for (let i = 0; i < 40; i++) {
    g.globalAlpha = 0.2
    g.fillStyle = css(shade(col, rnd() < 0.5 ? 0.8 : 1.18))
    const x = rnd() * W
    g.fillRect(x, H - rnd() * H * 0.5, 1.5 + rnd() * 3, H)
    g.globalAlpha = 1
  }
  // soft base fade so the card melts into the fog band
  g.globalCompositeOperation = 'destination-out'
  const grad = g.createLinearGradient(0, H * 0.72, 0, H)
  grad.addColorStop(0, 'rgba(0,0,0,0)')
  grad.addColorStop(1, 'rgba(0,0,0,0.9)')
  g.fillStyle = grad
  g.fillRect(0, H * 0.72, W, H * 0.28)
  g.globalCompositeOperation = 'source-over'
}

// The painted sky/fog backdrop — bright band, sage haze, dark teal top,
// pin-prick stars. Pre-fogged; the material ignores scene fog.
function paintBackdrop(g, W, H, seed) {
  const rnd = mulberry32(seed)
  const N = makeNoise2(seed + 2)
  // vertical ramp: v=0 top → v=1 bottom (canvas y down)
  const stops = [
    [0.0, rgb(0x06211f)], // TOP_CORNER-class near-black teal
    [0.16, rgb(0x2a4a47)],
    [0.34, rgb(0x617c7b)], // SKY_GLOW
    [0.52, rgb(0x969d95)], // FOG_MID
    [0.62, rgb(0x9fa194)], // FOG_BRIGHT band
    [0.74, rgb(0x8e948b)],
    [1.0, rgb(0x7b8b83)], // FOG_FAR at the base
  ]
  const grad = g.createLinearGradient(0, 0, 0, H)
  for (const [p, c] of stops) grad.addColorStop(p, css(c))
  g.fillStyle = grad
  g.fillRect(0, 0, W, H)
  // large soft luminance wisps riding the band
  for (let i = 0; i < 26; i++) {
    const y = H * (0.42 + rnd() * 0.34)
    const x = rnd() * W
    const w = W * (0.1 + rnd() * 0.22)
    const h = H * (0.02 + rnd() * 0.05)
    const gr = g.createRadialGradient(x, y, 0, x, y, w)
    const bright = rnd() < 0.6
    gr.addColorStop(0, bright ? 'rgba(214,216,202,0.13)' : 'rgba(28,52,48,0.12)')
    gr.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = gr
    g.save()
    g.translate(x, y)
    g.scale(1, h / w)
    g.beginPath()
    g.arc(0, 0, w, 0, TAU)
    g.fill()
    g.restore()
  }
  // darker upper drapes (the ref's heavy top-left cloud masses)
  for (let i = 0; i < 8; i++) {
    const x = rnd() * W
    const y = H * (0.02 + rnd() * 0.2)
    const w = W * (0.16 + rnd() * 0.3)
    const gr = g.createRadialGradient(x, y, 0, x, y, w)
    gr.addColorStop(0, 'rgba(6,26,24,0.35)')
    gr.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = gr
    g.save()
    g.translate(x, y)
    g.scale(1, 0.4)
    g.beginPath()
    g.arc(0, 0, w, 0, TAU)
    g.fill()
    g.restore()
  }
  // faint noise grain so the gradient never bands
  for (let i = 0; i < 2400; i++) {
    const x = rnd() * W
    const y = rnd() * H
    const n = N.fbm(x / 60, y / 60, 3)
    g.globalAlpha = 0.05
    g.fillStyle = n > 0 ? '#ffffff' : '#001410'
    g.fillRect(x, y, 2, 2)
    g.globalAlpha = 1
  }
  // stars — upper half only, pin-prick, a few brighter (ref top-right)
  for (let i = 0; i < 44; i++) {
    const x = rnd() * W
    const y = rnd() * H * 0.34
    const big = rnd() < 0.2
    g.globalAlpha = 0.25 + rnd() * (big ? 0.5 : 0.3)
    g.fillStyle = '#d8e4da'
    g.fillRect(x, y, big ? 2 : 1.4, big ? 2 : 1.4)
    g.globalAlpha = 1
  }
}

// Foreground grass-blade clump silhouette (bottom-left corner dressing).
function paintBlades(g, W, H, seed, dark) {
  const rnd = mulberry32(seed)
  const col = rgb(dark ? 0x14251c : 0x4c5840)
  const tip = rgb(dark ? 0x2c3d2c : 0x77775b)
  for (let i = 0; i < 26; i++) {
    const x = W * (0.1 + rnd() * 0.8)
    const lean = (rnd() - 0.5) * 0.9
    const h = H * (0.5 + rnd() * 0.48)
    const w = 1.5 + rnd() * 2.5
    g.strokeStyle = css(rnd() < 0.25 ? tip : col)
    g.lineWidth = w
    g.beginPath()
    g.moveTo(x, H)
    g.quadraticCurveTo(x + lean * h * 0.3, H - h * 0.6, x + lean * h, H - h)
    g.stroke()
  }
}

// ===========================================================================
// 8. HIGHLAND build — frame05's misty shelf (§4)
// ===========================================================================

function buildHighland(env) {
  const { group, aniso, rnd } = env
  const CAM = new THREE.Vector3(0, 7, 14) // fixed proscenium seat (§1)

  // ---- groundY: shelf flat to z −5, then a 2° rise upstage, tiny undulation
  const TAN2 = 0.0349
  function groundY(x, z) {
    let y = z < -5 ? (-5 - z) * TAN2 : 0
    // continuous, gentle undulation — feet and contact blobs plant on this
    y += 0.035 * Math.sin(x * 0.53 + 1.7) * Math.sin(z * 0.41 - 0.6)
    return y
  }

  // ---- materials ----------------------------------------------------------
  // Teal-green emissive floor (§11.6: highland darks are #022123-class).
  const tGround = canvasTex(1024, 1024, aniso, (g, S) => paintHighGround(g, S, 121))
  const tRock = canvasTex(256, 256, aniso, (g, S) => paintHighRock(g, S, 232))
  const MAT = {
    ground: new THREE.MeshStandardMaterial({ map: tGround, roughness: 1, metalness: 0, emissive: 0x08201c, emissiveIntensity: 0.9 }),
    rock: new THREE.MeshStandardMaterial({ map: tRock, roughness: 1, metalness: 0, emissive: 0x08201c, emissiveIntensity: 0.9 }),
    crag: new THREE.MeshStandardMaterial({ map: tRock, color: 0x9aa8a2, roughness: 1, metalness: 0, emissive: 0x071b18, emissiveIntensity: 1.0 }),
  }
  const B = { ground: [], rock: [], crag: [] }

  // ---- the shelf: displaced plane ending at the cliff lip (z −14) ---------
  {
    const W = 48
    const D = 21
    const geo = new THREE.PlaneGeometry(W, D, 96, 44)
    geo.rotateX(-HPI) // now on XZ, z spans −D/2…+D/2
    geo.translate(0, 0, -14 + D / 2 + 0.0) // z −14 … +7
    const pos = geo.attributes.position
    const uv = geo.attributes.uv
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      let y = groundY(x, z)
      // shelf edge dips at the very lip so the rim rocks read as a brink
      if (z < -13.2) y -= (z + 13.2) * (z + 13.2) * 0.55
      pos.setY(i, y)
      uv.setXY(i, x / 11, z / 11)
    }
    geo.computeVertexNormals()
    addG(B.ground, geo)
  }

  // ---- rock knuckles ------------------------------------------------------
  // Midground band behind the duel line (ref 0.42–0.60 fw cluster).
  const knuckles = [
    [-0.8, -10.6, 1.5, 0.9, 1.2], [0.9, -11.4, 2.1, 1.3, 1.5], [2.6, -12.1, 1.2, 0.7, 1.0],
    [-2.6, -11.8, 1.7, 1.0, 1.3], [4.6, -12.6, 1.6, 0.9, 1.2], [-5.2, -12.3, 2.2, 1.4, 1.6],
  ]
  let rs = 40
  for (const [x, z, sx, sy, sz] of knuckles) {
    addG(B.rock, gRock(rs++, sx, sy, sz, x, groundY(x, z), z, { ry: rnd() * TAU }))
  }
  // ragged lip row along the brink
  for (let i = 0; i < 12; i++) {
    const x = -13 + i * 2.3 + (rnd() - 0.5) * 1.2
    const z = -13.3 - rnd() * 0.9
    const s = 0.5 + rnd() * 1.1
    addG(B.rock, gRock(rs++, s, s * (0.5 + rnd() * 0.5), s, x, groundY(x, Math.max(z, -13.2)), z, { ry: rnd() * TAU }))
  }
  // foreground-left scatter
  for (const [x, z, s] of [[-6.8, -2.2, 0.9], [-7.9, -4.8, 1.3], [-5.6, -0.6, 0.6], [7.6, -2.4, 0.7]]) {
    addG(B.rock, gRock(rs++, s, s * 0.7, s, x, groundY(x, z), z, { ry: rnd() * TAU }))
  }
  // the upper-right crag buttress — stacked blocks descending toward centre
  const stack = [
    [9.2, -14.5, 3.2, 2.6, 2.8, 0], [10.6, -15.8, 3.6, 4.4, 3.0, 0.2],
    [12.2, -16.8, 3.4, 6.4, 3.2, -0.15], [8.4, -15.6, 2.2, 1.7, 2.0, 0.4],
    [11.4, -14.9, 2.6, 3.4, 2.4, -0.3],
  ]
  for (const [x, z, sx, sy, sz, ry] of stack) {
    addG(B.crag, gRock(rs++, sx, sy, sz, x, -0.6, z, { ry }))
  }
  // one lone far crag rising left of the buttress gap
  addG(B.crag, gRock(rs++, 2.8, 3.4, 2.6, -8.8, -0.8, -16.5, { ry: 0.7 }))

  mergeBuckets(group, B, MAT, { noCast: ['ground', 'crag'] })

  // ---- conifer silhouette cards, stage-left (ref: only the left flank) ----
  const trees = []
  const treeSpecs = [
    // x, z, h — near giants exit the frame top; far pair reads through fog
    [-8.6, 1.2, 10.5], [-10.8, -1.8, 11.5], [-8.2, -4.6, 9.0],
    [-11.6, -7.5, 8.0], [-7.3, -9.8, 5.6], [-9.8, -11.5, 6.4],
  ]
  let ti = 0
  for (const [x, z, h] of treeSpecs) {
    const tex = canvasTex(160, 384, aniso, (g, w, hh) => paintPine(g, w, hh, 500 + ti * 17), { clamp: true, smooth: true })
    const w = h * 0.46
    const mat = new THREE.MeshStandardMaterial({
      map: tex, alphaTest: 0.42, roughness: 1, metalness: 0,
      emissive: 0x061a16, emissiveIntensity: 0.8, side: THREE.DoubleSide,
    })
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
    const gy = groundY(x, z)
    m.position.set(x, gy + h / 2 - 0.15, z) // base sunk into contact
    m.rotation.y = Math.atan2(CAM.x - x, CAM.z - z)
    m.castShadow = false
    m.receiveShadow = false
    group.add(m)
    trees.push({ m, phase: rnd() * TAU, baseRot: m.rotation.y })
    ti++
  }

  // ---- skyline cards + painted backdrop -----------------------------------
  {
    // mid crag line (z −22) and far peak line (z −32) — genuine parallax slabs
    const mkCard = (w, h, y, z, kind, col, seed) => {
      const tex = canvasTex(1024, 256, aniso, (g, ww, hh) => paintSkyline(g, ww, hh, seed, kind, col), { clamp: true, smooth: true })
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, fog: false })
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
      m.position.set(0, y, z)
      m.renderOrder = 2
      group.add(m)
      return m
    }
    // colours are pre-fogged (§4 ROCK_THRU_FOG far end → fog colour)
    mkCard(34, 7.5, 2.6, -22, 'crag', 0x35504a, 801)
    mkCard(44, 9.0, 3.4, -32, 'peak', 0x5f7570, 802)
    const bTex = canvasTex(1024, 512, aniso, (g, w, h) => paintBackdrop(g, w, h, 900), { clamp: true, smooth: true })
    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(58, 36),
      new THREE.MeshBasicMaterial({ map: bTex, fog: false, depthWrite: false })
    )
    back.position.set(0, 1.5, -42)
    back.renderOrder = 1
    group.add(back)
  }

  // ---- backlight glow disc behind the boss (§4: (−2.5, 3.5, −9.5) r 6) ----
  const glowDisc = new THREE.Mesh(
    new THREE.PlaneGeometry(12, 12),
    new THREE.MeshBasicMaterial({
      map: radialTex(256, [[0, 0.5], [0.4, 0.26], [1, 0]]), color: 0xb1c0b4,
      transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false,
    })
  )
  glowDisc.position.set(-2.5, 3.5, -9.5)
  glowDisc.renderOrder = 3
  group.add(glowDisc)

  // ---- three drifting fog cards (§4: z −4/−9/−14, α .22/.35/.50) ----------
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
    const w = 2.3 + rnd() * 2.0
    const h = 0.9 + rnd() * 0.55
    const mat = new THREE.MeshBasicMaterial({
      map: i % 2 ? mistTexA : mistTexB, color: 0xa8b2a6, transparent: true,
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

  // ---- foreground blade clumps, bottom-left corner silhouettes ------------
  for (let i = 0; i < 7; i++) {
    const dark = i < 5
    const tex = canvasTex(128, 128, aniso, (g, w, h) => paintBlades(g, w, h, 700 + i * 9, dark), { clamp: true, smooth: true })
    const w = dark ? 1.6 + rnd() * 1.2 : 0.7 + rnd() * 0.4
    const h = w * (0.75 + rnd() * 0.3)
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, fog: !dark })
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
    const x = dark ? -7.2 + rnd() * 3.2 : -2 + rnd() * 9
    const z = dark ? 1.2 + rnd() * 1.6 : -2.5 - rnd() * 7
    m.position.set(x, groundY(x, z) + h * 0.48, z)
    m.rotation.y = Math.atan2(CAM.x - x, CAM.z - z)
    m.renderOrder = dark ? 16 : 0
    group.add(m)
    trees.push({ m, phase: rnd() * TAU, baseRot: m.rotation.y, tuft: true })
  }

  return {
    groundY,
    torches: [], // no fire in the highland — rim comes from the key (§5.1)
    safeStage: { x0: -5.5, x1: 7.5, z0: -12.0, z1: -1.0 },
    fogCards, mists, motes, mSeed, mPos, mGeo, glowDisc, trees,
  }
}

// ===========================================================================
// 9. createArena — the one export (BATTLE_CONTRACT)
// ===========================================================================

const _vA = new THREE.Vector3()
const _vB = new THREE.Vector3()

export function createArena({ renderer, scene, variant = 'hall' } = {}) {
  const group = new THREE.Group()
  group.name = 'battleArena_' + variant
  const aniso = renderer && renderer.capabilities ? renderer.capabilities.getMaxAnisotropy() : 4
  const rnd = mulberry32(variant === 'hall' ? 0xa17e04 : 0xa17e05)
  const env = { group, aniso, rnd }

  const spellGroup = new THREE.Group()
  spellGroup.name = 'arenaSpellLights'
  group.add(spellGroup)

  let built
  let fire = null
  let doorGlow = null
  let coalsMat = null
  const rim = { dir: [0, -1], color: '#cfd6cb', strength: 0.7, sources: [] }

  if (variant === 'hall') {
    // ---- scene atmosphere (§3): the hall drowns, it doesn't haze ----------
    if (scene) {
      scene.fog = new THREE.FogExp2(0x0a1018, 0.012)
      scene.background = new THREE.Color(0x070e18) // blue-black, never #000
    }
    built = buildHall(env)
    fire = buildFireRig(env, built.torches)

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

    // door glow centred (0.534, 0.20) screen → the lintel wash at z −12 (§3)
    doorGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 2.4),
      new THREE.MeshBasicMaterial({
        map: radialTex(128, [[0, 0.5], [0.4, 0.24], [1, 0]]), color: 0xe99648,
        transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending,
        depthWrite: false, fog: false,
      })
    )
    doorGlow.position.set(0.5, 4.55, -11.85)
    doorGlow.renderOrder = 6
    group.add(doorGlow)

    const cm = group.getObjectByName('arena_coals')
    coalsMat = cm ? cm.material : null

    // rim law (§5.1): #ffb47a at 0.55 from the nearest warm source; boot dir
    // points at torch R from the party block (updated per frame with camera).
    rim.dir = [0.19, -0.98]
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
    // key — #c9d2c4, 0.9 (§4). Soft shadow map so the rocks seat visually.
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
    const spells = collectSpellLights()

    // publish live rim sources: torches (or key) + any active spell lights
    rim.sources.length = built.torches.length ? built.torches.length : 1
    for (const L of spells) {
      rim.sources.push({ x: L.position.x, y: L.position.y, z: L.position.z, kind: 'spell', intensity: L.intensity })
    }

    if (variant === 'hall') {
      fire.update(t, dt, camera, spells)
      if (doorGlow) doorGlow.material.opacity = 0.2 + 0.045 * vnoise1(t * 4.3 + 2.2)
      if (coalsMat) coalsMat.emissiveIntensity = 1.45 + 0.35 * vnoise1(t * 8.2)

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
        F.m.position.x = Math.sin(t * w + F.phase) * amp * 0.32
        F.m.material.map.offset.x = t * F.base.speed * 0.011 + F.phase
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
      built.glowDisc.material.opacity = 0.35 + 0.025 * Math.sin(t * 0.21)
      // near-imperceptible tree/tuft sway keeps the flank alive
      for (const T of built.trees) {
        T.m.rotation.z = (T.tuft ? 0.016 : 0.005) * Math.sin(t * (T.tuft ? 0.9 : 0.5) + T.phase)
      }
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




