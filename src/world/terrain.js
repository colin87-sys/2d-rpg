// ---------------------------------------------------------------------------
// src/world/terrain.js — Aetherbound overworld terrain (FRAMING.md solve)
//
// The stage of the frame01 diorama, rebuilt to the FRAMING §4 tabletop-
// miniature layout: everything the camera sees lives within ~90 m. A grass
// shelf at y ~10.4, the central limestone massif (bench lips y 13 / 15,
// grassy summit knob y 16.5 at (−32.5, +5.5)) with the 4 m waterfall off its
// E shoulder terrace, the castle plateau flat y 10.5, the hard-lipped west
// coast (lip y 8–8.5 straight into the sea), the inlet notch under the west
// trestle, a rolling north valley y 10–14, and the S-curve road graph.
//
// The heightfield is AUTHORED, not raw fBm: stacked bench STAMPS quantise
// every cliff zone into 1.5–2.5 m terraces in the GEOMETRY (flat lit shelf
// tops, near-vertical shadowed risers); the strata texture is gated by
// surface normal only — never banded by elevation isolines. All queries
// (height / normal / slope / biome / isWater / onRoad / waterHeight) read
// precomputed grids and are allocation-free; height() reproduces the
// rendered triangulation exactly, so anything snapped to it sits on the
// visible surface. Ground at (−38, +18) is exactly 10.4.
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

// Hard terrace shaping of the fractional step: a near-flat shelf (10 % of the
// step's rise spread over 93 % of its run) then a near-vertical riser over the
// last 7 %. C0 across steps. This is what turns slopes into stacked plateaus
// with lit tops and shadowed risers instead of striped clay ramps.
function terraceHard(fr) {
  const a = 0.93
  if (fr < a) return 0.1 * (fr / a)
  const u = (fr - a) / (1 - a)
  return 0.1 + 0.9 * u * u * (3 - 2 * u)
}

// Quantise a height into hard terrace benches of stepM metres, anchored so a
// bench top lands exactly at `anchor`. `wob` (m) wanders the bench edges in
// plan; `keep` controls how much wobble is subtracted back off shelf tops
// (1 = perfectly flat shelves, lower = gentle roll survives).
function benchify(hIn, anchor, stepM, wob, keep) {
  const t = (hIn + wob - anchor) / stepM
  const f = Math.floor(t)
  return anchor + (f + terraceHard(t - f)) * stepM - keep * wob
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
  // ROUND 3: back to the bible ramp verbatim. The terraces are now hard
  // GEOMETRY (flat sunlit bench tops, near-vertical risers), so the sun does
  // the lit-top / shadowed-riser separation — the albedo no longer needs a
  // lifted ramp to fake it, and the strata texture is gated strictly by
  // surface normal (never by elevation isolines).
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

// --- Coastline (FRAMING §4, BINDING): lip polyline (−53,+23) → (−57,+10.5)
// --- → (−63.5,−6.5) → (−72,−28) → (−79,−45), extended off-frame both ways.
// --- Land is d = x − coastX(z) > 0. Meander is kept tiny (±0.4 m) so the
// --- verified lip landmarks stay within tolerance.
const COAST_BREAKS = [
  // [z, x] — monotonic decreasing z, southmost first
  [256, -60.0],
  [120, -55.5],
  [60, -51.5],
  [40, -51.5],
  [23, -53.0],
  [10.5, -57.0],
  [-6.5, -63.5],
  [-28, -72.0],
  [-45, -79.0],
  [-80, -84.0],
  [-140, -90.0],
  [-256, -96.0],
]
function coastX(z) {
  let x
  if (z >= COAST_BREAKS[0][0]) x = COAST_BREAKS[0][1]
  else if (z <= COAST_BREAKS[COAST_BREAKS.length - 1][0]) x = COAST_BREAKS[COAST_BREAKS.length - 1][1]
  else {
    x = COAST_BREAKS[COAST_BREAKS.length - 1][1]
    for (let i = 0; i < COAST_BREAKS.length - 1; i++) {
      const a = COAST_BREAKS[i]
      const b = COAST_BREAKS[i + 1]
      if (z <= a[0] && z >= b[0]) {
        const t = (a[0] - z) / (a[0] - b[0] || 1e-6)
        x = lerp(a[1], b[1], t)
        break
      }
    }
  }
  return x + 0.4 * Math.sin(z * 0.23 + 1.7) + 0.25 * Math.sin(z * 0.61 + 4.1)
}

// --- River (FRAMING §4, BINDING). One downstream polyline: perched coastal
// --- headwater → under the north bridge (−41, −1) → falls lip (−30.5, +3)
// --- y 12.5 → 4 m FALLS → pool (−30, +2) y 8.5 → gorge run east between the
// --- massif E face and the castle backdrop, exiting at (−15, +8), then
// --- fading off-frame east. w = full width (m), lv = water surface (m).
const RIVER_PTS = [
  { x: -70, z: -110, w: 2.6, lv: 17.2 }, // fog-washed spring, far north coast
  { x: -68, z: -80, w: 2.6, lv: 16.2 },
  { x: -66, z: -58, w: 2.6, lv: 15.7 },
  { x: -64, z: -42, w: 2.8, lv: 15.2 },
  { x: -62, z: -30, w: 2.8, lv: 14.8 },
  { x: -59, z: -20, w: 3.0, lv: 14.4 },
  { x: -55, z: -12, w: 3.0, lv: 14.05 },
  { x: -51, z: -7, w: 3.0, lv: 13.75 },
  { x: -48, z: -3, w: 3.0, lv: 13.5 }, // §4 headwater start proper
  { x: -44, z: -2.2, w: 3.0, lv: 13.3 },
  { x: -41, z: -1, w: 3.0, lv: 13.15 }, // NORTH BRIDGE (deck y 13.5)
  { x: -38, z: -1.8, w: 3.0, lv: 13.0 },
  { x: -35, z: -2.6, w: 2.8, lv: 12.85 },
  { x: -32.5, z: -1.6, w: 2.6, lv: 12.7 }, // notch round the massif NE flank
  { x: -31, z: 0.5, w: 2.5, lv: 12.6 },
  { x: -30.5, z: 3, w: 2.5, lv: 12.5 }, // WATERFALL LIP (E shoulder terrace)
  { x: -30, z: 2, w: 4.2, lv: 8.5 }, // WATERFALL POOL — 4 m single drop
  { x: -28.6, z: 3.6, w: 4.4, lv: 8.3 },
  { x: -27.5, z: 5, w: 4.4, lv: 8.0 }, // small cascade y 8 → 7.5
  { x: -26.6, z: 5.6, w: 4.4, lv: 7.6 },
  { x: -24.5, z: 6.2, w: 4.6, lv: 7.5 },
  { x: -22, z: 6.5, w: 4.6, lv: 7.4 }, // §4 gorge waypoint
  { x: -18.5, z: 7.3, w: 4.8, lv: 7.15 },
  { x: -15, z: 8, w: 5.0, lv: 7.0 }, // §4: exits E behind the castle plateau
  { x: -10, z: 8.6, w: 5.2, lv: 6.8 },
  { x: -4, z: 9.4, w: 5.5, lv: 6.6 },
  { x: 6, z: 11, w: 6.0, lv: 6.3 },
  { x: 20, z: 13, w: 6.5, lv: 6.0 },
  { x: 45, z: 16, w: 7.0, lv: 5.5 },
  { x: 80, z: 22, w: 7.5, lv: 5.0 },
  { x: 130, z: 30, w: 8.0, lv: 4.4 },
  { x: 200, z: 42, w: 8.5, lv: 3.8 },
  { x: 250, z: 50, w: 9.0, lv: 3.4 }, // fades off the E map edge
]
const WFALL_LIP = { x: -30.5, z: 3, y: 12.5 }
const WFALL_BASE = { x: -30, z: 2, y: 8.5 }

// --- Sea inlet notch (FRAMING §4): cuts NE from the ocean at (−62, +13) to
// --- its head at (−55, +6); the west trestle bridge (−59, +9.5, deck 12)
// --- spans it. Water is sea level 0.
const INLET_PTS = [
  { x: -66, z: 15, w: 9.0 }, // open water mouth
  { x: -62, z: 13, w: 7.0 },
  { x: -59, z: 8.8, w: 5.0 }, // bridge crossing (deck midpoint −59, +9.5)
  { x: -56.5, z: 6.8, w: 3.6 },
  { x: -55, z: 6, w: 2.6 }, // inlet head
]

// --- Roads (FRAMING §4/§8, BINDING): S entry crosses the bottom edge near
// --- fw 0.57 through (−36, +31) → hero (−38, +18) → fork (−49.5, +8.5);
// --- W branch → inlet bridge; N branch switchback over the north bridge to
// --- the village; E branch → saddle → castle gate.
// --- Width 2.6 core + 1.2 feather each side (§5, unchanged).
const ROAD_DEFS = [
  {
    name: 'south', // bottom-edge entry → hero → fork
    pts: [
      { x: -30, z: 58 }, { x: -31.5, z: 50 }, { x: -33, z: 44 }, { x: -34.5, z: 38 },
      { x: -36, z: 31 } /* bottom-edge crossing, fw 0.57 */, { x: -37.3, z: 24 },
      { x: -38, z: 18 } /* hero anchor, ground exactly 10.4 */, { x: -39.8, z: 14 },
      { x: -43, z: 11 }, { x: -46.5, z: 9.3 }, { x: -49.5, z: 8.5 } /* fork */,
    ],
  },
  {
    name: 'castle', // hero → saddle (−31, +17) y 9.7 → castle gate (−24.8, +19.3)
    pts: [
      { x: -38, z: 18 }, { x: -35.5, z: 16.8 }, { x: -34, z: 16.5 }, { x: -32.5, z: 16.7 },
      { x: -31, z: 17 } /* saddle */, { x: -29, z: 18 }, { x: -27, z: 18.8 },
      { x: -24.8, z: 19.3 } /* gate arch */, { x: -23.2, z: 19.4 },
    ],
  },
  {
    name: 'west', // fork → inlet trestle bridge SE abutment
    pts: [
      { x: -49.5, z: 8.5 }, { x: -52.5, z: 9.2 }, { x: -54.3, z: 10.8 }, { x: -55.5, z: 13 },
    ],
  },
  {
    name: 'north', // fork → switchback → north bridge (−41, −1) → village
    pts: [
      { x: -49.5, z: 8.5 }, { x: -48, z: 5.5 }, { x: -47, z: 3 } /* §4 switchback */,
      { x: -44.5, z: 1 }, { x: -42.2, z: 1.8 }, { x: -41, z: 2.9 } /* S abutment */,
      { x: -41, z: -4.9 } /* N abutment */, { x: -42.5, z: -8 }, { x: -46, z: -12 },
      { x: -50.5, z: -16.5 } /* village */,
    ],
  },
]

// --- Wheat paddocks (FRAMING §4): P1 at the hero's E shoulder + its W lobe
// --- (wheat reads on BOTH shoulders), P2 south of it, the big SE field
// --- sprawling to z +38. rx ≥ rz kept for the fast bounds test.
const PADDOCKS = [
  { x: -37, z: 15.5, rx: 4.0, rz: 2.75, rot: 0.18 }, // P1, ~8×5.5
  { x: -40.5, z: 16, rx: 2.1, rz: 1.6, rot: -0.35 }, // P1 west lobe, ~3×4
  { x: -36.5, z: 22.5, rx: 6.0, rz: 3.5, rot: -0.10 }, // P2, ~12×7
  { x: -29.5, z: 28.5, rx: 7.0, rz: 4.5, rot: 0.28 }, // big SE field, ~14×9
  { x: -27.5, z: 34.5, rx: 5.5, rz: 3.8, rot: -0.15 }, // SE sprawl to z +38
]

// --- Flat pads. Castle plateau is its own authored stage (kind 'castle' is
// --- kept only so road points near the gate get pinned during grading).
const PADS = [
  { x: -23.5, z: 17, r: 8, h: 10.5, kind: 'castle' },
  { x: -50.5, z: -16.5, r: 7.5, h: 11.5, kind: 'village' },
  { x: -12, z: -12, r: 5, h: 12.0, kind: 'shrine' },
  { x: -32, z: 46, r: 6, h: 9.5, kind: 'camp' },
  { x: -37, z: 15.5, r: 6, h: 10.45, kind: 'farm' },
  // bridge abutments — decks must meet solid ground at both ends
  { x: -41, z: 2.9, r: 2.6, h: 13.5, kind: 'abutment' }, // north bridge S
  { x: -41, z: -4.9, r: 2.6, h: 13.5, kind: 'abutment' }, // north bridge N
  { x: -55.5, z: 13, r: 2.2, h: 12.0, kind: 'abutment' }, // inlet SE
  { x: -62.5, z: 6, r: 2.4, h: 12.0, kind: 'stack' }, // inlet NW sea-stack
]

// --- Forest stands (authored clump anchors): centre, radius, strength
const STANDS = [
  { x: -47.5, z: 27.5, r: 7, s: 1.0 }, // SW forest knoll — bottom-left mass
  { x: -53, z: 13, r: 6, s: 0.9 }, // forest band west of the fork
  { x: -51, z: 19, r: 5, s: 0.85 },
  { x: -32.5, z: 5.5, r: 3, s: 0.9 }, // massif summit knob landmark pines
  { x: -36.5, z: 8, r: 4, s: 0.5 }, // massif terrace conifers
  { x: -49.5, z: -12, r: 5, s: 0.85 }, // olive-gold autumn grove site
  { x: -45, z: -25, r: 6, s: 0.9 }, // north valley knoll woods
  { x: -28, z: -20, r: 6, s: 0.85 },
  { x: -38, z: -35, r: 10, s: 0.9 },
  { x: -20, z: -40, r: 8, s: 0.85 },
  { x: -13, z: 1, r: 6, s: 0.75 }, // backdrop cliffs east of the gorge
  { x: -22, z: 34, r: 6, s: 0.55 }, // SE lowland copses
  { x: -44, z: 40, r: 8, s: 0.7 },
  // fog band, top of frame and beyond
  { x: -52, z: -60, r: 15, s: 0.9 },
  { x: -15, z: -65, r: 14, s: 0.85 },
  { x: 15, z: -55, r: 12, s: 0.8 },
  { x: -70, z: -90, r: 16, s: 0.85 },
  { x: 40, z: -90, r: 18, s: 0.8 },
  { x: -30, z: -120, r: 20, s: 0.9 },
  { x: 10, z: -150, r: 20, s: 0.85 },
  { x: -60, z: -172, r: 20, s: 0.9 },
  { x: 60, z: -190, r: 24, s: 0.9 },
  { x: -10, z: -210, r: 24, s: 0.95 },
  { x: 148, z: -104, r: 30, s: 1.0 }, // NE ridge forest (out of shot)
  { x: 180, z: -140, r: 34, s: 1.0 },
  // south + east so free-orbit never shows bare plains
  { x: -30, z: 70, r: 14, s: 0.8 },
  { x: -62, z: 60, r: 12, s: 0.75 },
  { x: 12, z: 82, r: 14, s: 0.7 },
  { x: 60, z: 40, r: 14, s: 0.7 },
  { x: 90, z: -30, r: 18, s: 0.75 },
  { x: 150, z: 120, r: 20, s: 0.75 },
]

// POI table (FRAMING §8.4 — these exact coordinates; y snapped at build time)
const POI_DEFS = [
  { name: 'Grandpine Castle', x: -24.5, z: 16, kind: 'castle' },
  { name: 'Ferren Hamlet', x: -50.5, z: -16.5, kind: 'village' },
  { name: 'Windward Shrine', x: -12, z: -12, kind: 'shrine' },
  { name: 'Inlet Trestle', x: -59, z: 9.5, kind: 'bridge' },
  { name: 'North Gorge Bridge', x: -41, z: -1, kind: 'bridge' },
  { name: 'Paddock Farm', x: -37, z: 15.5, kind: 'farm' },
  { name: 'Roadside Camp', x: -32, z: 46, kind: 'camp' },
]

// --- Massif + cliff stamp constants (shared by the height author and the
// --- rock stencil so texture always agrees with geometry)
// `rise` is the stamp face's full descent (skirt bottom = top − rise); it is
// kept deep enough to duck under every neighbouring surface so smax stacking
// never floats a skirt — the VISIBLE band height is lip-to-lip (1.5–2.5 m).
const M_APRON = { cx: -35, cz: 4.5, rx: 10, rz: 11, top: 11.3, rise: 2.2, fw: 2.2, wob: 0.5 }
const M_TIER1 = { cx: -36.3, cz: 4, rx: 6.8, rz: 7.0, top: 13.0, rise: 4.0, fw: 1.6, wob: 0.5 }
const M_TIER2 = { cx: -34.5, cz: 4.5, rx: 3.6, rz: 3.8, top: 15.0, rise: 4.5, fw: 1.5, wob: 0.45 }
const M_KNOB = { cx: -33, cz: 6, rx: 3.9, rz: 3.0, top: 16.5, rise: 4.5, fw: 1.5, wob: 0.3 }
const M_SHLDR = { cx: -28.7, cz: 3.2, rx: 3.2, rz: 4.0, top: 12.5, rise: 4.5, fw: 1.4, wob: 0.4 }
const M_NFLNK = { cx: -36, cz: -5.5, rx: 6.0, rz: 3.2, top: 12.8, rise: 3.0, fw: 2.6, wob: 0.5 }
const BACKDROP = [
  { cx: -15.5, cz: 5, rx: 5.5, rz: 5.5, top: 13.0, rise: 3.5, fw: 1.5, wob: 0.5 },
  { cx: -9, cz: 3.5, rx: 6.2, rz: 5.8, top: 15.2, rise: 5.5, fw: 1.5, wob: 0.5 },
]
const KNOLLS = [
  { cx: -45, cz: -25, rx: 5.5, rz: 4.5, top: 13.4, rise: 3.4, fw: 1.5, wob: 0.5 },
  { cx: -45.5, cz: -24.5, rx: 3.2, rz: 2.6, top: 15.4, rise: 4.5, fw: 1.4, wob: 0.4 },
  { cx: -28, cz: -20, rx: 5.0, rz: 4.2, top: 13.2, rise: 3.4, fw: 1.5, wob: 0.5 },
  { cx: -27.6, cz: -20.3, rx: 2.9, rz: 2.5, top: 15.5, rise: 4.6, fw: 1.4, wob: 0.4 },
]

// Rock stencil: 1 on the massif's limestone benches (texture follows the
// stamp GEOMETRY, never elevation); the grassy summit knob is carved out.
function massifStoneAt(x, z) {
  if (x < -46 || x > -23 || z < -9 || z > 16) return 0
  let m = 0
  for (const t of [M_TIER1, M_TIER2, M_SHLDR]) {
    const er = ellipseR(x, z, t.cx, t.cz, t.rx, t.rz, 0)
    const v = sstep(1.08, 0.94, er)
    if (v > m) m = v
  }
  const erK = ellipseR(x, z, M_KNOB.cx, M_KNOB.cz, M_KNOB.rx * 0.92, M_KNOB.rz * 0.92, 0)
  return m * (1 - sstep(1.0, 0.78, erK))
}

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
  // clamp grade to 20 % by iterative relaxation; excess spreads across the
  // free interior, never into pinned points (the switchback climbs 11 → 13.5
  // in ~13 m, so 15 % could never converge between its pinned ends)
  const clampGrade = () => {
    for (let pass = 0; pass < 260; pass++) {
      let worst = 0
      for (let i = 0; i < n - 1; i++) {
        const ds = Math.max(0.25, pts[i + 1].s - pts[i].s)
        const maxDh = 0.2 * ds
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
          // §5: full-opacity core only inside ~1.4 m total, then a long soft
          // feather out to core+feather. The old 0.72→edge curve was nearly a
          // stencil (feather <15 % of width); this ramp is close to linear so
          // the shader can pass it through and the edges dissolve into grass.
          const m = sstep(ROAD_CORE + ROAD_FEATHER, ROAD_CORE * 0.55, d)
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

// One terraced bench stamp: flat top, near-vertical riser of `rise` metres
// over `fw` metres of run, ragged rim via noise wobble. Returns the stamped
// surface (combine with smax so stacked benches read as a stepped cake —
// the quantisation lives in the HEIGHTFIELD, not in the albedo).
function benchStamp(x, z, t, h) {
  const er = ellipseR(x, z, t.cx, t.cz, t.rx, t.rz, 0)
  const rEff = (t.rx + t.rz) * 0.5
  let mIn = (1 - er) * rEff
  if (t.wob > 0) mIn += t.wob * fbm(x * 0.23 + t.cx, z * 0.23 + t.cz, 2, 2.2, 0.5)
  if (mIn <= -0.3) return h
  const u = clamp01((mIn + 0.3) / (t.fw + 0.3))
  const surf = t.top - t.rise * (1 - sstep(0, 1, u)) + 0.06 * vnoise(x * 0.31 + t.cx, z * 0.31)
  return smax(h, surf, 0.45)
}

// The full height author (FRAMING §4/§8 — the tabletop-miniature world).
// `fs` is the field set; flags gate the road-grade and micro-detail stages
// so the road pre-pass can query virgin terrain.
function authorHeight(x, z, fs, useRoads, useMicro) {
  // ---- A. macro base: low rolling grassland; slow far-north/far-east rise
  let h = 9.8 + 1.1 * fbm(x * 0.012 + 11.3, z * 0.012, 3, 2.1, 0.5)
  const northT = sstep(-48, -210, z)
  h += 13.0 * Math.pow(northT, 1.2)
  const eastT = sstep(24, 128, x) * sstep(40, -60, z)
  h += 9.0 * eastT
  const neM = sstep(105, 148, x) * sstep(-70, -112, z)
  if (neM > 0) h += neM * (6.0 + 10.0 * ridged(x * 0.021, z * 0.021, 3))
  if (h > 40) h = 40 + (h - 40) * 0.35

  // ---- B. hero grass shelf (x −62…−16, z −2…+45, y 9.5…11.5) -------------
  {
    const m = boxMask(x, -62, -16, 10) * boxMask(z, -2, 45, 10)
    if (m > 0.001) {
      const shelf =
        10.15 +
        0.42 * fbm(x * 0.035 + 7.7, z * 0.035, 3, 2.1, 0.5) +
        0.22 * fbm(x * 0.09 + 2.3, z * 0.09, 3, 2.1, 0.5)
      h = lerp(h, shelf, m * 0.95)
    }
  }
  // SE field flats y 9.5 (big wheat field ground)
  {
    const m = boxMask(x, -36, -16, 7) * boxMask(z, 21, 42, 6)
    if (m > 0.001) h = lerp(h, 9.5 + 0.18 * fbm(x * 0.07 + 3.1, z * 0.07, 3, 2.1, 0.5), m)
  }
  // north valley: rolling low band y 10–14 (z −8…−45)
  {
    const m = boxMask(x, -72, -6, 12) * boxMask(z, -46, -6, 8)
    if (m > 0.001) {
      const valley = 11.4 + 1.4 * fbm(x * 0.03 + 4.9, z * 0.03, 3, 2.1, 0.5)
      h = lerp(h, valley, m * 0.9)
    }
  }

  // ---- C. flat pads: village / shrine / camp / farm ----------------------
  // (castle plateau is stage E; bridge abutments come after the carves)
  for (let i = 0; i < PADS.length; i++) {
    const p = PADS[i]
    if (p.kind === 'castle' || p.kind === 'abutment' || p.kind === 'stack') continue
    const dx = x - p.x
    const dz = z - p.z
    const d2 = dx * dx + dz * dz
    if (d2 > p.r * p.r * 1.9) continue
    const d = Math.sqrt(d2)
    const m = sstep(p.r * 1.32, p.r * 0.58, d)
    if (m > 0.001) h = lerp(h, p.h + 0.1 * vnoise(x * 0.3 + i, z * 0.3), m)
  }

  // ---- D. SW forest knoll (−47.5, +27.5), crown y 12 + fork rise ---------
  h = benchStamp(x, z, { cx: -47.5, cz: 27.5, rx: 7, rz: 5, top: 12.0, rise: 2.6, fw: 3.5, wob: 0.6 }, h)
  h = benchStamp(x, z, { cx: -49.5, cz: 8.5, rx: 4, rz: 3.5, top: 11.05, rise: 1.3, fw: 2.5, wob: 0.3 }, h)

  // ---- E. central limestone massif — the frame's structural anchor -------
  // Stacked bench stamps: grassy apron toe (y ~11 at (−36.5, +13.5)), two
  // limestone bands with lips at y 13 and y 15, the grassy summit knob at
  // y 16.5 (−32.5, +5.5), the E shoulder falls terrace y 12.5, and the N
  // flank descending to ~13 by z −8. Each riser is 1.5–2.8 m of REAL
  // geometry — flat lit top, near-vertical shadowed face.
  if (x > -50 && x < -20 && z > -12 && z < 18) {
    h = benchStamp(x, z, M_APRON, h)
    h = benchStamp(x, z, M_TIER1, h)
    h = benchStamp(x, z, M_TIER2, h)
    h = benchStamp(x, z, M_KNOB, h)
    h = benchStamp(x, z, M_SHLDR, h)
    h = benchStamp(x, z, M_NFLNK, h)
  }

  // ---- F. castle plateau: flat y 10.5, x −30…−17, z +12…+22 --------------
  {
    const dcp =
      sdRoundBox(x, z, -23.5, 17, 6.5, 5.0, 0, 2.2) +
      0.35 * fbm(x * 0.14 + 1.1, z * 0.14, 2, 2.2, 0.5)
    if (dcp < 2.0) {
      const top = 10.5 + 0.05 * vnoise(x * 0.25 + 3.3, z * 0.25)
      const w = sstep(1.6, -0.8, dcp) // crisp 1 m riser: S cliff to 9.5 etc.
      h = lerp(h, top, w)
    }
  }
  // saddle (−31, +17) y 9.7 on the road to the castle gate
  {
    const dsq = (x + 31) * (x + 31) + (z - 17) * (z - 17)
    if (dsq < 22) {
      const w = Math.exp(-dsq / 4.5)
      if (h > 9.7) h = lerp(h, 9.7, w * 0.92)
    }
  }

  // ---- G. backdrop cliffs (x −20…−2, z −2…+12, y 12–16, hazed) + north
  // ---- valley knolls (y 15–16 near (−45, −25) and (−28, −20)) ------------
  if (x > -24 && x < 0 && z > -8 && z < 14) {
    for (let i = 0; i < BACKDROP.length; i++) h = benchStamp(x, z, BACKDROP[i], h)
  }
  if (z > -32 && z < -12 && x > -54 && x < -20) {
    for (let i = 0; i < KNOLLS.length; i++) h = benchStamp(x, z, KNOLLS[i], h)
  }

  // ---- H. west coast: hard lip y 8–8.5, near-vertical banded face to sea -
  {
    let d = x - coastX(z)
    if (d < 6.0) {
      const lipY = 8.35 + 0.12 * vnoise(z * 0.13 + 6.6, 3.3) // lip y 8.23–8.47
      // beach cove (−78, −40) and the small pier cove (−64.8, −16.3): the
      // cove pulls the effective coastline inland so the pocket floods to a
      // shallow sandy bay instead of holding the cliff wall
      const cove = Math.max(
        Math.exp(-((x + 78) * (x + 78) + (z + 40.5) * (z + 40.5)) / 46),
        Math.exp(-((x + 64.8) * (x + 64.8) + (z + 16.3) * (z + 16.3)) / 22)
      )
      d -= 6.5 * cove
      if (d > -1.1) {
        // shelf → lip: hold a level lip crest, blend to inland within ~4 m
        const w = 1 - sstep(1.0, 4.0, d)
        h = lerp(h, lipY, w)
      } else {
        // the face: near-vertical drop quantised into 1.8–2.6 m strata
        // benches (geometry, not stripes), then the sea floor
        const faceW = 2.6
        const t = clamp01((-1.1 - d) / faceW)
        const floor = -0.5 - 5.4 * sstep(1.5, 11, -d) + 0.25 * fbm(x * 0.05 + 2.8, z * 0.05, 2, 2.2, 0.5)
        let hh = lerp(lipY, floor, sstep(0, 1, Math.pow(t, 0.85)))
        if (hh > 0.8 && cove < 0.25) {
          const wobg = 0.8 * fbm(z * 0.11 + 3.3, x * 0.11, 2, 2.2, 0.5)
          hh = clamp(benchify(hh, lipY, 2.1 + 0.5 * vnoise(z * 0.09 + 8.2, 2.7), wobg, 0.8), floor, lipY)
        }
        h = Math.min(h, hh)
      }
    }
  }

  // ---- I. sea inlet notch (west trestle bridge site, water y 0) ----------
  {
    const s = sampleField(fs, fs.inletDist, x, z)
    const hw = sampleField(fs, fs.inletHalfW, x, z)
    if (s < hw * 1.1) {
      const u = clamp01(s / hw)
      const carve = -1.1 + 0.4 * u * u + Math.pow(u, 3.2) * 11.5
      if (carve < h) h = carve
    }
  }

  // ---- J. river: perched headwater with hugging banks, the 4 m falls face,
  // ---- and the walled gorge run (floor 4–6 m between real cliff walls) ---
  {
    const s = sampleField(fs, fs.riverDist, x, z)
    const hw = sampleField(fs, fs.riverHalfW, x, z)
    const bankW = 3.2
    if (s < hw + bankW) {
      const lv = sampleField(fs, fs.riverLevel, x, z)
      const gorge = sstep(11.5, 9.8, lv) // 1 on the gorge run, 0 on headwater
      if (s < hw) {
        // bed: shallow rocky channel (deep enough to read as water; the
        // gorge run stays shallower so its floor sits near the §4 levels)
        const depth = lerp(0.62, 0.35, gorge)
        const bed = lv - depth + Math.pow(s / hw, 2) * depth * 0.5
        if (bed < h) h = bed
      } else {
        const u = (s - hw) / bankW
        const bankY = lv + 0.3 + 2.4 * u * u
        const w = 1 - sstep(0.62, 1.0, u)
        if (h < bankY) h = lerp(h, bankY, w) // fill low ground: hold the water
        else {
          // headwater: CUT gently-high banks down to a hugging grass lip so
          // the stream reads as open water from the 28° camera — but never
          // shave real cliffs (> ~2 m over the bank line: the summit knob,
          // the massif NE notch walls). Gorge run: keep a narrow floor
          // margin + one mid-ledge bench, then let the stamped cliff walls
          // stand — the falls face and slot walls come free.
          const over = h - bankY
          const hug = lerp(h, bankY, w * sstep(2.4, 1.0, over)) // shave low banks only
          let walled = h
          if (u < 0.42) walled = Math.min(walled, lv + 0.35) // floor margin
          else if (u < 0.78) walled = Math.min(walled, lv + 2.3) // mid-ledge bench
          h = lerp(hug, walled, gorge)
        }
      }
    }
    // bedrock sill at the falls lip (−30.5, +3) y 12.5: the hard limestone
    // edge the sheet pours over — keeps the lip at the verified height even
    // though the channel field blends levels across the 4 m drop. Gated to
    // the UPSTREAM half-plane (pool→lip direction) so the plunge pool below
    // the face is never raised.
    const dl2 = (x + 30.5) * (x + 30.5) + (z - 3) * (z - 3)
    if (dl2 < 2.9 && (x + 30.5) * -0.447 + (z - 3) * 0.894 > -0.35) {
      const sill = 12.45 - 0.55 * Math.sqrt(dl2)
      if (h < sill) h = sill
    }
  }

  // ---- K. bridge abutments + the inlet NW sea-stack (after the carves) ---
  for (let i = 0; i < PADS.length; i++) {
    const p = PADS[i]
    if (p.kind !== 'abutment' && p.kind !== 'stack') continue
    const dx = x - p.x
    const dz = z - p.z
    const d2 = dx * dx + dz * dz
    if (d2 > p.r * p.r * 1.9) continue
    const d = Math.sqrt(d2)
    const m = sstep(p.r * 1.32, p.r * 0.58, d)
    if (m < 0.001) continue
    if (p.kind === 'stack') {
      // stone pillar footing rising out of the inlet mouth
      h = Math.max(h, lerp(h, p.h + 0.1 * vnoise(x * 0.3 + i, z * 0.3), sstep(p.r * 1.1, p.r * 0.5, d)))
    } else if (h > p.h - 6) {
      h = lerp(h, p.h + 0.1 * vnoise(x * 0.3 + i, z * 0.3), m)
    }
  }

  // ---- L. road grading ---------------------------------------------------
  if (useRoads) {
    const m = sampleField(fs, fs.roadMask, x, z)
    if (m > 0.004) {
      const rh = sampleField(fs, fs.roadH, x, z)
      if (rh !== 0) h = lerp(h, rh, Math.min(1, m * 1.2) * 0.965)
    }
  }

  // ---- M. micro detail, masked off roads / fields / beds / crisp lips ----
  if (useMicro) {
    let protect = 0
    if (useRoads) protect = Math.min(1, sampleField(fs, fs.roadMask, x, z) * 1.35)
    const fm = fieldMaskAt(x, z)
    if (fm > protect) protect = fm
    const rs = sampleField(fs, fs.riverDist, x, z)
    const rw = sampleField(fs, fs.riverHalfW, x, z)
    if (rs < rw + 1.2) protect = 1
    // keep the verified landmarks crisp: summit knob crown, castle plateau
    // core, the coast lip band
    const erK = ellipseR(x, z, M_KNOB.cx, M_KNOB.cz, M_KNOB.rx, M_KNOB.rz, 0)
    protect = Math.max(protect, sstep(0.9, 0.6, erK))
    if (x > -29 && x < -18 && z > 13 && z < 21) protect = 1
    const dCoast = x - coastX(z)
    if (dCoast > -3.4 && dCoast < 2.0) protect = Math.max(protect, 0.8)
    const det =
      0.24 * fbm(x * 0.115 + 1.6, z * 0.115, 2, 2.2, 0.5) +
      0.09 * fbm(x * 0.33 + 8.4, z * 0.33, 2, 2.2, 0.5)
    h += det * (1 - 0.9 * protect)
  }

  // ---- N. hard ceilings (FRAMING §8.5) -----------------------------------
  if (x > -50 && x < -20 && z > -10 && z < 15 && h > 17) h = 17 // massif crown is the local max
  if (z < -8 && z > -47 && h > 16) h = 16 // north valley band (z −8…−45 + mesh feather)

  // ---- O. hero anchor: ground at (−38, +18) is EXACTLY 10.4 --------------
  {
    const dsq = (x + 38) * (x + 38) + (z - 18) * (z - 18)
    if (dsq < 30) h += (10.4 - h) * Math.exp(-dsq / 7)
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
  const ctrlB = new Uint8Array(FRES * FRES * 4) // curvature (0.5-neutral), riverbed, sand, forest floor
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

      // bipolar curvature: concavities darken (AO), convex ridge breaks get
      // worn dry earth in the splat. Encoded 0.5-neutral in ctrlB.r.
      const r1 = 2.2
      const r2 = 5.0
      const avg1 =
        (height(x + r1, z) + height(x - r1, z) + height(x, z + r1) + height(x, z - r1)) * 0.25
      const avg2 =
        (height(x + r2, z) + height(x - r2, z) + height(x, z + r2) + height(x, z - r2)) * 0.25
      const cav = clamp01((avg1 - h) * 0.42 + (avg2 - h) * 0.16)
      const ridge = clamp01((h - avg1) * 0.34 + (h - avg2) * 0.12)

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

      // rock stencil: steep faces by NORMAL (never by elevation) + the
      // massif's limestone benches by stamp geometry, grassy knob carved out
      const stone = massifStoneAt(x, z)
      const rockF = Math.max(sstep(0.86, 0.6, ny), stone * 0.95)
      const bedM = rs < rw * 1.08 ? 1 - sstep(rw * 0.8, rw * 1.08, rs) : 0
      // sand: the beach cove (−78, −40) + pier pocket (−64.8, −16.3) +
      // submerged shore shelf only — the open coast is cliff-into-surf
      const dCove = Math.min(Math.hypot(x + 78, z + 40.5), Math.hypot(x + 64.8, z + 16.3))
      const sandM = Math.max(
        sstep(10, 5.5, dCove) * sstep(1.7, 0.35, h),
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
      else if (ny < 0.74 || stone > 0.6) b = B_ROCK
      else if (forestM > 0.5 && h > 1) b = B_FOREST
      biomes[idx] = b

      ctrlA[i4] = (clamp01(roadM) * 255) | 0
      ctrlA[i4 + 1] = (rockF * 255) | 0
      ctrlA[i4 + 2] = (clamp01(fieldM) * 255) | 0
      ctrlA[i4 + 3] = (clamp01(wet) * 255) | 0
      ctrlB[i4] = (clamp01(0.5 + cav * 0.5 - ridge * 0.5) * 255) | 0
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
// Band count is tuned to the terrace geometry: ~15 chunky strata per tile at
// the shader's /14 wall scale ≈ 0.9–1 m per stratum → 6–8 visible bands per
// 5.4–7.8 m terrace riser (frame01's banding), not high-frequency corduroy.
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
  const cycle = [PAL.CLIFF_LIT, PAL.CLIFF_MID, PAL.CLIFF_LIT, PAL.CLIFF_SHADOW, PAL.CLIFF_MID]
  let ci = 0
  while (acc < S) {
    const t = 10 + (rnd() * 14) | 0
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

// --- Rock TOP: weathered flat limestone for shelf tops. NO strata bands —
// --- horizontal bands projected top-down are what read as contour rings.
function paintRockTop(rnd, renderer) {
  const S = 256
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')
  g.fillStyle = cssHex(PAL.CLIFF_MID)
  g.fillRect(0, 0, S, S)

  // broad tonal blotches
  for (let i = 0; i < 58; i++) {
    const x = rnd() * S
    const y = rnd() * S
    const r = 10 + rnd() * 30
    g.globalAlpha = 0.1 + rnd() * 0.1
    g.fillStyle = cssHex(rnd() < 0.55 ? PAL.CLIFF_LIT : PAL.CLIFF_SHADOW)
    wrapped(g, S, x, y, r, (px, py) => {
      g.beginPath()
      g.arc(px, py, r, 0, Math.PI * 2)
      g.fill()
    })
  }
  g.globalAlpha = 1

  // flat fracture slabs: lit top-left edges, dark bottom-right edges
  for (let i = 0; i < 90; i++) {
    const x = (rnd() * S) | 0
    const y = (rnd() * S) | 0
    const w = 6 + (rnd() * 14) | 0
    const hh = 5 + (rnd() * 10) | 0
    wrapped(g, S, x, y, 26, (px, py) => {
      g.fillStyle = cssShade(PAL.CLIFF_MID, 0.94 + hash2(px | 0, py | 0) * 0.12)
      g.fillRect(px, py, w, hh)
      g.fillStyle = cssShade(PAL.CLIFF_LIT, 1.04)
      g.fillRect(px, py, w, 1)
      g.fillRect(px, py, 1, hh)
      g.fillStyle = cssHex(PAL.CLIFF_SHADOW)
      g.fillRect(px, py + hh - 1, w, 1)
      g.fillRect(px + w - 1, py, 1, hh)
    })
  }

  // grain
  for (let i = 0; i < 1900; i++) {
    const x = rnd() * S
    const y = rnd() * S
    const pick = rnd()
    g.fillStyle =
      pick < 0.4 ? cssShade(PAL.CLIFF_MID, 0.9) : pick < 0.75 ? cssShade(PAL.CLIFF_LIT, 0.97) : cssHex(PAL.CLIFF_SHADOW)
    wrapped(g, S, x, y, 2, (px, py) => g.fillRect(px | 0, py | 0, 1, 1))
  }

  // meandering crevice cracks
  g.fillStyle = cssHex(PAL.CLIFF_CREVICE)
  for (let i = 0; i < 30; i++) {
    let x = (rnd() * S) | 0
    let y = (rnd() * S) | 0
    const len = 8 + (rnd() * 22) | 0
    let dx = rnd() < 0.5 ? 1 : -1
    let dy = rnd() < 0.5 ? 1 : 0
    for (let j = 0; j < len; j++) {
      wrapped(g, S, x, y, 2, (px, py) => g.fillRect(px | 0, py | 0, 1, 1))
      x = (x + dx + S) % S
      y = (y + dy + S) % S
      if (rnd() < 0.25) dy = ((rnd() * 3) | 0) - 1
      if (rnd() < 0.15) dx = rnd() < 0.5 ? 1 : -1
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
    uRockTop: { value: paintRockTop(rnd, renderer) },
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
uniform sampler2D uRockTop;
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

  // ---- grass: two detail frequencies + layered macro mottle ----
  // frame01's pasture is never one flat green: ±18 % value swing at ~30–90 m,
  // a second mid-frequency swing at ~10 m, warm dry patches, deep cool
  // patches, and pale worn earth showing through on convex ridge breaks.
  vec3 g1 = texture2D(uGrass, wxz / 7.3).rgb;
  vec3 g2 = texture2D(uGrass, wxz / 1.87).rgb;
  vec3 grass = mix(g1, g2, 0.45);
  grass *= mix(vec3(0.82, 0.87, 0.74), vec3(1.17, 1.14, 1.02), mac.r);
  grass *= mix(0.93, 1.06, mac.b);
  grass  = mix(grass, grass * vec3(1.16, 1.06, 0.70), smoothstep(0.58, 0.85, mac2.g) * 0.5);
  grass  = mix(grass, grass * vec3(0.70, 0.82, 0.73), smoothstep(0.60, 0.88, mac.g) * 0.45);
  float ridgeQ = max(1.0 - cB.r * 2.0, 0.0); // ctrlB.r is bipolar, 0.5 = flat
  vec3 earth = texture2D(uDirt, wxz / 6.1).rgb * vec3(0.95, 0.89, 0.80);
  float wear = ridgeQ * smoothstep(0.78, 0.93, nrm.y) * (0.25 + 0.75 * smoothstep(0.45, 0.80, mac2.r));
  grass  = mix(grass, earth, clamp(wear, 0.0, 1.0) * 0.5);
  grass  = mix(grass, grass * vec3(0.55, 0.68, 0.56), cB.a * 0.70); // forest floor

  // ---- wheat field ----
  vec3 fld = texture2D(uField, wxz / 4.6).rgb;
  fld *= mix(0.90, 1.10, mac2.r);

  // ---- road: pale packed core, darker feathered shoulders. The mask field
  // ---- is now a near-linear 2.6 m-core + 1.2 m-feather ramp (§5) ----
  vec3 road = mix(texture2D(uDirt, wxz / 5.3).rgb, texture2D(uDirt, wxz / 1.43).rgb, 0.40);
  float rCore = smoothstep(0.55, 0.95, cA.r);
  road *= mix(vec3(0.82, 0.78, 0.73), vec3(1.06), rCore);
  road *= mix(0.94, 1.06, mac.g);

  // ---- rock: strata are gated by SURFACE NORMAL, never by elevation ----
  // The terraces are quantised in the heightfield, so risers are genuinely
  // near-vertical (ny < ~0.5) and bench tops genuinely flat. The banded
  // strata texture exists ONLY on those near-vertical faces (where its
  // horizontal layering is real bedding, not an isoline); everything
  // flatter — bench tops, shoulders, blend cells — gets the weathered flat
  // limestone. A stripe can therefore never trace an elevation contour
  // across a walkable slope. ~15 bands per 8 m tile ≈ 0.55 m per stratum
  // → 3–4 bands per 1.5–2.5 m riser (frame01's miniature banding); a slow
  // vertical phase wander (uMacro at ~90 m) breaks band-phase repetition.
  float axf = smoothstep(0.35, 0.65, abs(nrm.x) / (abs(nrm.x) + abs(nrm.z) + 1e-4));
  float sph = (mac.g - 0.5) * 4.0;
  vec3 wallC = mix(texture2D(uRock, vec2(vWPos.x, -vWPos.y + sph) / 8.0).rgb,
                   texture2D(uRock, vec2(vWPos.z, -vWPos.y + sph) / 8.0).rgb, axf);
  vec3 wallF = mix(texture2D(uRock, vec2(vWPos.x, -vWPos.y) / 4.2).rgb,
                   texture2D(uRock, vec2(vWPos.z, -vWPos.y) / 4.2).rgb, axf);
  vec3 rock = mix(wallC, wallF, 0.15);
  rock = mix(rock, texture2D(uRockTop, wxz / 9.5).rgb, smoothstep(0.30, 0.55, nrm.y));
  rock *= mix(0.90, 1.10, mac.r);

  vec3 sand = texture2D(uSand, wxz / 3.1).rgb;

  // ---- layer masks ----
  // was smoothstep(0.66, 0.86): 40° shoulders came out 55 % rock, which spread
  // the strata banding across gentle grass slopes. Rock now belongs to real
  // cliff faces (and wherever the terrain explicitly stencils it in cA.g).
  float rockM = max(1.0 - smoothstep(0.58, 0.79, nrm.y), cA.g * 0.9);
  rockM = clamp(rockM + (mac2.b - 0.5) * 0.22, 0.0, 1.0);
  float moss = smoothstep(0.80, 0.93, nrm.y) * (1.0 - smoothstep(0.30, 0.60, cA.g))
             * smoothstep(0.45, 0.85, mac2.r) * 0.6;
  rockM *= 1.0 - moss;

  vec3 col = grass;
  col = mix(col, sand, cB.b * (1.0 - rockM));
  col = mix(col, fld, cA.b * (1.0 - rockM));
  float roadM = smoothstep(0.03, 0.97, cA.r + (mac2.g - 0.5) * 0.12) * (1.0 - rockM * 0.85);
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

  // ---- cavity AO (ctrlB.r bipolar: >0.5 concave): grounds cliff bases ----
  float cavQ = max(cB.r * 2.0 - 1.0, 0.0);
  col *= mix(1.0, 0.70, cavQ * (1.0 - rockM * 0.35));

  diffuseColor.rgb = col;
}`
      )
  }
  mat.customProgramCacheKey = () => 'aetherbound-terrain-splat-v2'
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
    // already the pad level, and grading must not smear ramps across pads.
    // The hero anchor (−38, +18) is pinned too — its pre-height is exactly
    // 10.4 (stage O), and grading must never move it.
    const pinned = res.map((p) => {
      if (Math.hypot(p.x + 38, p.z - 18) < 1.1) return true // hero, exactly 10.4
      if (Math.hypot(p.x + 31, p.z - 17) < 1.1) return true // saddle dip y 9.7
      for (const pad of PADS) {
        const dc = Math.hypot(p.x - pad.x, p.z - pad.z)
        const rr = pad.kind === 'castle' ? 5.0 : pad.r * 0.6
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
  // meta.river keeps the FULL course (the minimap draws it); meta.rivers
  // splits it at the falls so water.js (which prefers meta.rivers) never
  // builds a ribbon draped down the cliff face — the falls sheets own the
  // lip → pool drop.
  const riverMeta = resampleSpline(RIVER_PTS, 2.5, ['w', 'lv']).map((p) => ({
    x: p.x,
    z: p.z,
    y: p.lv,
    width: p.w,
    level: p.lv,
  }))
  let waterfallIndex = 0
  let bestD = Infinity
  let baseIndex = 0
  let bestBaseD = Infinity
  for (let i = 0; i < riverMeta.length; i++) {
    const dx = riverMeta[i].x - WFALL_LIP.x
    const dz = riverMeta[i].z - WFALL_LIP.z
    const d2 = dx * dx + dz * dz
    if (d2 < bestD) {
      bestD = d2
      waterfallIndex = i
    }
    const bx = riverMeta[i].x - WFALL_BASE.x
    const bz = riverMeta[i].z - WFALL_BASE.z
    const b2 = bx * bx + bz * bz
    if (b2 < bestBaseD) {
      bestBaseD = b2
      baseIndex = i
    }
  }
  const riverUpper = riverMeta.slice(0, waterfallIndex + 1)
  const riverLower = riverMeta.slice(Math.max(baseIndex, waterfallIndex + 1))
  const fallDx = WFALL_BASE.x - WFALL_LIP.x
  const fallDz = WFALL_BASE.z - WFALL_LIP.z
  const fallLen = Math.hypot(fallDx, fallDz) || 1

  const poi = POI_DEFS.map((p) => {
    let y
    if (p.kind === 'bridge') y = p.name.indexOf('Inlet') >= 0 ? 12.0 : 13.5 // deck heights (§4)
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
    rivers: [
      { name: 'headwater', points: riverUpper }, // ends exactly on the lip
      { name: 'lowland', points: riverLower }, // starts at the falls base/pool
    ],
    // lip/pool objects are the shape water.js's resolver consumes; the flat
    // x/z/lipY/baseY/drop/dir fields stay for the HUD + older readers.
    waterfall: {
      lip: { x: WFALL_LIP.x, y: WFALL_LIP.y, z: WFALL_LIP.z },
      pool: { x: WFALL_BASE.x, y: WFALL_BASE.y, z: WFALL_BASE.z },
      x: WFALL_LIP.x,
      z: WFALL_LIP.z,
      lipY: WFALL_LIP.y,
      baseY: WFALL_BASE.y,
      drop: WFALL_LIP.y - WFALL_BASE.y, // 4 m single drop (§4)
      width: 2.5,
      dir: { x: fallDx / fallLen, z: fallDz / fallLen },
    },
    roads: roadsMeta,
    extras: {
      pier: { x: -64, z: -16, y: 0.55, angle: Math.atan2(0.38, -0.92), length: 5 },
      fork: { x: -49.5, z: 8.5, y: height(-49.5, 8.5) },
      heroSpawn: { x: -38, z: 18, y: height(-38, 18) },
    },
  }

  function update(/* t, camera */) {
    // static stage — nothing animates here (water/scatter own their motion)
  }

  return { object3D, height, normal, slope, biome, isWater, onRoad, waterHeight, update, meta }
}
