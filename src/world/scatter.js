// ---------------------------------------------------------------------------
// src/world/scatter.js — vegetation & rock scatter for the frame01 diorama.
//
// ~20k pixel-art billboards (trees, bushes, rocks, tufts, wheat, flowers,
// blossoms, bamboo, cattails, lilypads) placed deterministically over the
// authored terrain with the ART_BIBLE §8 placement law: CLUMPS + VOIDS,
// never carpet. Dense overlapping forest stands with ragged noise-eaten
// edges and interior clearings; genuinely empty pasture between; trees
// crowding road shoulders, cliff lips and river banks; wheat only inside
// the farm paddock fields; one designated blossom valley + a bamboo stand
// by the village; rocks on high slope and scree at cliff feet.
//
// Rendering: ONE InstancedMesh for every upright billboard (single draw
// call over the shared atlas), Y-axis-locked billboarding done in the
// vertex shader, per-instance atlas UV rects / tint / wind phase, alpha
// cutout (no blending), lit by the scene's sun + hemisphere + fog through
// a patched MeshLambertMaterial, casting real shadows via a matching
// customDepthMaterial. A second InstancedMesh lays soft elliptical
// contact-shadow decals on the ground under everything; a third renders
// the flat-on-water lilypads. 8×8 world-cell frustum culling + far fade.
//
// Contract (frozen): createScatter({ terrain, atlas, renderer })
//   -> { object3D, update(t, camera), count }
// ---------------------------------------------------------------------------

import * as THREE from 'three'

// ===========================================================================
// 1. Deterministic RNG + tiny value-noise field (self-contained, fixed seed —
//    the scatter must reproduce the same forest every boot)
// ===========================================================================

const MASTER_SEED = 0x5ca77e12

function mulberry32(seed) {
  let a = seed | 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashStr(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const rngFor = (name) => mulberry32(hashStr(name) ^ MASTER_SEED)

// Position-stable hash in [0,1): identical for a coordinate regardless of
// visit order, so budget caps never re-shuffle the layout.
function hash2(x, y, k) {
  let h = Math.imul((x * 8192) | 0, 374761393) + Math.imul((y * 8192) | 0, 668265263) + Math.imul(k | 0, 2246822519)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

// Value noise (for the forest mask / clearing carve / flower drifts).
const NPERM = new Uint8Array(512)
const NGRAD = new Float32Array(256)
{
  const rnd = mulberry32(MASTER_SEED ^ 0x9e3779b9)
  const p = new Uint8Array(256)
  for (let i = 0; i < 256; i++) p[i] = i
  for (let i = 255; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0
    const t = p[i]
    p[i] = p[j]
    p[j] = t
  }
  for (let i = 0; i < 512; i++) NPERM[i] = p[i & 255]
  for (let i = 0; i < 256; i++) NGRAD[i] = rnd() * 2 - 1
}

function vnoise(x, y) {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const X = xi & 255
  const Y = yi & 255
  const a = NGRAD[NPERM[X + NPERM[Y]]]
  const b = NGRAD[NPERM[X + 1 + NPERM[Y]]]
  const c = NGRAD[NPERM[X + NPERM[Y + 1]]]
  const d = NGRAD[NPERM[X + 1 + NPERM[Y + 1]]]
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

function fbm2(x, y, oct) {
  let amp = 1
  let sum = 0
  let norm = 0
  for (let i = 0; i < oct; i++) {
    sum += vnoise(x, y) * amp
    norm += amp
    amp *= 0.5
    x = x * 2.03 + 17.1
    y = y * 2.03 + 9.7
  }
  return sum / norm // ~[-1, 1]
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const lerp = (a, b, t) => a + (b - a) * t
function sstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

// ===========================================================================
// 2. SPECIES TABLE — art-bible §5 scale chart, §8 wind, per-species limits.
//    baseH is the world-height *mode* in metres; the mandatory per-instance
//    jitter is height ×U(0.82, 1.24) with independent ±8 % width jitter.
// ===========================================================================

// kind: coarse class used by placement / shadow rules.
// slopeMax: reject above this terrain.slope (0 flat → 1 vertical).
// clearR: crown collision radius factor (× half-width) vs other placed items.
// sway: wind amplitude in radians at the crown (bible: trees 0.8–1.2°,
//       wheat ×2, tufts ×1.5); rocks/wood 0.
// blobA: contact-shadow decal alpha class (0 = none).
// hueAmp: per-instance hue jitter amplitude (R↔B channel skew). Frame01 shows
// STRONG hue variety between neighbouring crowns — olive, yellow-green and
// blue-green in one stand — so trees swing far wider than ground cover.
// clearR for trees is tuned so crowns OVERLAP 20–40 % inside clumps (bible §8:
// spacing 1.2–2.2 m, no visible ground) — round 1's 0.55 kept every crown
// isolated and read as park scatter.
const SPECIES = {
  pine_a:   { kind: 'tree',  baseH: 2.80, slopeMax: 0.55, clearR: 0.38, sway: 0.017, blobA: 0.50, hueAmp: 0.085 },
  pine_b:   { kind: 'tree',  baseH: 2.65, slopeMax: 0.55, clearR: 0.38, sway: 0.017, blobA: 0.50, hueAmp: 0.085 },
  pine_c:   { kind: 'tree',  baseH: 2.95, slopeMax: 0.55, clearR: 0.38, sway: 0.017, blobA: 0.50, hueAmp: 0.085 },
  pine_snow:{ kind: 'tree',  baseH: 2.75, slopeMax: 0.60, clearR: 0.38, sway: 0.015, blobA: 0.46, hueAmp: 0.05 },
  oak_a:    { kind: 'tree',  baseH: 1.95, slopeMax: 0.42, clearR: 0.36, sway: 0.016, blobA: 0.50, hueAmp: 0.15 },
  oak_b:    { kind: 'tree',  baseH: 1.85, slopeMax: 0.42, clearR: 0.36, sway: 0.016, blobA: 0.50, hueAmp: 0.15 },
  oak_c:    { kind: 'tree',  baseH: 2.05, slopeMax: 0.42, clearR: 0.36, sway: 0.016, blobA: 0.50, hueAmp: 0.12 },
  blossom_a:{ kind: 'tree',  baseH: 2.00, slopeMax: 0.45, clearR: 0.36, sway: 0.018, blobA: 0.50 },
  blossom_b:{ kind: 'tree',  baseH: 1.90, slopeMax: 0.45, clearR: 0.36, sway: 0.018, blobA: 0.50 },
  blossom_c:{ kind: 'tree',  baseH: 2.10, slopeMax: 0.45, clearR: 0.36, sway: 0.018, blobA: 0.50 },
  bamboo_a: { kind: 'tree',  baseH: 2.50, slopeMax: 0.40, clearR: 0.32, sway: 0.021, blobA: 0.42, hueAmp: 0.07 },
  bamboo_b: { kind: 'tree',  baseH: 2.30, slopeMax: 0.40, clearR: 0.32, sway: 0.021, blobA: 0.42, hueAmp: 0.07 },
  bush_a:   { kind: 'bush',  baseH: 0.72, slopeMax: 0.52, clearR: 0.55, sway: 0.012, blobA: 0.40, hueAmp: 0.09 },
  bush_b:   { kind: 'bush',  baseH: 0.66, slopeMax: 0.52, clearR: 0.55, sway: 0.012, blobA: 0.40, hueAmp: 0.09 },
  bush_c:   { kind: 'bush',  baseH: 0.78, slopeMax: 0.52, clearR: 0.55, sway: 0.012, blobA: 0.40, hueAmp: 0.09 },
  rock_a:   { kind: 'rock',  baseH: 0.70, slopeMax: 0.88, clearR: 0.55, sway: 0,     blobA: 0.42 },
  rock_b:   { kind: 'rock',  baseH: 0.62, slopeMax: 0.88, clearR: 0.55, sway: 0,     blobA: 0.42 },
  rock_c:   { kind: 'rock',  baseH: 0.80, slopeMax: 0.88, clearR: 0.55, sway: 0,     blobA: 0.42 },
  boulder_a:{ kind: 'rock',  baseH: 1.90, slopeMax: 0.80, clearR: 0.62, sway: 0,     blobA: 0.48 },
  // Tufts/flowers sized to the top of the bible band + lifted value range so
  // pasture reads DRESSED — round 1's 0.30 m neutral-tint tufts vanished into
  // the ground texture and left 40 m² patches effectively bald (hard fail).
  grass_tuft_a: { kind: 'ground', baseH: 0.37, slopeMax: 0.58, clearR: 0.30, sway: 0.026, blobA: 0.14, vLo: 1.00, vHi: 1.15, hueAmp: 0.07 },
  grass_tuft_b: { kind: 'ground', baseH: 0.34, slopeMax: 0.58, clearR: 0.30, sway: 0.026, blobA: 0.14, vLo: 1.00, vHi: 1.15, hueAmp: 0.07 },
  fern_a:   { kind: 'ground', baseH: 0.34, slopeMax: 0.55, clearR: 0.35, sway: 0.020, blobA: 0.16, vLo: 0.96, vHi: 1.08 },
  flower_a: { kind: 'ground', baseH: 0.30, slopeMax: 0.42, clearR: 0.28, sway: 0.030, blobA: 0.12, vLo: 1.02, vHi: 1.16 },
  flower_b: { kind: 'ground', baseH: 0.30, slopeMax: 0.42, clearR: 0.28, sway: 0.030, blobA: 0.12, vLo: 1.02, vHi: 1.16 },
  // Wheat: blobA 0 — per-stalk cast shadows and contact blobs are SUPPRESSED
  // (they made the paddocks read as countable crunchy stalks); the field gets
  // one soft AO gradient at its downwind edge instead (see buildBlobs). Hue
  // jitter stays narrow so the mass reads as one coherent gold.
  wheat_a:  { kind: 'crop',  baseH: 0.85, slopeMax: 0.35, clearR: 0.26, sway: 0.034, blobA: 0, hueAmp: 0.028 },
  wheat_b:  { kind: 'crop',  baseH: 0.82, slopeMax: 0.35, clearR: 0.26, sway: 0.034, blobA: 0, hueAmp: 0.028 },
  stump:    { kind: 'wood',  baseH: 0.45, slopeMax: 0.40, clearR: 0.55, sway: 0,     blobA: 0.38 },
  log:      { kind: 'wood',  baseH: 0.50, slopeMax: 0.38, clearR: 0.55, sway: 0,     blobA: 0.38 },
  cattail:  { kind: 'reed',  baseH: 0.92, slopeMax: 0.70, clearR: 0.32, sway: 0.030, blobA: 0 },
  lilypad:  { kind: 'flat',  baseH: 0.46, slopeMax: 1.00, clearR: 0.50, sway: 0,     blobA: 0 },
}

// Global budgets. Tree budgets are sized so they DON'T bind inside clumps:
// round 1's 4200/3300 caps bound against the hash-shuffled candidate list,
// which thinned every stand uniformly to park scatter — the critic's main
// forest fail. Collision spacing (clearR) is the real density governor now.
// INTEGRATION (round 2): both tree caps were BINDING (oak 7400/7400, conifer
// 6853/6800), so the candidate shuffle thinned every clump interior uniformly
// and grass showed between crowns — the closed-canopy repair could not land
// while the cap, not clearR, was the governor. Raised until the caps go slack
// at the tightened grid (§4.1 step 1.22 m vs 1.57 m crowns → 20–40 % overlap).
const BUDGET = {
  conifer: 11500, oak: 11500, bush: 2300, rockAll: 950, tuft: 12000,
  // wheat is thinned by the paddock fill spacing (see §4.7), not by this cap —
  // the cap must stay slack or it truncates the last paddock scanned.
  wheat: 6000, flower: 850, fern: 500, blossom: 400, bamboo: 120,
  cattail: 260, lilypad: 140, wood: 60,
}

// Wheat paddock ellipses — mirrors terrain.js PADDOCKS (authored constants),
// the same trick props.js uses for the fences. Drives the packed paddock fill
// (§4.7) and the per-field downwind AO decals (buildBlobs); the biome raster
// stays the per-sample authority.
const WHEAT_PADDOCKS = [
  { x: -34, z: 14, rx: 6.0, rz: 3.6, rot: 0.30 },
  { x: -42, z: 26, rx: 8.0, rz: 4.6, rot: -0.18 },
  { x: -30, z: 30, rx: 6.6, rz: 4.0, rot: 0.42 },
  { x: -20, z: 52, rx: 8.2, rz: 4.6, rot: 0.12 },
  { x: 1, z: 36, rx: 9.0, rz: 5.0, rot: -0.30 },
]

// ===========================================================================
// 3. createScatter
// ===========================================================================

export function createScatter({ terrain, atlas, renderer }) {
  const T = terrain
  const half = (T.meta && T.meta.size ? T.meta.size : 512) * 0.5
  const LIM = half - 3 // stay off the exact map rim

  // ---- POI keep-out discs (trees/bushes/rocks never inside; ground cover ok
  // ---- outside the tighter inner radius). Farm pad allows crops but no trees.
  const KEEPOUT = []
  const poi = (T.meta && T.meta.poi) || []
  let villagePOI = null
  for (const p of poi) {
    if (p.kind === 'castle') KEEPOUT.push({ x: p.x, z: p.z, r: 21, ground: 12 })
    else if (p.kind === 'village') { KEEPOUT.push({ x: p.x, z: p.z, r: 15, ground: 10 }); villagePOI = p }
    else if (p.kind === 'shrine') KEEPOUT.push({ x: p.x, z: p.z, r: 9.5, ground: 6 })
    else if (p.kind === 'camp') KEEPOUT.push({ x: p.x, z: p.z, r: 7.5, ground: 4 })
    else if (p.kind === 'farm') KEEPOUT.push({ x: p.x, z: p.z, r: 16, ground: 0, cropsOK: true })
    else if (p.kind === 'bridge') KEEPOUT.push({ x: p.x, z: p.z, r: 5.5, ground: 3 })
  }
  // The hero boots at (−38, +18) on the road — guarantee a clean stage.
  KEEPOUT.push({ x: -38, z: 18, r: 3.2, ground: 2.2, heroPad: true })

  function keepOut(x, z, isGroundCover, isCrop) {
    for (let i = 0; i < KEEPOUT.length; i++) {
      const k = KEEPOUT[i]
      const dx = x - k.x
      const dz = z - k.z
      const rr = isGroundCover ? k.ground : k.r
      if (isCrop && k.cropsOK) continue
      if (dx * dx + dz * dz < rr * rr) return true
    }
    return false
  }

  // ---- Structure clearance rects: no billboard within 1.5 m of a wall.
  // The farm barn + cart (props.js buildFarm) sit outside every POI keep-out
  // disc, so round 1 grew conifers straight through the barn walls. Oriented
  // rects, half-extents cover the roof/lean-to overhang; trees get extra
  // margin for crown overhang.
  const STRUCT_CLEAR = [
    { x: -62, z: 25, rot: 1.25, hx: 3.75, hz: 1.95 },   // barn + east lean-to
    { x: -59.6, z: 23.2, rot: -0.5, hx: 1.35, hz: 1.0 }, // cart
  ]
  for (const s of STRUCT_CLEAR) { s.c = Math.cos(s.rot); s.s = Math.sin(s.rot) }
  function structClear(x, z, margin) {
    for (let i = 0; i < STRUCT_CLEAR.length; i++) {
      const s = STRUCT_CLEAR[i]
      const dx = x - s.x
      const dz = z - s.z
      // world -> struct local (inverse of props' makeRotationY(rot) frame)
      const lx = dx * s.c - dz * s.s
      const lz = dx * s.s + dz * s.c
      if (Math.abs(lx) < s.hx + margin && Math.abs(lz) < s.hz + margin) return true
    }
    return false
  }

  // ---- Occupancy hash grid: blue-noise spacing across every pass. Trees may
  // ---- interpenetrate crowns 20–40 % (bible §8) → clearR ~0.6 × halfwidth.
  const OCC_CELL = 2.5
  const occ = new Map()
  const occKey = (cx, cz) => cx * 4096 + cz
  function occInsert(x, z, r) {
    const cx = Math.floor((x + half) / OCC_CELL)
    const cz = Math.floor((z + half) / OCC_CELL)
    const key = occKey(cx, cz)
    let arr = occ.get(key)
    if (!arr) { arr = []; occ.set(key, arr) }
    arr.push(x, z, r)
  }
  function occClear(x, z, r) {
    const cx = Math.floor((x + half) / OCC_CELL)
    const cz = Math.floor((z + half) / OCC_CELL)
    const span = Math.ceil((r + 1.8) / OCC_CELL)
    for (let ix = cx - span; ix <= cx + span; ix++) {
      for (let iz = cz - span; iz <= cz + span; iz++) {
        const arr = occ.get(occKey(ix, iz))
        if (!arr) continue
        for (let i = 0; i < arr.length; i += 3) {
          const dx = x - arr[i]
          const dz = z - arr[i + 1]
          const rr = r + arr[i + 2]
          if (dx * dx + dz * dz < rr * rr) return false
        }
      }
    }
    return true
  }

  // ---- Authored south copses. NOTE the geometry, measured this round: the
  // ---- boot camera sits at z +64.8 looking north and its bottom frame edge
  // ---- meets the ground near z +34 — round 1 put these discs at z 78–130,
  // ---- BEHIND the camera, which is why the bottom blur band rendered empty
  // ---- road and grass. The near ring (z 46–70) now backs up the dedicated
  // ---- foreground crown belt (§4.0); the far ring keeps free-orbit south
  // ---- from going bald.
  const SOUTH_COPSES = [
    { x: -70, z: 52, r: 15 }, { x: -54, z: 62, r: 17 }, { x: -34, z: 68, r: 14 },
    { x: -12, z: 58, r: 13 }, { x: 8, z: 66, r: 15 }, { x: -88, z: 68, r: 18 },
    { x: 28, z: 54, r: 12 },
    { x: -62, z: 92, r: 19 }, { x: -24, z: 100, r: 18 }, { x: 6, z: 112, r: 16 },
    { x: -90, z: 118, r: 21 }, { x: 34, z: 92, r: 14 },
  ]

  // ---- Forest mask: organic clump field over the whole map. terrain.biome
  // ---- 'forest' marks the authored stands (mask 1); a low-frequency noise
  // ---- adds satellite copses on open grass; a mid-frequency "clearing"
  // ---- noise eats holes and chews the edges ragged (bible §8 ecotone).
  function forestMask(x, z) {
    const b = T.biome(x, z)
    let authored = false
    let m = 0
    if (b === 'forest') {
      authored = true
      m = 1
    } else if (b === 'grass') {
      // satellite copse field on open grass; the south foreground band
      // (frame01's bottom blur strip) gets a density bias so the frame's
      // lower edge dissolves into crowns, not bare pasture.
      let n = fbm2(x * 0.0115 + 3.1, z * 0.0115 - 7.4, 3)
      n += 0.25 * sstep(36, 62, z)
      // threshold a touch higher than round 1: satellite copses spend the
      // same tree budget as the authored stands — too many diffuse copses
      // and the caps bind, thinning clump INTERIORS back to park scatter
      m = sstep(0.33, 0.63, n)
      for (let i = 0; i < SOUTH_COPSES.length; i++) {
        const d = SOUTH_COPSES[i]
        const dd = Math.hypot(x - d.x, z - d.z) / d.r
        if (dd < 1) {
          const belt = (1 - sstep(0.5, 1.0, dd)) * (0.62 + 0.38 * (fbm2(x * 0.09, z * 0.09, 2) * 0.5 + 0.5))
          if (belt > m) m = belt
        }
      }
    } else return 0
    // glade carve + ragged edges: ~9 m noise pokes clearings into stands and
    // chews the rims into fingers. Authored stands stay SOLID at heart —
    // frame01's clumps have no visible ground inside (bible §8) — while
    // noise copses fray harder. Round 1 carved 45 % out of authored interiors
    // too, which opened grass gaps inside every clump; the carve now only
    // nips the rims of authored stands.
    const c = fbm2(x * 0.11 - 11.2, z * 0.11 + 5.9, 2)
    m *= 1 - (authored ? 0.22 : 0.7) * sstep(0.5, 0.8, c)
    m = m * sstep(0.06, authored ? 0.3 : 0.5, m + 0.26 * c)
    return clamp01(m)
  }

  // ---- Ring probes -------------------------------------------------------
  const RING8 = []
  for (let i = 0; i < 8; i++) RING8.push([Math.cos((i / 8) * Math.PI * 2), Math.sin((i / 8) * Math.PI * 2)])

  function roadNear(x, z, r) {
    let m = 0
    for (let i = 0; i < 8; i++) {
      const v = T.onRoad(x + RING8[i][0] * r, z + RING8[i][1] * r)
      if (v > m) m = v
    }
    return m
  }
  function waterNear(x, z, r) {
    for (let i = 0; i < 8; i++) if (T.isWater(x + RING8[i][0] * r, z + RING8[i][1] * r)) return true
    return false
  }
  function cliffNear(x, z, r) {
    let m = 0
    for (let i = 0; i < 8; i += 2) {
      const s = T.slope(x + RING8[i][0] * r, z + RING8[i][1] * r)
      if (s > m) m = s
    }
    return m
  }

  // ---- Special-stand discs (decided up front so the generic tree pass can
  // ---- leave them alone): the designated blossom valley SE of the village
  // ---- and the bamboo stand at the village fringe (frame02 biome grammar).
  const BLOSSOM_C = villagePOI
    ? { x: villagePOI.x + 16, z: villagePOI.z + 18, r: 26 }
    : { x: -54, z: -110, r: 26 }
  const BAMBOO_C = villagePOI
    ? { x: villagePOI.x + 16, z: villagePOI.z + 6, r: 7.5 }
    : { x: -54, z: -122, r: 7.5 }
  const inDisc = (x, z, d, f) => {
    const dx = x - d.x
    const dz = z - d.z
    const rr = d.r * (f || 1)
    return dx * dx + dz * dz < rr * rr
  }

  // ---- Instance records --------------------------------------------------
  // { key, x, y, z, w, h, tint[3], phase, amp, freq, flip, rotY (flats) }
  const inst = []
  const counts = Object.create(null)
  const bump = (g) => { counts[g] = (counts[g] || 0) + 1 }

  // Species → world size. Height mode × mandatory jitter U(0.82, 1.24),
  // independent width jitter ±8 %. Oak crowns biased wider (bible: crown
  // width 1.3× height — the atlas aspect gives 1.2, the bias supplies the rest).
  function makeInstance(key, x, z, rnd, opts) {
    const sp = SPECIES[key]
    const fr = atlas.frames[key]
    if (!fr) return null
    const o = opts || {}
    let h = sp.baseH * lerp(0.82, 1.24, rnd()) * (o.scale || 1)
    if (sp.kind === 'tree' && h > 5) h = 5 // bible: never > 5 m
    let wBias = 1
    if (key === 'oak_a' || key === 'oak_b' || key === 'oak_c') wBias = 1.09
    // INTEGRATION (round 2): the repair packed the paddocks solid, but each
    // cluster sprite was still ~1.36 m wide — 50 screen px at the shipped rig,
    // so the mass read as countable chunks with their own dark outlines. In
    // frame01 a stalk cluster is ~1/20 of the paddock's width. Narrowing the
    // quad (the art squashes to thinner stalks) and packing the rows tighter
    // keeps identical coverage and paddock height while the field finally
    // reads as ONE golden mass with fine striation.
    else if (key === 'wheat_a' || key === 'wheat_b') wBias = 0.56
    const w = h * fr.aspect * wBias * lerp(0.92, 1.08, rnd())
    // tint: ±6 % value (per-species range — ground cover is lifted so it pops
    // against the terrain) + hue skew along an R↔B axis. Trees carry a WIDE
    // per-species hueAmp: frame01 mixes olive, yellow-green and blue-green
    // crowns inside a single stand — value-only jitter read as one flat green.
    // Blossoms rotate along a pink↔violet axis instead (frame02 grammar).
    const v = lerp(sp.vLo !== undefined ? sp.vLo : 0.94, sp.vHi !== undefined ? sp.vHi : 1.06, rnd())
    const hj = rnd() * 2 - 1
    let tr, tg, tb
    if (key.indexOf('blossom') === 0) {
      tr = v * (1 - 0.045 * hj); tg = v * (1 - 0.02 * Math.abs(hj)); tb = v * (1 + 0.06 * hj)
    } else {
      const ha = sp.hueAmp !== undefined ? sp.hueAmp : 0.055
      tr = v * (1 + ha * hj); tg = v * (1 + 0.25 * ha * hj); tb = v * (1 - 0.9 * ha * hj)
    }
    const y = T.height(x, z) - (0.024 * h + 0.012) // base sinks 2–3 texels (§6)
    return {
      key, x, y, z, w, h,
      tint: [tr, tg, tb],
      phase: rnd() * Math.PI * 2,
      amp: sp.sway * lerp(0.8, 1.25, rnd()),
      freq: lerp(2.5, 4.4, rnd()),
      flip: rnd() < 0.5 ? 1 : 0,
      rotY: o.rotY || 0,
      flat: sp.kind === 'flat',
      blobA: sp.blobA,
      // crops never write the shadow map (depth pass collapses them) — the
      // per-stalk cast shadows were half of the wheat's crunchy-noise read
      cast: sp.kind === 'crop' ? 0 : 1,
    }
  }

  // Common accept test for an upright billboard of species `key` at (x,z).
  function accepts(key, x, z) {
    if (x < -LIM || x > LIM || z < -LIM || z > LIM) return false
    const sp = SPECIES[key]
    if (T.isWater(x, z)) return false
    if (T.slope(x, z) > sp.slopeMax) return false
    const road = T.onRoad(x, z)
    if (sp.kind === 'tree' && road > 0.01) return false
    if (sp.kind === 'crop') {
      if (road > 0.25) return false // wheat runs up to the road feather (frame01)
    } else if (sp.kind !== 'tree' && sp.kind !== 'ground' && road > 0.05) return false
    if (sp.kind === 'ground' && road > 0.3) return false
    if (structClear(x, z, sp.kind === 'tree' ? 2.1 : 1.5)) return false
    if (keepOut(x, z, sp.kind === 'ground' || sp.kind === 'crop', sp.kind === 'crop')) return false
    if (sp.kind === 'tree') {
      // crowns must not hang over water or punch into cliff faces
      if (waterNear(x, z, 1.1)) return false
      if (cliffNear(x, z, 1.6) > 0.93 && T.slope(x, z) > 0.35) return false
    }
    return true
  }

  // Place with collision + record. Returns true when planted.
  function plant(key, x, z, rnd, group, opts) {
    if (!accepts(key, x, z)) return false
    const it = makeInstance(key, x, z, rnd, opts)
    if (!it) return false
    const r = SPECIES[key].clearR * it.w * 0.5
    if (!occClear(x, z, r)) return false
    occInsert(x, z, r)
    inst.push(it)
    bump(group)
    return true
  }

  // =========================================================================
  // 4. PLACEMENT PASSES (fixed order → deterministic under budget caps)
  // =========================================================================

  // ---- 4.0 FOREGROUND CROWN BELT: fill the bottom blur band ---------------
  // The §2 boot camera (z +64.8, pitch 28°, vFOV 26°) meets the ground with
  // its bottom frame edge near z +34; crowns rooted in z ≈ 33.5–46.5 rise
  // into the 0.88–1.0 fh near-blur zone as the big soft out-of-focus masses
  // frame01 closes its bottom edge with — half the miniature illusion. Large
  // scale bias so the crowns defocus into fat blobs; the farm keep-out, the
  // road corridor and the 'field' biome carve the centre automatically, so
  // the belt flanks the wheat/road stage exactly like the reference. Runs
  // FIRST so tree budgets can never starve it.
  {
    const rnd = rngFor('foreground')
    const step = 1.55
    for (let gz = 33.5; gz <= 46.5; gz += step) {
      for (let gx = -86; gx <= 30; gx += step) {
        const jx = gx + (hash2(gx, gz, 231) - 0.5) * step * 1.3
        const jz = gz + (hash2(gx, gz, 232) - 0.5) * step * 1.3
        const b = T.biome(jx, jz)
        if (b !== 'grass' && b !== 'forest') continue
        const p = 0.86 * (0.58 + 0.42 * (fbm2(jx * 0.05 - 4.4, jz * 0.05 + 8.9, 2) * 0.5 + 0.5))
        if (hash2(jx, jz, 233) > p) continue
        const r = hash2(jx, jz, 234)
        const key =
          r < 0.30 ? (r < 0.15 ? 'pine_a' : 'pine_b')
          : r < 0.44 ? 'oak_c' // olive-gold accents read strongly in the near blur
          : r < 0.74 ? 'oak_a' : 'oak_b'
        const grp = key.indexOf('pine') === 0 ? 'conifer' : 'oak'
        plant(key, jx, jz, rnd, grp, { scale: 1.18 + hash2(jx, jz, 235) * 0.26 })
      }
    }
  }

  // ---- 4.1 TREES: jittered-grid blue-noise over the whole map -------------
  // Grid 1.45 m ≈ the bible's 1.2–2.2 m in-clump crown spacing; the forest
  // mask thresholds acceptance so interiors are packed solid, edges fray
  // into outrider clusters and pasture keeps only anchored lone trees.
  {
    const rnd = rngFor('trees')
    const step = 1.22 // < the 1.57 m pine crown → crowns overlap, canopy closes
    let nConifer = counts.conifer || 0 // budgets are global: count the belt
    let nOak = counts.oak || 0
    // Candidates visited in hash-shuffled order: if a species budget binds,
    // the thinning lands uniformly across the whole map instead of
    // truncating whichever corner the scan reaches last.
    const cand = []
    for (let gz = -LIM; gz <= LIM; gz += step) {
      for (let gx = -LIM; gx <= LIM; gx += step) cand.push(gx, gz)
    }
    const order = new Uint32Array(cand.length / 2)
    for (let i = 0; i < order.length; i++) order[i] = i
    const sortKey = new Float64Array(order.length)
    for (let i = 0; i < order.length; i++) sortKey[i] = hash2(cand[i * 2], cand[i * 2 + 1], 777)
    order.sort((a, b) => sortKey[a] - sortKey[b])
    for (let oi = 0; oi < order.length; oi++) {
      {
        const gx = cand[order[oi] * 2]
        const gz = cand[order[oi] * 2 + 1]
        const jx = gx + (hash2(gx, gz, 1) - 0.5) * step * 1.15
        const jz = gz + (hash2(gx, gz, 2) - 0.5) * step * 1.15
        const b = T.biome(jx, jz)
        if (b === 'ocean' || b === 'beach' || b === 'road' || b === 'field') continue
        // reserved for the blossom valley / bamboo passes
        if (inDisc(jx, jz, BLOSSOM_C, 0.92) || inDisc(jx, jz, BAMBOO_C, 1.15)) continue

        const y = T.height(jx, jz)
        const sl = T.slope(jx, jz)
        let p = 0
        let m = 0
        if (b === 'forest' || b === 'grass') {
          m = forestMask(jx, jz)
          // interior ≈ saturated (collision spacing alone shapes it — frame01
          // clump hearts show NO ground); rims thin quadratically
          p = m > 0.55 ? 0.985 : m * m * 1.05
          if (m < 0.14) {
            // open pasture: rare lone trees, anchored near features so they
            // read placed (fence lines / rocks / forks), never confetti.
            const anchored = roadNear(jx, jz, 3.2) > 0.25 || cliffNear(jx, jz, 3) > 0.55
            p = anchored ? 0.012 : 0.0035
          }
          // roadside crowding handled by its own pass; cliff lips get a boost
          const lip = cliffNear(jx, jz, 2.6)
          if (lip > 0.55 && sl < 0.3) p = Math.max(p, 0.30)
          // river banks: trees crowd the water line (outside the 1.1 m guard)
          if (!waterNear(jx, jz, 1.2) && waterNear(jx, jz, 3.4) && y > 0.8) p = Math.max(p, 0.34)
        } else if (b === 'rock') {
          p = sl < 0.5 ? 0.045 : 0 // crag pines
        } else if (b === 'snow') {
          p = 0.16
        } else continue

        if (p <= 0 || hash2(jx, jz, 3) > p) continue

        // ---- species: conifers claim altitude + slope + snow; deciduous
        // ---- claim low rolling grass; olive-gold oak_c is the ~9 % accent.
        const snowy = b === 'snow' || (y > 30 && jx > 80 && jz < -60)
        let key
        if (snowy) key = 'pine_snow'
        else {
          const coniferW =
            0.22 + 0.55 * sstep(12, 21, y) + 0.35 * sstep(0.16, 0.4, sl) + (b === 'rock' ? 0.5 : 0)
          const r0 = hash2(jx, jz, 4)
          if (r0 < clamp01(coniferW)) {
            const r1 = hash2(jx, jz, 5)
            key = r1 < 0.4 ? 'pine_a' : r1 < 0.74 ? 'pine_b' : 'pine_c'
          } else {
            const r1 = hash2(jx, jz, 6)
            // olive-gold accent raised to ~1 in 6 — frame01 stands are salted
            // with golden-olive crowns, not a rare fleck
            key = r1 < 0.16 ? 'oak_c' : r1 < 0.58 ? 'oak_a' : 'oak_b'
          }
        }
        const isConifer = key.indexOf('pine') === 0
        if (isConifer && nConifer >= BUDGET.conifer) continue
        if (!isConifer && nOak >= BUDGET.oak) continue

        // rare landmark pine (bible: to 4.5 m, never > 5)
        const landmark = isConifer && m > 0.5 && hash2(jx, jz, 7) < 0.014
        if (plant(key, jx, jz, rnd, isConifer ? 'conifer' : 'oak', landmark ? { scale: 1.45 } : undefined)) {
          if (isConifer) nConifer++
          else nOak++
          // ecotone outriders: 2–5-tree satellite clusters off ragged clump
          // rims so boundaries never read convex-smooth (bible §8 ecotone)
          if (m > 0.15 && m < 0.55 && hash2(jx, jz, 8) < 0.34) {
            const n = 2 + ((hash2(jx, jz, 9) * 3.4) | 0)
            for (let k = 0; k < n; k++) {
              const a = hash2(jx, jz, 10 + k) * Math.PI * 2
              const d = 1.3 + hash2(jx, jz, 20 + k) * 1.9
              const ox = jx + Math.cos(a) * d
              const oz = jz + Math.sin(a) * d
              const kk = hash2(ox, oz, 11) < (isConifer ? 0.75 : 0.3)
                ? (hash2(ox, oz, 12) < 0.5 ? 'pine_a' : 'pine_b')
                : (hash2(ox, oz, 12) < 0.5 ? 'oak_a' : 'oak_b')
              const ic = kk.indexOf('pine') === 0
              if (ic && nConifer >= BUDGET.conifer) continue
              if (!ic && nOak >= BUDGET.oak) continue
              if (plant(kk, ox, oz, rnd, ic ? 'conifer' : 'oak')) { if (ic) nConifer++; else nOak++ }
            }
          }
        }
      }
    }
  }

  // ---- 4.2 ROADSIDE CROWDING: trees/bushes hug ~35 % of every shoulder ----
  // Frame01's road is lined with conifers and round crowns 1–3 m off the
  // ochre; a longitudinal noise gate keeps runs broken so it never reads as
  // a picket row. Species and size alternate.
  {
    const rnd = rngFor('roadside')
    const step = 1.7
    for (let gz = -LIM; gz <= LIM; gz += step) {
      for (let gx = -LIM; gx <= LIM; gx += step) {
        const jx = gx + (hash2(gx, gz, 31) - 0.5) * step
        const jz = gz + (hash2(gx, gz, 32) - 0.5) * step
        if (T.onRoad(jx, jz) > 0.02) continue
        const near = roadNear(jx, jz, 2.3)
        if (near < 0.3) continue // not in the 1–3 m shoulder band
        // longitudinal gate: ~35–40 % of road length gets crowding
        const gate = fbm2(jx * 0.045 + 7.7, jz * 0.045 - 3.3, 2)
        if (gate < 0.14) continue
        if (hash2(jx, jz, 33) > 0.42) continue
        const b = T.biome(jx, jz)
        if (b !== 'grass' && b !== 'forest') continue
        const r = hash2(jx, jz, 34)
        const key =
          r < 0.34 ? (r < 0.17 ? 'pine_a' : 'pine_b')
          : r < 0.62 ? (r < 0.48 ? 'oak_a' : 'oak_b')
          : r < 0.72 ? 'oak_c'
          : r < 0.9 ? (r < 0.82 ? 'bush_a' : 'bush_b')
          : 'bush_c'
        const grp = key.indexOf('pine') === 0 ? 'conifer' : key.indexOf('oak') === 0 ? 'oak' : 'bush'
        if (grp === 'conifer' && (counts.conifer || 0) >= BUDGET.conifer) continue
        if (grp === 'oak' && (counts.oak || 0) >= BUDGET.oak) continue
        if (grp === 'bush' && (counts.bush || 0) >= BUDGET.bush) continue
        plant(key, jx, jz, rnd, grp)
      }
    }
  }

  // ---- 4.3 BLOSSOM VALLEY: one designated stand (F2 biome) ----------------
  // Sited in the hazed valley pocket south-east of the village so the pink
  // reads as soft distant masses in frame01's blur band — never mid-frame.
  // Three pink ramps intermixed + dark conifers interleaved (bible F2 note).
  {
    const rnd = rngFor('blossom')
    const cx = BLOSSOM_C.x
    const cz = BLOSSOM_C.z
    const R = BLOSSOM_C.r
    const step = 1.4
    let n = 0
    for (let gz = cz - R; gz <= cz + R; gz += step) {
      for (let gx = cx - R; gx <= cx + R; gx += step) {
        if (n >= BUDGET.blossom) break
        const jx = gx + (hash2(gx, gz, 41) - 0.5) * step
        const jz = gz + (hash2(gx, gz, 42) - 0.5) * step
        const d = Math.hypot(jx - cx, jz - cz) / R
        if (d > 1) continue
        const b = T.biome(jx, jz)
        if (b !== 'grass' && b !== 'forest') continue
        // solid interior plateau, ragged noise-eaten rim (frame02's pink
        // hillsides are a near-continuous mass, not sprinkles)
        const p = (1 - sstep(0.62, 1.0, d)) * (0.74 + 0.26 * fbm2(jx * 0.06, jz * 0.06, 2))
        if (hash2(jx, jz, 43) > p) continue
        const r = hash2(jx, jz, 44)
        const key =
          r < 0.32 ? 'blossom_a' : r < 0.58 ? 'blossom_b' : r < 0.78 ? 'blossom_c'
          : r < 0.9 ? 'pine_b' : 'pine_a' // interleaved dark conifers (bible F2)
        const grp = key.indexOf('pine') === 0 ? 'conifer' : 'blossom'
        if (plant(key, jx, jz, rnd, grp)) { if (grp === 'blossom') n++ }
      }
    }
  }

  // ---- 4.4 BAMBOO STAND: tight cane clusters near the village -------------
  {
    const rnd = rngFor('bamboo')
    const cx = BAMBOO_C.x
    const cz = BAMBOO_C.z
    const R = BAMBOO_C.r
    const step = 0.85
    let n = 0
    for (let gz = cz - R; gz <= cz + R; gz += step) {
      for (let gx = cx - R; gx <= cx + R; gx += step) {
        if (n >= BUDGET.bamboo) break
        const jx = gx + (hash2(gx, gz, 51) - 0.5) * step
        const jz = gz + (hash2(gx, gz, 52) - 0.5) * step
        const d = Math.hypot(jx - cx, jz - cz) / R
        if (d > 1) continue
        const p = (1 - sstep(0.62, 1.0, d)) * 0.9
        if (hash2(jx, jz, 53) > p) continue
        const key = hash2(jx, jz, 54) < 0.55 ? 'bamboo_a' : 'bamboo_b'
        if (plant(key, jx, jz, rnd, 'bamboo')) n++
      }
    }
  }

  // ---- 4.5 BUSHES: forest fringe, riverbank, roadside, sparse pasture -----
  {
    const rnd = rngFor('bush')
    const step = 2.55
    for (let gz = -LIM; gz <= LIM; gz += step) {
      for (let gx = -LIM; gx <= LIM; gx += step) {
        if ((counts.bush || 0) >= BUDGET.bush) break
        const jx = gx + (hash2(gx, gz, 61) - 0.5) * step * 1.1
        const jz = gz + (hash2(gx, gz, 62) - 0.5) * step * 1.1
        const b = T.biome(jx, jz)
        if (b !== 'grass' && b !== 'forest' && b !== 'rock') continue
        const m = forestMask(jx, jz)
        let p = 0.06 // pasture base
        if (m > 0.15 && m < 0.72) p = 0.52 // ecotone fringe — bushes skirt the stands
        else if (m >= 0.72) p = 0.10 // a few under the canopy
        if (!waterNear(jx, jz, 1.0) && waterNear(jx, jz, 2.8)) p = Math.max(p, 0.45)
        if (roadNear(jx, jz, 2.2) > 0.3 && T.onRoad(jx, jz) < 0.03) p = Math.max(p, 0.30)
        if (b === 'rock') p *= 0.35
        if (hash2(jx, jz, 63) > p) continue
        const r = hash2(jx, jz, 64)
        const key = r < 0.4 ? 'bush_a' : r < 0.75 ? 'bush_b' : 'bush_c'
        plant(key, jx, jz, rnd, 'bush')
      }
    }
  }

  // ---- 4.6 ROCKS & BOULDERS: high slope, scree at cliff feet, clusters ----
  {
    const rnd = rngFor('rocks')
    const step = 3.1
    for (let gz = -LIM; gz <= LIM; gz += step) {
      for (let gx = -LIM; gx <= LIM; gx += step) {
        if ((counts.rockAll || 0) >= BUDGET.rockAll) break
        const jx = gx + (hash2(gx, gz, 71) - 0.5) * step * 1.1
        const jz = gz + (hash2(gx, gz, 72) - 0.5) * step * 1.1
        const b = T.biome(jx, jz)
        if (b === 'ocean' || b === 'road' || b === 'field') continue
        const sl = T.slope(jx, jz)
        const lip = cliffNear(jx, jz, 2.8)
        let p = 0.012 // pasture erratics
        if (sl > 0.32) p = 0.30 // slopes carry the rock (billboard trees stop at 0.35–0.55)
        if (b === 'rock') p = Math.max(p, 0.34)
        if (b === 'snow') p = Math.max(p, 0.20)
        if (b === 'beach') p = 0.05
        // scree: gentle ground right under a steep face
        if (lip > 0.6 && sl < 0.35) p = Math.max(p, 0.42)
        if (hash2(jx, jz, 73) > p) continue
        const r = hash2(jx, jz, 74)
        const key = r < 0.11 ? 'boulder_a' : r < 0.43 ? 'rock_a' : r < 0.74 ? 'rock_b' : 'rock_c'
        if (plant(key, jx, jz, rnd, 'rockAll') && hash2(jx, jz, 75) < 0.38) {
          // rocks come in families of 2–4
          const n = 1 + ((hash2(jx, jz, 76) * 3) | 0)
          for (let k = 0; k < n; k++) {
            if ((counts.rockAll || 0) >= BUDGET.rockAll) break
            const a = hash2(jx, jz, 77 + k) * Math.PI * 2
            const d = 0.7 + hash2(jx, jz, 87 + k) * 1.4
            const rk = hash2(jx, jz, 97 + k)
            plant(rk < 0.35 ? 'rock_a' : rk < 0.7 ? 'rock_b' : 'rock_c',
              jx + Math.cos(a) * d, jz + Math.sin(a) * d, rnd, 'rockAll')
          }
        }
      }
    }
  }

  // ---- 4.7 WHEAT: only on the farm paddock fields (biome 'field') ---------
  // ROUND-2 REWRITE. Round 1's 0.86 m grid with ±0.2 m jitter drew visible
  // diagonal lattice rows of one countable stalk sprite over the bare sand
  // decal — grid alignment AND same-species-same-scale repetition, both §8
  // hard fails. Frame01's wheat is a SOLID GOLDEN MASS. So: staggered-row
  // packing at ~2.4 clusters/m² (≈2.2× round 1) with FULL-cell blue-noise
  // jitter, cells ~1.2 m wide overlapping 30–50 %, no ground showing through
  // the interior. Wheat takes NO part in the occupancy grid — the overlap is
  // the point, and nothing else plants inside 'field' — and the mandatory
  // per-instance jitter (height ×U(0.82,1.24), tint ±6 % value) plus the
  // wheat_a/b frame mix and the sprite's pale WHEAT_TIPS heads keep the mass
  // reading as wheat, not a texture. Per-stalk shadows are off (SPECIES
  // blobA 0 + depth-pass collapse); buildBlobs lays one soft AO gradient at
  // each field's downwind edge instead.
  {
    const rnd = rngFor('wheat')
    const colStep = 0.42 // narrower quads (see makeInstance) → tighter packing
    const rowStep = 0.38
    for (const p of WHEAT_PADDOCKS) {
      const ext = Math.max(p.rx, p.rz) * 1.2
      const cr = Math.cos(p.rot)
      const sr = Math.sin(p.rot)
      let row = 0
      for (let oz = -ext; oz <= ext; oz += rowStep, row++) {
        const stag = row & 1 ? colStep * 0.5 : 0
        for (let ox = -ext + stag; ox <= ext; ox += colStep) {
          if ((counts.wheat || 0) >= BUDGET.wheat) break
          // full-amplitude jitter: no residual row/lattice read survives
          const lx = ox + (hash2(p.x + ox, p.z + oz, 101) - 0.5) * colStep * 0.9
          const lz = oz + (hash2(p.x + ox, p.z + oz, 102) - 0.5) * rowStep * 0.9
          const jx = p.x + lx * cr - lz * sr
          const jz = p.z + lx * sr + lz * cr
          if (T.biome(jx, jz) !== 'field') continue
          if (hash2(jx, jz, 103) > 0.955) continue // rare micro-gaps only
          const key = hash2(jx, jz, 104) < 0.55 ? 'wheat_a' : 'wheat_b'
          if (!accepts(key, jx, jz)) continue
          const it = makeInstance(key, jx, jz, rnd)
          if (it) { inst.push(it); bump('wheat') }
        }
      }
    }
  }

  // ---- 4.8 GRASS TUFTS: the ground-cover carpet that bans bare terrain ----
  // Meadow-noise modulated so the pasture breathes (drifted waves of tufts),
  // dense along the road feather, absent under closed canopy and on fields.
  {
    const rnd = rngFor('tufts')
    const step = 1.85
    for (let gz = -LIM; gz <= LIM; gz += step) {
      for (let gx = -LIM; gx <= LIM; gx += step) {
        if ((counts.tuft || 0) >= BUDGET.tuft) break
        const jx = gx + (hash2(gx, gz, 111) - 0.5) * step * 1.2
        const jz = gz + (hash2(gx, gz, 112) - 0.5) * step * 1.2
        const b = T.biome(jx, jz)
        let p
        if (b === 'grass' || b === 'forest') {
          const m = forestMask(jx, jz)
          if (m > 0.78) continue // closed canopy — no visible ground
          // meadow waves, but with a raised FLOOR: round 1's troughs left
          // 40 m²+ of pasture with nothing on it (a §8 hard fail) — the
          // floor now guarantees ≥ ~400 tufts/ha everywhere on open grass
          const meadow = 0.5 + 0.5 * fbm2(jx * 0.03 + 23.4, jz * 0.03 - 8.8, 3)
          p = 0.25 * (0.58 + 0.82 * meadow)
          const road = T.onRoad(jx, jz)
          if (road > 0.02 && road < 0.3) p *= 1.35 // tufts crowd the feathered edge
        } else if (b === 'rock' || b === 'snow') p = 0.10
        else if (b === 'beach') p = 0.07
        else continue
        if (hash2(jx, jz, 113) > p) continue
        const key = hash2(jx, jz, 114) < 0.55 ? 'grass_tuft_a' : 'grass_tuft_b'
        plant(key, jx, jz, rnd, 'tuft')
      }
    }
  }

  // ---- 4.9 FLOWER DRIFTS: hand-sized colonies, one species per drift ------
  {
    const rnd = rngFor('flowers')
    const cellW = 11
    for (let gz = -LIM; gz <= LIM; gz += cellW) {
      for (let gx = -LIM; gx <= LIM; gx += cellW) {
        if ((counts.flower || 0) >= BUDGET.flower) break
        if (hash2(gx, gz, 121) > 0.13) continue
        const cx = gx + (hash2(gx, gz, 122) - 0.5) * 8
        const cz = gz + (hash2(gx, gz, 123) - 0.5) * 8
        if (T.biome(cx, cz) !== 'grass') continue
        if (forestMask(cx, cz) > 0.4) continue
        const main = hash2(gx, gz, 124) < 0.55 ? 'flower_a' : 'flower_b'
        const alt = main === 'flower_a' ? 'flower_b' : 'flower_a'
        const n = 6 + ((hash2(gx, gz, 125) * 11) | 0)
        for (let k = 0; k < n; k++) {
          if ((counts.flower || 0) >= BUDGET.flower) break
          const a = hash2(gx, gz, 130 + k) * Math.PI * 2
          const d = Math.sqrt(hash2(gx, gz, 150 + k)) * 2.8
          const key = hash2(gx, gz, 170 + k) < 0.8 ? main : alt
          plant(key, cx + Math.cos(a) * d, cz + Math.sin(a) * d, rnd, 'flower')
        }
      }
    }
  }

  // ---- 4.10 FERNS: the shade layer at stand edges and damp banks ----------
  {
    const rnd = rngFor('ferns')
    const step = 2.6
    for (let gz = -LIM; gz <= LIM; gz += step) {
      for (let gx = -LIM; gx <= LIM; gx += step) {
        if ((counts.fern || 0) >= 600) break
        const jx = gx + (hash2(gx, gz, 181) - 0.5) * step
        const jz = gz + (hash2(gx, gz, 182) - 0.5) * step
        const b = T.biome(jx, jz)
        if (b !== 'grass' && b !== 'forest') continue
        const m = forestMask(jx, jz)
        let p = 0
        if (m > 0.18 && m < 0.78) p = 0.34
        if (!waterNear(jx, jz, 0.9) && waterNear(jx, jz, 2.4)) p = Math.max(p, 0.25)
        if (p === 0 || hash2(jx, jz, 183) > p) continue
        plant('fern_a', jx, jz, rnd, 'fern')
      }
    }
  }

  // ---- 4.11 CATTAILS + LILYPADS: the river dressing -----------------------
  // Coarse scan finds fresh-water cells (surface above sea level); cattail
  // clusters take the banks, lilypads take slow shallow pools.
  {
    const rnd = rngFor('reeds')
    const wtiles = []
    for (let gz = -LIM; gz <= LIM; gz += 4) {
      for (let gx = -LIM; gx <= LIM; gx += 4) {
        if (T.isWater(gx, gz) && T.waterHeight(gx, gz) > 0.3) wtiles.push(gx, gz)
      }
    }
    const fine = 1.1
    for (let i = 0; i < wtiles.length; i += 2) {
      const tx = wtiles[i]
      const tz = wtiles[i + 1]
      for (let oz = -2.6; oz <= 2.6; oz += fine) {
        for (let ox = -2.6; ox <= 2.6; ox += fine) {
          const jx = tx + ox + (hash2(tx + ox, tz + oz, 191) - 0.5) * 0.7
          const jz = tz + oz + (hash2(tx + ox, tz + oz, 192) - 0.5) * 0.7
          if (jx < -LIM || jx > LIM || jz < -LIM || jz > LIM) continue

          if (!T.isWater(jx, jz)) {
            // ---- bank: cattail clusters right at the waterline
            if ((counts.cattail || 0) >= BUDGET.cattail) continue
            if (!waterNear(jx, jz, 1.1)) continue
            if (T.slope(jx, jz) > 0.68 || T.onRoad(jx, jz) > 0.05) continue
            if (hash2(jx, jz, 193) > 0.30) continue
            plant('cattail', jx, jz, rnd, 'cattail')
          } else if (
            // ---- shallows: reeds emerge from the water margin itself (the
            // ---- carved channels have steep rock banks — the waterline is
            // ---- where the reeds live, roots just under the surface)
            (counts.cattail || 0) < BUDGET.cattail &&
            T.waterHeight(jx, jz) - T.height(jx, jz) <= 0.3 &&
            hash2(jx, jz, 196) < 0.22
          ) {
            // needs a dry shoulder within ~1.2 m so reeds hug the edge
            let dry = false
            for (let k = 0; k < 8 && !dry; k++) {
              if (!T.isWater(jx + RING8[k][0] * 1.2, jz + RING8[k][1] * 1.2)) dry = true
            }
            if (!dry) continue
            const it = makeInstance('cattail', jx, jz, rnd)
            if (!it) continue
            it.y = T.waterHeight(jx, jz) - 0.06 // base just below the surface
            if (!occClear(jx, jz, 0.3)) continue
            occInsert(jx, jz, 0.3)
            inst.push(it)
            bump('cattail')
          } else {
            // ---- pool: lilypads on slow, shallow fresh water
            if ((counts.lilypad || 0) >= BUDGET.lilypad) continue
            const wh = T.waterHeight(jx, jz)
            if (wh <= 0.3) continue
            const depth = wh - T.height(jx, jz)
            if (depth < 0.22 || depth > 2.2) continue
            // POOLS only: deep + a locally dead-flat surface. The flowing
            // reaches drop ~1 m / 80 m — this gate keeps pads out of them
            // and clusters them in the plunge pool / slack water.
            if (Math.abs(T.waterHeight(jx + 2, jz) - wh) > 0.022) continue
            if (Math.abs(T.waterHeight(jx, jz + 2) - wh) > 0.022) continue
            if (depth < 0.45 && hash2(jx, jz, 197) > 0.25) continue
            if (hash2(jx, jz, 194) > 0.10) continue
            const n = 2 + ((hash2(jx, jz, 195) * 4) | 0)
            for (let k = 0; k < n; k++) {
              if ((counts.lilypad || 0) >= BUDGET.lilypad) break
              const a = hash2(jx, jz, 200 + k) * Math.PI * 2
              const d = hash2(jx, jz, 210 + k) * 1.1
              const px = jx + Math.cos(a) * d
              const pz = jz + Math.sin(a) * d
              if (!T.isWater(px, pz)) continue
              const pwh = T.waterHeight(px, pz)
              if (pwh <= 0.3) continue
              const it = makeInstance('lilypad', px, pz, rnd, { rotY: rnd() * Math.PI * 2 })
              if (!it) continue
              it.y = pwh + 0.02 // float ON the water surface
              if (!occClear(px, pz, 0.28)) continue
              occInsert(px, pz, 0.28)
              inst.push(it)
              bump('lilypad')
            }
          }
        }
      }
    }
  }

  // ---- 4.12 STUMPS & LOGS: sparse woodland-margin storytelling ------------
  {
    const rnd = rngFor('wood')
    const step = 6
    for (let gz = -LIM; gz <= LIM; gz += step) {
      for (let gx = -LIM; gx <= LIM; gx += step) {
        if ((counts.wood || 0) >= BUDGET.wood) break
        const jx = gx + (hash2(gx, gz, 221) - 0.5) * step
        const jz = gz + (hash2(gx, gz, 222) - 0.5) * step
        if (T.biome(jx, jz) !== 'grass') continue
        const m = forestMask(jx, jz)
        const nearRoad = roadNear(jx, jz, 2.6) > 0.3 && T.onRoad(jx, jz) < 0.03
        if (!(m > 0.08 && m < 0.45) && !nearRoad) continue
        if (hash2(jx, jz, 223) > 0.075) continue
        plant(hash2(jx, jz, 224) < 0.55 ? 'stump' : 'log', jx, jz, rnd, 'wood')
      }
    }
  }

  // =========================================================================
  // 5. GPU ASSEMBLY — one InstancedMesh for every upright billboard (single
  //    draw call on the shared atlas), one for the flat lilypads, one for the
  //    contact-shadow decals. 8×8 world cells drive frustum culling.
  // =========================================================================

  const CELLS = 8
  const cellW = (half * 2) / CELLS
  const cellId = (x, z) => {
    const cx = Math.min(CELLS - 1, Math.max(0, Math.floor((x + half) / cellW)))
    const cz = Math.min(CELLS - 1, Math.max(0, Math.floor((z + half) / cellW)))
    return cz * CELLS + cx
  }
  const cellMinY = new Float32Array(CELLS * CELLS).fill(1e9)
  const cellMaxY = new Float32Array(CELLS * CELLS).fill(-1e9)

  const uprights = []
  const flats = []
  for (const it of inst) {
    ;(it.flat ? flats : uprights).push(it)
    const c = cellId(it.x, it.z)
    it.cell = c
    if (it.y < cellMinY[c]) cellMinY[c] = it.y
    if (it.y + it.h > cellMaxY[c]) cellMaxY[c] = it.y + it.h
  }

  // ---- shared uniforms (one write updates every material) -----------------
  const uTime = { value: 0 }
  const uCellVis = { value: new Float32Array(CELLS * CELLS).fill(1) }
  const uFadeRange = { value: new THREE.Vector2(270, 330) }

  const GLSL_DECL = /* glsl */ `
    attribute vec4 iRect;   // atlas u0, v0, uSize, vSize
    attribute vec3 iTint;   // per-instance albedo tint (value + hue jitter)
    attribute vec4 iWind;   // phase, amplitude(rad), frequency, flipU
    attribute vec4 iSize;   // world w, world h (billb.) / depth (flat), cellId, castsShadow
    uniform float uTime;
    uniform float uCellVis[${CELLS * CELLS}];
    uniform vec2 uFadeRange;
    varying vec3 vSctTint;
    varying float vSctFade;
  `

  // Runs at <uv_vertex> (the first include of main) in BOTH the colour and
  // the depth vertex shaders. Y-axis-locked billboarding: the quad rotates
  // toward the rendering camera about +Y only — during the shadow pass
  // `cameraPosition` is the light's camera, so the same code yields a full
  // tree-shaped silhouette in the shadow map. Wind shears the top of the
  // quad while the base row (y = 0) stays planted.
  const GLSL_PLACE = /* glsl */ `
    vec3 sctPos = vec3( instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2] );
    float sctVis = uCellVis[ int( iSize.z + 0.5 ) ];
    vec3 sctToCam = cameraPosition - sctPos;
    float sctDist = length( sctToCam );
    vSctFade = 1.0 - smoothstep( uFadeRange.x, uFadeRange.y, sctDist );
    vSctTint = iTint;
    vec3 sctLocal;
    #ifdef SCT_BILLBOARD
      float sctYaw = atan( sctToCam.x, sctToCam.z );
      float sctC = cos( sctYaw );
      float sctS = sin( sctYaw );
      float sctH01 = clamp( position.y, 0.0, 1.0 );
      float sctSway = iWind.y * iSize.y * sctH01 *
        ( sin( uTime * iWind.z + iWind.x ) + 0.35 * sin( uTime * iWind.z * 2.63 + iWind.x * 1.7 ) );
      float sctX = position.x * iSize.x + sctSway;
      sctLocal = vec3( sctX * sctC, position.y * iSize.y, -sctX * sctS );
    #else
      sctLocal = vec3( position.x * iSize.x, 0.0, position.z * iSize.y );
    #endif
    if ( sctVis < 0.5 || vSctFade <= 0.001 ) sctLocal = vec3( 0.0, -1.0e6, 0.0 );
    #ifdef SCT_DEPTH
      // shadow pass only: crops (wheat) never write the shadow map — the
      // field reads as one lit golden mass, not 1200 crunchy stalk shadows
      if ( iSize.w < 0.5 ) sctLocal = vec3( 0.0, -1.0e6, 0.0 );
    #endif
    #ifdef USE_MAP
      float sctU = mix( uv.x, 1.0 - uv.x, iWind.w );
      vMapUv = vec2( iRect.x + sctU * iRect.z, iRect.y + uv.y * iRect.w );
    #endif
  `

  function patchVertex(shader, billboard) {
    shader.uniforms.uTime = uTime
    shader.uniforms.uCellVis = uCellVis
    shader.uniforms.uFadeRange = uFadeRange
    let v = shader.vertexShader
    v = v.replace('#include <uv_vertex>', GLSL_PLACE)
    v = v.replace('#include <begin_vertex>', 'vec3 transformed = sctLocal;')
    if (v.indexOf('#include <beginnormal_vertex>') !== -1) {
      // Faux billboard normal (bible §4): mostly up, leaned 35 % toward the
      // camera — crowns take the sun + hemisphere like rounded masses, not
      // like flat cards.
      v = v.replace(
        '#include <beginnormal_vertex>',
        billboard
          ? 'vec3 objectNormal = normalize( mix( vec3( 0.0, 1.0, 0.0 ), normalize( sctToCam ), 0.35 ) );'
          : 'vec3 objectNormal = vec3( 0.0, 1.0, 0.0 );'
      )
    }
    shader.vertexShader = GLSL_DECL + v
  }

  function makeColorMaterial(billboard) {
    const mat = new THREE.MeshLambertMaterial({
      map: atlas.texture,
      alphaTest: 0.42,
      side: THREE.DoubleSide,
      transparent: false, // pure cutout — blending would break depth sorting
    })
    if (billboard) mat.defines = { SCT_BILLBOARD: '' }
    mat.onBeforeCompile = (shader) => {
      patchVertex(shader, billboard)
      shader.fragmentShader = 'varying vec3 vSctTint;\nvarying float vSctFade;\n' +
        shader.fragmentShader.replace(
          '#include <alphatest_fragment>',
          'diffuseColor.rgb *= vSctTint;\n\tdiffuseColor.a *= vSctFade;\n\t#include <alphatest_fragment>'
        )
    }
    // patched shaders need their own program cache key
    mat.customProgramCacheKey = () => 'sct_color_' + (billboard ? 'bb' : 'flat')
    return mat
  }

  function makeDepthMaterial() {
    const mat = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      map: atlas.texture,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    })
    mat.defines = { SCT_BILLBOARD: '', SCT_DEPTH: '' }
    mat.onBeforeCompile = (shader) => patchVertex(shader, true)
    mat.customProgramCacheKey = () => 'sct_depth_bb'
    return mat
  }

  // ---- base quads ---------------------------------------------------------
  function uprightQuad() {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(
      [-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(
      [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3))
    g.setIndex([0, 1, 2, 0, 2, 3])
    return g
  }
  function flatQuad() {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(
      [-0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, -0.5], 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(
      [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3))
    g.setIndex([0, 1, 2, 0, 2, 3])
    return g
  }

  function fillMesh(list, geometryBase, billboard) {
    const n = list.length
    const geo = geometryBase
    const rect = new Float32Array(n * 4)
    const tint = new Float32Array(n * 3)
    const wind = new Float32Array(n * 4)
    const size = new Float32Array(n * 4)
    const mat = makeColorMaterial(billboard)
    const mesh = new THREE.InstancedMesh(geo, mat, n)
    const m4 = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const up = new THREE.Vector3(0, 1, 0)
    const one = new THREE.Vector3(1, 1, 1)
    const pos = new THREE.Vector3()
    for (let i = 0; i < n; i++) {
      const it = list[i]
      const fr = atlas.frames[it.key]
      rect[i * 4] = fr.u0
      rect[i * 4 + 1] = fr.v0
      rect[i * 4 + 2] = fr.u1 - fr.u0
      rect[i * 4 + 3] = fr.v1 - fr.v0
      tint[i * 3] = it.tint[0]
      tint[i * 3 + 1] = it.tint[1]
      tint[i * 3 + 2] = it.tint[2]
      wind[i * 4] = it.phase
      wind[i * 4 + 1] = it.amp
      wind[i * 4 + 2] = it.freq
      wind[i * 4 + 3] = it.flip
      size[i * 4] = it.w
      size[i * 4 + 1] = billboard ? it.h : it.w / (atlas.frames[it.key].aspect || 1)
      size[i * 4 + 2] = it.cell
      size[i * 4 + 3] = it.cast === 0 ? 0 : 1
      pos.set(it.x, it.y, it.z)
      if (!billboard && it.rotY) q.setFromAxisAngle(up, it.rotY)
      else q.identity()
      m4.compose(pos, q, one)
      mesh.setMatrixAt(i, m4)
    }
    geo.setAttribute('iRect', new THREE.InstancedBufferAttribute(rect, 4))
    geo.setAttribute('iTint', new THREE.InstancedBufferAttribute(tint, 3))
    geo.setAttribute('iWind', new THREE.InstancedBufferAttribute(wind, 4))
    geo.setAttribute('iSize', new THREE.InstancedBufferAttribute(size, 4))
    mesh.instanceMatrix.needsUpdate = true
    mesh.frustumCulled = false // we cull per world cell in the shader
    return mesh
  }

  // ---- 5.1 contact-shadow decals ------------------------------------------
  // Soft elliptical CONTACT_SHADOW (#241611) blobs projected onto the ground
  // under every billboard (bible §8: radius 0.9× crown radius, α ~0.5, 40 %
  // feather; ground cover gets faint micro-blobs). Slightly elongated and
  // nudged along the sun's shadow azimuth (~70° — sun WSW at az 250°) so
  // bases feel keyed to the light, oriented to the terrain normal so decals
  // hug slopes instead of clipping them.
  function buildBlobs() {
    const items = []
    for (const it of inst) {
      if (!it.blobA || it.flat) continue
      if (T.slope(it.x, it.z) > 0.75) continue
      items.push(it)
    }
    // + one crescent AO decal per wheat paddock: the field's single soft
    // grounding shadow at its downwind edge (replaces per-stalk blobs).
    const n = items.length + WHEAT_PADDOCKS.length
    // ±1-extent ground quad: instance scale columns are the ellipse RADII.
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(
      [-1, 0, 1, 1, 0, 1, 1, 0, -1, -1, 0, -1], 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2))
    geo.setIndex([0, 1, 2, 0, 2, 3])
    const alpha = new Float32Array(n)
    const cell = new Float32Array(n)
    const cres = new Float32Array(n * 3) // local dirX, dirY(uv), strength
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uCellVis: uCellVis,
        uFadeRange: uFadeRange,
        uFogDensity: { value: 0.0072 }, // bible §4 — attenuates blobs into the haze
        uColor: { value: new THREE.Color(0x241611) },
      },
      vertexShader: /* glsl */ `
        attribute float cAlpha;
        attribute float cCell;
        attribute vec3 cCres;
        uniform float uCellVis[${CELLS * CELLS}];
        uniform vec2 uFadeRange;
        uniform float uFogDensity;
        varying vec2 vUv;
        varying float vA;
        varying vec3 vCres;
        void main() {
          vec4 wp = modelMatrix * instanceMatrix * vec4( position, 1.0 );
          float vis = uCellVis[ int( cCell + 0.5 ) ];
          float dist = distance( cameraPosition, wp.xyz );
          float fade = 1.0 - smoothstep( uFadeRange.x, uFadeRange.y, dist );
          float fogT = exp( - uFogDensity * uFogDensity * dist * dist );
          vA = cAlpha * fade * mix( 0.12, 1.0, fogT );
          if ( vis < 0.5 || vA < 0.004 ) wp = vec4( 0.0, -1.0e6, 0.0, 1.0 );
          vUv = uv;
          vCres = cCres;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying vec2 vUv;
        varying float vA;
        varying vec3 vCres;
        void main() {
          vec2 q = vUv * 2.0 - 1.0;
          float d = length( q );
          float a = 1.0 - smoothstep( 0.60, 1.0, d );   // 40 % feather
          a *= 0.82 + 0.18 * ( 1.0 - smoothstep( 0.0, 0.55, d ) ); // denser core
          // crescent mode (wheat-field AO): alpha ramps toward the downwind
          // rim and dies at the centre/upwind side — one soft edge gradient
          if ( vCres.z > 0.001 ) {
            float w = smoothstep( 0.02, 0.72, dot( q, vCres.xy ) );
            a *= mix( 1.0, w, vCres.z );
          }
          float outA = a * vA;
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
    const mesh = new THREE.InstancedMesh(geo, mat, n)
    const m4 = new THREE.Matrix4()
    const nrm = new THREE.Vector3()
    const t1 = new THREE.Vector3()
    const t2 = new THREE.Vector3()
    const pos = new THREE.Vector3()
    const SHADOW_AZ = (70 * Math.PI) / 180 // shadow falls toward az 70° (NE-ish)
    const sd = new THREE.Vector3(Math.sin(SHADOW_AZ), 0, -Math.cos(SHADOW_AZ))
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const sp = SPECIES[it.key]
      const cr = it.w * 0.5
      const rx = Math.max(0.13, 0.9 * cr * 1.15)
      const rz = Math.max(0.10, 0.9 * cr * 0.82)
      T.normal(it.x, it.z, nrm)
      if (nrm.y < 0.2) nrm.set(0, 1, 0)
      t1.copy(sd).addScaledVector(nrm, -sd.dot(nrm)).normalize()
      t2.crossVectors(nrm, t1)
      const lift = 0.035 + 0.03 * rx
      pos.set(it.x + t1.x * rx * 0.18, T.height(it.x, it.z), it.z + t1.z * rx * 0.18)
        .addScaledVector(nrm, lift)
      m4.makeBasis(t1.clone().multiplyScalar(rx), nrm.clone(), t2.clone().multiplyScalar(rz))
      m4.setPosition(pos)
      mesh.setMatrixAt(i, m4)
      alpha[i] = sp.blobA
      cell[i] = it.cell
      // cres stays (0,0,0): plain elliptical blob
    }
    // ---- wheat-field AO: one soft crescent per paddock, hugging the
    // ---- downwind (shadow-azimuth) edge of the golden mass. Drawn on the
    // ---- ground before the billboards, so it grounds the field and darkens
    // ---- interior peeks without per-stalk shadow crunch.
    for (let pi = 0; pi < WHEAT_PADDOCKS.length; pi++) {
      const i = items.length + pi
      const p = WHEAT_PADDOCKS[pi]
      const rx = p.rx * 1.16
      const rz = p.rz * 1.16
      T.normal(p.x, p.z, nrm)
      if (nrm.y < 0.2) nrm.set(0, 1, 0)
      const ax = Math.cos(p.rot)
      const az = Math.sin(p.rot)
      t1.set(ax, 0, az).addScaledVector(nrm, -(ax * nrm.x + az * nrm.z)).normalize()
      t2.crossVectors(nrm, t1)
      pos.set(p.x, T.height(p.x, p.z), p.z).addScaledVector(nrm, 0.07)
      m4.makeBasis(t1.clone().multiplyScalar(rx), nrm.clone(), t2.clone().multiplyScalar(rz))
      m4.setPosition(pos)
      mesh.setMatrixAt(i, m4)
      alpha[i] = 0.34
      cell[i] = cellId(p.x, p.z)
      // shadow direction expressed in the decal's local uv frame (uv.y runs
      // opposite local z), radius-weighted so the crescent tracks the ellipse
      let ldx = sd.dot(t1) * rx
      let ldz = -sd.dot(t2) * rz
      const ll = Math.hypot(ldx, ldz) || 1
      cres[i * 3] = ldx / ll
      cres[i * 3 + 1] = ldz / ll
      cres[i * 3 + 2] = 1
    }
    geo.setAttribute('cAlpha', new THREE.InstancedBufferAttribute(alpha, 1))
    geo.setAttribute('cCell', new THREE.InstancedBufferAttribute(cell, 1))
    geo.setAttribute('cCres', new THREE.InstancedBufferAttribute(cres, 3))
    mesh.instanceMatrix.needsUpdate = true
    mesh.frustumCulled = false
    mesh.renderOrder = 1 // over the opaque terrain, under everything else
    mesh.castShadow = false
    mesh.receiveShadow = false
    return mesh
  }

  // ---- 5.2 assemble -------------------------------------------------------
  const group = new THREE.Group()
  group.name = 'scatter'

  // receiveShadow stays OFF for billboards: the colour pass faces the camera
  // while the shadow pass faces the sun, so a shadow-map self-test would
  // paint a false hard terminator across every crown. The sprites carry
  // authored form shading (frame01 crowns are not cross-shadowed), and the
  // trees still CAST real shadows via the custom depth material below.
  const vegMesh = fillMesh(uprights, uprightQuad(), true)
  vegMesh.name = 'scatter_billboards'
  vegMesh.castShadow = true
  vegMesh.receiveShadow = false
  vegMesh.customDepthMaterial = makeDepthMaterial()
  vegMesh.renderOrder = 2
  group.add(vegMesh)

  let flatMesh = null
  if (flats.length > 0) {
    flatMesh = fillMesh(flats, flatQuad(), false)
    flatMesh.name = 'scatter_lilypads'
    flatMesh.castShadow = false
    flatMesh.receiveShadow = false
    flatMesh.renderOrder = 3 // after the water surface so pads sit on it
    group.add(flatMesh)
  }

  const blobMesh = buildBlobs()
  blobMesh.name = 'scatter_contact_shadows'
  group.add(blobMesh)

  group.userData.counts = counts

  // ---- 5.3 frustum-aware update -------------------------------------------
  // 8×8 world-cell AABBs tested against the camera frustum each frame; a
  // shared uniform array collapses hidden cells to degenerate triangles in
  // the vertex shader — zero per-instance CPU work, still one draw call.
  const cellBoxes = []
  {
    const PAD = 9 // covers crown overhang + wind sway + one frame of camera lag
    for (let cz = 0; cz < CELLS; cz++) {
      for (let cx = 0; cx < CELLS; cx++) {
        const i = cz * CELLS + cx
        const empty = cellMaxY[i] < cellMinY[i]
        const x0 = -half + cx * cellW
        const z0 = -half + cz * cellW
        cellBoxes.push(
          empty
            ? null
            : new THREE.Box3(
                new THREE.Vector3(x0 - PAD, cellMinY[i] - 2, z0 - PAD),
                new THREE.Vector3(x0 + cellW + PAD, cellMaxY[i] + 2, z0 + cellW + PAD)
              )
        )
      }
    }
  }
  const _viewProj = new THREE.Matrix4()
  const _inv = new THREE.Matrix4()
  const _frustum = new THREE.Frustum()

  function update(t, camera) {
    uTime.value = t
    if (!camera) return
    camera.updateMatrixWorld()
    _inv.copy(camera.matrixWorld).invert()
    _viewProj.multiplyMatrices(camera.projectionMatrix, _inv)
    _frustum.setFromProjectionMatrix(_viewProj)
    const vis = uCellVis.value
    for (let i = 0; i < cellBoxes.length; i++) {
      const box = cellBoxes[i]
      vis[i] = box && _frustum.intersectsBox(box) ? 1 : 0
    }
  }

  return {
    object3D: group,
    update,
    count: inst.length,
  }
}
