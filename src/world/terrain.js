// ---------------------------------------------------------------------------
// src/world/terrain.js — Aetherbound overworld terrain
//
// The stage of the frame01 diorama: a late-morning coastal grassland shelf
// above a western ocean, a banded limestone massif with a 9 m waterfall,
// terraced northern plateaus, a castle plateau at the right third, ochre
// roads, wheat paddocks and a river that runs from the highland to the sea.
//
// The heightfield is AUTHORED, not raw fBm: distance-field landforms,
// terraced cliff bands, spline-carved river/inlet, graded road corridors,
// with noise only as surface detail. All queries (height / normal / slope /
// biome / isWater / onRoad / waterHeight) read precomputed grids and are
// allocation-free; height() reproduces the rendered triangulation exactly,
// so anything snapped to it sits on the visible surface.
//
// Contract: export function createTerrain({ size, seed, renderer }) : Terrain
// ---------------------------------------------------------------------------

import * as THREE from 'three'

// ===========================================================================
// 1. Deterministic RNG + value noise
// ===========================================================================

function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Shared permutation table, rebuilt per createTerrain() from the seed.
const PERM = new Uint8Array(512)
const GRAD = new Float32Array(256)

function seedNoise(seed) {
  const rnd = mulberry32(seed >>> 0)
  const p = new Uint8Array(256)
  for (let i = 0; i < 256; i++) p[i] = i
  for (let i = 255; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0
    const t = p[i]
    p[i] = p[j]
    p[j] = t
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255]
  for (let i = 0; i < 256; i++) GRAD[i] = rnd() * 2 - 1
}

function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

// 2D value noise in [-1, 1]
function vnoise(x, y) {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const X = xi & 255
  const Y = yi & 255
  const a = GRAD[PERM[X + PERM[Y]]]
  const b = GRAD[PERM[X + 1 + PERM[Y]]]
  const c = GRAD[PERM[X + PERM[Y + 1]]]
  const d = GRAD[PERM[X + 1 + PERM[Y + 1]]]
  const u = fade(xf)
  const v = fade(yf)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

// fBm, o octaves, in [-1, 1]-ish
function fbm(x, y, o, lac, gain) {
  let amp = 1
  let sum = 0
  let norm = 0
  for (let i = 0; i < o; i++) {
    sum += vnoise(x, y) * amp
    norm += amp
    amp *= gain
    x = x * lac + 13.7
    y = y * lac + 7.9
  }
  return sum / norm
}

// Ridged noise in [0, 1] — sharp crests for the far NE ridge
function ridged(x, y, o) {
  let amp = 0.55
  let sum = 0
  let norm = 0
  for (let i = 0; i < o; i++) {
    const n = 1 - Math.abs(vnoise(x, y))
    sum += n * n * amp
    norm += amp
    amp *= 0.55
    x = x * 2.08 + 31.4
    y = y * 2.08 + 17.2
  }
  return sum / norm
}

// Cheap deterministic hash for per-item jitter
function hash2(x, y) {
  let h = (Math.imul(x * 374761393 + y * 668265263, 1274126177) >>> 0)
  h = (h ^ (h >>> 13)) >>> 0
  return (Math.imul(h, 1597334677) >>> 0) / 4294967296
}

// ===========================================================================
// 2. Scalar helpers
// ===========================================================================

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const lerp = (a, b, t) => a + (b - a) * t

function sstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

// Polynomial smooth-max: crisp landform unions without creases
function smax(a, b, k) {
  const h = clamp01(0.5 + (0.5 * (b - a)) / k)
  return lerp(a, b, h) + k * h * (1 - h)
}

// Terrace shaping of the fractional step: flat-ish top (14 % tilt) then a
// steep escarpment face over the last 45 % of the step. C0 across steps.
function terraceFrac(fr) {
  const s = sstep(0.55, 1.0, fr)
  const face = s * s * (1.55 - 0.55 * s) // slightly eased-in cliff face
  return 0.14 * fr + 0.86 * face
}

// Rounded-box SDF in 2D (rotated), negative inside
function sdRoundBox(px, pz, cx, cz, hx, hz, rot, round) {
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  const dx0 = px - cx
  const dz0 = pz - cz
  const dx = Math.abs(dx0 * c + dz0 * s) - (hx - round)
  const dz = Math.abs(-dx0 * s + dz0 * c) - (hz - round)
  const ax = Math.max(dx, 0)
  const az = Math.max(dz, 0)
  return Math.sqrt(ax * ax + az * az) + Math.min(Math.max(dx, dz), 0) - round
}

// Rotated-ellipse "radius fraction": <1 inside, 1 on rim
function ellipseR(px, pz, cx, cz, rx, rz, rot) {
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  const dx0 = px - cx
  const dz0 = pz - cz
  const u = (dx0 * c + dz0 * s) / rx
  const v = (-dx0 * s + dz0 * c) / rz
  return Math.sqrt(u * u + v * v)
}

// ===========================================================================
// 3. Palette (ART_BIBLE §3, authored sRGB)
// ===========================================================================

const PAL = {
  GRASS_HI: 0x7fa63b,
  GRASS_LIT: 0x62902e,
  GRASS_MID: 0x4a7429,
  GRASS_SHADOW: 0x2f5426,
  GRASS_DEEP: 0x1d3a1e,
  CLIFF_LIT: 0xb7c2a8,
  CLIFF_MID: 0x8a9880,
  CLIFF_SHADOW: 0x5d7161,
  CLIFF_CREVICE: 0x37473f,
  ROAD_LIT: 0xc39a5c,
  ROAD_MID: 0xa57a45,
  ROAD_SHADOW: 0x6f5638,
  WHEAT_TIPS: 0xeed794,
  WHEAT_LIT: 0xe0c26e,
  WHEAT_SHADOW: 0xb3913f,
  SNOW_LIT: 0xeef2f0,
  SNOW_SHADOW: 0xc2ced2,
  SAND_LIT: 0xcfc09a,
  SAND_MID: 0xb3a37e,
}

function hexRGB(hex) {
  return [((hex >> 16) & 255), ((hex >> 8) & 255), (hex & 255)]
}

// ===========================================================================
// 4. Splines — Catmull-Rom resampling that carries arbitrary extra fields
// ===========================================================================

// pts: [{ x, z, ...extras }] — returns evenly (~spacing m) resampled points
// with extras linearly interpolated and cumulative arc length `s` attached.
function resampleSpline(pts, spacing, extraKeys = []) {
  if (pts.length < 2) return pts.slice()
  const P = (i) => pts[clamp(i, 0, pts.length - 1)]
  const out = []
  const tmp = {}
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = P(i - 1)
    const p1 = P(i)
    const p2 = P(i + 1)
    const p3 = P(i + 2)
    const segLen = Math.hypot(p2.x - p1.x, p2.z - p1.z)
    const steps = Math.max(2, Math.ceil(segLen / spacing))
    for (let j = 0; j < steps; j++) {
      const t = j / steps
      const t2 = t * t
      const t3 = t2 * t
      // uniform Catmull-Rom
      const cx =
        0.5 *
        (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3)
      const cz =
        0.5 *
        (2 * p1.z + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3)
      const o = { x: cx, z: cz }
      for (const k of extraKeys) {
        const a = p1[k] !== undefined ? p1[k] : 0
        const b = p2[k] !== undefined ? p2[k] : a
        o[k] = lerp(a, b, t)
      }
      out.push(o)
    }
  }
  const last = pts[pts.length - 1]
  const o = { x: last.x, z: last.z }
  for (const k of extraKeys) o[k] = last[k] !== undefined ? last[k] : 0
  out.push(o)
  let s = 0
  out[0].s = 0
  for (let i = 1; i < out.length; i++) {
    s += Math.hypot(out[i].x - out[i - 1].x, out[i].z - out[i - 1].z)
    out[i].s = s
  }
  return out
}

// ===========================================================================
// 5. AUTHORED LAYOUT — the frame01 world, in metres (ART_BIBLE §1 table)
// ===========================================================================

const SEA_LEVEL = 0

// --- Coastline: mean x −82 (meander ±10) for z ≥ −45, veering west to
// --- x ≈ −128 north of z −60. Land is d = x − coastX(z) > 0.
function coastX(z) {
  const south = -82 + 6.5 * Math.sin(z * 0.021 + 1.3) + 3.0 * Math.sin(z * 0.049 + 4.1)
  const north = -128 + 5.0 * Math.sin(z * 0.026 + 0.7)
  const t = sstep(0, 1, clamp01((-46 - z) / 24)) // veer complete by z −70
  return lerp(south, north, t)
}

// --- River. One downstream polyline, headwater → sea exit, with per-point
// --- half-usable data: w = full width (m), lv = water surface level (m).
// --- The waterfall is the segment between WFALL_LIP_I and WFALL_BASE_I.
const RIVER_PTS = [
  { x: -37, z: -252, w: 3.0, lv: 30.6 }, // fog-washed headwater at map edge
  { x: -33, z: -216, w: 3.0, lv: 29.4 },
  { x: -36, z: -182, w: 3.2, lv: 28.2 },
  { x: -34, z: -152, w: 3.2, lv: 27.0 }, // north highland
  { x: -31, z: -132, w: 3.4, lv: 26.0 },
  { x: -30, z: -118, w: 3.6, lv: 25.0 }, // under the log bridge (deck +26)
  { x: -29, z: -102, w: 3.8, lv: 24.2 },
  { x: -28.5, z: -86, w: 4.0, lv: 23.4 },
  { x: -27, z: -70, w: 4.0, lv: 22.6 },
  { x: -26.5, z: -56, w: 4.2, lv: 21.6 }, // enters the massif top
  { x: -26.2, z: -47, w: 4.2, lv: 20.8 },
  { x: -26.5, z: -40, w: 4.4, lv: 20.2 }, // WATERFALL LIP (massif SW face)
  { x: -29.5, z: -35.5, w: 5.0, lv: 11.0 }, // WATERFALL BASE → plunge pool
  { x: -30.5, z: -34, w: 9.0, lv: 11.0 }, // pool centre (−31, −33)-ish
  { x: -26, z: -31, w: 6.5, lv: 10.6 },
  { x: -18, z: -28.5, w: 5.0, lv: 9.9 },
  { x: -8, z: -26, w: 5.0, lv: 9.2 }, // bible waypoint
  { x: 3, z: -23.5, w: 5.2, lv: 8.6 },
  { x: 14, z: -20, w: 5.4, lv: 8.1 }, // bible waypoint
  { x: 27, z: -13, w: 5.4, lv: 7.4 },
  { x: 38, z: -3, w: 5.6, lv: 6.9 },
  { x: 48, z: 4, w: 5.8, lv: 6.4 },
  { x: 60, z: 10, w: 6.0, lv: 6.0 }, // bible: exits SE at (+60, +10)
  { x: 84, z: 20, w: 6.5, lv: 5.4 },
  { x: 112, z: 33, w: 7.0, lv: 4.8 },
  { x: 148, z: 49, w: 7.5, lv: 4.2 },
  { x: 194, z: 62, w: 8.0, lv: 3.6 },
  { x: 244, z: 72, w: 8.5, lv: 3.1 }, // fades off the SE map edge
]
const WFALL_LIP = { x: -26.5, z: -40, y: 20.2 }
const WFALL_BASE = { x: -29.5, z: -35.5, y: 11.0 }

// --- Sea inlet gorge under the west trestle bridge (−84, −66), 12 m span.
const INLET_PTS = [
  { x: -126, z: -62, w: 26 },
  { x: -110, z: -64, w: 18 },
  { x: -97, z: -65.5, w: 13 },
  { x: -87, z: -66.2, w: 10.5 },
  { x: -80, z: -66.6, w: 8.0 },
  { x: -76.5, z: -66.8, w: 5.5 }, // inlet head, east tip
]

// --- Roads: waypoints hand-laid along contours (grading pass refines Y).
// --- Width 2.6 core + 1.2 feather each side (§5).
const ROAD_DEFS = [
  {
    name: 'south', // map entry → past the farm → the hero → the fork
    pts: [
      { x: -22, z: 132 }, { x: -24, z: 120 }, { x: -27, z: 104 }, { x: -30, z: 88 },
      { x: -31, z: 72 }, { x: -33, z: 58 }, { x: -36, z: 42 }, { x: -37.5, z: 28 },
      { x: -38, z: 18 } /* hero anchor */, { x: -39.5, z: 10 }, { x: -44, z: 2 },
    ],
  },
  {
    name: 'camp_spur', // east off the south road to the roadside camp
    pts: [
      { x: -30, z: 88 }, { x: -20, z: 92 }, { x: -8, z: 93 }, { x: 2, z: 90 }, { x: 8, z: 88 },
    ],
  },
  {
    name: 'castle', // fork → SW ramp switchback → castle gate (gate faces SW)
    pts: [
      { x: -44, z: 2 }, { x: -37, z: 6.5 }, { x: -31.5, z: 11.5 }, { x: -27.5, z: 15 },
      { x: -24.5, z: 13.8 }, { x: -23.2, z: 11 }, { x: -23.5, z: 8 }, { x: -22, z: 5.5 },
    ],
  },
  {
    name: 'west', // fork → coastal rise → trestle bridge south abutment
    pts: [
      { x: -44, z: 2 }, { x: -50, z: -4 }, { x: -56, z: -12 }, { x: -61, z: -22 },
      { x: -64, z: -32 }, { x: -69, z: -40 }, { x: -75, z: -47 }, { x: -80, z: -54 },
      { x: -83, z: -59.5 },
    ],
  },
  {
    name: 'west_north', // trestle north abutment → up the coast → village
    pts: [
      { x: -85, z: -73 }, { x: -84, z: -82 }, { x: -80, z: -94 }, { x: -76, z: -106 },
      { x: -73, z: -116 }, { x: -70.5, z: -123 },
    ],
  },
  {
    name: 'north', // fork → massif west flank switchbacks → village
    pts: [
      { x: -44, z: 2 }, { x: -46, z: -8 }, { x: -47.5, z: -18 }, { x: -50, z: -30 },
      { x: -49, z: -42 }, { x: -45.5, z: -50 }, { x: -50, z: -58 }, { x: -55, z: -66 },
      { x: -54, z: -76 }, { x: -56, z: -88 }, { x: -59, z: -100 }, { x: -63, z: -112 },
      { x: -67, z: -121 }, { x: -70, z: -126 },
    ],
  },
  {
    name: 'shrine', // village road → log bridge over the gorge → shrine
    pts: [
      { x: -59, z: -100 }, { x: -50, z: -106 }, { x: -42, z: -112 }, { x: -35, z: -117 },
      { x: -30, z: -118.5 }, { x: -24, z: -118 }, { x: -15, z: -112 }, { x: -5, z: -104 },
      { x: 5, z: -96 }, { x: 15, z: -88 }, { x: 24, z: -80 }, { x: 32, z: -72 },
      { x: 38, z: -64 },
    ],
  },
]

// --- Wheat paddocks: rounded-organic patches (centre, rx, rz, rot)
const PADDOCKS = [
  { x: -34, z: 14, rx: 6.0, rz: 3.6, rot: 0.30 }, // hero's east shoulder
  { x: -42, z: 26, rx: 8.0, rz: 4.6, rot: -0.18 },
  { x: -30, z: 30, rx: 6.6, rz: 4.0, rot: 0.42 },
  { x: -20, z: 52, rx: 8.2, rz: 4.6, rot: 0.12 }, // south foreground pair
  { x: 1, z: 36, rx: 9.0, rz: 5.0, rot: -0.30 },
]

// --- Flat pads: castle / village / shrine / camp (+ the farm terrace)
const PADS = [
  { x: -20, z: 4, r: 19, h: 14.0, kind: 'castle' }, // plateau surface (smax'd)
  { x: -70, z: -128, r: 15, h: 24.0, kind: 'village' },
  { x: 38, z: -64, r: 9, h: 18.0, kind: 'shrine' },
  { x: 8, z: 88, r: 7, h: 8.0, kind: 'camp' },
  { x: -36, z: 22, r: 15, h: 10.0, kind: 'farm' },
  // bridge abutments — decks must meet solid ground at both ends
  { x: -84, z: -59.8, r: 5.5, h: 18.0, kind: 'abutment' }, // trestle south
  { x: -85, z: -73.2, r: 5.5, h: 18.0, kind: 'abutment' }, // trestle north
  { x: -34.5, z: -117.8, r: 4.5, h: 26.0, kind: 'abutment' }, // log west
  { x: -25.5, z: -118.2, r: 4.5, h: 26.0, kind: 'abutment' }, // log east
]

// --- Forest stands (authored clump anchors): centre, radius, strength
const STANDS = [
  { x: -54, z: 42, r: 17, s: 1.0 }, // west of the south road
  { x: -22, z: 70, r: 13, s: 0.9 },
  { x: -70, z: 6, r: 11, s: 0.9 }, // coastal lip groves
  { x: -64, z: -28, r: 12, s: 0.85 },
  { x: -18, z: -36, r: 16, s: 1.0 }, // massif top pines
  { x: -8, z: -44, r: 13, s: 0.95 },
  { x: 20, z: -34, r: 14, s: 0.9 }, // east river bank
  { x: 2, z: 16, r: 9, s: 0.7 }, // castle east flank
  { x: -46, z: -84, r: 18, s: 0.9 }, // north plateau woods
  { x: -14, z: -84, r: 16, s: 0.85 },
  { x: 16, z: -110, r: 20, s: 0.9 },
  { x: -88, z: -104, r: 14, s: 0.8 },
  { x: 60, z: -60, r: 16, s: 0.8 },
  { x: 96, z: -34, r: 18, s: 0.8 }, // east highland fringe
  { x: 60, z: 46, r: 14, s: 0.75 }, // south-east lowland copses
  { x: 30, z: 78, r: 12, s: 0.7 },
  { x: -36, z: 60, r: 9, s: 0.65 }, // roadside grove, south approach
  { x: 148, z: -104, r: 30, s: 1.0 }, // NE ridge forest
  { x: 180, z: -140, r: 34, s: 1.0 },
  // the top-of-frame band: frame01's upstage is heavily wooded under fog
  { x: -30, z: -160, r: 22, s: 0.9 },
  { x: 10, z: -150, r: 18, s: 0.85 },
  { x: -60, z: -172, r: 20, s: 0.9 },
  { x: 42, z: -172, r: 22, s: 0.9 },
  { x: 92, z: -152, r: 20, s: 0.85 },
  { x: -10, z: -202, r: 24, s: 0.95 },
  { x: 62, z: -212, r: 24, s: 0.9 },
  { x: -92, z: -202, r: 18, s: 0.85 },
  { x: 132, z: -192, r: 26, s: 0.95 },
  { x: -130, z: -160, r: 16, s: 0.8 },
  // far south-east so free-orbit never shows bare plains
  { x: 150, z: 120, r: 20, s: 0.75 },
  { x: 90, z: 180, r: 18, s: 0.7 },
  { x: 205, z: 60, r: 16, s: 0.7 },
]

// POI table (y snapped to pads at build time)
const POI_DEFS = [
  { name: 'Grandpine Castle', x: -20, z: 4, kind: 'castle' },
  { name: 'Ferren Hamlet', x: -70, z: -128, kind: 'village' },
  { name: 'Windward Shrine', x: 38, z: -64, kind: 'shrine' },
  { name: 'Trestle Crossing', x: -84, z: -66.3, kind: 'bridge' },
  { name: 'North Gorge Bridge', x: -30, z: -118.4, kind: 'bridge' },
  { name: 'Paddock Farm', x: -36, z: 22, kind: 'farm' },
  { name: 'Roadside Camp', x: 8, z: 88, kind: 'camp' },
]

// ===========================================================================
// 6. Field grids (0.5 m/texel) — river / inlet / road data rasterized once
// ===========================================================================

const FRES = 1024 // field resolution over the whole map

function makeFieldSet(size) {
  const n = FRES * FRES
  return {
    size,
    half: size / 2,
    scale: (FRES - 1) / size,
    riverDist: new Float32Array(n).fill(1e9),
    riverLevel: new Float32Array(n),
    riverHalfW: new Float32Array(n).fill(1),
    inletDist: new Float32Array(n).fill(1e9),
    inletHalfW: new Float32Array(n).fill(1),
    roadMask: new Float32Array(n),
    roadHSum: new Float32Array(n),
    roadWSum: new Float32Array(n),
    roadH: new Float32Array(n),
  }
}

// Bilinear sample of one Float32 field at world (x, z). Allocation-free.
function sampleField(fs, arr, x, z) {
  let gx = (x + fs.half) * fs.scale
  let gz = (z + fs.half) * fs.scale
  gx = gx < 0 ? 0 : gx > FRES - 1.001 ? FRES - 1.001 : gx
  gz = gz < 0 ? 0 : gz > FRES - 1.001 ? FRES - 1.001 : gz
  const ix = gx | 0
  const iz = gz | 0
  const fx = gx - ix
  const fz = gz - iz
  const i0 = iz * FRES + ix
  const a = arr[i0]
  const b = arr[i0 + 1]
  const c = arr[i0 + FRES]
  const d = arr[i0 + FRES + 1]
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz
}

// March a resampled polyline, splatting per-texel min distance (+ carried
// data) into fields inside a radius window around every segment.
function splatPolyline(fs, pts, radiusOf, write) {
  const inv = 1 / fs.scale
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const R = Math.max(radiusOf(a), radiusOf(b))
    const minX = Math.min(a.x, b.x) - R
    const maxX = Math.max(a.x, b.x) + R
    const minZ = Math.min(a.z, b.z) - R
    const maxZ = Math.max(a.z, b.z) + R
    const gx0 = Math.max(0, Math.floor((minX + fs.half) * fs.scale))
    const gx1 = Math.min(FRES - 1, Math.ceil((maxX + fs.half) * fs.scale))
    const gz0 = Math.max(0, Math.floor((minZ + fs.half) * fs.scale))
    const gz1 = Math.min(FRES - 1, Math.ceil((maxZ + fs.half) * fs.scale))
    const abx = b.x - a.x
    const abz = b.z - a.z
    const abLen2 = abx * abx + abz * abz || 1e-9
    for (let gz = gz0; gz <= gz1; gz++) {
      const wz = gz * inv - fs.half
      for (let gx = gx0; gx <= gx1; gx++) {
        const wx = gx * inv - fs.half
        let t = ((wx - a.x) * abx + (wz - a.z) * abz) / abLen2
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const dx = wx - (a.x + abx * t)
        const dz = wz - (a.z + abz * t)
        const d = Math.sqrt(dx * dx + dz * dz)
        if (d <= R) write(gz * FRES + gx, d, a, b, t)
      }
    }
  }
}

function buildRiverFields(fs, riverPts) {
  splatPolyline(
    fs,
    riverPts,
    (p) => p.w * 0.5 + 5.5,
    (idx, d, a, b, t) => {
      if (d < fs.riverDist[idx]) {
        fs.riverDist[idx] = d
        fs.riverLevel[idx] = lerp(a.lv, b.lv, t)
        fs.riverHalfW[idx] = lerp(a.w, b.w, t) * 0.5
      }
    }
  )
}

function buildInletFields(fs, inletPts) {
  splatPolyline(
    fs,
    inletPts,
    (p) => p.w * 0.5 + 9,
    (idx, d, a, b, t) => {
      if (d < fs.inletDist[idx]) {
        fs.inletDist[idx] = d
        fs.inletHalfW[idx] = lerp(a.w, b.w, t) * 0.5
      }
    }
  )
}

const ROAD_CORE = 1.3 // half-width of the packed core (2.6 m core, §5)
const ROAD_FEATHER = 1.2 // feathered blend each side
const ROAD_GRADE_R = 5.4 // grading influence half-width

// Longitudinal smoothing + grade clamping of a road's centreline heights.
function gradeRoadHeights(pts, hs, pinnedIn) {
  const n = pts.length
  const out = hs.slice()
  const pinned = new Array(n)
  for (let i = 0; i < n; i++) pinned[i] = i === 0 || i === n - 1 || !!(pinnedIn && pinnedIn[i])
  // pyramid smoothing; pinned points (endpoints + pad cores) never move
  const smooth = (passes) => {
    for (let pass = 0; pass < passes; pass++) {
      const prev = out.slice()
      for (let i = 2; i < n - 2; i++) {
        if (pinned[i]) continue
        out[i] = (prev[i - 2] + 4 * prev[i - 1] + 6 * prev[i] + 4 * prev[i + 1] + prev[i + 2]) / 16
      }
    }
  }
  // clamp grade to 15 % by iterative relaxation; excess spreads across the
  // free interior, never into pinned points
  const clampGrade = () => {
    for (let pass = 0; pass < 260; pass++) {
      let worst = 0
      for (let i = 0; i < n - 1; i++) {
        const ds = Math.max(0.25, pts[i + 1].s - pts[i].s)
        const maxDh = 0.15 * ds
        const dh = out[i + 1] - out[i]
        if (Math.abs(dh) <= maxDh) continue
        const over = Math.abs(dh) - maxDh
        worst = Math.max(worst, over)
        const sgn = dh > 0 ? 1 : -1
        const loFree = !pinned[i]
        const hiFree = !pinned[i + 1]
        if (loFree && hiFree) {
          out[i] += sgn * over * 0.5
          out[i + 1] -= sgn * over * 0.5
        } else if (hiFree) {
          out[i + 1] -= sgn * over
        } else if (loFree) {
          out[i] += sgn * over
        }
      }
      if (worst < 0.02) break
    }
  }
  smooth(5)
  clampGrade()
  smooth(2)
  clampGrade()
  return out
}

// Splat every road: mask (core + feather) and graded height (wider halo).
// Segments that would cross the river channel are skipped — bridges span
// those gaps (props builds the decks; meta.roads records the polylines).
function buildRoadFields(fs, roads) {
  for (const road of roads) {
    const pts = road.pts
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]
      const b = pts[i + 1]
      const mx = (a.x + b.x) * 0.5
      const mz = (a.z + b.z) * 0.5
      const rd = sampleField(fs, fs.riverDist, mx, mz)
      const rw = sampleField(fs, fs.riverHalfW, mx, mz)
      if (rd < rw + 1.0) continue // gorge / channel — leave open for a bridge
      splatPolyline(
        fs,
        [a, b],
        () => ROAD_GRADE_R,
        (idx, d, p, q, t) => {
          const y = lerp(p.y, q.y, t)
          const w = sstep(ROAD_GRADE_R, ROAD_CORE * 0.6, d)
          const m = sstep(ROAD_CORE + ROAD_FEATHER, ROAD_CORE * 0.72, d)
          if (m > fs.roadMask[idx]) fs.roadMask[idx] = m
          fs.roadHSum[idx] += y * (w + 1e-4)
          fs.roadWSum[idx] += w + 1e-4
        }
      )
    }
  }
  for (let i = 0; i < fs.roadH.length; i++) {
    fs.roadH[i] = fs.roadWSum[i] > 1e-3 ? fs.roadHSum[i] / fs.roadWSum[i] : 0
  }
}

// ===========================================================================
// 7. AUTHORED HEIGHT PIPELINE
// ===========================================================================

// Soft box mask helper: 1 inside [a, b] with feather f on each end
function boxMask(v, a, b, f) {
  return sstep(a - f * 0.4, a + f * 0.6, v) * sstep(b + f * 0.4, b - f * 0.6, v)
}

// Wheat paddock mask (organic superellipse edges with noise wobble)
function fieldMaskAt(x, z) {
  let m = 0
  for (let i = 0; i < PADDOCKS.length; i++) {
    const p = PADDOCKS[i]
    if (Math.abs(x - p.x) > p.rx + 3 || Math.abs(z - p.z) > p.rx + 3) continue
    const er = ellipseR(x, z, p.x, p.z, p.rx, p.rz, p.rot) + 0.11 * fbm(x * 0.32 + i * 9.1, z * 0.32, 2, 2.2, 0.5)
    const v = sstep(1.04, 0.88, er)
    if (v > m) m = v
  }
  return m
}

// Forest stand strength 0..1 at (x, z) — authored anchors × clump noise.
function forestMaskAt(x, z) {
  let acc = 0
  for (let i = 0; i < STANDS.length; i++) {
    const st = STANDS[i]
    const dx = x - st.x
    const dz = z - st.z
    const d2 = dx * dx + dz * dz
    const r2 = st.r * st.r * 2.4
    if (d2 < r2) acc += st.s * Math.exp((-d2 / (st.r * st.r)) * 1.35)
  }
  if (acc < 0.06) return 0
  const clump = fbm(x * 0.034 + 3.7, z * 0.034, 3, 2.1, 0.5) * 0.5 + 0.5
  const rag = sstep(0.47 - clamp01(acc) * 0.24, 0.56 - clamp01(acc) * 0.24, clump)
  return clamp01(acc) * rag
}

// The full height author. `fs` is the field set; flags gate the road-grade
// and micro-detail stages so the road pre-pass can query virgin terrain.
function authorHeight(x, z, fs, useRoads, useMicro) {
  // ---- A. macro base: south lowland → terraced north/east highland -------
  const nBig = fbm(x * 0.0062 + 11.3, z * 0.0062, 3, 2.1, 0.5)
  let h = 8.2 + 2.1 * nBig
  const northT = sstep(30, -160, z)
  h += 24.5 * Math.pow(northT, 1.25)
  const eastT = sstep(24, 128, x) * sstep(40, -60, z)
  h += 9.0 * eastT
  const neM = sstep(105, 148, x) * sstep(-70, -112, z)
  if (neM > 0) h += neM * (4.5 + 8.0 * ridged(x * 0.021, z * 0.021, 3))
  h += 1.55 * fbm(x * 0.021 + 5.1, z * 0.021, 3, 2.1, 0.5)

  // ---- B. terracing: crisp cliff-banded steps in the highland ------------
  const terrW = sstep(12.5, 17.5, h) * clamp01(Math.max(northT * 1.25, eastT, neM))
  if (terrW > 0.001) {
    const wob = 1.8 * fbm(x * 0.043 + 2.2, z * 0.043, 2, 2.2, 0.5)
    const step = 6.4 + 2.1 * vnoise(x * 0.0085 + 5.5, z * 0.0085)
    const t = (h + wob - 12) / step
    const f = Math.floor(t)
    const terr = 12 + (f + terraceFrac(t - f)) * step - 0.62 * wob
    h = lerp(h, terr, terrW)
  }
  // soft ceiling: the far-NE crests top out ~+42 (art bible ridge band)
  if (h > 38) h = 38 + (h - 38) * 0.35

  // ---- C. hero grass shelf (x −80…−10, z −15…+60, +9…+12) ----------------
  {
    const m = boxMask(x, -80, -10, 16) * boxMask(z, -15, 60, 18)
    if (m > 0.001) {
      const dxh = x + 38
      const dzh = z - 18
      const bump = 0.5 * Math.exp(-(dxh * dxh + dzh * dzh) / 300)
      const shelf = 9.9 + 1.05 * fbm(x * 0.041 + 7.7, z * 0.041, 3, 2.1, 0.5) + bump
      h = lerp(h, shelf, m * 0.95)
    }
  }

  // ---- D. flat pads: village / shrine / camp / farm ----------------------
  // (castle is stage E; bridge abutments come after the river carve)
  for (let i = 0; i < PADS.length; i++) {
    const p = PADS[i]
    if (p.kind === 'castle' || p.kind === 'abutment') continue
    const dx = x - p.x
    const dz = z - p.z
    const d2 = dx * dx + dz * dz
    if (d2 > p.r * p.r * 1.9) continue
    const d = Math.sqrt(d2)
    const m = sstep(p.r * 1.32, p.r * 0.58, d)
    if (m > 0.001) h = lerp(h, p.h + 0.14 * vnoise(x * 0.3 + i, z * 0.3), m)
  }

  // ---- E. castle plateau: crisp escarpment, SW ramp sector for the road --
  {
    const er = ellipseR(x, z, -20, 4, 18, 15, 0.35) + 0.05 * fbm(x * 0.16 + 1.1, z * 0.16, 2, 2.2, 0.5)
    if (er < 1.02) {
      const ang = Math.atan2(z - 4, x + 20) // SW ≈ +2.36 rad
      let dAng = Math.abs(ang - 2.36)
      if (dAng > Math.PI) dAng = 2 * Math.PI - dAng
      const sector = sstep(1.05, 0.35, dAng) // 1 in the SW ramp wedge
      const rimMetres = (1 - Math.min(er, 1)) * 16.5 // ≈ metres inside the rim
      const edgeW = lerp(3.1, 12.0, sector)
      const eT = clamp01(rimMetres / edgeW)
      const prof = Math.pow(sstep(0, 1, eT), lerp(0.42, 1.35, sector))
      const top = 14.05 + 0.16 * vnoise(x * 0.24 + 3.3, z * 0.24)
      const target = lerp(h, top, prof)
      if (target > h) h = target
      // hard-flat courtyard core: the keep must sit dead level
      const dcx = x + 20
      const dcz = z - 4
      const dc = Math.sqrt(dcx * dcx + dcz * dcz)
      if (dc < 12.5) {
        const m = sstep(12.5, 9.8, dc)
        h = lerp(h, 14.05 + 0.1 * vnoise(x * 0.3 + 9.1, z * 0.3), m)
      }
    }
  }

  // ---- F. central limestone massif (+20…+24 band, waterfall host) --------
  {
    let d = sdRoundBox(x, z, -18, -35, 16.5, 17.5, 0.10, 9)
    d += 1.6 * fbm(x * 0.075 + 9.2, z * 0.075, 2, 2.2, 0.5) // ragged silhouette
    const faceW = 7.0 + 2.0 * vnoise(x * 0.05 + 1.9, z * 0.05)
    if (d < faceW) {
      const u = clamp01(1 - d / faceW) // 0 at outer toe → 1 on the plateau
      // two-ledge terraced face; the ledge line wanders so the bands never
      // read as concentric rings
      const split = clamp(0.5 + 0.15 * fbm(x * 0.052 + 3.7, z * 0.052, 2, 2.2, 0.5), 0.3, 0.7)
      const prof =
        u < split
          ? terraceFrac(u / split) * split
          : split + terraceFrac((u - split) / (1 - split)) * (1 - split)
      const crown = 3.3 * sstep(-24, -50, z) // band climbs upstage: 20.6 → 23.9
      const top = 20.6 + crown + 0.7 * fbm(x * 0.055 + 4.4, z * 0.055, 2, 2.2, 0.5)
      const surf = lerp(9.6, top, prof)
      h = smax(h, surf, 1.4)
    }
  }

  // ---- G. west coast: ocean floor, banded sea cliffs, pier cove ----------
  {
    const cw0 = 4.4 + 1.5 * vnoise(z * 0.07 + 6.6, 3.3)
    const d = x - coastX(z)
    if (d < cw0 + 11.5) {
      const dxc = x + 79
      const dzc = z + 8
      const cove = Math.exp(-(dxc * dxc + dzc * dzc) / 64) // pier cove (−79, −8)
      if (cove > 0.02) h = lerp(h, 1.15, cove * 0.92)
      const cw = lerp(cw0, 11.0, cove)
      const t = clamp01(d / cw)
      let shaped = sstep(0, 1, Math.pow(t, 0.68))
      // mid-face bench ledge, noise-gated so it comes and goes along shore
      const ledge = Math.exp(-Math.pow((t - 0.45) / 0.16, 2)) * (0.5 + 0.5 * vnoise(z * 0.11 + 8.2, 2.7))
      shaped = clamp01(shaped - 0.15 * ledge * (1 - cove))
      const floor =
        -0.35 - 5.9 * sstep(0, 26, -d) + 0.3 * fbm(x * 0.05 + 2.8, z * 0.05, 2, 2.2, 0.5)
      h = lerp(floor, h, shaped)
    }
  }

  // ---- H. sea inlet gorge (trestle bridge site) --------------------------
  {
    const s = sampleField(fs, fs.inletDist, x, z)
    const hw = sampleField(fs, fs.inletHalfW, x, z)
    if (s < hw * 1.15) {
      const u = clamp01(s / hw)
      const carve = -1.35 + 0.5 * u * u + Math.pow(u, 3.4) * 26
      if (carve < h) h = carve
    }
  }

  // ---- I. river channel + banks + plunge pool ----------------------------
  {
    const s = sampleField(fs, fs.riverDist, x, z)
    const hw = sampleField(fs, fs.riverHalfW, x, z)
    const bankW = 3.0
    if (s < hw + bankW) {
      const lv = sampleField(fs, fs.riverLevel, x, z)
      if (s < hw) {
        const bed = lv - 1.38 + Math.pow(s / hw, 2) * 1.74
        if (bed < h) h = bed
      } else {
        const u = (s - hw) / bankW
        const floor = lv + 0.36 + 2.8 * u * u
        if (h < floor) h = lerp(floor, h, sstep(0.7, 1.0, u))
      }
    }
    // upstream gorge shoulders: the highland course is perched above the
    // terraced plateaus in places — hold the rims up so it reads as a gorge.
    // Applies OUTSIDE the channel only: fades in from the bank edge, back to
    // natural ground by ~9 m out.
    if (s > hw + 1.2 && s < hw + 9) {
      const lv2 = sampleField(fs, fs.riverLevel, x, z)
      if (lv2 > 12.5) {
        const wIn = sstep(hw + 1.2, hw + 2.6, s)
        const wOut = 1 - sstep(hw + 5.5, hw + 9, s)
        const shoulder = lv2 + 0.42
        if (h < shoulder) h = lerp(h, shoulder, wIn * wOut)
      }
    }
  }

  // ---- I2. bridge abutment pads (after the carves: decks sit flush on
  // ---- solid flattened rims, while the channel/gorge below stays open) ---
  for (let i = 0; i < PADS.length; i++) {
    const p = PADS[i]
    if (p.kind !== 'abutment') continue
    const dx = x - p.x
    const dz = z - p.z
    const d2 = dx * dx + dz * dz
    if (d2 > p.r * p.r * 1.9) continue
    const d = Math.sqrt(d2)
    const m = sstep(p.r * 1.32, p.r * 0.58, d)
    // guard: level the rims, never fill the gorge below the deck
    if (m > 0.001 && h > p.h - 6) h = lerp(h, p.h + 0.14 * vnoise(x * 0.3 + i, z * 0.3), m)
  }

  // ---- J. road grading ---------------------------------------------------
  if (useRoads) {
    const m = sampleField(fs, fs.roadMask, x, z)
    if (m > 0.004) {
      const rh = sampleField(fs, fs.roadH, x, z)
      if (rh !== 0) h = lerp(h, rh, Math.min(1, m * 1.2) * 0.965)
    }
  }

  // ---- K. micro detail, masked off roads / fields / beds -----------------
  if (useMicro) {
    let protect = 0
    if (useRoads) protect = Math.min(1, sampleField(fs, fs.roadMask, x, z) * 1.35)
    const fm = fieldMaskAt(x, z)
    if (fm > protect) protect = fm
    const rs = sampleField(fs, fs.riverDist, x, z)
    const rw = sampleField(fs, fs.riverHalfW, x, z)
    if (rs < rw + 1.2) protect = 1
    const det =
      0.34 * fbm(x * 0.115 + 1.6, z * 0.115, 2, 2.2, 0.5) +
      0.11 * fbm(x * 0.33 + 8.4, z * 0.33, 2, 2.2, 0.5)
    h += det * (1 - 0.88 * protect)
  }

  return h
}

// ===========================================================================
// 8. Height grid + allocation-free queries
// ===========================================================================

const SEGS = 768 // mesh segments per side (contract: 512–1024)

function buildHeightGrid(size, fs) {
  const N = SEGS + 1
  const step = size / SEGS
  const half = size / 2
  const heights = new Float32Array(N * N)
  let minH = Infinity
  let maxH = -Infinity
  for (let j = 0; j < N; j++) {
    const z = -half + j * step
    for (let i = 0; i < N; i++) {
      const x = -half + i * step
      const h = authorHeight(x, z, fs, true, true)
      heights[j * N + i] = h
      if (h < minH) minH = h
      if (h > maxH) maxH = h
    }
  }
  return { heights, N, step, half, minH, maxH }
}

// height(x, z): reproduces the mesh triangulation EXACTLY (diagonal a→d per
// cell, same as the index buffer below), so queries match rendered geometry
// to float precision. No allocation, no branching beyond the diagonal test.
function makeHeightQuery(grid) {
  const { heights, N, step, half } = grid
  const maxC = N - 2
  return function height(x, z) {
    let gx = (x + half) / step
    let gz = (z + half) / step
    gx = gx < 0 ? 0 : gx > N - 1.0001 ? N - 1.0001 : gx
    gz = gz < 0 ? 0 : gz > N - 1.0001 ? N - 1.0001 : gz
    let ix = gx | 0
    let iz = gz | 0
    if (ix > maxC) ix = maxC
    if (iz > maxC) iz = maxC
    const fx = gx - ix
    const fz = gz - iz
    const i00 = iz * N + ix
    const h00 = heights[i00]
    const h10 = heights[i00 + 1]
    const h01 = heights[i00 + N]
    const h11 = heights[i00 + N + 1]
    if (fx >= fz) {
      // triangle (a, d, b): a=(0,0) d=(1,1) b=(1,0)
      return h00 + (h10 - h00) * fx + (h11 - h10) * fz
    }
    // triangle (a, c, d): a=(0,0) c=(0,1) d=(1,1)
    return h00 + (h11 - h01) * fx + (h01 - h00) * fz
  }
}

// ===========================================================================
// 9. Biome / control rasters (1024², sampled off the finished heightfield)
// ===========================================================================

const BIOME_NAMES = ['grass', 'ocean', 'beach', 'forest', 'road', 'rock', 'snow', 'field']
const B_GRASS = 0
const B_OCEAN = 1
const B_BEACH = 2
const B_FOREST = 3
const B_ROAD = 4
const B_ROCK = 5
const B_SNOW = 6
const B_FIELD = 7

function buildBiomeAndControl(size, fs, height) {
  const half = size / 2
  const inv = size / (FRES - 1)
  const biomes = new Uint8Array(FRES * FRES)
  const ctrlA = new Uint8Array(FRES * FRES * 4) // road, rock, field, wet
  const ctrlB = new Uint8Array(FRES * FRES * 4) // AO, riverbed, sand, forest floor
  const e = 0.8 // slope probe half-step (m)

  for (let gz = 0; gz < FRES; gz++) {
    const z = gz * inv - half
    for (let gx = 0; gx < FRES; gx++) {
      const x = gx * inv - half
      const idx = gz * FRES + gx
      const i4 = idx * 4
      const h = height(x, z)

      // normal.y from central differences
      const dhx = (height(x + e, z) - height(x - e, z)) / (2 * e)
      const dhz = (height(x, z + e) - height(x, z - e)) / (2 * e)
      const ny = 1 / Math.sqrt(dhx * dhx + dhz * dhz + 1)

      // curvature AO: two-ring average vs centre (concavities darken)
      const r1 = 2.2
      const r2 = 5.0
      const avg1 =
        (height(x + r1, z) + height(x - r1, z) + height(x, z + r1) + height(x, z - r1)) * 0.25
      const avg2 =
        (height(x + r2, z) + height(x - r2, z) + height(x, z + r2) + height(x, z - r2)) * 0.25
      const cav = clamp01((avg1 - h) * 0.42 + (avg2 - h) * 0.16)

      const roadM = sampleField(fs, fs.roadMask, x, z)
      const fieldM = fieldMaskAt(x, z)
      const rs = sampleField(fs, fs.riverDist, x, z)
      const rw = sampleField(fs, fs.riverHalfW, x, z)
      const is = sampleField(fs, fs.inletDist, x, z)
      const iw = sampleField(fs, fs.inletHalfW, x, z)
      const dCoast = x - coastX(z)
      const forestM = forestMaskAt(x, z)

      // wet: river margins, shoreline, inlet walls
      let wet = 0
      if (rs < rw + 2.4) wet = Math.max(wet, 1 - sstep(rw * 0.5, rw + 2.4, rs))
      if (is < iw + 2.0) wet = Math.max(wet, 1 - sstep(iw * 0.5, iw + 2.0, is))
      wet = Math.max(wet, sstep(1.1, 0.1, h) * sstep(10, 2, Math.abs(dCoast)))

      const rockF = sstep(0.86, 0.60, ny)
      const bedM = rs < rw * 1.08 ? 1 - sstep(rw * 0.8, rw * 1.08, rs) : 0
      // sand: the pier cove pocket + submerged shore shelf only — the open
      // coast is cliff-into-surf (frame01), never a sand strip
      const dCove = Math.hypot(x + 79, z + 8)
      const sandM = Math.max(
        sstep(14, 8, dCove) * sstep(1.7, 0.35, h),
        sstep(0.55, -0.4, h) * sstep(9, 1.5, Math.abs(dCoast))
      )

      // snow dusting on the far-NE CRESTS only (top ~10 % of the capped
      // relief band, noise-broken edge)
      const snowM =
        sstep(126, 148, x) *
        (1 - sstep(-120, -98, z)) *
        sstep(41.4, 42.3, h + 0.8 * vnoise(x * 0.09, z * 0.09)) *
        sstep(0.55, 0.8, ny)

      // ---------- biome precedence ----------
      let b = B_GRASS
      if (h < -0.02) b = B_OCEAN
      else if (roadM > 0.5) b = B_ROAD
      else if (fieldM > 0.45) b = B_FIELD
      else if (sandM > 0.55 && ny > 0.72) b = B_BEACH
      else if (snowM > 0.5) b = B_SNOW
      else if (ny < 0.74) b = B_ROCK
      else if (forestM > 0.5 && h > 1) b = B_FOREST
      biomes[idx] = b

      ctrlA[i4] = (clamp01(roadM) * 255) | 0
      ctrlA[i4 + 1] = (rockF * 255) | 0
      ctrlA[i4 + 2] = (clamp01(fieldM) * 255) | 0
      ctrlA[i4 + 3] = (clamp01(wet) * 255) | 0
      ctrlB[i4] = (cav * 255) | 0
      ctrlB[i4 + 1] = (clamp01(bedM) * 255) | 0
      ctrlB[i4 + 2] = (clamp01(sandM) * 255) | 0
      ctrlB[i4 + 3] = (clamp01(forestM * 0.85) * 255) | 0
    }
  }
  return { biomes, ctrlA, ctrlB }
}

// ===========================================================================
// 10. Geometry — world-space grid mesh + perimeter skirt
// ===========================================================================

function buildGeometry(grid) {
  const { heights, N, step, half } = grid
  const gridVerts = N * N
  const skirtBottomVerts = 4 * N
  const totalVerts = gridVerts + skirtBottomVerts
  const positions = new Float32Array(totalVerts * 3)
  const normals = new Float32Array(totalVerts * 3)

  // grid vertices (world-space; the mesh stays at identity transform)
  for (let j = 0; j < N; j++) {
    const z = -half + j * step
    for (let i = 0; i < N; i++) {
      const vi = (j * N + i) * 3
      positions[vi] = -half + i * step
      positions[vi + 1] = heights[j * N + i]
      positions[vi + 2] = z
    }
  }
  // smooth normals via central differences on the height grid
  const inv2s = 1 / (2 * step)
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const iw = i > 0 ? i - 1 : i
      const ie = i < N - 1 ? i + 1 : i
      const jn = j > 0 ? j - 1 : j
      const js = j < N - 1 ? j + 1 : j
      const sx = (ie - iw) * step || step
      const sz = (js - jn) * step || step
      const dhx = (heights[j * N + ie] - heights[j * N + iw]) / sx
      const dhz = (heights[js * N + i] - heights[jn * N + i]) / sz
      const il = 1 / Math.sqrt(dhx * dhx + dhz * dhz + 1)
      const vi = (j * N + i) * 3
      normals[vi] = -dhx * il
      normals[vi + 1] = il
      normals[vi + 2] = -dhz * il
    }
  }

  // main index buffer: per-cell diagonal a→d (matches makeHeightQuery)
  const cellTris = SEGS * SEGS * 2
  const skirtTris = 4 * (N - 1) * 2
  const index = new Uint32Array((cellTris + skirtTris) * 3)
  let k = 0
  for (let j = 0; j < SEGS; j++) {
    for (let i = 0; i < SEGS; i++) {
      const a = j * N + i
      const b = a + 1
      const c = a + N
      const d = c + 1
      index[k++] = a
      index[k++] = c
      index[k++] = d
      index[k++] = a
      index[k++] = d
      index[k++] = b
    }
  }

  // skirt: rim verts reused on top, dropped duplicates below (y = −16)
  const SKIRT_Y = -16
  let sv = gridVerts
  const addSkirt = (rimIndexOf, nx, nz, flip) => {
    const start = sv
    for (let t = 0; t < N; t++) {
      const ri = rimIndexOf(t)
      const vi = sv * 3
      positions[vi] = positions[ri * 3]
      positions[vi + 1] = SKIRT_Y
      positions[vi + 2] = positions[ri * 3 + 2]
      normals[vi] = nx
      normals[vi + 1] = 0
      normals[vi + 2] = nz
      sv++
    }
    for (let t = 0; t < N - 1; t++) {
      const p0 = rimIndexOf(t)
      const p1 = rimIndexOf(t + 1)
      const d0 = start + t
      const d1 = start + t + 1
      if (!flip) {
        index[k++] = p0
        index[k++] = d0
        index[k++] = d1
        index[k++] = p0
        index[k++] = d1
        index[k++] = p1
      } else {
        index[k++] = p0
        index[k++] = d1
        index[k++] = d0
        index[k++] = p0
        index[k++] = p1
        index[k++] = d1
      }
    }
  }
  addSkirt((t) => (N - 1) * N + t, 0, 1, false) // south rim (z = +half)
  addSkirt((t) => t, 0, -1, true) // north rim (z = −half)
  addSkirt((t) => t * N + (N - 1), 1, 0, true) // east rim (x = +half)
  addSkirt((t) => t * N, -1, 0, false) // west rim (x = −half)

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geo.setIndex(new THREE.BufferAttribute(index, 1))
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 12, 0), half * 1.75)
  return geo
}

// ===========================================================================
// 11. Procedural detail textures (Canvas2D, tileable, palette-locked)
// ===========================================================================

function cssHex(hex) {
  return '#' + hex.toString(16).padStart(6, '0')
}

function cssShade(hex, f) {
  const [r, g, b] = hexRGB(hex)
  const m = (v) => clamp(Math.round(v * f), 0, 255)
  return `rgb(${m(r)},${m(g)},${m(b)})`
}

// Draw cb(x, y) wrapped so stamps crossing an edge repeat on the far side.
function wrapped(ctx, size, x, y, r, cb) {
  const xs = [0]
  const ys = [0]
  if (x + r > size) xs.push(-size)
  if (x - r < 0) xs.push(size)
  if (y + r > size) ys.push(-size)
  if (y - r < 0) ys.push(size)
  for (const ox of xs) for (const oy of ys) cb(x + ox, y + oy)
}

function finishTexture(canvas, renderer, srgb) {
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 1
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  tex.needsUpdate = true
  return tex
}

// --- Grass: mottled meadow, blade clusters, HI stipple (no dithering) ------
function paintGrass(rnd, renderer) {
  const S = 256
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')
  g.fillStyle = cssHex(PAL.GRASS_MID)
  g.fillRect(0, 0, S, S)

  // large soft value patches — kills flatness at the first frequency
  for (let i = 0; i < 46; i++) {
    const x = rnd() * S
    const y = rnd() * S
    const r = 18 + rnd() * 46
    const lit = rnd() < 0.5
    g.globalAlpha = 0.07 + rnd() * 0.09
    g.fillStyle = cssHex(lit ? PAL.GRASS_LIT : PAL.GRASS_SHADOW)
    wrapped(g, S, x, y, r, (px, py) => {
      g.beginPath()
      g.arc(px, py, r, 0, Math.PI * 2)
      g.fill()
    })
  }
  g.globalAlpha = 1

  // blade clusters: 3–7 short vertical strokes each
  for (let i = 0; i < 430; i++) {
    const cx = rnd() * S
    const cy = rnd() * S
    const n = 3 + (rnd() * 5) | 0
    for (let j = 0; j < n; j++) {
      const x = cx + (rnd() - 0.5) * 7
      const y = cy + (rnd() - 0.5) * 5
      const len = 2 + (rnd() * 2) | 0
      const pick = rnd()
      g.fillStyle = cssHex(pick < 0.42 ? PAL.GRASS_LIT : pick < 0.72 ? PAL.GRASS_MID : PAL.GRASS_SHADOW)
      wrapped(g, S, x, y, 4, (px, py) => g.fillRect(px | 0, py | 0, 1, len))
    }
    // dark pocket under ~40 % of clusters
    if (rnd() < 0.4) {
      g.fillStyle = cssHex(PAL.GRASS_DEEP)
      wrapped(g, S, cx, cy + 3, 4, (px, py) => g.fillRect(px | 0, py | 0, 2, 1))
    }
  }

  // loose blade flecks
  for (let i = 0; i < 1300; i++) {
    const x = rnd() * S
    const y = rnd() * S
    const pick = rnd()
    g.fillStyle = cssHex(pick < 0.5 ? PAL.GRASS_LIT : pick < 0.8 ? PAL.GRASS_SHADOW : PAL.GRASS_MID)
    wrapped(g, S, x, y, 3, (px, py) => g.fillRect(px | 0, py | 0, 1, 2))
  }

  // HI stipple — single-pixel bloom-kissed tips only
  g.fillStyle = cssHex(PAL.GRASS_HI)
  for (let i = 0; i < 240; i++) {
    const x = rnd() * S
    const y = rnd() * S
    wrapped(g, S, x, y, 2, (px, py) => g.fillRect(px | 0, py | 0, 1, 1))
  }
  return finishTexture(c, renderer, true)
}

// --- Road dirt: packed ochre, pebbles with lit tops, faint ruts ------------
function paintDirt(rnd, renderer) {
  const S = 256
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')
  g.fillStyle = cssHex(PAL.ROAD_LIT)
  g.fillRect(0, 0, S, S)

  for (let i = 0; i < 70; i++) {
    const x = rnd() * S
    const y = rnd() * S
    const r = 12 + rnd() * 34
    g.globalAlpha = 0.08 + rnd() * 0.1
    g.fillStyle = cssHex(rnd() < 0.7 ? PAL.ROAD_MID : PAL.ROAD_SHADOW)
    wrapped(g, S, x, y, r, (px, py) => {
      g.beginPath()
      g.arc(px, py, r, 0, Math.PI * 2)
      g.fill()
    })
  }
  g.globalAlpha = 1

  // fine grain
  for (let i = 0; i < 2600; i++) {
    const x = rnd() * S
    const y = rnd() * S
    const pick = rnd()
    g.fillStyle =
      pick < 0.45 ? cssHex(PAL.ROAD_MID) : pick < 0.8 ? cssShade(PAL.ROAD_LIT, 1.08) : cssShade(PAL.ROAD_MID, 0.9)
    wrapped(g, S, x, y, 2, (px, py) => g.fillRect(px | 0, py | 0, 1, 1))
  }

  // pebbles: dark body, single lit top-left pixel
  for (let i = 0; i < 150; i++) {
    const x = (rnd() * S) | 0
    const y = (rnd() * S) | 0
    const w = 1 + (rnd() * 2.4) | 0
    const h = 1 + (rnd() * 1.8) | 0
    wrapped(g, S, x, y, 5, (px, py) => {
      g.fillStyle = cssHex(PAL.ROAD_SHADOW)
      g.fillRect(px, py, w, h)
      g.fillStyle = cssShade(PAL.ROAD_LIT, 1.12)
      g.fillRect(px, py, 1, 1)
    })
  }

  // faint transverse wear arcs
  g.globalAlpha = 0.055
  g.strokeStyle = cssHex(PAL.ROAD_SHADOW)
  g.lineWidth = 1.6
  for (let i = 0; i < 24; i++) {
    const y = rnd() * S
    const amp = 2 + rnd() * 4
    const ph = rnd() * Math.PI * 2
    g.beginPath()
    for (let x = -8; x <= S + 8; x += 6) {
      const yy = y + Math.sin((x / S) * Math.PI * 4 + ph) * amp
      x === -8 ? g.moveTo(x, yy) : g.lineTo(x, yy)
    }
    g.stroke()
  }
  g.globalAlpha = 1
  return finishTexture(c, renderer, true)
}

// --- Rock: HORIZONTAL strata bands — layered limestone, not noise ----------
function paintRock(rnd, renderer) {
  const S = 256
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')
  g.fillStyle = cssHex(PAL.CLIFF_MID)
  g.fillRect(0, 0, S, S)

  // band list summing to S so the texture tiles vertically
  const bands = []
  let acc = 0
  const cycle = [PAL.CLIFF_LIT, PAL.CLIFF_MID, PAL.CLIFF_SHADOW, PAL.CLIFF_MID]
  let ci = 0
  while (acc < S) {
    const t = 7 + (rnd() * 10) | 0
    bands.push({ y: acc, t: Math.min(t, S - acc), col: cycle[ci % cycle.length], f: 0.94 + rnd() * 0.12 })
    acc += t
    ci++
  }

  // tileable horizontal wobble via integer-frequency sines
  const wob = (x, s) =>
    Math.sin((x / S) * Math.PI * 2 * 2 + s * 9.7) * 1.6 + Math.sin((x / S) * Math.PI * 2 * 5 + s * 3.1) * 0.8

  for (let bi = 0; bi < bands.length; bi++) {
    const b = bands[bi]
    g.fillStyle = cssShade(b.col, b.f)
    for (let x = 0; x < S; x++) {
      const o = wob(x, bi)
      g.fillRect(x, Math.round(b.y + o), 1, b.t)
    }
  }
  // wrap seam: repaint first band across the bottom overflow
  {
    const b = bands[0]
    g.fillStyle = cssShade(b.col, b.f)
    for (let x = 0; x < S; x++) {
      const o = wob(x, 0)
      g.fillRect(x, Math.round(S + b.y + o) - 2, 1, 2)
    }
  }

  // crevice seams between bands + lit top edges (sun from above)
  for (let bi = 0; bi < bands.length; bi++) {
    const b = bands[bi]
    for (let x = 0; x < S; x++) {
      const yTop = Math.round(b.y + wob(x, bi))
      if (hash2(x, bi * 7) < 0.85) {
        g.fillStyle = cssHex(PAL.CLIFF_CREVICE)
        g.fillRect(x, (yTop - 1 + S) % S, 1, 1)
      }
      if (hash2(x, bi * 13 + 3) < 0.5) {
        g.fillStyle = cssShade(PAL.CLIFF_LIT, 1.05)
        g.fillRect(x, yTop % S, 1, 1)
      }
    }
  }

  // grain + chips
  for (let i = 0; i < 2200; i++) {
    const x = rnd() * S
    const y = rnd() * S
    const pick = rnd()
    g.fillStyle =
      pick < 0.4 ? cssShade(PAL.CLIFF_MID, 0.9) : pick < 0.75 ? cssShade(PAL.CLIFF_LIT, 0.97) : cssHex(PAL.CLIFF_SHADOW)
    wrapped(g, S, x, y, 2, (px, py) => g.fillRect(px | 0, py | 0, 1, 1))
  }

  // vertical cracks crossing bands
  g.fillStyle = cssHex(PAL.CLIFF_CREVICE)
  for (let i = 0; i < 42; i++) {
    let x = (rnd() * S) | 0
    let y = (rnd() * S) | 0
    const len = 3 + (rnd() * 9) | 0
    for (let j = 0; j < len; j++) {
      wrapped(g, S, x, y, 2, (px, py) => g.fillRect(px | 0, py | 0, 1, 1))
      y = (y + 1) % S
      if (rnd() < 0.3) x = (x + (rnd() < 0.5 ? 1 : -1) + S) % S
    }
  }
  return finishTexture(c, renderer, true)
}

// --- Wheat field: furrow rows, stalk texture, pale seed-head stipple -------
function paintField(rnd, renderer) {
  const S = 256
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')
  g.fillStyle = cssHex(PAL.WHEAT_LIT)
  g.fillRect(0, 0, S, S)

  const pitch = 10
  const rows = S / pitch // 25.6 → use integer wave frequencies for tiling
  for (let r = 0; r < Math.ceil(rows); r++) {
    const yBase = r * pitch
    // furrow shadow line (wavy, tileable)
    g.fillStyle = cssHex(PAL.WHEAT_SHADOW)
    for (let x = 0; x < S; x++) {
      const o = Math.sin((x / S) * Math.PI * 2 * 3 + r * 2.4) * 1.5
      g.fillRect(x, Math.round(yBase + o) % S, 1, 2)
    }
    // stalk body above the furrow
    for (let x = 0; x < S; x += 1) {
      if (hash2(x, r * 31) < 0.55) {
        const o = Math.sin((x / S) * Math.PI * 2 * 3 + r * 2.4) * 1.5
        const y = (Math.round(yBase + o) - 3 - ((hash2(x, r * 17) * 4) | 0) + S) % S
        g.fillStyle = hash2(x, r * 53) < 0.5 ? cssShade(PAL.WHEAT_LIT, 0.94) : cssShade(PAL.WHEAT_SHADOW, 1.15)
        g.fillRect(x, y, 1, 3)
      }
    }
  }

  // seed-head stipple
  g.fillStyle = cssHex(PAL.WHEAT_TIPS)
  for (let i = 0; i < 1700; i++) {
    const x = rnd() * S
    const y = rnd() * S
    wrapped(g, S, x, y, 2, (px, py) => g.fillRect(px | 0, py | 0, 1, 1))
  }
  // sparse green weeds
  g.fillStyle = cssHex(PAL.GRASS_MID)
  for (let i = 0; i < 90; i++) {
    const x = rnd() * S
    const y = rnd() * S
    wrapped(g, S, x, y, 2, (px, py) => g.fillRect(px | 0, py | 0, 1, 2))
  }
  return finishTexture(c, renderer, true)
}

// --- Sand: pale shore grit ------------------------------------------------
function paintSand(rnd, renderer) {
  const S = 128
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')
  g.fillStyle = cssHex(PAL.SAND_LIT)
  g.fillRect(0, 0, S, S)
  for (let i = 0; i < 26; i++) {
    const x = rnd() * S
    const y = rnd() * S
    const r = 8 + rnd() * 22
    g.globalAlpha = 0.09
    g.fillStyle = cssHex(PAL.SAND_MID)
    wrapped(g, S, x, y, r, (px, py) => {
      g.beginPath()
      g.arc(px, py, r, 0, Math.PI * 2)
      g.fill()
    })
  }
  g.globalAlpha = 1
  for (let i = 0; i < 1500; i++) {
    const x = rnd() * S
    const y = rnd() * S
    const pick = rnd()
    g.fillStyle = pick < 0.5 ? cssHex(PAL.SAND_MID) : pick < 0.85 ? cssShade(PAL.SAND_LIT, 1.07) : cssShade(PAL.SAND_MID, 0.88)
    wrapped(g, S, x, y, 2, (px, py) => g.fillRect(px | 0, py | 0, 1, 1))
  }
  return finishTexture(c, renderer, true)
}

// --- Macro variation noise (linear data, sampled at two world scales) ------
function paintMacro(renderer) {
  const S = 512
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')
  const img = g.createImageData(S, S)
  const d = img.data
  const TAU = Math.PI * 2
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // toroidal fBm — sample noise on a torus so the tile wraps seamlessly
      const a = (x / S) * TAU
      const b = (y / S) * TAU
      const nx = Math.cos(a) * 1.6
      const nyy = Math.sin(a) * 1.6
      const nz = Math.cos(b) * 1.6
      const nw = Math.sin(b) * 1.6
      const r =
        0.5 +
        0.5 *
          (0.62 * vnoise(nx * 2 + nz * 1.3, nyy * 2 + nw * 1.3) +
            0.38 * vnoise(nx * 5.1 + nw * 2.2 + 7.7, nz * 5.1 + nyy * 2.2))
      const gg =
        0.5 +
        0.5 *
          (0.6 * vnoise(nz * 2.4 + 19.1 + nyy, nw * 2.4 + nx) +
            0.4 * vnoise(nx * 6.3 + 4.2, nw * 6.3 + nz * 1.7))
      const bb = 0.5 + 0.5 * vnoise(nx * 9.4 + nw * 3.1 + 31.7, nyy * 9.4 + nz * 3.1)
      const i4 = (y * S + x) * 4
      d[i4] = clamp(Math.round(r * 255), 0, 255)
      d[i4 + 1] = clamp(Math.round(gg * 255), 0, 255)
      d[i4 + 2] = clamp(Math.round(bb * 255), 0, 255)
      d[i4 + 3] = 255
    }
  }
  g.putImageData(img, 0, 0)
  return finishTexture(c, renderer, false)
}

// ===========================================================================
// 12. Terrain material — multi-layer splat over MeshStandardMaterial
// ===========================================================================

function linCol(hex) {
  return new THREE.Color(hex).convertSRGBToLinear()
}

function makeControlTexture(data) {
  const tex = new THREE.DataTexture(data, FRES, FRES, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearFilter
  tex.generateMipmaps = false
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.colorSpace = THREE.NoColorSpace
  tex.flipY = false
  tex.needsUpdate = true
  return tex
}

function makeTerrainMaterial(renderer, size, ctrlA, ctrlB, seed) {
  const rnd = mulberry32((seed ^ 0x51ab) >>> 0)
  const uniforms = {
    uGrass: { value: paintGrass(rnd, renderer) },
    uDirt: { value: paintDirt(rnd, renderer) },
    uRock: { value: paintRock(rnd, renderer) },
    uField: { value: paintField(rnd, renderer) },
    uSand: { value: paintSand(rnd, renderer) },
    uMacro: { value: paintMacro(renderer) },
    uCtrlA: { value: makeControlTexture(ctrlA) },
    uCtrlB: { value: makeControlTexture(ctrlB) },
    uHalfSize: { value: size / 2 },
    uInvSize: { value: 1 / size },
    uSnowLit: { value: linCol(PAL.SNOW_LIT) },
    uSnowShadow: { value: linCol(PAL.SNOW_SHADOW) },
    uOceanFloor: { value: linCol(0x1c3b47) },
  }

  const mat = new THREE.MeshStandardMaterial({ roughness: 1.0, metalness: 0.0 })
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;'
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvWPos = position;\nvWNormal = normal;'
      )

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWPos;
varying vec3 vWNormal;
uniform sampler2D uGrass;
uniform sampler2D uDirt;
uniform sampler2D uRock;
uniform sampler2D uField;
uniform sampler2D uSand;
uniform sampler2D uMacro;
uniform sampler2D uCtrlA;
uniform sampler2D uCtrlB;
uniform float uHalfSize;
uniform float uInvSize;
uniform vec3 uSnowLit;
uniform vec3 uSnowShadow;
uniform vec3 uOceanFloor;`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  vec2 wxz = vWPos.xz;
  vec2 cuv = (wxz + vec2(uHalfSize)) * uInvSize;
  vec4 cA = texture2D(uCtrlA, cuv); // r road  g rock  b field  a wet
  vec4 cB = texture2D(uCtrlB, cuv); // r AO    g bed   b sand   a forest
  vec3 nrm = normalize(vWNormal);
  vec4 mac  = texture2D(uMacro, wxz / 91.0);
  vec4 mac2 = texture2D(uMacro, wxz / 23.0);

  // ---- grass: two detail frequencies + macro patchiness ----
  vec3 g1 = texture2D(uGrass, wxz / 7.3).rgb;
  vec3 g2 = texture2D(uGrass, wxz / 1.87).rgb;
  vec3 grass = mix(g1, g2, 0.45);
  grass *= mix(vec3(0.92, 0.97, 0.88), vec3(1.09, 1.05, 0.92), mac.r);
  grass  = mix(grass, grass * vec3(1.10, 1.02, 0.74), smoothstep(0.60, 0.86, mac2.g) * 0.45);
  grass  = mix(grass, grass * vec3(0.60, 0.72, 0.60), cB.a * 0.55); // forest floor

  // ---- wheat field ----
  vec3 fld = texture2D(uField, wxz / 4.6).rgb;
  fld *= mix(0.90, 1.10, mac2.r);

  // ---- road: pale packed core, darker feathered shoulders ----
  vec3 road = mix(texture2D(uDirt, wxz / 5.3).rgb, texture2D(uDirt, wxz / 1.43).rgb, 0.40);
  float rCore = smoothstep(0.12, 0.85, cA.r);
  road *= mix(vec3(0.80, 0.76, 0.72), vec3(1.06), rCore);
  road *= mix(0.94, 1.06, mac.g);

  // ---- rock: wall projections keep strata horizontal on cliffs ----
  float axf = smoothstep(0.35, 0.65, abs(nrm.x) / (abs(nrm.x) + abs(nrm.z) + 1e-4));
  vec3 wallC = mix(texture2D(uRock, vec2(vWPos.x, -vWPos.y) / 6.2).rgb,
                   texture2D(uRock, vec2(vWPos.z, -vWPos.y) / 6.2).rgb, axf);
  vec3 wallF = mix(texture2D(uRock, vec2(vWPos.x, -vWPos.y) / 2.1).rgb,
                   texture2D(uRock, vec2(vWPos.z, -vWPos.y) / 2.1).rgb, axf);
  vec3 rock = mix(wallC, wallF, 0.35);
  rock = mix(rock, texture2D(uRock, wxz / 8.5).rgb, smoothstep(0.62, 0.88, nrm.y));
  rock *= mix(0.90, 1.10, mac.r);

  vec3 sand = texture2D(uSand, wxz / 3.1).rgb;

  // ---- layer masks ----
  float rockM = max(1.0 - smoothstep(0.66, 0.86, nrm.y), cA.g * 0.9);
  rockM = clamp(rockM + (mac2.b - 0.5) * 0.22, 0.0, 1.0);
  float moss = smoothstep(0.80, 0.93, nrm.y) * (1.0 - smoothstep(0.30, 0.60, cA.g))
             * smoothstep(0.45, 0.85, mac2.r) * 0.6;
  rockM *= 1.0 - moss;

  vec3 col = grass;
  col = mix(col, sand, cB.b * (1.0 - rockM));
  col = mix(col, fld, cA.b * (1.0 - rockM));
  float roadM = smoothstep(0.06, 0.92, cA.r + (mac2.g - 0.5) * 0.18) * (1.0 - rockM * 0.85);
  col = mix(col, road, roadM);
  col = mix(col, rock, rockM);

  // ---- snow dusting, far NE crests only ----
  float snowM = smoothstep(126.0, 148.0, vWPos.x)
              * (1.0 - smoothstep(-120.0, -98.0, vWPos.z))
              * smoothstep(41.4, 42.3, vWPos.y + (mac.b - 0.5) * 1.6)
              * smoothstep(0.55, 0.80, nrm.y);
  col = mix(col, mix(uSnowShadow, uSnowLit, 0.35 + 0.65 * mac.r), snowM);

  // ---- water beds, damp margins, ocean floor depth tint ----
  col = mix(col, col * vec3(0.50, 0.60, 0.56), cB.g * 0.80);
  col = mix(col, col * vec3(0.70, 0.78, 0.76), cA.a * (1.0 - cB.g) * 0.50);
  float uw = 1.0 - smoothstep(-5.5, -0.05, vWPos.y);
  col = mix(col, uOceanFloor, uw * 0.85);

  // ---- cavity AO: grounds cliff bases, channels, clump hollows ----
  col *= mix(1.0, 0.70, cB.r * (1.0 - rockM * 0.35));

  diffuseColor.rgb = col;
}`
      )
  }
  mat.customProgramCacheKey = () => 'aetherbound-terrain-splat-v1'
  return mat
}

// ===========================================================================
// 13. createTerrain — public contract entry
// ===========================================================================

export function createTerrain(opts = {}) {
  const size = opts.size || 512
  const seed = opts.seed !== undefined ? opts.seed : 20260802
  const renderer = opts.renderer || null

  seedNoise(seed)
  const fs = makeFieldSet(size)

  // --- water splines first: everything else reacts to them
  const riverRes = resampleSpline(RIVER_PTS, 1.4, ['w', 'lv'])
  buildRiverFields(fs, riverRes)
  const inletRes = resampleSpline(INLET_PTS, 1.6, ['w'])
  buildInletFields(fs, inletRes)

  // --- roads: resample, grade on virgin terrain, then splat corridors
  const gradedRoads = []
  const roadsMeta = []
  for (const def of ROAD_DEFS) {
    const res = resampleSpline(def.pts, 2.0)
    const hs = new Array(res.length)
    for (let i = 0; i < res.length; i++) hs[i] = authorHeight(res[i].x, res[i].z, fs, false, false)
    // pin road points that sit inside flat pad cores: their pre-heights are
    // already the pad level, and grading must not smear ramps across pads
    const pinned = res.map((p) => {
      for (const pad of PADS) {
        const dc = Math.hypot(p.x - pad.x, p.z - pad.z)
        const rr = pad.kind === 'castle' ? 9.0 : pad.r * 0.6
        if (dc < rr) return true
      }
      return false
    })
    const graded = gradeRoadHeights(res, hs, pinned)
    for (let i = 0; i < res.length; i++) res[i].y = graded[i]
    gradedRoads.push({ name: def.name, pts: res })
    roadsMeta.push({
      name: def.name,
      width: ROAD_CORE * 2,
      feather: ROAD_FEATHER,
      points: res.map((p) => ({ x: p.x, z: p.z, y: p.y })),
    })
  }
  buildRoadFields(fs, gradedRoads)

  // --- the heightfield and its exact query
  const grid = buildHeightGrid(size, fs)
  const height = makeHeightQuery(grid)

  // --- biome + control rasters off the finished field
  const { biomes, ctrlA, ctrlB } = buildBiomeAndControl(size, fs, height)

  // --- render mesh
  const hasDOM = typeof document !== 'undefined'
  const geo = buildGeometry(grid)
  const mat = hasDOM
    ? makeTerrainMaterial(renderer, size, ctrlA, ctrlB, seed)
    : new THREE.MeshStandardMaterial()
  const mesh = new THREE.Mesh(geo, mat)
  mesh.name = 'terrain'
  mesh.receiveShadow = true
  mesh.castShadow = true
  mesh.frustumCulled = false
  mesh.matrixAutoUpdate = false
  const object3D = new THREE.Group()
  object3D.name = 'terrainRoot'
  object3D.add(mesh)

  // --- allocation-free queries -------------------------------------------
  const half = size / 2
  const eps = grid.step
  const fScale = (FRES - 1) / size

  function normal(x, z, target) {
    const t = target || new THREE.Vector3()
    const dhx = (height(x + eps, z) - height(x - eps, z)) / (2 * eps)
    const dhz = (height(x, z + eps) - height(x, z - eps)) / (2 * eps)
    return t.set(-dhx, 1, -dhz).normalize()
  }

  function slope(x, z) {
    const dhx = (height(x + eps, z) - height(x - eps, z)) / (2 * eps)
    const dhz = (height(x, z + eps) - height(x, z - eps)) / (2 * eps)
    const ny = 1 / Math.sqrt(dhx * dhx + dhz * dhz + 1)
    return Math.min(1, Math.acos(Math.min(1, ny)) / 1.5707963267948966)
  }

  function biome(x, z) {
    let gx = Math.round((x + half) * fScale)
    let gz = Math.round((z + half) * fScale)
    gx = gx < 0 ? 0 : gx > FRES - 1 ? FRES - 1 : gx
    gz = gz < 0 ? 0 : gz > FRES - 1 ? FRES - 1 : gz
    return BIOME_NAMES[biomes[gz * FRES + gx]]
  }

  function isWater(x, z) {
    const h = height(x, z)
    if (h < -0.02) return true
    const s = sampleField(fs, fs.riverDist, x, z)
    const hw = sampleField(fs, fs.riverHalfW, x, z)
    if (s < hw * 0.98) {
      const lv = sampleField(fs, fs.riverLevel, x, z)
      if (h < lv - 0.04) return true
    }
    return false
  }

  function onRoad(x, z) {
    const m = sampleField(fs, fs.roadMask, x, z)
    return m < 0 ? 0 : m > 1 ? 1 : m
  }

  function waterHeight(x, z) {
    const s = sampleField(fs, fs.riverDist, x, z)
    const hw = sampleField(fs, fs.riverHalfW, x, z)
    if (s < hw + 2.5) return sampleField(fs, fs.riverLevel, x, z)
    return SEA_LEVEL
  }

  // --- meta ---------------------------------------------------------------
  const riverMeta = resampleSpline(RIVER_PTS, 2.5, ['w', 'lv']).map((p) => ({
    x: p.x,
    z: p.z,
    y: p.lv,
    width: p.w,
    level: p.lv,
  }))
  let waterfallIndex = 0
  let bestD = Infinity
  for (let i = 0; i < riverMeta.length; i++) {
    const dx = riverMeta[i].x - WFALL_LIP.x
    const dz = riverMeta[i].z - WFALL_LIP.z
    const d2 = dx * dx + dz * dz
    if (d2 < bestD) {
      bestD = d2
      waterfallIndex = i
    }
  }
  const fallDx = WFALL_BASE.x - WFALL_LIP.x
  const fallDz = WFALL_BASE.z - WFALL_LIP.z
  const fallLen = Math.hypot(fallDx, fallDz) || 1

  const poi = POI_DEFS.map((p) => {
    let y
    if (p.kind === 'bridge') y = p.name.indexOf('Trestle') >= 0 ? 18.0 : 26.0
    else y = height(p.x, p.z)
    return { name: p.name, x: p.x, z: p.z, y, kind: p.kind }
  })

  const meta = {
    size,
    seaLevel: SEA_LEVEL,
    maxHeight: grid.maxH,
    minHeight: grid.minH,
    poi,
    river: { points: riverMeta, waterfallIndex },
    waterfall: {
      x: WFALL_LIP.x,
      z: WFALL_LIP.z,
      lipY: WFALL_LIP.y,
      baseY: WFALL_BASE.y,
      drop: WFALL_LIP.y - WFALL_BASE.y,
      width: 4.4,
      dir: { x: fallDx / fallLen, z: fallDz / fallLen },
    },
    roads: roadsMeta,
    extras: {
      pier: { x: -76, z: -8, y: 0.55, angle: Math.atan2(0.38, -0.92), length: 5 },
      fork: { x: -44, z: 2, y: height(-44, 2) },
      heroSpawn: { x: -38, z: 18, y: height(-38, 18) },
    },
  }

  function update(/* t, camera */) {
    // static stage — nothing animates here (water/scatter own their motion)
  }

  return { object3D, height, normal, slope, biome, isWater, onRoad, waterHeight, update, meta }
}
