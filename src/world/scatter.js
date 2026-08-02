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
const SPECIES = {
  pine_a:   { kind: 'tree',  baseH: 2.80, slopeMax: 0.55, clearR: 0.62, sway: 0.017, blobA: 0.50 },
  pine_b:   { kind: 'tree',  baseH: 2.65, slopeMax: 0.55, clearR: 0.62, sway: 0.017, blobA: 0.50 },
  pine_c:   { kind: 'tree',  baseH: 2.95, slopeMax: 0.55, clearR: 0.62, sway: 0.017, blobA: 0.50 },
  pine_snow:{ kind: 'tree',  baseH: 2.75, slopeMax: 0.60, clearR: 0.62, sway: 0.015, blobA: 0.46 },
  oak_a:    { kind: 'tree',  baseH: 1.95, slopeMax: 0.42, clearR: 0.60, sway: 0.016, blobA: 0.50 },
  oak_b:    { kind: 'tree',  baseH: 1.85, slopeMax: 0.42, clearR: 0.60, sway: 0.016, blobA: 0.50 },
  oak_c:    { kind: 'tree',  baseH: 2.05, slopeMax: 0.42, clearR: 0.60, sway: 0.016, blobA: 0.50 },
  blossom_a:{ kind: 'tree',  baseH: 2.00, slopeMax: 0.45, clearR: 0.60, sway: 0.018, blobA: 0.50 },
  blossom_b:{ kind: 'tree',  baseH: 1.90, slopeMax: 0.45, clearR: 0.60, sway: 0.018, blobA: 0.50 },
  blossom_c:{ kind: 'tree',  baseH: 2.10, slopeMax: 0.45, clearR: 0.60, sway: 0.018, blobA: 0.50 },
  bamboo_a: { kind: 'tree',  baseH: 2.50, slopeMax: 0.40, clearR: 0.48, sway: 0.021, blobA: 0.42 },
  bamboo_b: { kind: 'tree',  baseH: 2.30, slopeMax: 0.40, clearR: 0.48, sway: 0.021, blobA: 0.42 },
  bush_a:   { kind: 'bush',  baseH: 0.72, slopeMax: 0.52, clearR: 0.55, sway: 0.012, blobA: 0.40 },
  bush_b:   { kind: 'bush',  baseH: 0.66, slopeMax: 0.52, clearR: 0.55, sway: 0.012, blobA: 0.40 },
  bush_c:   { kind: 'bush',  baseH: 0.78, slopeMax: 0.52, clearR: 0.55, sway: 0.012, blobA: 0.40 },
  rock_a:   { kind: 'rock',  baseH: 0.70, slopeMax: 0.88, clearR: 0.55, sway: 0,     blobA: 0.42 },
  rock_b:   { kind: 'rock',  baseH: 0.62, slopeMax: 0.88, clearR: 0.55, sway: 0,     blobA: 0.42 },
  rock_c:   { kind: 'rock',  baseH: 0.80, slopeMax: 0.88, clearR: 0.55, sway: 0,     blobA: 0.42 },
  boulder_a:{ kind: 'rock',  baseH: 1.90, slopeMax: 0.80, clearR: 0.62, sway: 0,     blobA: 0.48 },
  grass_tuft_a: { kind: 'ground', baseH: 0.32, slopeMax: 0.58, clearR: 0.30, sway: 0.026, blobA: 0.14 },
  grass_tuft_b: { kind: 'ground', baseH: 0.30, slopeMax: 0.58, clearR: 0.30, sway: 0.026, blobA: 0.14 },
  fern_a:   { kind: 'ground', baseH: 0.34, slopeMax: 0.55, clearR: 0.35, sway: 0.020, blobA: 0.16 },
  flower_a: { kind: 'ground', baseH: 0.27, slopeMax: 0.42, clearR: 0.28, sway: 0.030, blobA: 0.12 },
  flower_b: { kind: 'ground', baseH: 0.27, slopeMax: 0.42, clearR: 0.28, sway: 0.030, blobA: 0.12 },
  wheat_a:  { kind: 'crop',  baseH: 0.85, slopeMax: 0.35, clearR: 0.26, sway: 0.034, blobA: 0.10 },
  wheat_b:  { kind: 'crop',  baseH: 0.82, slopeMax: 0.35, clearR: 0.26, sway: 0.034, blobA: 0.10 },
  stump:    { kind: 'wood',  baseH: 0.45, slopeMax: 0.40, clearR: 0.55, sway: 0,     blobA: 0.38 },
  log:      { kind: 'wood',  baseH: 0.50, slopeMax: 0.38, clearR: 0.55, sway: 0,     blobA: 0.38 },
  cattail:  { kind: 'reed',  baseH: 0.92, slopeMax: 0.50, clearR: 0.32, sway: 0.030, blobA: 0 },
  lilypad:  { kind: 'flat',  baseH: 0.46, slopeMax: 1.00, clearR: 0.50, sway: 0,     blobA: 0 },
}

// Global budgets (ART_BIBLE §8 table + the F2-biome extras).
const BUDGET = {
  conifer: 2600, oak: 1900, bush: 2300, rockAll: 950, tuft: 9000,
  wheat: 1300, flower: 700, fern: 500, blossom: 400, bamboo: 120,
  cattail: 260, lilypad: 140, wood: 60,
}

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

  // ---- Forest mask: organic clump field over the whole map. terrain.biome
  // ---- 'forest' marks the authored stands (mask 1); a low-frequency noise
  // ---- adds satellite copses on open grass; a mid-frequency "clearing"
  // ---- noise eats holes and chews the edges ragged (bible §8 ecotone).
  function forestMask(x, z) {
    const b = T.biome(x, z)
    let m = 0
    if (b === 'forest') m = 1
    else if (b === 'grass') {
      const n = fbm2(x * 0.0115 + 3.1, z * 0.0115 - 7.4, 3) // large clump field
      m = sstep(0.30, 0.62, n)
    } else return 0
    // clearing carve + ragged edges: mid-scale noise modulates the mask so
    // stand interiors open into glades and rims break into fingers.
    const c = fbm2(x * 0.052 - 11.2, z * 0.052 + 5.9, 2)
    m *= 1 - 0.85 * sstep(0.34, 0.66, c)          // interior clearings
    m = m * sstep(0.10, 0.55, m + 0.30 * c)       // noise-eaten rim
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
    const w = h * fr.aspect * wBias * lerp(0.92, 1.08, rnd())
    // tint: ±6 % value, ±4° hue (warm↔cool channel skew; blossoms rotate
    // along a pink↔violet axis instead so the stand mixes like frame02).
    const v = lerp(0.94, 1.06, rnd())
    const hj = rnd() * 2 - 1
    let tr, tg, tb
    if (key.indexOf('blossom') === 0) {
      tr = v * (1 - 0.045 * hj); tg = v * (1 - 0.02 * Math.abs(hj)); tb = v * (1 + 0.06 * hj)
    } else {
      tr = v * (1 + 0.055 * hj); tg = v * (1 + 0.012 * hj); tb = v * (1 - 0.05 * hj)
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
    if (sp.kind !== 'tree' && sp.kind !== 'ground' && road > 0.05) return false
    if (sp.kind === 'ground' && road > 0.3) return false
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

  // ---- 4.1 TREES: jittered-grid blue-noise over the whole map -------------
  // Grid 1.55 m ≈ the bible's 1.2–2.2 m in-clump crown spacing; the forest
  // mask thresholds acceptance so interiors are packed (260–420 /ha), edges
  // fray into outrider clusters and pasture keeps only anchored lone trees.
  {
    const rnd = rngFor('trees')
    const step = 1.55
    let nConifer = 0
    let nOak = 0
    let nBlossomBudget = 0
    for (let gz = -LIM; gz <= LIM; gz += step) {
      for (let gx = -LIM; gx <= LIM; gx += step) {
        const jx = gx + (hash2(gx, gz, 1) - 0.5) * step * 1.15
        const jz = gz + (hash2(gx, gz, 2) - 0.5) * step * 1.15
        const b = T.biome(jx, jz)
        if (b === 'ocean' || b === 'beach' || b === 'road' || b === 'field') continue

        const y = T.height(jx, jz)
        const sl = T.slope(jx, jz)
        let p = 0
        let m = 0
        if (b === 'forest' || b === 'grass') {
          m = forestMask(jx, jz)
          p = m * m * 0.86 // interior ≈ full density, rim thins quadratically
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
            key = r1 < 0.086 ? 'oak_c' : r1 < 0.55 ? 'oak_a' : 'oak_b'
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
          // ecotone outriders: small satellite clusters off ragged clump rims
          if (m > 0.18 && m < 0.5 && hash2(jx, jz, 8) < 0.3) {
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
    nBlossomBudget = 0 // (blossoms placed by their own valley pass below)
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
          : r < 0.68 ? 'oak_c'
          : r < 0.9 ? (r < 0.79 ? 'bush_a' : 'bush_b')
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
    const cx = villagePOI ? villagePOI.x + 14 : -56
    const cz = villagePOI ? villagePOI.z + 16 : -112
    const R = 24
    const step = 1.7
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
        // clumpy falloff with ragged rim
        const p = (1 - sstep(0.55, 1.0, d)) * (0.55 + 0.45 * fbm2(jx * 0.06, jz * 0.06, 2))
        if (hash2(jx, jz, 43) > p * 0.8) continue
        const r = hash2(jx, jz, 44)
        const key =
          r < 0.36 ? 'blossom_a' : r < 0.62 ? 'blossom_b' : r < 0.82 ? 'blossom_c'
          : r < 0.93 ? 'pine_b' : 'pine_a' // interleaved dark conifers
        const grp = key.indexOf('pine') === 0 ? 'conifer' : 'blossom'
        if (plant(key, jx, jz, rnd, grp)) { if (grp === 'blossom') n++ }
      }
    }
  }

  // ---- 4.4 BAMBOO STAND: tight cane clusters near the village -------------
  {
    const rnd = rngFor('bamboo')
    const cx = villagePOI ? villagePOI.x + 11 : -59
    const cz = villagePOI ? villagePOI.z + 9 : -119
    const R = 7.5
    const step = 0.95
    let n = 0
    for (let gz = cz - R; gz <= cz + R; gz += step) {
      for (let gx = cx - R; gx <= cx + R; gx += step) {
        if (n >= BUDGET.bamboo) break
        const jx = gx + (hash2(gx, gz, 51) - 0.5) * step
        const jz = gz + (hash2(gx, gz, 52) - 0.5) * step
        const d = Math.hypot(jx - cx, jz - cz) / R
        if (d > 1) continue
        const p = (1 - sstep(0.5, 1.0, d)) * 0.85
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
        let p = 0.05 // pasture base
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

/* @@CHUNK4@@ */
