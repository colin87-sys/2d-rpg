/**
 * src/art/atlas.js — procedural pixel-art vegetation/prop atlas.
 *
 * Every tree, bush, rock and ground plant in the frame is authored here as
 * deliberate pixel art (per ART_BIBLE.md §3/§5/§6, matched by eye against
 * docs/reference/frame01.png + frame02.png) and packed into one 2048×2048
 * atlas.
 *
 * Authoring model:
 *   - Each sprite is drawn on a logical grid at the art bible's exact cell
 *     size (pine 64×112, oak 96×80, … — 30–40 texels per world metre).
 *   - Pixels are stored as (rampId, shadeIdx) indices, not RGB, so global
 *     lighting passes (frosted lobe tops, under-shelf shadows, the 1 px mint
 *     rim on the right silhouette edge, the colour-matched dark outline) can
 *     re-grade art without losing material identity. Max 6 indices per
 *     material: HI / LIT / MID / SHADOW + RIM + OUTLINE (bible §6).
 *   - The finished cell is blitted into the atlas with 4×4 texel blocks
 *     (nearest, integer coords). The logical pixel grid — the thing your eye
 *     reads — is unchanged; the fat texels just survive trilinear
 *     minification and anisotropy far better in the fogged distance.
 *
 * CONTRACT (frozen):
 *   makeVegetationAtlas(renderer) -> {
 *     texture: THREE.Texture,          // 2048², sRGB, Nearest mag, trilinear min, mips
 *     frames:  Record<string, Frame>,  // Frame = { u0,v0,u1,v1,px,py,aspect,anchor:'bottom' }
 *     size:    2048
 *   }
 *   `px`/`py` are the LOGICAL cell dimensions (the art-bible §6 table — e.g.
 *   pine 64×112). The UVs already map the upscaled atlas region, so px/py are
 *   what you want for world sizing: worldHeight ≈ py / 40 texels-per-metre
 *   reproduces the §5 scale chart (pine cell → 2.8 m). aspect = px/py.
 *   v0 is the BOTTOM of the sprite (anchor row), v1 the top.
 *
 *   atlasDebugCanvas(atlas) -> HTMLCanvasElement  (the raw packed canvas)
 *
 * Determinism: a single fixed master seed; every frame draws from its own
 * name-hashed PRNG stream, so output is stable across reloads and does not
 * depend on build order.
 */

import * as THREE from 'three'

// ---------------------------------------------------------------------------
// 0. Deterministic PRNG
// ---------------------------------------------------------------------------

const MASTER_SEED = 0x5eed0a71

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

function rngFor(name) {
  return mulberry32(hashStr(name) ^ MASTER_SEED)
}

const rr = (rng, a, b) => a + (b - a) * rng()
const ri = (rng, a, b) => Math.floor(a + (b - a + 1) * rng())
const chance = (rng, p) => rng() < p

// ---------------------------------------------------------------------------
// 1. Palette — ART_BIBLE §3, verbatim. Ramps are [HI, LIT, MID, SHADOW] plus
//    a RIM colour (the right-edge bounce; mint-class for greens) and a 1 px
//    OUTLINE (~15 % value, hue kept — never black).
// ---------------------------------------------------------------------------

function hx(s) {
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]
}

const RAMP_DEFS = []
const R = {} // name -> ramp id
function defRamp(name, c4, out, rim) {
  const id = RAMP_DEFS.length
  const cols = c4.map(hx)
  RAMP_DEFS.push({ name, cols: [...cols, hx(rim || c4[0]), hx(out)] })
  R[name] = id
  return id
}

// Vegetation (bible §3 "Vegetation" table)
defRamp('conifer', ['7fae6a', '4c7c3e', '33592b', '1e3c1c'], '12240f')
defRamp('decid', ['a8c47c', '6f9a44', '4e7a33', '2b4d24'], '14290f')
defRamp('olive', ['c6c05e', '9aa032', '767d20', '4d5416'], '23260a')
defRamp('blossomA', ['f0c9e2', 'dfa6cf', 'b478ae', '7e5279'], '3a2233')
defRamp('blossomB', ['e3aed6', 'd092bb', 'b76fa6', '8d4f86'], '371f33')
defRamp('blossomC', ['c19bd8', 'a273b8', '7a5292', '5d3a58'], '241629')
defRamp('bamboo', ['b5d96e', '8fbf4e', '55842f', '2f5522'], '17300e')
// Terrain-adjacent materials
defRamp('grass', ['7fa63b', '62902e', '4a7429', '2f5426'], '142a10')
defRamp('wheat', ['eed794', 'e0c26e', 'b3913f', '7a6128'], '38290d')
defRamp('rock', ['b7c2a8', '8a9880', '5d7161', '37473f'], '232e29', 'ccd5bf')
defRamp('snow', ['eef2f0', 'c2ced2', '9fb2c0', '6e8291'], '2c3a44')
// Wood: bark and cut faces (fence/trestle wood family, road-mid rings)
defRamp('bark', ['8a6a44', '5d4226', '3f2d18', '241a0e'], '150d06', 'a5834f')
defRamp('woodcut', ['efe3c2', 'd9c9a8', 'a57a45', '6f5638'], '150d06')
// Flower heads (outlined in deep green so they sit into grass like the ref)
defRamp('petalW', ['fdf9ee', 'efeadb', 'cfc5a8', '9a9078'], '142a10')
defRamp('petalG', ['f3dd85', 'e5c95c', 'b3913f', '7a6128'], '142a10')

const SH = { HI: 0, LIT: 1, MID: 2, SHADOW: 3, RIM: 4, OUT: 5 }

// ---------------------------------------------------------------------------
// 2. Cell — an indexed-colour pixel surface with the drawing toolkit.
// ---------------------------------------------------------------------------

const EMPTY = 255
const F_NO_OUTLINE = 1 // loose petals / pollen: keep them airy, no dark ring

class Cell {
  constructor(w, h) {
    this.w = w
    this.h = h
    this.ramp = new Uint8Array(w * h).fill(EMPTY)
    this.shade = new Uint8Array(w * h)
    this.flag = new Uint8Array(w * h)
  }

  inb(x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h
  }

  on(x, y) {
    return this.inb(x, y) && this.ramp[y * this.w + x] !== EMPTY
  }

  put(x, y, rampId, shade, flag = 0) {
    x |= 0
    y |= 0
    if (!this.inb(x, y)) return
    const i = y * this.w + x
    this.ramp[i] = rampId
    this.shade[i] = shade
    this.flag[i] = flag
  }

  erase(x, y) {
    x |= 0
    y |= 0
    if (!this.inb(x, y)) return
    this.ramp[y * this.w + x] = EMPTY
  }

  shadeAt(x, y) {
    return this.shade[y * this.w + x]
  }

  /** Darken an existing pixel by n ramp steps (clamped at SHADOW). */
  darken(x, y, n = 1) {
    x |= 0
    y |= 0
    if (!this.on(x, y)) return
    const i = y * this.w + x
    if (this.shade[i] <= SH.SHADOW) this.shade[i] = Math.min(SH.SHADOW, this.shade[i] + n)
  }

  /**
   * The workhorse: a ragged, individually shaded foliage puffball.
   * Lit from the upper-left (sun WSW, bible §4): HI/LIT cluster top-left of
   * the lobe, SHADOW pools bottom-right. `skirt` casts the lobe's own shadow
   * 1–2 px onto whatever it overlaps below — this is what separates shelves
   * and makes broccoli crowns read as volume. `darkenBy` pushes back-layer
   * lobes a step darker so crown interiors have depth.
   */
  lobe(rng, cx, cy, rx, ry, rampId, opts = {}) {
    const ragged = opts.ragged !== undefined ? opts.ragged : 0.24
    const bias = opts.bias || 0
    const hiP = opts.hiP !== undefined ? opts.hiP : 0.13
    const darkenBy = opts.darkenBy || 0
    const skirt = opts.skirt || 0
    const SEC = 12
    const jit = []
    for (let i = 0; i < SEC; i++) jit.push(1 - ragged * rng())
    const x0 = Math.floor(cx - rx - 1)
    const x1 = Math.ceil(cx + rx + 1)
    const y0 = Math.floor(cy - ry - 1)
    const y1 = Math.ceil(cy + ry + 1)
    const bottomAt = new Int16Array(x1 - x0 + 1).fill(-1)
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const nx = (x - cx) / rx
        const ny = (y - cy) / ry
        const d = Math.hypot(nx, ny)
        if (d > 1.001) continue
        const ang = Math.atan2(ny, nx)
        const s = ((ang + Math.PI) / (Math.PI * 2)) * SEC
        const i0 = Math.floor(s) % SEC
        const f = s - Math.floor(s)
        const edge = jit[i0] * (1 - f) + jit[(i0 + 1) % SEC] * f
        if (d > edge + (rng() - 0.5) * 0.05) continue
        // top-left light: t > 0 faces the key
        const t = -(nx * 0.55 + ny * 0.8) + bias
        let sh = t > 0.4 ? SH.LIT : t > -0.3 ? SH.MID : SH.SHADOW
        if (sh === SH.LIT && t > 0.58 && rng() < hiP) sh = SH.HI
        if (darkenBy) sh = Math.min(SH.SHADOW, sh + darkenBy)
        this.put(x, y, rampId, sh)
        const bi = x - x0
        if (y > bottomAt[bi]) bottomAt[bi] = y
      }
    }
    if (skirt > 0) {
      for (let bi = 0; bi < bottomAt.length; bi++) {
        const by = bottomAt[bi]
        if (by < 0) continue
        const x = x0 + bi
        for (let dy = 1; dy <= skirt; dy++) this.darken(x, by + dy, 1)
        if (this.on(x, by + skirt + 1) && rng() < 0.5) this.darken(x, by + skirt + 1, 1)
      }
    }
  }

  /** 1 px-wide arcing blade (grass, bamboo leaves, cattail leaves). */
  blade(rng, x0, y0, x1, y1, bend, rampId, shadeFn) {
    const mx = (x0 + x1) / 2 - (y1 - y0) * bend
    const my = (y0 + y1) / 2 + (x1 - x0) * bend
    const n = Math.max(3, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 1.8))
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const a = 1 - t
      const px = a * a * x0 + 2 * a * t * mx + t * t * x1
      const py = a * a * y0 + 2 * a * t * my + t * t * y1
      this.put(px, py, rampId, shadeFn(t, rng))
    }
  }

  /** Straight thick line (branches). */
  line(x0, y0, x1, y1, rampId, shade, thick = 1) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)))
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const x = x0 + (x1 - x0) * t
      const y = y0 + (y1 - y0) * t
      for (let dx = 0; dx < thick; dx++) this.put(x + dx, y, rampId, shade)
    }
  }

  /** Scanline-filled simple polygon (rock facets, root flares, chips). */
  poly(pts, rampId, shade) {
    let minY = Infinity
    let maxY = -Infinity
    for (const p of pts) {
      if (p[1] < minY) minY = p[1]
      if (p[1] > maxY) maxY = p[1]
    }
    for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
      const yc = y + 0.5
      const xs = []
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i]
        const [bx, by] = pts[(i + 1) % pts.length]
        if (ay <= yc !== by <= yc) xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax))
      }
      xs.sort((a, b) => a - b)
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = Math.round(xs[k]); x < Math.round(xs[k + 1]); x++) this.put(x, y, rampId, shade)
      }
    }
  }

  polyErase(pts) {
    let minY = Infinity
    let maxY = -Infinity
    for (const p of pts) {
      if (p[1] < minY) minY = p[1]
      if (p[1] > maxY) maxY = p[1]
    }
    for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
      const yc = y + 0.5
      const xs = []
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i]
        const [bx, by] = pts[(i + 1) % pts.length]
        if (ay <= yc !== by <= yc) xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax))
      }
      xs.sort((a, b) => a - b)
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = Math.round(xs[k]); x < Math.round(xs[k + 1]); x++) this.erase(x, y)
      }
    }
  }

  /** Dashed elliptical ring (growth rings on stump/log cut faces). */
  ring(rng, cx, cy, rx, ry, rampId, shade, gap = 0.15) {
    const n = Math.max(8, Math.ceil((rx + ry) * 2.4))
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      if (rng() < gap) continue
      this.put(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, rampId, shade)
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Shared lighting/finish passes (bible §6 rules)
// ---------------------------------------------------------------------------

/**
 * Frosted tops: every foliage pixel with open sky directly above steps one
 * shade lighter (sunlit shelf tops); a fraction sparkle to HI. This is what
 * gives the reference its pale scalloped crowns.
 */
function frostTops(cell, rng, rampIds, hiP = 0.35) {
  const set = new Set(rampIds)
  const { w, h } = cell
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!set.has(cell.ramp[i])) continue
      if (y > 0 && cell.ramp[(y - 1) * w + x] !== EMPTY) continue
      if (cell.shade[i] <= SH.HI) continue
      if (cell.shade[i] > SH.SHADOW) continue
      cell.shade[i] = chance(rng, hiP) ? SH.HI : Math.min(cell.shade[i], SH.LIT)
    }
  }
}

/**
 * Under-shelf shadow: bottom edges of solid masses drop to SHADOW (dark
 * undersides under every tier/lobe). Mass-gated so 1 px blades are spared.
 */
function underShadow(cell, rampIds) {
  const set = new Set(rampIds)
  const { w, h } = cell
  const snapshot = cell.ramp.slice()
  const solid = (x, y) => x >= 0 && y >= 0 && x < w && y < h && snapshot[y * w + x] !== EMPTY
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!set.has(cell.ramp[i])) continue
      if (solid(x, y + 1)) continue // not a bottom edge
      let n = 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) if (!(dx === 0 && dy === 0) && solid(x + dx, y + dy)) n++
      if (n < 4) continue // a blade tip, not a mass
      cell.shade[i] = SH.SHADOW
      if (solid(x, y - 1) && cell.shade[(y - 1) * w + x] > SH.LIT) {
        cell.shade[(y - 1) * w + x] = Math.max(cell.shade[(y - 1) * w + x], SH.MID)
      }
    }
  }
}

/**
 * The 1 px pale bounce rim on the RIGHT silhouette edge (~40 % coverage,
 * biased to the upper-mid band) — bible §6; clearly visible on frame01's
 * roadside conifers. Uses each material's RIM colour (mint for greens).
 */
function rimRight(cell, rng, opts = {}) {
  const cov = opts.cov !== undefined ? opts.cov : 0.55
  // sprite bbox
  let top = cell.h
  let bot = -1
  for (let y = 0; y < cell.h; y++) {
    for (let x = 0; x < cell.w; x++) {
      if (cell.ramp[y * cell.w + x] !== EMPTY) {
        if (y < top) top = y
        if (y > bot) bot = y
        break
      }
    }
  }
  if (bot < 0) return
  const y0 = top + (bot - top) * (opts.band ? opts.band[0] : 0.12)
  const y1 = top + (bot - top) * (opts.band ? opts.band[1] : 0.62)
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    if (y < 0 || y >= cell.h) continue
    for (let x = cell.w - 1; x >= 1; x--) {
      const i = y * cell.w + x
      if (cell.ramp[i] === EMPTY) continue
      // rightmost opaque pixel of this row inside the band
      if (chance(rng, cov) && !cell.flag[i]) cell.shade[i] = SH.RIM
      break
    }
  }
}

/**
 * 1 px full outer silhouette in the neighbour material's own ultra-dark
 * outline colour (bible: colour-matched, never black). Grows outward so no
 * art is eaten. Loose petals flagged F_NO_OUTLINE stay ring-free.
 */
function outline(cell) {
  const { w, h } = cell
  const src = cell.ramp.slice()
  const flg = cell.flag.slice()
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (src[y * w + x] !== EMPTY) continue
      let pick = -1
      let sawOnlyFlagged = true
      const look = (xx, yy) => {
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) return
        const j = yy * w + xx
        if (src[j] === EMPTY) return
        if (flg[j] & F_NO_OUTLINE) return
        sawOnlyFlagged = false
        if (pick < 0) pick = src[j]
      }
      look(x - 1, y)
      look(x, y - 1)
      look(x + 1, y)
      look(x, y + 1)
      if (pick < 0 || sawOnlyFlagged) continue
      cell.put(x, y, pick, SH.OUT)
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Small construction helpers
// ---------------------------------------------------------------------------

/** Tapered bark trunk with a lit west edge and dark east edge + root flare. */
function trunk(c, rng, xc, yTop, yBase, wTop, wBase, opts = {}) {
  for (let y = Math.round(yTop); y <= yBase; y++) {
    const t = (y - yTop) / Math.max(1, yBase - yTop)
    const half = (wTop + (wBase - wTop) * t) / 2
    const lean = opts.lean ? opts.lean * (yBase - y) : 0
    const l = Math.round(xc + lean - half)
    const rgt = Math.round(xc + lean + half)
    for (let x = l; x <= rgt; x++) {
      let sh = x === l ? SH.HI : x >= rgt - 1 ? SH.MID + 1 : SH.LIT
      if (y >= yBase - 1) sh = SH.SHADOW
      if (chance(rng, 0.06)) sh = Math.min(SH.SHADOW, sh + 1)
      c.put(x, y, R.bark, Math.min(SH.SHADOW, sh))
    }
  }
  if (opts.flare) {
    const y = yBase
    c.poly([[xc - wBase / 2 - 2.5, y + 1], [xc - wBase / 2 + 0.5, y - 2.5], [xc - wBase / 2 + 1.5, y + 1]], R.bark, SH.MID)
    c.poly([[xc + wBase / 2 - 1.5, y + 1], [xc + wBase / 2 - 0.5, y - 2.5], [xc + wBase / 2 + 2.5, y + 1]], R.bark, SH.SHADOW)
  }
}

/**
 * Solid conifer body: a filled, ragged, stepped cone core (so the silhouette
 * is a MASS, exactly like frame01/02 — never see-through), then rows of
 * drooping knob-lobes along every tier baseline for the scalloped shelf
 * edges and frosted tops. The core waist between shelves is narrower than
 * the knob rows, which is what gives the stepped-triangle read.
 */
function pineBody(c, rng, opts) {
  const { tiers, topY, ax, knobR, coreK = 0.82, knobSpace = 1.15 } = opts
  const phase = rr(rng, 0, Math.PI * 2)
  // core width profile: piecewise between baselines, always narrower than
  // the knob rows so shelves overhang.
  const pts = tiers.map(([y, w]) => [y, w * coreK]).concat([[topY, 1.4]])
  const widthAt = (y) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const [y0, w0] = pts[i]
      const [y1, w1] = pts[i + 1]
      if (y <= y0 && y >= y1) {
        const t = (y0 - y) / Math.max(1, y0 - y1)
        return w0 + (w1 - w0) * t
      }
    }
    return null
  }
  for (let y = Math.round(topY); y <= tiers[0][0]; y++) {
    const w = widthAt(y)
    if (w === null) continue
    const wj = w * (1 + 0.05 * Math.sin(y * 0.9 + phase)) + rr(rng, -0.8, 0.8)
    const a = ax(y)
    const xl = Math.round(a - wj)
    const xr = Math.round(a + wj)
    for (let x = xl; x <= xr; x++) {
      const sh = x > a + wj * 0.55 ? SH.SHADOW : SH.MID
      c.put(x, y, R.conifer, sh)
    }
  }
  // knob shelf rows, bottom tier first so upper shelves cast onto lower
  for (let ti = 0; ti < tiers.length; ti++) {
    const [baseY, halfW] = tiers[ti]
    const r = (knobR || 6) * (1 - 0.45 * (ti / Math.max(1, tiers.length - 1)))
    const a = ax(baseY)
    const n = Math.max(2, Math.round((halfW * 2) / (r * knobSpace)))
    for (let i = 0; i < n; i++) {
      const f = n === 1 ? 0.5 : i / (n - 1)
      const x = a - halfW + f * 2 * halfW + rr(rng, -1.1, 1.1)
      const edge = Math.abs(f - 0.5) * 2
      const kr = Math.max(2.4, r * (1.08 - 0.22 * edge) * rr(rng, 0.88, 1.14))
      const droop = edge * rr(rng, 0.8, 2.8)
      c.lobe(rng, x, baseY - kr * 0.5 + droop, kr * rr(rng, 1.05, 1.3), kr * rr(rng, 0.78, 0.95), R.conifer, {
        ragged: 0.3,
        skirt: 2,
        bias: (0.5 - f) * 0.3 - 0.04,
        hiP: 0.1,
      })
    }
  }
}

/** Loose falling petal (blossom cells). */
function petal(c, rng, x, y, rampId) {
  c.put(x, y, rampId, chance(rng, 0.5) ? SH.HI : SH.LIT, F_NO_OUTLINE)
  if (chance(rng, 0.4)) c.put(x + 1, y, rampId, SH.LIT, F_NO_OUTLINE)
}

/** 5-px "plus" flower head with a contrasting heart. */
function flowerHead(c, x, y, rampId, heartRamp, heartShade) {
  c.put(x, y - 1, rampId, SH.HI)
  c.put(x - 1, y, rampId, SH.LIT)
  c.put(x + 1, y, rampId, SH.LIT)
  c.put(x, y + 1, rampId, SH.MID)
  c.put(x, y, heartRamp, heartShade)
}

// ---------------------------------------------------------------------------
// 5. The thirty frames — silhouette-first, hand-authored.
//    Cell sizes are ART_BIBLE §6 verbatim.
// ---------------------------------------------------------------------------

const SPECS = []
function spec(key, w, h, post, build) {
  SPECS.push({ key, w, h, post, build })
}

// ————— CONIFERS (64×112) ————————————————————————————————————————————————
// Frame01/02: stepped triangles of lumpy shelf-tiers, frosted tops, dark
// undersides, ragged notched edges, 2 px trunk foot. Three genuinely
// different silhouettes (broad classic / slim leaning spire / stocky dome).

const treePost = { frost: ['conifer'], under: ['conifer', 'bark'], rim: { cov: 0.55, band: [0.14, 0.6] } }

spec('pine_a', 64, 112, treePost, (c, rng) => {
  // Broad classic: solid stepped cone, 6 shelves, gentle axis wobble.
  const phase = rr(rng, 0, Math.PI * 2)
  const ax = (y) => 32 + Math.sin(y * 0.06 + phase) * 1.5
  trunk(c, rng, 32, 96, 111, 3, 5, { flare: true })
  pineBody(c, rng, {
    ax,
    topY: 12,
    knobR: 6.6,
    tiers: [
      [104, 26],
      [89, 22],
      [74, 18.5],
      [59, 15],
      [45, 11.5],
      [32, 8],
      [21, 4.5],
    ],
  })
  c.lobe(rng, ax(12), 12, 3.4, 4, R.conifer, { ragged: 0.3, skirt: 1, bias: 0.15 })
})

spec('pine_b', 64, 112, treePost, (c, rng) => {
  // Slim leaning spire: tighter waist, pronounced steps, long spike tip.
  const lean = 0.055
  const ax = (y) => 28 + (104 - y) * lean + Math.sin(y * 0.1) * 0.7
  trunk(c, rng, 28, 100, 111, 2.5, 4, { lean, flare: true })
  pineBody(c, rng, {
    ax,
    topY: 14,
    knobR: 5,
    coreK: 0.74,
    knobSpace: 1.25,
    tiers: [
      [104, 19],
      [90, 16.5],
      [76, 14],
      [62, 11.5],
      [48, 9],
      [35, 6.5],
      [23, 4],
    ],
  })
  c.lobe(rng, ax(14), 13, 2.4, 3.4, R.conifer, { ragged: 0.25, bias: 0.1 })
  c.put(ax(9), 9, R.conifer, SH.LIT)
  c.put(ax(10), 10, R.conifer, SH.MID)
  c.put(ax(11), 11, R.conifer, SH.MID)
})

spec('pine_c', 64, 112, treePost, (c, rng) => {
  // Stocky fir: 4 heavy shelves, near cell-wide, round mounded cap.
  const ax = (y) => 32 + Math.sin(y * 0.05 + 1.2) * 1.2
  trunk(c, rng, 32, 96, 111, 4, 6, { flare: true })
  pineBody(c, rng, {
    ax,
    topY: 34,
    knobR: 8.2,
    coreK: 0.86,
    tiers: [
      [104, 28.5],
      [85, 23.5],
      [66, 17.5],
      [48, 11],
    ],
  })
  c.lobe(rng, 27, 38, 6, 5, R.conifer, { ragged: 0.28, skirt: 2, bias: 0.18 })
  c.lobe(rng, 37, 39, 6, 5, R.conifer, { ragged: 0.28, skirt: 2, bias: -0.1 })
  c.lobe(rng, 31, 30, 5.4, 4.8, R.conifer, { ragged: 0.28, skirt: 2, bias: 0.12 })
  c.lobe(rng, 33, 23, 4, 3.8, R.conifer, { ragged: 0.3, skirt: 1, bias: 0.1 })
})

spec('pine_snow', 64, 112, { frost: null, under: ['conifer', 'bark'], rim: { cov: 0.4, band: [0.14, 0.6] } }, (c, rng) => {
  // pine_a construction, own stream (different notches), then snow caps on
  // every open tier top. Far-NE ridge only (bible §1) — fully fog-washed.
  const phase = rr(rng, 0, Math.PI * 2)
  const ax = (y) => 32 + Math.sin(y * 0.07 + phase) * 1.3
  trunk(c, rng, 32, 96, 111, 3, 5, { flare: true })
  pineBody(c, rng, {
    ax,
    topY: 13,
    knobR: 6.4,
    tiers: [
      [104, 25],
      [89, 21.5],
      [74, 18],
      [59, 14.5],
      [45, 11],
      [32, 7.5],
      [21, 4.5],
    ],
  })
  c.lobe(rng, ax(13), 12, 3.2, 3.8, R.conifer, { ragged: 0.3, skirt: 1 })
  // snow pass: cap every conifer pixel with sky above, thicken 1 px upward,
  // sag 1–2 px down; lit west of axis, cool east.
  const snap = c.ramp.slice()
  const isCon = (x, y) => c.inb(x, y) && snap[y * c.w + x] === R.conifer
  for (let y = c.h - 1; y >= 1; y--) {
    for (let x = 0; x < c.w; x++) {
      if (!isCon(x, y)) continue
      if (snap[(y - 1) * c.w + x] !== EMPTY) continue
      const lit = x < ax(y) - 1 ? SH.HI : chance(rng, 0.35) ? SH.HI : SH.LIT
      c.put(x, y, R.snow, lit)
      c.put(x, y - 1, R.snow, x < ax(y) ? SH.HI : SH.LIT)
      if (chance(rng, 0.55) && isCon(x, y + 1)) c.put(x, y + 1, R.snow, lit === SH.HI ? SH.LIT : SH.MID)
      if (chance(rng, 0.18) && isCon(x, y + 2)) c.put(x, y + 2, R.snow, SH.MID)
    }
  }
})

// ————— DECIDUOUS (96×80) ————————————————————————————————————————————————
// Frame01 broccoli crowns: stacked shelves of ragged puffball lobes, wider
// than tall, deep V-notches, dark back-lobes for interior depth, small trunk
// with a visible branch or two.

spec('oak_a', 96, 80, { frost: ['decid'], under: ['decid', 'bark'], rim: { cov: 0.55, band: [0.1, 0.58] } }, (c, rng) => {
  trunk(c, rng, 47, 50, 79, 5, 7, { flare: true })
  c.line(47, 58, 36, 48, R.bark, SH.MID, 2)
  c.line(48, 56, 60, 47, R.bark, SH.SHADOW, 2)
  // back layer (darker, fills the crown core)
  c.lobe(rng, 34, 42, 13, 10, R.decid, { darkenBy: 1, ragged: 0.2, hiP: 0 })
  c.lobe(rng, 58, 41, 13, 10, R.decid, { darkenBy: 1, ragged: 0.2, hiP: 0 })
  c.lobe(rng, 46, 32, 12, 9, R.decid, { darkenBy: 1, ragged: 0.2, hiP: 0 })
  // bottom shelf
  c.lobe(rng, 20, 52, 11, 8.5, R.decid, { skirt: 2, bias: 0.2 })
  c.lobe(rng, 38, 55, 12, 9, R.decid, { skirt: 2, bias: 0.06 })
  c.lobe(rng, 57, 54, 12, 8.5, R.decid, { skirt: 2, bias: -0.06 })
  c.lobe(rng, 73, 51, 10, 8, R.decid, { skirt: 2, bias: -0.2 })
  // middle shelf
  c.lobe(rng, 27, 40, 11.5, 9, R.decid, { skirt: 2, bias: 0.22 })
  c.lobe(rng, 46, 41, 13, 9.5, R.decid, { skirt: 2, bias: 0.04 })
  c.lobe(rng, 65, 39, 11, 8.5, R.decid, { skirt: 2, bias: -0.18 })
  // top shelf
  c.lobe(rng, 36, 28, 10, 8, R.decid, { skirt: 2, bias: 0.24 })
  c.lobe(rng, 53, 27, 10.5, 8, R.decid, { skirt: 2, bias: 0.02 })
  c.lobe(rng, 45, 18, 8, 6.5, R.decid, { skirt: 1, bias: 0.18 })
})

spec('oak_b', 96, 80, { frost: ['decid'], under: ['decid', 'bark'], rim: { cov: 0.55, band: [0.1, 0.6] } }, (c, rng) => {
  // Twin-crown grove clump with a saddle notch — the wide roadside masses.
  trunk(c, rng, 32, 52, 79, 5, 6, { flare: true })
  trunk(c, rng, 64, 58, 79, 4, 5, { lean: -0.05, flare: true })
  c.line(32, 58, 44, 50, R.bark, SH.SHADOW, 2)
  // left (dominant) crown
  c.lobe(rng, 30, 42, 14, 11, R.decid, { darkenBy: 1, ragged: 0.2, hiP: 0 })
  c.lobe(rng, 16, 51, 10, 8, R.decid, { skirt: 2, bias: 0.22 })
  c.lobe(rng, 32, 54, 12, 9, R.decid, { skirt: 2, bias: 0.05 })
  c.lobe(rng, 44, 49, 10, 8, R.decid, { skirt: 2, bias: -0.05 })
  c.lobe(rng, 22, 36, 11, 8.5, R.decid, { skirt: 2, bias: 0.24 })
  c.lobe(rng, 38, 34, 11.5, 9, R.decid, { skirt: 2, bias: 0.06 })
  c.lobe(rng, 30, 23, 9.5, 7.5, R.decid, { skirt: 2, bias: 0.2 })
  // right (smaller, lower) crown
  c.lobe(rng, 66, 50, 12, 9, R.decid, { darkenBy: 1, ragged: 0.2, hiP: 0 })
  c.lobe(rng, 58, 56, 9, 7, R.decid, { skirt: 2, bias: 0.1 })
  c.lobe(rng, 72, 55, 10, 7.5, R.decid, { skirt: 2, bias: -0.15 })
  c.lobe(rng, 66, 43, 10, 8, R.decid, { skirt: 2, bias: -0.02 })
  c.lobe(rng, 74, 37, 8, 6.5, R.decid, { skirt: 1, bias: -0.2 })
})

spec('oak_c', 96, 80, { frost: ['olive'], under: ['olive', 'bark'], rim: { cov: 0.5, band: [0.1, 0.58] } }, (c, rng) => {
  // The olive-gold upright (frame01's "yellow" trees are olive-gold, §10.8):
  // narrower teardrop of banded shelves, dense sparkle on the tops.
  trunk(c, rng, 46, 60, 79, 4, 6, { flare: true })
  c.lobe(rng, 46, 45, 13, 12, R.olive, { darkenBy: 1, ragged: 0.2, hiP: 0 })
  c.lobe(rng, 32, 58, 10, 8, R.olive, { skirt: 2, bias: 0.2, hiP: 0.2 })
  c.lobe(rng, 48, 60, 11, 8.5, R.olive, { skirt: 2, bias: 0.02, hiP: 0.2 })
  c.lobe(rng, 61, 56, 9, 7.5, R.olive, { skirt: 2, bias: -0.18, hiP: 0.2 })
  c.lobe(rng, 34, 45, 10, 8, R.olive, { skirt: 2, bias: 0.22, hiP: 0.2 })
  c.lobe(rng, 52, 46, 11, 8.5, R.olive, { skirt: 2, bias: -0.04, hiP: 0.2 })
  c.lobe(rng, 42, 33, 10, 8, R.olive, { skirt: 2, bias: 0.18, hiP: 0.2 })
  c.lobe(rng, 55, 32, 8.5, 7, R.olive, { skirt: 2, bias: -0.12, hiP: 0.2 })
  c.lobe(rng, 47, 21, 7.5, 6.5, R.olive, { skirt: 1, bias: 0.14, hiP: 0.25 })
  c.lobe(rng, 46, 13, 5, 4.5, R.olive, { skirt: 1, bias: 0.1, hiP: 0.25 })
})

// ————— BLOSSOM (88×72) ——————————————————————————————————————————————————
// Frame02: grape-clusters of small round florets in three distinct pink
// ramps, plum undersides, loose petals adrift on the breeze.

function blossomPost(ramp) {
  return { frost: [ramp], under: [ramp, 'bark'], rim: { cov: 0.45, band: [0.1, 0.55] }, floret: ramp }
}

spec('blossom_a', 88, 72, blossomPost('blossomA'), (c, rng) => {
  trunk(c, rng, 43, 48, 71, 4, 5, { flare: true })
  c.line(43, 54, 34, 46, R.bark, SH.MID, 2)
  const P = R.blossomA
  c.lobe(rng, 42, 38, 15, 11, P, { darkenBy: 1, ragged: 0.16, hiP: 0 })
  const puffs = [
    [16, 48, 7.5, 0.2], [29, 51, 8, 0.1], [43, 52, 8.5, 0.03], [57, 50, 8, -0.08], [69, 46, 7, -0.2],
    [22, 38, 8, 0.22], [36, 39, 8.5, 0.08], [51, 38, 8.5, -0.04], [64, 36, 7.5, -0.18],
    [30, 27, 7.5, 0.2], [44, 26, 8, 0.05], [56, 27, 7, -0.12],
    [38, 17, 6.5, 0.16], [49, 18, 6, -0.02],
  ]
  for (const [x, y, r, b] of puffs) c.lobe(rng, x, y, r, r * 0.85, P, { skirt: 1, ragged: 0.16, bias: b, hiP: 0.16 })
  petal(c, rng, 78, 30, P)
  petal(c, rng, 82, 44, P)
  petal(c, rng, 72, 58, P)
  petal(c, rng, 63, 64, P)
})

spec('blossom_b', 88, 72, blossomPost('blossomB'), (c, rng) => {
  // Orchid ramp, asymmetric: heavy west mass, small east cluster, one
  // dangling puff below the saddle.
  trunk(c, rng, 38, 46, 71, 4, 5, { flare: true })
  c.line(38, 52, 47, 46, R.bark, SH.SHADOW, 2) // stays tucked under the crown
  const P = R.blossomB
  c.lobe(rng, 32, 36, 14, 11, P, { darkenBy: 1, ragged: 0.16, hiP: 0 })
  const puffs = [
    [14, 44, 7, 0.22], [26, 48, 8, 0.1], [40, 47, 8, 0.0],
    [20, 33, 8, 0.22], [34, 31, 8.5, 0.08], [46, 34, 7.5, -0.05],
    [28, 20, 7, 0.18], [40, 21, 7, 0.02],
    [62, 40, 7.5, -0.15], [72, 44, 6.5, -0.22], [66, 30, 6.5, -0.1],
    [55, 52, 5.5, -0.05], // dangler in the saddle
  ]
  for (const [x, y, r, b] of puffs) c.lobe(rng, x, y, r, r * 0.85, P, { skirt: 1, ragged: 0.16, bias: b, hiP: 0.16 })
  petal(c, rng, 79, 26, P)
  petal(c, rng, 82, 52, P)
  petal(c, rng, 52, 64, P)
})

spec('blossom_c', 88, 72, blossomPost('blossomC'), (c, rng) => {
  // Violet ramp: compact tall dome of fewer, bigger puffs, slight west lean.
  trunk(c, rng, 46, 50, 71, 4, 5, { lean: 0.04, flare: true })
  const P = R.blossomC
  c.lobe(rng, 43, 34, 13, 11, P, { darkenBy: 1, ragged: 0.16, hiP: 0 })
  const puffs = [
    [26, 47, 8.5, 0.18], [41, 50, 9, 0.04], [56, 46, 8, -0.14],
    [30, 33, 9, 0.2], [46, 33, 9.5, 0.0], [59, 33, 7.5, -0.18],
    [36, 20, 8, 0.16], [50, 21, 7.5, -0.04],
    [43, 12, 6, 0.1],
  ]
  for (const [x, y, r, b] of puffs) c.lobe(rng, x, y, r, r * 0.88, P, { skirt: 1, ragged: 0.16, bias: b, hiP: 0.16 })
  petal(c, rng, 70, 38, P)
  petal(c, rng, 74, 56, P)
  petal(c, rng, 20, 62, P)
})

// ————— BAMBOO (48×96) ———————————————————————————————————————————————————
// Frame02's bright columns: segmented culms with leafy tuft-tiers stacked
// along them and narrow blades flicking out.

function culm(c, rng, xb, topY, lean) {
  let nodeAt = 94 - ri(rng, 4, 7)
  for (let y = 94; y >= topY; y--) {
    const x = Math.round(xb + lean * (94 - y))
    if (y === nodeAt) {
      c.put(x, y, R.bamboo, SH.SHADOW)
      c.put(x + 1, y, R.bamboo, SH.SHADOW)
      if (c.inb(x - 1, y - 1)) c.put(x - 1, y - 1, R.bamboo, SH.HI)
      nodeAt -= ri(rng, 9, 13)
    } else {
      c.put(x, y, R.bamboo, SH.LIT)
      c.put(x + 1, y, R.bamboo, SH.MID)
    }
  }
  return (y) => Math.round(xb + lean * (94 - y))
}

/** Leafy tuft centred ON the culm so the column reads as solid foliage. */
function bambooTuft(c, rng, x, y, big) {
  const r = big ? rr(rng, 5, 6.2) : rr(rng, 3.8, 5)
  c.lobe(rng, x, y + 1, r * 1.05, r * 0.7, R.bamboo, { ragged: 0.36, skirt: 1, bias: 0.05, hiP: 0.2 })
  c.lobe(rng, x - r * 0.75, y - r * 0.4, r * 0.85, r * 0.62, R.bamboo, { ragged: 0.36, skirt: 1, bias: 0.2, hiP: 0.2 })
  c.lobe(rng, x + r * 0.75, y - r * 0.35, r * 0.85, r * 0.62, R.bamboo, { ragged: 0.36, skirt: 1, bias: -0.12, hiP: 0.2 })
  c.lobe(rng, x, y - r * 0.85, r * 0.8, r * 0.6, R.bamboo, { ragged: 0.36, skirt: 1, bias: 0.12, hiP: 0.22 })
  const blades = ri(rng, 3, big ? 5 : 4)
  for (let i = 0; i < blades; i++) {
    const dir = chance(rng, 0.5) ? -1 : 1
    const len = rr(rng, 6, 10)
    c.blade(rng, x, y - 1, x + dir * len, y - 1 - rr(rng, -3, 6), dir * 0.18, R.bamboo, (t) =>
      t > 0.75 ? SH.HI : t > 0.35 ? SH.LIT : SH.MID
    )
  }
}

spec('bamboo_a', 48, 96, { frost: ['bamboo'], under: ['bamboo'], rim: { cov: 0.35, band: [0.08, 0.7] } }, (c, rng) => {
  // Dense stand: five culms, tuft-tiers stacked down the upper two-thirds so
  // it reads as leafy columns (F2), bare segmented culms at the foot.
  const culms = [
    [7, 28, -0.015], [15, 13, -0.008], [23, 7, 0], [31, 18, 0.01], [39, 33, 0.02],
  ]
  for (const [x, top, lean] of culms) {
    const axis = culm(c, rng, x, top, lean)
    bambooTuft(c, rng, axis(top), top, true)
    for (let y = top + 13; y < 70; y += 13) {
      if (chance(rng, 0.85)) bambooTuft(c, rng, axis(y), y, false)
    }
  }
  // ground shoots
  c.poly([[4, 95], [5.5, 89], [7, 95]], R.bamboo, SH.MID)
  c.poly([[42, 95], [43.5, 90], [45, 95]], R.bamboo, SH.SHADOW)
})

spec('bamboo_b', 48, 96, { frost: ['bamboo'], under: ['bamboo'], rim: { cov: 0.35, band: [0.08, 0.7] } }, (c, rng) => {
  // Sparse leaning stand — three leafy culms and one snapped bare cane.
  const culms = [
    [10, 20, 0.025, true], [18, 34, 0.04, true], [27, 10, 0.055, true], [37, 58, 0.04, false],
  ]
  for (const [x, top, lean, leafy] of culms) {
    const axis = culm(c, rng, x, top, lean)
    if (leafy) {
      bambooTuft(c, rng, axis(top), top, top < 20)
      if (chance(rng, 0.8)) bambooTuft(c, rng, axis(top + 14), top + 14, false)
      if (top < 16) bambooTuft(c, rng, axis(top + 28), top + 28, false)
    } else {
      // snapped: splintered top
      c.put(axis(top), top - 1, R.bamboo, SH.SHADOW)
      c.put(axis(top) + 1, top - 2, R.bamboo, SH.MID)
    }
  }
  for (let i = 0; i < 3; i++) {
    const x = ri(rng, 6, 40)
    c.blade(rng, x, 94, x + ri(rng, 4, 9), 86 - ri(rng, 0, 4), 0.2, R.bamboo, (t) => (t > 0.7 ? SH.LIT : SH.MID))
  }
})

// ————— BUSHES (48×32) ———————————————————————————————————————————————————

const bushPost = { frost: ['decid'], under: ['decid'], rim: { cov: 0.45, band: [0.12, 0.65] } }

spec('bush_a', 48, 32, bushPost, (c, rng) => {
  c.lobe(rng, 24, 22, 12, 8, R.decid, { darkenBy: 1, ragged: 0.2, hiP: 0 })
  c.lobe(rng, 12, 24, 8.5, 6.5, R.decid, { skirt: 1, bias: 0.2 })
  c.lobe(rng, 27, 25, 9.5, 6.5, R.decid, { skirt: 1, bias: 0 })
  c.lobe(rng, 38, 25, 7, 5.5, R.decid, { skirt: 1, bias: -0.2 })
  c.lobe(rng, 18, 15, 7.5, 5.5, R.decid, { skirt: 1, bias: 0.22 })
  c.lobe(rng, 30, 14, 7, 5.5, R.decid, { skirt: 1, bias: -0.05 })
})

spec('bush_b', 48, 32, bushPost, (c, rng) => {
  // Long low hedge-form with a ragged top line.
  c.lobe(rng, 24, 24, 16, 7, R.decid, { darkenBy: 1, ragged: 0.2, hiP: 0 })
  c.lobe(rng, 8, 26, 6.5, 5, R.decid, { skirt: 1, bias: 0.22 })
  c.lobe(rng, 19, 27, 7.5, 5.5, R.decid, { skirt: 1, bias: 0.08 })
  c.lobe(rng, 31, 26, 7.5, 5.5, R.decid, { skirt: 1, bias: -0.06 })
  c.lobe(rng, 41, 27, 6, 4.5, R.decid, { skirt: 1, bias: -0.2 })
  c.lobe(rng, 14, 18, 6, 4.5, R.decid, { skirt: 1, bias: 0.2 })
  c.lobe(rng, 26, 17, 6.5, 5, R.decid, { skirt: 1, bias: 0 })
  c.lobe(rng, 37, 19, 5.5, 4, R.decid, { skirt: 1, bias: -0.15 })
})

spec('bush_c', 48, 32, bushPost, (c, rng) => {
  // Round dome dotted with white flowers (pasture accent).
  c.lobe(rng, 24, 21, 13, 9, R.decid, { darkenBy: 1, ragged: 0.18, hiP: 0 })
  c.lobe(rng, 15, 23, 8, 6.5, R.decid, { skirt: 1, bias: 0.2 })
  c.lobe(rng, 30, 23, 9, 7, R.decid, { skirt: 1, bias: -0.08 })
  c.lobe(rng, 22, 14, 8, 6, R.decid, { skirt: 1, bias: 0.15 })
  c.lobe(rng, 33, 15, 6, 4.5, R.decid, { skirt: 1, bias: -0.15 })
  for (let i = 0; i < 5; i++) {
    const x = ri(rng, 10, 36)
    const y = ri(rng, 11, 20)
    if (c.on(x, y)) {
      c.put(x, y, R.petalW, SH.HI)
      if (chance(rng, 0.5)) c.put(x + 1, y, R.petalW, SH.LIT)
    }
  }
})

// ————— ROCKS & BOULDER ——————————————————————————————————————————————————
// Pale limestone (cliff family): 3 hard facets — lit top plane, mid face,
// dark base — crevice cracks, chips at the toe, a breath of moss.

function roughenSides(c, rng, p = 0.16) {
  const snap = c.ramp.slice()
  for (let y = 1; y < c.h - 2; y++) {
    for (let x = 1; x < c.w - 1; x++) {
      const i = y * c.w + x
      if (snap[i] === EMPTY) continue
      const leftEdge = snap[i - 1] === EMPTY
      const rightEdge = snap[i + 1] === EMPTY
      if ((leftEdge || rightEdge) && chance(rng, p)) c.erase(x, y)
    }
  }
}

const rockPost = { under: ['rock'], rim: { cov: 0.3, band: [0.06, 0.5] } }

spec('rock_a', 48, 36, rockPost, (c, rng) => {
  // Angular wedge, peak west of centre.
  c.poly([[8, 34], [4, 23], [14, 9], [26, 5], [42, 15], [44, 28], [40, 34]], R.rock, SH.MID)
  c.poly([[4, 23], [14, 9], [26, 5], [31, 13], [13, 26]], R.rock, SH.HI) // lit top plane
  c.poly([[31, 13], [42, 15], [44, 28], [40, 34], [30, 34]], R.rock, SH.MID + 1) // east face
  for (let x = 7; x <= 41; x++) if (c.on(x, 33)) c.darken(x, 33, 2)
  roughenSides(c, rng)
  // crevice cracks drawn last so they stay crisp
  c.line(26, 5, 30, 13, R.rock, SH.SHADOW, 1)
  c.line(30, 13, 28, 26, R.rock, SH.SHADOW, 1)
  c.line(13, 26, 10, 33, R.rock, SH.SHADOW, 1)
  // chips + moss toe
  c.poly([[1, 35], [3, 31.5], [5, 35]], R.rock, SH.MID)
  c.poly([[43, 35], [45, 32], [47, 35]], R.rock, SH.SHADOW)
  c.put(9, 33, R.grass, SH.MID)
  c.put(10, 34, R.grass, SH.LIT)
  c.put(36, 34, R.grass, SH.MID)
})

spec('rock_b', 48, 36, rockPost, (c, rng) => {
  // Two stacked slabs — long low profile with strata lines.
  c.poly([[6, 32], [5, 19], [16, 11], [34, 9], [43, 17], [41, 32]], R.rock, SH.MID)
  c.poly([[5, 19], [16, 11], [34, 9], [37, 14], [12, 22]], R.rock, SH.HI)
  c.poly([[37, 14], [43, 17], [41, 32], [30, 32]], R.rock, SH.MID + 1)
  // front slab
  c.poly([[28, 26], [44, 23], [46, 33], [30, 34]], R.rock, SH.MID)
  c.poly([[28, 26], [44, 23], [45, 26], [29, 29]], R.rock, SH.HI)
  for (let x = 5; x <= 46; x++) {
    if (c.on(x, 32) ) c.darken(x, 32, 2)
    if (c.on(x, 33)) c.darken(x, 33, 2)
  }
  // strata
  for (let x = 8; x <= 38; x++) if (chance(rng, 0.6) && c.on(x, 20)) c.darken(x, 20, 1)
  for (let x = 10; x <= 40; x++) if (chance(rng, 0.5) && c.on(x, 25)) c.darken(x, 25, 1)
  roughenSides(c, rng, 0.12)
  c.poly([[1, 34], [2.5, 31], [4, 34]], R.rock, SH.MID)
  c.put(7, 31, R.grass, SH.MID)
  c.put(44, 33, R.grass, SH.MID)
})

spec('rock_c', 48, 36, rockPost, (c, rng) => {
  // Shard cluster — three standing splinters (the F2 monolith family).
  c.poly([[6, 34], [8, 17], [15, 15], [16, 34]], R.rock, SH.MID)
  c.poly([[8, 17], [12, 16], [12, 30], [8, 30]], R.rock, SH.HI)
  c.poly([[16, 34], [18, 8], [26, 5], [30, 34]], R.rock, SH.MID)
  c.poly([[18, 8], [24, 6], [23, 24], [18, 24]], R.rock, SH.HI)
  c.poly([[26, 5], [30, 34], [27, 34]], R.rock, SH.MID + 1)
  c.poly([[32, 34], [34, 20], [41, 18], [43, 34]], R.rock, SH.MID)
  c.poly([[34, 20], [38, 19], [37, 28]], R.rock, SH.HI)
  for (let x = 5; x <= 44; x++) if (c.on(x, 33)) c.darken(x, 33, 2)
  roughenSides(c, rng, 0.1)
  c.line(16, 30, 16, 12, R.rock, SH.SHADOW, 1)
  c.line(31, 30, 31, 16, R.rock, SH.SHADOW, 1)
  c.put(13, 33, R.grass, SH.MID)
  c.put(33, 33, R.grass, SH.LIT)
})

spec('boulder_a', 64, 48, { under: ['rock'], rim: { cov: 0.3, band: [0.06, 0.5] } }, (c, rng) => {
  // The big faceted dome with strata banding and a crack from the crown.
  c.poly([[7, 45], [4, 27], [13, 12], [30, 6], [48, 9], [59, 20], [61, 35], [56, 45]], R.rock, SH.MID)
  c.poly([[4, 27], [13, 12], [30, 6], [44, 8], [36, 18], [12, 30]], R.rock, SH.HI)
  c.poly([[44, 8], [48, 9], [59, 20], [61, 35], [56, 45], [46, 45], [42, 20]], R.rock, SH.MID + 1)
  for (let x = 6; x <= 60; x++) {
    if (c.on(x, 44)) c.darken(x, 44, 2)
    if (c.on(x, 45)) c.darken(x, 45, 2)
  }
  // strata dashes
  for (let x = 8; x <= 56; x++) if (chance(rng, 0.55) && c.on(x, 26)) c.darken(x, 26, 1)
  for (let x = 10; x <= 58; x++) if (chance(rng, 0.45) && c.on(x, 33)) c.darken(x, 33, 1)
  roughenSides(c, rng, 0.12)
  // crack from the crown, drawn last so it stays crisp
  c.line(30, 6, 33, 15, R.rock, SH.SHADOW, 1)
  c.line(33, 15, 30, 26, R.rock, SH.SHADOW, 1)
  c.line(30, 26, 33, 36, R.rock, SH.SHADOW, 1)
  // chips + moss crown
  c.poly([[1, 46], [3, 42.5], [5, 46]], R.rock, SH.MID)
  c.poly([[59, 46], [61, 43], [63, 46]], R.rock, SH.SHADOW)
  c.put(16, 13, R.grass, SH.LIT)
  c.put(17, 12, R.grass, SH.MID)
  c.put(19, 13, R.grass, SH.MID)
  c.put(14, 15, R.grass, SH.LIT)
  c.put(10, 44, R.grass, SH.MID)
  c.put(52, 45, R.grass, SH.MID)
})

// ————— GROUND FLORA ——————————————————————————————————————————————————————

spec('grass_tuft_a', 24, 20, { frost: ['grass'] }, (c, rng) => {
  // Fountain tuft: blades fanning both ways, lit tips.
  const tips = [
    [4, 7], [8, 3], [12, 2], [16, 4], [20, 8], [6, 12], [18, 12],
  ]
  for (const [tx, ty] of tips) {
    const bend = (tx - 12) * 0.02
    c.blade(rng, 12 + rr(rng, -1, 1), 19, tx, ty + rr(rng, -1, 1), bend, R.grass, (t) =>
      t > 0.72 ? SH.LIT : t > 0.35 ? SH.MID : SH.SHADOW
    )
  }
  for (let x = 9; x <= 15; x++) c.put(x, 19, R.grass, SH.SHADOW)
  c.put(11, 18, R.grass, SH.MID)
  c.put(13, 18, R.grass, SH.MID)
})

spec('grass_tuft_b', 24, 20, { frost: ['grass'] }, (c, rng) => {
  // Wind-combed: every blade swept east, one seeding stem.
  const tips = [
    [13, 4], [17, 6], [20, 9], [22, 13], [15, 3], [19, 12],
  ]
  for (const [tx, ty] of tips) {
    c.blade(rng, 9 + rr(rng, -1, 1.5), 19, tx, ty, 0.22, R.grass, (t) =>
      t > 0.72 ? SH.LIT : t > 0.35 ? SH.MID : SH.SHADOW
    )
  }
  c.blade(rng, 8, 19, 3, 10, -0.15, R.grass, (t) => (t > 0.6 ? SH.MID : SH.SHADOW))
  c.blade(rng, 10, 19, 21, 2, 0.25, R.grass, (t) => (t > 0.5 ? SH.LIT : SH.MID))
  c.put(21, 2, R.grass, SH.HI)
  c.put(22, 3, R.grass, SH.HI)
  for (let x = 7; x <= 12; x++) c.put(x, 19, R.grass, SH.SHADOW)
})

spec('fern_a', 32, 24, { frost: ['conifer'] }, (c, rng) => {
  // Forest-floor fern in the darker conifer greens: four arcing fronds with
  // chevron leaflets shrinking to the tip; upper sides lit, undersides dark.
  const fronds = [
    [4, 9, -0.2], [11, 2, -0.08], [21, 3, 0.08], [28, 11, 0.2],
  ]
  for (const [tx, ty, bend] of fronds) {
    const x0 = 16 + rr(rng, -1, 1)
    const mx = (x0 + tx) / 2 - (ty - 22) * bend
    const my = (22 + ty) / 2 + (tx - x0) * bend
    const n = 14
    let prev = null
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const a = 1 - t
      const px = a * a * x0 + 2 * a * t * mx + t * t * tx
      const py = a * a * 22 + 2 * a * t * my + t * t * ty
      c.put(px, py, R.conifer, t > 0.7 ? SH.LIT : SH.MID)
      if (i >= 4 && i % 3 === 0 && prev) {
        const dx = px - prev[0]
        const dy = py - prev[1]
        const L = Math.hypot(dx, dy) || 1
        const lw = Math.max(1, Math.round(2.4 * (1 - t)))
        for (let k = 1; k <= lw; k++) {
          if (chance(rng, 0.85)) c.put(px - (dy / L) * k, py + (dx / L) * k, R.conifer, t > 0.5 ? SH.LIT : SH.MID)
          if (chance(rng, 0.55)) c.put(px + (dy / L) * k, py - (dx / L) * k, R.conifer, SH.MID + (t > 0.5 ? 0 : 1))
        }
      }
      prev = [px, py]
    }
  }
  for (let x = 14; x <= 18; x++) c.put(x, 23, R.conifer, SH.SHADOW)
})

spec('flower_a', 20, 20, {}, (c, rng) => {
  // White meadow flowers with gold hearts on leaning green stems.
  c.blade(rng, 6, 19, 4, 9, -0.08, R.grass, (t) => (t > 0.5 ? SH.MID : SH.SHADOW))
  c.blade(rng, 10, 19, 10, 5, 0.04, R.grass, (t) => (t > 0.5 ? SH.MID : SH.SHADOW))
  c.blade(rng, 14, 19, 16, 10, 0.1, R.grass, (t) => (t > 0.5 ? SH.MID : SH.SHADOW))
  c.put(8, 14, R.grass, SH.MID)
  c.put(12, 12, R.grass, SH.MID)
  flowerHead(c, 4, 8, R.petalW, R.petalG, SH.LIT)
  flowerHead(c, 10, 4, R.petalW, R.petalG, SH.LIT)
  flowerHead(c, 16, 9, R.petalW, R.petalG, SH.LIT)
  c.put(7, 11, R.petalW, SH.HI, F_NO_OUTLINE) // drifting petal
})

spec('flower_b', 20, 20, {}, (c, rng) => {
  // Gold cluster — smaller heads, denser.
  const stems = [
    [4, 10], [8, 6], [12, 8], [16, 12],
  ]
  for (const [sx, sy] of stems) {
    c.blade(rng, sx, 19, sx + 1, sy, 0.06, R.grass, (t) => (t > 0.5 ? SH.MID : SH.SHADOW))
    c.put(sx + 1, sy - 1, R.petalG, SH.HI)
    c.put(sx, sy - 1, R.petalG, SH.LIT)
    c.put(sx + 1, sy, R.petalG, SH.LIT)
    c.put(sx, sy, R.petalG, SH.MID)
  }
  c.put(6, 15, R.grass, SH.MID)
  c.put(13, 14, R.grass, SH.MID)
})

// ————— WHEAT (40×28) ————————————————————————————————————————————————————
// Fenced golden paddocks beside the hero: vertical stalks, pale seed heads
// with flicked awns, shadowed feet. Back rank drawn dark for depth.

function wheatStalks(c, rng, leanAll, broken) {
  // back rank — mid-tone, gives body without muddying the gold
  for (let i = 0; i < 8; i++) {
    const x = 3 + i * 4.6 + ri(rng, 0, 2)
    const top = ri(rng, 10, 14)
    c.blade(rng, x, 26, x + leanAll * 0.7, top, 0.02, R.wheat, () => SH.MID)
    c.put(x + leanAll * 0.7, top - 1, R.wheat, SH.LIT)
  }
  // front rank — bright stalks with chunky pale seed heads (WHEAT_TIPS)
  const n = 13
  for (let i = 0; i < n; i++) {
    const x = 2 + i * 2.8 + rr(rng, -0.8, 0.8)
    const top = ri(rng, 5, 10)
    const lean = leanAll + rr(rng, -1, 1)
    const isBroken = broken && i === 8
    const tx = Math.round(x + lean)
    const ty = isBroken ? top + 7 : top
    c.blade(rng, x, 27, tx, ty, lean * 0.03, R.wheat, (t) => (t < 0.22 ? SH.MID : SH.LIT))
    if (isBroken) {
      // snapped head hanging sideways
      c.put(tx + 1, ty + 1, R.wheat, SH.LIT)
      c.put(tx + 2, ty + 2, R.wheat, SH.HI)
      c.put(tx + 3, ty + 3, R.wheat, SH.HI)
      continue
    }
    // seed head: 2 px-wide pale block, 4–5 tall, one awn flick
    const hh = ri(rng, 4, 5)
    for (let dy = 0; dy < hh; dy++) {
      c.put(tx, ty - dy, R.wheat, SH.HI)
      c.put(tx - 1, ty - dy, R.wheat, dy >= hh - 2 ? SH.HI : SH.LIT)
    }
    c.put(tx + (lean >= 0 ? 1 : -2), ty - hh, R.wheat, SH.HI)
  }
  // shadowed feet, only the bottom two rows
  for (let x = 1; x <= 38; x++) {
    if (chance(rng, 0.8)) c.put(x, 27, R.wheat, SH.SHADOW)
    if (chance(rng, 0.35)) c.put(x, 26, R.wheat, SH.SHADOW)
  }
}

spec('wheat_a', 40, 28, {}, (c, rng) => wheatStalks(c, rng, 0.6, false))
spec('wheat_b', 40, 28, {}, (c, rng) => wheatStalks(c, rng, 3.2, true)) // wind-bent, one snapped

// ————— STUMP & LOG ———————————————————————————————————————————————————————

spec('stump', 40, 28, { under: ['bark'], rim: { cov: 0.3, band: [0.15, 0.7] } }, (c, rng) => {
  // Bark barrel
  for (let x = 10; x <= 30; x++) {
    for (let y = 11; y <= 26; y++) {
      let sh = SH.LIT
      if (x <= 11) sh = SH.HI
      else if (x >= 28) sh = SH.SHADOW
      else if ((x * 7 + 3) % 5 === 0) sh = SH.MID // vertical bark striping
      else if ((x * 3 + 1) % 7 === 0) sh = SH.SHADOW
      if (y >= 25) sh = SH.SHADOW
      c.put(x, y, R.bark, sh)
    }
  }
  // root flares
  c.poly([[6, 27], [10, 21], [12, 27]], R.bark, SH.MID)
  c.poly([[28, 27], [30, 22], [34, 27]], R.bark, SH.SHADOW)
  // cut face: ellipse + growth rings + offset heart
  const cx = 20
  const cy = 9.5
  for (let y = 4; y <= 15; y++) {
    for (let x = 8; x <= 32; x++) {
      const nx = (x - cx) / 11.4
      const ny = (y - cy) / 4.9
      if (nx * nx + ny * ny <= 1) c.put(x, y, R.woodcut, ny < -0.55 ? SH.HI : SH.LIT)
    }
  }
  c.ring(rng, cx, cy, 11.4, 4.9, R.woodcut, SH.MID, 0.05) // bark lip
  c.ring(rng, cx + 1, cy + 0.5, 8.2, 3.4, R.woodcut, SH.MID, 0.2)
  c.ring(rng, cx + 1.5, cy + 0.8, 5.4, 2.2, R.woodcut, SH.MID, 0.2)
  c.ring(rng, cx + 2, cy + 1, 2.8, 1.2, R.woodcut, SH.SHADOW, 0.25)
  c.put(cx + 2, cy + 1, R.woodcut, SH.SHADOW)
  // axe notch chipped from the east rim
  c.polyErase([[30, 4], [34, 6], [33, 9]])
  c.put(30, 7, R.woodcut, SH.MID)
  c.put(31, 8, R.bark, SH.SHADOW)
  // moss at the west foot
  c.put(9, 24, R.grass, SH.MID)
  c.put(10, 25, R.grass, SH.LIT)
  c.put(9, 26, R.grass, SH.MID)
})

spec('log', 48, 24, { under: ['bark'], rim: { cov: 0.35, band: [0.1, 0.6] } }, (c, rng) => {
  // Fallen trunk: lit top surface, banded bark, broken west end, ringed east
  // face, moss saddle. Kept mid-value so it reads against grass shadow.
  for (let x = 4; x <= 43; x++) {
    const wob = Math.round(Math.sin(x * 0.3) * 1)
    for (let y = 9 + wob; y <= 20; y++) {
      let sh = SH.LIT
      if (y <= 11 + wob) sh = SH.HI // sunlit top curve
      else if (y >= 18) sh = SH.SHADOW
      else if (y >= 16) sh = SH.MID
      c.put(x, y, R.bark, sh)
    }
  }
  // bark grain dashes on the mid band only
  for (let i = 0; i < 16; i++) {
    const x = ri(rng, 7, 39)
    const y = ri(rng, 13, 16)
    c.put(x, y, R.bark, SH.MID)
    if (chance(rng, 0.5)) c.put(x + 1, y, R.bark, SH.MID)
  }
  // splintered west break
  c.polyErase([[3, 8], [7, 8], [4, 12]])
  c.polyErase([[3, 20], [8, 21], [3, 16]])
  c.poly([[4, 12], [8, 10], [8, 16]], R.woodcut, SH.MID)
  c.put(7, 12, R.woodcut, SH.LIT)
  // east cut face with rings
  for (let y = 9; y <= 20; y++) {
    for (let x = 40; x <= 47; x++) {
      const nx = (x - 43.5) / 3.6
      const ny = (y - 14.5) / 5.8
      if (nx * nx + ny * ny <= 1) c.put(x, y, R.woodcut, nx < -0.3 ? SH.HI : SH.LIT)
    }
  }
  c.ring(rng, 43.5, 14.5, 2.3, 4, R.woodcut, SH.MID, 0.12)
  c.ring(rng, 43.8, 14.7, 1.1, 2, R.woodcut, SH.MID, 0.2)
  c.put(44, 15, R.woodcut, SH.SHADOW)
  // branch stub
  c.poly([[15, 10], [13, 4], [17, 4], [18, 10]], R.bark, SH.MID)
  c.put(14, 9, R.bark, SH.HI)
  c.put(14, 4, R.woodcut, SH.MID)
  c.put(15, 4, R.woodcut, SH.LIT)
  c.put(16, 4, R.woodcut, SH.MID)
  // moss run along the lit top
  for (let x = 21; x <= 34; x++) {
    const yy = 9 + Math.round(Math.sin(x * 0.3) * 1)
    if (chance(rng, 0.8)) c.put(x, yy, R.grass, chance(rng, 0.45) ? SH.HI : SH.LIT)
    if (chance(rng, 0.4)) c.put(x, yy + 1, R.grass, SH.MID)
  }
})

// ————— CATTAIL & LILYPAD (river-bank / water dressing) ———————————————————

spec('cattail', 24, 40, { frost: ['grass'] }, (c, rng) => {
  // Three stems: two brown sausage heads with pale spikes, arcing leaves.
  const stems = [
    [6, 9, true], [12, 3, true], [18, 15, false],
  ]
  for (const [sx, top, headed] of stems) {
    c.blade(rng, sx, 39, sx + 1, top + (headed ? 8 : 0), 0.02, R.grass, (t) => (t > 0.5 ? SH.MID : SH.SHADOW))
    if (headed) {
      for (let y = top; y <= top + 7; y++) {
        c.put(sx, y, R.bark, SH.HI)
        c.put(sx + 1, y, R.bark, SH.LIT)
        c.put(sx + 2, y, R.bark, SH.MID + 1)
      }
      c.put(sx, top, R.bark, SH.LIT)
      c.put(sx + 2, top, R.bark, SH.SHADOW)
      c.put(sx + 1, top - 1, R.bark, SH.LIT)
      for (let dy = 2; dy <= 4; dy++) c.put(sx + 1, top - dy, R.wheat, dy === 2 ? SH.LIT : SH.HI)
    }
  }
  c.blade(rng, 6, 39, 1, 13, -0.14, R.grass, (t) => (t > 0.65 ? SH.HI : t > 0.3 ? SH.LIT : SH.MID))
  c.blade(rng, 12, 39, 21, 15, 0.16, R.grass, (t) => (t > 0.65 ? SH.HI : t > 0.3 ? SH.LIT : SH.MID))
  c.blade(rng, 18, 39, 22, 27, 0.12, R.grass, (t) => (t > 0.7 ? SH.LIT : SH.MID))
  c.blade(rng, 9, 39, 3, 29, -0.1, R.grass, (t) => (t > 0.6 ? SH.MID : SH.SHADOW))
  c.blade(rng, 15, 39, 10, 18, -0.1, R.grass, (t) => (t > 0.7 ? SH.LIT : SH.MID))
  for (let x = 4; x <= 20; x++) if (chance(rng, 0.5)) c.put(x, 39, R.grass, SH.SHADOW)
})

spec('lilypad', 32, 16, {}, (c, rng) => {
  // Three floating pads with notch wedges + a tiny pink lotus. Top-lit discs,
  // dark waterline edge below.
  const pad = (cx, cy, rx, ry, base) => {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const nx = (x - cx) / rx
        const ny = (y - cy) / ry
        if (nx * nx + ny * ny > 1) continue
        let sh = base
        if (ny < -0.35 && nx < 0.2) sh = base - 1
        if (ny > 0.55) sh = SH.SHADOW
        c.put(x, y, R.decid, Math.max(SH.HI, sh))
      }
    }
  }
  pad(11, 8, 9.5, 4.4, SH.LIT)
  pad(25, 12, 6, 2.7, SH.MID)
  pad(4, 13, 3.5, 1.8, SH.MID)
  c.polyErase([[11, 8], [22, 5], [22, 9]]) // the classic notch
  c.put(12, 7, R.decid, SH.SHADOW)
  c.put(13, 6, R.decid, SH.SHADOW)
  // lotus
  c.put(8, 4, R.blossomA, SH.HI)
  c.put(7, 5, R.blossomA, SH.LIT)
  c.put(9, 5, R.blossomA, SH.LIT)
  c.put(8, 5, R.blossomA, SH.MID)
  c.put(8, 3, R.petalW, SH.HI, F_NO_OUTLINE)
})

// ---------------------------------------------------------------------------
// 6. Packing + texture assembly
// ---------------------------------------------------------------------------

const ATLAS_SIZE = 2048
const SCALE = 4 // logical pixel -> 4×4 texel block (fat texels for mips/aniso)
const GAP = 16 // transparent gutter between cells, in atlas texels (= 4 logical px)

function buildCell(specDef) {
  const c = new Cell(specDef.w, specDef.h)
  const rng = rngFor(specDef.key)
  specDef.build(c, rng)
  const post = specDef.post || {}
  const postRng = rngFor(specDef.key + '/post')
  if (post.frost) frostTops(c, postRng, post.frost.map((n) => R[n]), 0.35)
  if (post.floret) {
    // blossom floret sparkle: structured single-px lightening across lobetops
    const id = R[post.floret]
    for (let i = 0; i < c.ramp.length; i++) {
      if (c.ramp[i] !== id) continue
      if (c.shade[i] === SH.LIT && chance(postRng, 0.12)) c.shade[i] = SH.HI
      else if (c.shade[i] === SH.MID && chance(postRng, 0.07)) c.shade[i] = SH.LIT
    }
  }
  if (post.under) underShadow(c, post.under.map((n) => R[n]))
  if (post.rim) rimRight(c, postRng, post.rim)
  outline(c)
  return c
}

export function makeVegetationAtlas(renderer) {
  const canvas = document.createElement('canvas')
  canvas.width = ATLAS_SIZE
  canvas.height = ATLAS_SIZE
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false

  const frames = {}
  let penX = GAP
  let penY = GAP
  let rowH = 0

  for (const sd of SPECS) {
    const cell = buildCell(sd)
    const W4 = sd.w * SCALE
    const H4 = sd.h * SCALE
    if (penX + W4 + GAP > ATLAS_SIZE) {
      penX = GAP
      penY += rowH + GAP
      rowH = 0
    }
    if (penY + H4 + GAP > ATLAS_SIZE) {
      throw new Error('atlas.js: atlas overflow — packing exceeded ' + ATLAS_SIZE)
    }

    // Blit at 4× with nearest blocks via raw ImageData (putImageData is exact:
    // no compositing, no smoothing, integer coords).
    const img = ctx.createImageData(W4, H4)
    const d = img.data
    for (let y = 0; y < sd.h; y++) {
      for (let x = 0; x < sd.w; x++) {
        const i = y * sd.w + x
        const rid = cell.ramp[i]
        if (rid === EMPTY) continue
        const col = RAMP_DEFS[rid].cols[cell.shade[i]]
        for (let by = 0; by < SCALE; by++) {
          let o = ((y * SCALE + by) * W4 + x * SCALE) * 4
          for (let bx = 0; bx < SCALE; bx++) {
            d[o] = col[0]
            d[o + 1] = col[1]
            d[o + 2] = col[2]
            d[o + 3] = 255
            o += 4
          }
        }
      }
    }
    ctx.putImageData(img, penX, penY)

    // UVs: tight to the art cell. flipY upload => v = 1 - y/size, so v0 is
    // the sprite's BOTTOM row (the anchor), v1 its top.
    frames[sd.key] = {
      u0: penX / ATLAS_SIZE,
      v0: 1 - (penY + H4) / ATLAS_SIZE,
      u1: (penX + W4) / ATLAS_SIZE,
      v1: 1 - penY / ATLAS_SIZE,
      px: sd.w, // logical (art-bible §6) cell dims — use for world sizing:
      py: sd.h, // worldHeight ≈ py / 40 texels-per-metre reproduces §5.
      aspect: sd.w / sd.h,
      anchor: 'bottom',
    }

    penX += W4 + GAP
    if (H4 > rowH) rowH = H4
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  const caps = renderer && renderer.capabilities
  texture.anisotropy = caps && caps.getMaxAnisotropy ? caps.getMaxAnisotropy() : 4
  texture.needsUpdate = true

  return { texture, frames, size: ATLAS_SIZE }
}

/** Debug helper: the raw packed atlas canvas, for inspection. */
export function atlasDebugCanvas(atlas) {
  return atlas.texture.image
}
