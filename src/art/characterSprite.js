// ---------------------------------------------------------------------------
// characterSprite.js — hero + chocobo-mount sprite sheets, 100% procedural.
//
// Contract (docs/CONTRACT.md — frozen):
//   export function makeHeroSheet(): Sheet
//   export function makeMountSheet(): Sheet
//   Sheet = { texture, frameW, frameH, cols, rows, anims, fps }
//   anim keys: idle_s idle_n idle_e idle_w walk_s walk_n walk_e walk_w
//              run_s run_n run_e run_w        (frame index = row * cols + col)
//
// Art direction (docs/ART_BIBLE.md):
//   - 64×64 cells, hero body ≈56 px tall in-cell → at 35 texels/m the sprite
//     plane is 64/35 = 1.83 m and the body reads 1.60 m. Mount cells 64×64.
//   - 4-shade ramps per material + HI accents, zero gradients, zero dithering.
//   - 1 px colour-matched warm near-black outline #1d1410 (hero pops harder
//     than vegetation).
//   - Sun WSW / screen upper-LEFT: lit shades cluster top-left, shadow pools
//     bottom-right, plus a warm sun-side rim on the LEFT silhouette edge and
//     a faint cool bounce on the lower RIGHT edge.
//   - Sheets are exact power-of-two (1024×512) with an exact 16×8 grid of
//     64×64 cells, so both common UV conventions (1/cols vs frameW/texW)
//     agree. NearestFilter, sRGB.
//
// Everything is authored: explicit silhouettes, hand-placed pixels for faces,
// trim, folds and feathers; the seeded PRNG is used only for single-pixel
// HI speckle so output is fully deterministic.
// ---------------------------------------------------------------------------

import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Sheet geometry
// ---------------------------------------------------------------------------

const CELL = 64                 // px per frame cell (both sheets)
const COLS = 16                 // cells per row
const ROWS = 8                  // cell rows
const SHEET_W = COLS * CELL     // 1024 (power of two)
const SHEET_H = ROWS * CELL     // 512  (power of two)
const FPS = 15                  // one clock for all anims; idle uses repeats

const GY = 60                   // ground row inside a cell (soles rest here;
                                // the 1 px outline lands on 61, rows 62–63
                                // stay clear so bases can sink 2–3 texels)

// ---------------------------------------------------------------------------
// Palette — ramps anchored on ART_BIBLE §3 "Hero & mount" lit/shade pairs.
// hi = sun-kissed accent, lit/mid/sh = the working 3, deep = occlusion floor.
// ---------------------------------------------------------------------------

function hex(h) {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const OUT = hex('#1d1410')      // sprite outline (bible-exact warm near-black)

const SKIN = { hi: hex('#f6dfc2'), lit: hex('#e8c9a8'), mid: hex('#cfa987'), sh: hex('#b08c6c') }
const HAIR = { hi: hex('#f8e9a2'), lit: hex('#e8cf6f'), mid: hex('#cda44e'), sh: hex('#b3873a'), deep: hex('#8a6428') }
const RED  = { hi: hex('#c04a38'), lit: hex('#a03028'), mid: hex('#7c241e'), sh: hex('#5c1c14') }
const BLK  = { hi: hex('#4e4642'), lit: hex('#37302e'), mid: hex('#2a2422'), sh: hex('#1d1815') }
const GOLD = { hi: hex('#ffe9a6'), lit: hex('#d9b542'), mid: hex('#b08f33'), sh: hex('#8a6d24') }
const CAPE = { hi: hex('#eef3f6'), lit: hex('#dce4ea'), mid: hex('#b5c4d2'), sh: hex('#8fa3b8'), deep: hex('#6b8093') }
const BODY = { hi: hex('#f2cd7a'), lit: hex('#e0a844'), mid: hex('#bd8a36'), sh: hex('#976d2c'), deep: hex('#6f4e1e') } // mount plumage
const BEAK = { hi: hex('#f0a34e'), lit: hex('#d97f2e'), mid: hex('#b06224'), sh: hex('#7e451a') }                      // beak + legs
const EYE_WHITE = hex('#f4f1e8')

// Sun-side rim: for each ramp colour, the colour an edge pixel is promoted to
// when the WSW sun grazes the left silhouette. Cool bounce: one-step lift used
// on the lower right edge. Both are lookup tables keyed by packed rgb.
const key = (c) => (c[0] << 16) | (c[1] << 8) | c[2]

const RIM_SUN = new Map()
const RIM_BOUNCE = new Map()
for (const r of [SKIN, HAIR, RED, BLK, GOLD, CAPE, BODY, BEAK]) {
  RIM_SUN.set(key(r.lit), r.hi)
  RIM_SUN.set(key(r.mid), r.lit)
  RIM_SUN.set(key(r.sh), r.mid)
  RIM_BOUNCE.set(key(r.sh), r.mid)
  if (r.deep) RIM_BOUNCE.set(key(r.deep), r.sh)
}
// Cape catches the mint sky bounce a touch harder (it faces the sky).
RIM_BOUNCE.set(key(CAPE.sh), CAPE.mid)

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — speckle only, never structure.
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// Pix — a 64×64 RGBA scratch cell with pixel-art primitives. All coordinates
// are integers; painters overwrite back-to-front. No canvas, no AA, ever.
// ---------------------------------------------------------------------------

class Pix {
  constructor() { this.d = new Uint8ClampedArray(CELL * CELL * 4) }
  clear() { this.d.fill(0) }
  px(x, y, c) {
    if (x < 0 || y < 0 || x >= CELL || y >= CELL) return
    const o = (y * CELL + x) * 4
    this.d[o] = c[0]; this.d[o + 1] = c[1]; this.d[o + 2] = c[2]; this.d[o + 3] = 255
  }
  get(x, y) {
    if (x < 0 || y < 0 || x >= CELL || y >= CELL) return 0
    return this.d[(y * CELL + x) * 4 + 3]
  }
  colAt(x, y) {
    const o = (y * CELL + x) * 4
    return [this.d[o], this.d[o + 1], this.d[o + 2]]
  }
  r(x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, c) }
  h(x0, x1, y, c) { for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.px(x, y, c) }
  v(x, y0, y1, c) { for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) this.px(x, y, c) }
  // Filled pixel ellipse centred on (cx, cy) — used for skulls, breasts, lobes.
  disc(cx, cy, rx, ry, c) {
    for (let dy = -ry; dy <= ry; dy++) {
      const t = dy / (ry + 0.35)
      const hw = Math.floor(rx * Math.sqrt(Math.max(0, 1 - t * t)) + 0.5)
      this.h(cx - hw, cx + hw, cy + dy, c)
    }
  }
  // Upward spike: base row `by` inclusive, base half-width, height, tip lean.
  spike(cx, by, halfW, hgt, lean, c) {
    for (let j = 0; j < hgt; j++) {
      const t = j / hgt
      const hw = Math.max(0, Math.round(halfW * (1 - t)))
      const off = Math.round(lean * t)
      this.h(cx - hw + off, cx + hw + off, by - j, c)
    }
  }
  // Downward spike (cape/coat hem points, tail fronds).
  spikeDown(cx, ty, halfW, hgt, lean, c) {
    for (let j = 0; j < hgt; j++) {
      const t = j / hgt
      const hw = Math.max(0, Math.round(halfW * (1 - t)))
      const off = Math.round(lean * t)
      this.h(cx - hw + off, cx + hw + off, ty + j, c)
    }
  }
  mirrorFrom(src) {
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const s = (y * CELL + (CELL - 1 - x)) * 4, d = (y * CELL + x) * 4
      this.d[d] = src.d[s]; this.d[d + 1] = src.d[s + 1]; this.d[d + 2] = src.d[s + 2]; this.d[d + 3] = src.d[s + 3]
    }
  }
  // 1 px outer silhouette outline, 4-connected dilation (seals diagonals).
  outline(c) {
    const add = []
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      if (this.get(x, y)) continue
      if (this.get(x - 1, y) || this.get(x + 1, y) || this.get(x, y - 1) || this.get(x, y + 1)) add.push(x, y)
    }
    for (let i = 0; i < add.length; i += 2) this.px(add[i], add[i + 1], c)
  }
  // Promote body pixels along one silhouette side through a colour LUT.
  // side −1 = left (sun), +1 = right (bounce). `gap` skips every Nth row so the
  // rim reads hand-placed (~covers (gap−1)/gap of the edge), y0..y1 band only.
  edgeRim(side, y0, y1, lut, gap) {
    for (let y = y0; y <= y1; y++) {
      if (gap > 0 && y % gap === 0) continue
      // walk in from the silhouette edge: the first body pixel just inside
      // the outline gets promoted through the ramp LUT
      if (side < 0) {
        for (let x = 1; x < CELL - 1; x++) {
          if (!this.get(x, y)) continue
          // x is the outline pixel; promote the body pixel just inside
          const bx = x + 1
          if (!this.get(bx, y)) break
          const c = lut.get(key(this.colAt(bx, y)))
          if (c) this.px(bx, y, c)
          break
        }
      } else {
        for (let x = CELL - 2; x > 0; x--) {
          if (!this.get(x, y)) continue
          const bx = x - 1
          if (!this.get(bx, y)) break
          const c = lut.get(key(this.colAt(bx, y)))
          if (c) this.px(bx, y, c)
          break
        }
      }
    }
  }
  blitTo(dest, cellIndex) {
    const cx = (cellIndex % COLS) * CELL
    const cy = Math.floor(cellIndex / COLS) * CELL
    for (let y = 0; y < CELL; y++) {
      const s = y * CELL * 4
      const d = ((cy + y) * SHEET_W + cx) * 4
      dest.set(this.d.subarray(s, s + CELL * 4), d)
    }
  }
}

// ---------------------------------------------------------------------------
// Gait tables. Foot cycle: contact → stance slides back → toe-off → swing
// forward with lift → contact. Far foot = near foot phase-shifted half cycle.
// bob is body y offset (+down): body drops on contacts, floats on passings.
// ---------------------------------------------------------------------------

const WALK = {
  n: 8,
  bob:   [1, 0, -1, 0, 1, 0, -1, 0],
  nearX: [5, 2, -2, -5, -4, 0, 4, 5],   // toward facing dir
  nearL: [0, 0, 0, 1, 3, 4, 2, 0],      // foot lift px
  farX:  [-4, 0, 4, 5, 5, 2, -2, -5],
  farL:  [3, 4, 2, 0, 0, 0, 0, 1],
  arm:   [-3, -1, 1, 3, 3, 1, -1, -3],  // near-arm swing, opposite near leg
  hem:   [1, 1, 0, -1, -1, -1, 0, 1],   // coat hem sway (lags the legs)
  cape:  [2, 3, 3, 2, 2, 3, 3, 2],      // extra trail length
  lean:  1,
}

const RUN = {
  n: 6,
  bob:   [0, 2, -2, 0, 2, -2],          // deep push, airborne float
  nearX: [7, 2, -5, -6, -2, 4],
  nearL: [1, 0, 2, 4, 4, 3],
  farX:  [-6, -2, 4, 7, 2, -5],
  farL:  [4, 4, 3, 1, 0, 2],
  arm:   [-5, -2, 4, 5, 2, -4],
  hem:   [2, 2, -1, -2, -2, 1],
  cape:  [5, 4, 6, 5, 4, 6],
  lean:  3,
}

// Idle: 4 authored frames — neutral / inhale / peak+cape-drift / blink.
const IDLE = {
  n: 4,
  breath: [0, -1, -1, 0],               // chest+head y (−1 = risen)
  drift:  [0, 0, 1, 0],                 // cape hem drift px
  blink:  [false, false, false, true],
}

// Anim play orders (indices into each gait's frame list). Idle repeats frames
// to slow the breath to ~1.3 s at the single sheet-wide FPS; blink is 2 ticks.
const IDLE_ORDER = [0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 1, 1, 1, 3, 3]

// ---------------------------------------------------------------------------
// Shared small parts
// ---------------------------------------------------------------------------

// Wheel-guard sword hilt (the reference hero carries a big back-slung blade;
// its ring guard reads over the shoulder). Dark iron ring + gold filigree so
// it reads as METAL against the blond hair, never as a hair blob.
// dir −1 = leans screen-left.
function swordHilt(p, x, y, dir) {
  p.h(x - 1, x + 1, y - 2, BLK.lit)                       // ring, top lit
  p.px(x - 2, y - 1, BLK.lit); p.r(x - 1, y - 1, 3, 1, BLK.mid); p.px(x + 2, y - 1, BLK.sh)
  p.px(x - 2, y, BLK.lit); p.px(x - 1, y, GOLD.lit); p.px(x, y, BLK.sh)
  p.px(x + 1, y, GOLD.mid); p.px(x + 2, y, BLK.sh)
  p.px(x - 2, y + 1, BLK.mid); p.r(x - 1, y + 1, 3, 1, BLK.mid); p.px(x + 2, y + 1, BLK.sh)
  p.h(x - 1, x + 1, y + 2, BLK.sh)                        // ring, under-shadow
  p.px(x, y - 2, GOLD.lit)                                // filigree quarters
  p.px(x - 1, y - 1, GOLD.hi)                             // specular, sun side
  p.px(x, y + 2, GOLD.sh)
  p.px(x - dir, y - 4, GOLD.lit); p.px(x - dir + 1, y - 4, GOLD.sh) // pommel gem
  p.px(x - dir, y - 3, GOLD.mid)
}

// Leather-wrapped grip with gold wire ticks, run as a straight 2 px diagonal.
function swordGrip(p, x0, y0, x1, y1) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1)
  for (let i = 0; i <= n; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / n)
    const y = Math.round(y0 + ((y1 - y0) * i) / n)
    p.px(x, y, i % 3 === 1 ? GOLD.sh : BLK.mid)
    p.px(x + 1, y, BLK.sh)
  }
}

// ---------------------------------------------------------------------------
// HERO — SOUTH (front). The face carries the sprite; everything is symmetric
// around x = 31/32 with the sun favouring the left half.
// ---------------------------------------------------------------------------

function heroSouth(p, o) {
  const b = o.bob | 0                 // +down
  const hem = o.hem | 0
  const lift = o.legs                 // { lx, ll, rx, rl } screen-left/right legs
  const armL = o.armL | 0, armR = o.armR | 0 // vertical glove offsets
  const breath = o.breath | 0
  const capeW = o.capeFlare | 0
  const drift = o.drift | 0

  // --- cape from the front: only slim slivers peek past the arms — the big
  // blue-white read belongs to the N/E views. Two 2 px falls + inward taper.
  const capTop = 36 + b + breath
  p.r(19 - capeW, capTop, 2, 12, CAPE.lit)
  p.v(19 - capeW, capTop + 1, capTop + 9, CAPE.hi)       // sunlit edge
  p.r(43 + capeW + drift, capTop, 2, 12, CAPE.sh)
  p.v(44 + capeW + drift, capTop + 1, capTop + 10, CAPE.deep)
  p.spikeDown(20 - capeW, capTop + 11, 2, 4, 1, CAPE.mid)   // taper toward legs
  p.spikeDown(43 + capeW + drift, capTop + 11, 2, 4, -1, CAPE.sh)

  // --- legs + boots (screen-left = his right). Planted foot at GY; lifted
  // foot rises with a bent read (shorter shin, sole line).
  const leg = (x, l, shade) => {
    const s = shade ? BLK.sh : BLK.lit
    p.r(x, 46 + b, 4, 8 - Math.min(3, l), s)             // trouser
    p.r(x - 1, GY - 5 - l, 6, 4, shade ? BLK.mid : BLK.lit) // boot cuff
    p.r(x - 1, GY - 2 - l, 6, 2, BLK.mid)                // boot foot
    p.h(x - 1, x + 4, GY - l, BLK.sh)                    // sole
    p.px(x - 1, GY - 5 - l, BLK.hi)                      // cuff catchlight
    if (l > 0) p.h(x, x + 3, GY - l + 1, BLK.sh)         // sole seen from below
  }
  leg(26 + (lift.lx | 0), lift.ll, false)
  leg(34 + (lift.rx | 0), lift.rl, true)

  // --- coat hem: red skirt flaring from the belt, split at centre front,
  // gold running trim on the bottom edge. Short enough that the legs read.
  const hy = 45 + b
  for (let j = 0; j < 6; j++) {
    const w = 8 + (j >> 1)
    const cx = 31 + Math.round(hem * (j / 5))
    p.h(cx - w, cx + w, hy + j, RED.lit)
    p.h(cx + 2, cx + w, hy + j, RED.mid)                 // shadow half
    if (j > 2) { p.px(cx, hy + j, RED.sh); p.px(cx + 1, hy + j, RED.sh) } // front split
  }
  p.h(31 + hem - 10, 31 + hem + 10, hy + 6, RED.sh)      // hem underside
  for (let x = 31 + hem - 9, k = 0; x <= 31 + hem + 9; x += 3, k++) p.px(x, hy + 6, k < 3 ? GOLD.lit : GOLD.mid) // trim ticks
  p.px(31 + hem - 8, hy + 5, GOLD.hi)                    // trim specular, sun side

  // --- torso: red coat over a black under-tunic, gold plackets, belt.
  const ty = 33 + b + breath
  p.r(24, ty, 16, 13, RED.lit)
  p.r(35, ty + 1, 5, 12, RED.mid)                        // shadow side
  p.r(29, ty + 2, 6, 11, BLK.lit)                        // under-tunic panel
  p.r(32, ty + 2, 3, 11, BLK.mid)
  p.v(28, ty + 2, ty + 12, GOLD.mid)                     // plackets
  p.v(35, ty + 2, ty + 12, GOLD.sh)
  p.px(28, ty + 3, GOLD.hi)                              // specular on sun-side trim
  p.px(28, ty + 8, GOLD.lit)
  // belt + buckle
  p.r(24, ty + 12, 16, 2, BLK.mid)
  p.h(24, 39, ty + 13, BLK.sh)
  p.r(30, ty + 12, 3, 2, GOLD.lit); p.px(30, ty + 12, GOLD.hi)

  // --- arms: puffed shoulder, sleeve, dark glove; swing = vertical offset.
  const arm = (x, dy, sun) => {
    p.r(x, ty + 2 + Math.max(0, dy), 4, 3, sun ? RED.lit : RED.mid)   // shoulder puff
    p.px(x + (sun ? 0 : 3), ty + 2 + Math.max(0, dy), sun ? RED.hi : RED.sh)
    p.r(x, ty + 5 + dy, 3, 5, sun ? RED.lit : RED.mid)                // sleeve
    p.v(x + (sun ? 2 : 0), ty + 5 + dy, ty + 9 + dy, sun ? RED.mid : RED.sh)
    p.r(x, ty + 10 + dy, 3, 3, BLK.lit)                               // glove
    p.px(x + 1, ty + 12 + dy, BLK.sh)
    p.px(x + (sun ? 0 : 2), ty + 10 + dy, BLK.hi)
  }
  arm(21, armL, true)
  arm(40, armR, false)

  // --- collar: pale cape clasp knot at the throat
  p.r(29, ty, 6, 2, CAPE.lit)
  p.px(34, ty, CAPE.sh); p.px(31, ty + 1, GOLD.lit); p.px(32, ty + 1, GOLD.sh)

  // --- sword hilt over his right shoulder (screen-left), riding high and
  // clear of the hair; the wrapped grip runs straight down to the shoulder.
  swordHilt(p, 16, 19 + b, 1)
  swordGrip(p, 17, 22 + b, 21, 31 + b)

  // --- head: big chibi skull. Hair mass first, then face plate, then fringe.
  const hb = b + breath
  p.disc(31, 19 + hb, 11, 10, HAIR.lit)                  // skull mass
  p.disc(34, 21 + hb, 9, 8, HAIR.mid)                    // volume turn (shade RHS)
  p.disc(29, 18 + hb, 8, 7, HAIR.lit)                    // re-carve lit crown
  // face plate
  p.r(25, 22 + hb, 14, 9, SKIN.lit)
  p.h(25, 38, 31 + hb, SKIN.mid)                         // jaw shade
  p.h(27, 36, 32 + hb, SKIN.lit)                         // chin
  p.h(29, 34, 33 + hb, SKIN.mid)
  p.r(37, 23 + hb, 2, 8, SKIN.mid)                       // cheek turn, shadow side
  p.px(24, 25 + hb, SKIN.mid); p.px(39, 25 + hb, SKIN.sh) // ear nubs
  // fringe: jagged spikes cutting over the brow, deep shade under it
  p.h(25, 38, 22 + hb, HAIR.deep)
  for (const [sx, sw, sh, ln] of [[26, 2, 3, -1], [29, 2, 4, 0], [32, 1, 3, 0], [34, 2, 4, 1], [37, 1, 3, 1]]) {
    p.spikeDown(sx, 22 + hb, sw, sh, ln, HAIR.mid)
  }
  p.spikeDown(27, 22 + hb, 1, 3, -1, HAIR.lit)           // sun-side fringe lick
  // crown spikes — the signature silhouette. Left cluster lit, right shaded.
  p.spike(24, 14 + hb, 2, 5, -2, HAIR.lit)
  p.spike(28, 12 + hb, 2, 6, -1, HAIR.lit)
  p.spike(32, 11 + hb, 2, 7, 0, HAIR.lit)
  p.spike(36, 12 + hb, 2, 6, 2, HAIR.mid)
  p.spike(40, 15 + hb, 2, 5, 3, HAIR.mid)
  p.spike(21, 19 + hb, 1, 4, -3, HAIR.mid)               // temple flick L
  p.spike(42, 19 + hb, 1, 4, 3, HAIR.sh)                 // temple flick R
  p.px(32, 5 + hb, HAIR.lit)                             // ahoge tip
  p.px(32, 6 + hb, HAIR.mid)
  // hair shading pass: HI on sun-facing spike flanks, sh pooling right
  p.px(27, 9 + hb, HAIR.hi); p.px(31, 7 + hb, HAIR.hi); p.px(23, 12 + hb, HAIR.hi)
  p.px(28, 10 + hb, HAIR.hi)
  p.v(41, 17 + hb, 20 + hb, HAIR.sh)
  p.v(42, 18 + hb, 21 + hb, HAIR.sh)
  // side hair falling past the ears
  p.r(23, 20 + hb, 2, 6, HAIR.mid); p.px(23, 26 + hb, HAIR.sh)
  p.r(39, 20 + hb, 2, 7, HAIR.sh); p.px(40, 27 + hb, HAIR.deep)
  // --- face: big read-at-60px eyes, brows, mouth
  if (o.blink) {
    p.h(26, 28, 27 + hb, BLK.lit); p.h(34, 36, 27 + hb, BLK.lit)
    p.h(26, 28, 28 + hb, SKIN.mid); p.h(34, 36, 28 + hb, SKIN.mid)
  } else {
    // left eye
    p.r(26, 24 + hb, 3, 4, BLK.lit)
    p.px(26, 25 + hb, EYE_WHITE); p.px(27, 24 + hb, EYE_WHITE)
    p.px(27, 26 + hb, BLK.sh); p.px(28, 26 + hb, BLK.sh)
    // right eye
    p.r(34, 24 + hb, 3, 4, BLK.lit)
    p.px(34, 25 + hb, EYE_WHITE)
    p.px(35, 26 + hb, BLK.sh); p.px(36, 26 + hb, BLK.sh)
  }
  p.h(26, 28, 23 + hb, HAIR.deep)                        // brows
  p.h(34, 36, 23 + hb, HAIR.deep)
  p.px(31, 28 + hb, SKIN.mid)                            // nose
  p.h(31, 32, 30 + hb, BLK.lit)                          // mouth (small, set)
  p.px(25, 28 + hb, SKIN.hi)                             // sun-side cheek light
}

// ---------------------------------------------------------------------------
// HERO — NORTH (back). The cape owns the drawing: a broad blue-white fall
// with two pressed folds; back of the blond mop above it, boots below,
// hilt over the right shoulder (screen-right from behind) + scabbard tip.
// ---------------------------------------------------------------------------

function heroNorth(p, o) {
  const b = o.bob | 0
  const hem = o.hem | 0
  const lift = o.legs
  const breath = o.breath | 0
  const drift = (o.drift | 0) + (o.capeFlare | 0)

  // --- boots under the cape hem
  const leg = (x, l, shade) => {
    p.r(x, 50 + b, 4, Math.max(2, 8 - l), shade ? BLK.mid : BLK.lit)
    p.r(x - 1, GY - 3 - l, 6, 3, shade ? BLK.mid : BLK.lit)
    p.h(x - 1, x + 4, GY - l, BLK.sh)
    if (l > 1) p.h(x, x + 3, GY - l + 1, BLK.sh)         // kicked-up sole shows
  }
  leg(26 + (lift.lx | 0), lift.ll, false)
  leg(34 + (lift.rx | 0), lift.rl, true)

  // --- coat hem peeking at the cape's sides
  p.r(22, 46 + b, 3, 8, RED.mid); p.px(22, 53 + b, RED.sh)
  p.r(39, 46 + b, 3, 8, RED.sh); p.px(41, 53 + b, RED.sh)

  // --- the cape: shoulders → hem, widening, three-point ragged hem.
  // Blue-white means blue-WHITE: lit band on the sun third only, the rest
  // rolls through mid into a cool shadowed right edge.
  const ct = 32 + b + breath
  const hemY = 52 + b
  for (let y = ct; y <= hemY; y++) {
    const t = (y - ct) / (hemY - ct)
    const w = Math.round(9 + t * 4)                       // 9 → 13 half-width
    const cx = 31 + Math.round((hem + drift) * t)
    p.h(cx - w, cx + w, y, CAPE.lit)
    p.h(cx - Math.round(w * 0.3), cx + w, y, CAPE.mid)    // turn away from sun
    p.h(cx + Math.round(w * 0.45), cx + w, y, CAPE.sh)
    p.px(cx + w, y, CAPE.deep)                            // shaded rim core
  }
  // pressed folds — long creases that swing with the hem
  for (let y = ct + 3; y <= hemY; y++) {
    const t = (y - ct) / (hemY - ct)
    const cx = 31 + Math.round((hem + drift) * t)
    p.px(cx - 5 + Math.round(t * 1), y, CAPE.mid)
    p.px(cx + 2 + Math.round(t * 2), y, CAPE.sh)
    if (y > ct + 8) p.px(cx - 1, y, CAPE.mid)             // centre crease grows in
  }
  // hem points
  const hcx = 31 + hem + drift
  p.spikeDown(hcx - 9, hemY, 3, 4, -1, CAPE.mid)
  p.spikeDown(hcx - 1, hemY, 3, 5, 0, CAPE.mid)
  p.spikeDown(hcx + 7, hemY, 3, 4, 1, CAPE.sh)
  p.h(hcx - 12, hcx - 8, hemY, CAPE.hi)                  // sun kisses the lit hem edge
  // sunlit left column + collar roll
  p.v(31 - 9 + 1, ct + 2, hemY - 3, CAPE.hi)
  p.r(25, ct - 2, 14, 3, CAPE.lit)
  p.h(25, 38, ct - 2, CAPE.hi)
  p.px(38, ct - 1, CAPE.sh); p.px(37, ct - 2, CAPE.mid)

  // --- shoulder caps of the red coat, flush with the cape's top edge
  p.r(22, ct - 1, 3, 3, RED.lit); p.px(22, ct - 1, RED.hi)
  p.r(38, ct - 1, 3, 3, RED.mid); p.px(40, ct + 1, RED.sh)

  // --- scabbard tip swinging out under the hem, lower-left (opposite the hilt)
  p.px(23, hemY + 3, BLK.mid); p.px(22, hemY + 4, BLK.lit)
  p.px(21, hemY + 5, BLK.mid); p.px(20, hemY + 6, BLK.sh)
  p.px(19, hemY + 7, GOLD.mid)                            // chape (metal tip)

  // --- back of the head: pure hair, layered spike shells, no face.
  const hb = b + breath
  p.disc(31, 18 + hb, 11, 10, HAIR.mid)
  p.disc(29, 17 + hb, 9, 8, HAIR.lit)                    // lit crown biased sunward
  p.h(24, 38, 27 + hb, HAIR.sh)                          // nape shadow rows
  p.h(25, 37, 28 + hb, HAIR.sh)
  p.h(26, 36, 29 + hb, HAIR.deep)
  // nape licks over the collar
  p.spikeDown(26, 28 + hb, 1, 3, -1, HAIR.sh)
  p.spikeDown(31, 29 + hb, 1, 3, 0, HAIR.deep)
  p.spikeDown(36, 28 + hb, 1, 3, 1, HAIR.sh)
  // crown spikes — same silhouette family as the front
  p.spike(24, 14 + hb, 2, 5, -2, HAIR.lit)
  p.spike(28, 12 + hb, 2, 6, -1, HAIR.lit)
  p.spike(32, 11 + hb, 2, 7, 0, HAIR.lit)
  p.spike(36, 12 + hb, 2, 6, 2, HAIR.mid)
  p.spike(40, 15 + hb, 2, 5, 3, HAIR.mid)
  p.spike(21, 19 + hb, 1, 4, -3, HAIR.mid)
  p.spike(42, 19 + hb, 1, 4, 3, HAIR.sh)
  p.px(32, 5 + hb, HAIR.lit); p.px(32, 6 + hb, HAIR.mid) // ahoge survives from behind
  // whorl hint + HI speckle top-left
  p.px(29, 15 + hb, HAIR.sh); p.px(30, 16 + hb, HAIR.sh); p.px(29, 17 + hb, HAIR.deep)
  p.px(26, 10 + hb, HAIR.hi); p.px(30, 8 + hb, HAIR.hi); p.px(23, 14 + hb, HAIR.hi)
  p.v(41, 18 + hb, 22 + hb, HAIR.sh)

  // --- hilt over his right shoulder = screen-right when seen from behind,
  // high and clear of the hair, grip wrapping down to the shoulder cap
  swordHilt(p, 47, 18 + b, -1)
  swordGrip(p, 45, 21 + b, 41, 30 + b)
}

// ---------------------------------------------------------------------------
// HERO — EAST (side, facing +x). West is a mirror of the finished cell.
// Cape streams out behind (screen-left); one big eye; deep stride reads.
// ---------------------------------------------------------------------------

function heroEast(p, o) {
  const b = o.bob | 0
  const lean = o.lean | 0                 // px the head/torso shift forward
  const arm = o.armSwing | 0
  const breath = o.breath | 0
  const trail = (o.capeTrail | 0) + (o.drift | 0)
  const flut = o.capeFlut | 0             // hem flutter row offset

  const tx = 31 + lean                    // torso centre x
  const ty = 33 + b + breath              // torso top y
  const hipY = 45 + b

  // --- limbs: 3 px slanted leg from hip to ankle + chunky ankle boot
  const legE = (footX, l, near) => {
    const base = near ? BLK.lit : BLK.sh
    const boot = near ? BLK.mid : BLK.sh
    const hipX = tx + (near ? 0 : -1)
    const fx = tx + footX
    const ankY = GY - 3 - l
    for (let y = hipY; y <= ankY; y++) {
      const t = (y - hipY) / Math.max(1, ankY - hipY)
      const cx = hipX + Math.round((fx - hipX) * t * t)  // knee stays under hip
      p.h(cx - 1, cx + 1, y, base)
    }
    p.r(fx - 2, GY - 4 - l, 6, 3, boot)                  // boot block
    p.h(fx - 2, fx + 4, GY - 1 - l, boot)
    p.h(fx - 2, fx + 4, GY - l, BLK.sh)                  // sole
    p.px(fx + 4, GY - 1 - l, boot)                       // toe
    p.px(fx - 2, GY - 4 - l, near ? BLK.hi : BLK.mid)    // cuff light
    if (l > 1) p.h(fx - 1, fx + 3, GY - l + 1, BLK.sh)   // lifted sole shows
  }

  // --- far leg (his left, beyond the body — one shade down)
  legE(o.farX | 0, o.farL | 0, false)

  // --- coat tail: short red flare off the hips, backward
  p.r(tx - 6, 43 + b, 6, 6, RED.mid)
  p.spikeDown(tx - 6, 48 + b, 2, 3, -1, RED.sh)
  p.h(tx - 7, tx - 3, 48 + b, RED.sh)

  // --- cape over the coat tail: attaches at the shoulder, streams back-left.
  // Idle: hangs nearly vertical. Run: pulled long and lifted, hem fluttering.
  const shX = tx - 2, shY = ty
  const reach = 7 + trail                                // horizontal throw
  const capeBot = 52 + b - Math.max(0, trail - 3)        // hem lifts when streaming
  for (let y = shY; y <= capeBot; y++) {
    const t = (y - shY) / Math.max(1, capeBot - shY)
    const xr = shX + 2 - Math.round(t * 3)               // body-side edge
    const xl = shX - 1 - Math.round(reach * Math.pow(t, 0.72)) - (t > 0.6 ? flut : 0)
    p.h(xl, xr, y, CAPE.lit)
    p.h(xl, xl + Math.max(1, (xr - xl) >> 2), y, CAPE.mid) // trailing half turns away
    if (t > 0.55) p.px(xl, y, CAPE.sh)
    if (t > 0.3) p.px(xr, y, CAPE.mid)                   // inner shade against body
  }
  // hem points grow off the cape's real last row — always connected
  const hemXl = shX - 1 - reach - flut
  p.spikeDown(hemXl + 1, capeBot, 2, 4, -1, CAPE.sh)
  p.spikeDown(hemXl + Math.max(3, (reach >> 1) + 1), capeBot + 1, 2, 4, -1, CAPE.mid)
  p.spikeDown(shX - 1, capeBot + 1, 2, 3, 0, CAPE.mid)
  p.h(shX - 2, shX + 2, shY, CAPE.hi)                    // lit shoulder roll
  p.px(hemXl + 1, capeBot - 2, CAPE.deep)                // deepest fold
  p.v(shX - 3, shY + 3, shY + 8, CAPE.hi)                // long sunlit crease

  // --- near leg over the cape (boot reads over the hem on the back swing)
  legE(o.nearX | 0, o.nearL | 0, true)

  // --- torso: side profile of the coat — red front, black under-panel line
  p.r(tx - 4, ty, 10, 13, RED.lit)
  p.r(tx - 4, ty + 1, 3, 12, RED.mid)                    // back half turns away
  p.v(tx + 5, ty + 1, ty + 11, RED.mid)
  p.v(tx + 4, ty + 2, ty + 12, GOLD.sh)                  // front placket
  p.px(tx + 4, ty + 3, GOLD.lit); p.px(tx + 4, ty + 4, GOLD.hi)
  p.r(tx - 4, ty + 12, 10, 2, BLK.mid)                   // belt
  p.px(tx + 3, ty + 12, GOLD.lit)                        // buckle glint
  p.h(tx - 4, tx + 5, ty, RED.hi)                        // sunlit shoulder line

  // --- near arm swinging (sleeve + glove), shoulder puff on top
  const ax = tx + Math.round(arm * 0.8)
  p.r(tx - 1, ty + 1, 4, 3, RED.lit)                     // shoulder puff
  p.px(tx - 1, ty + 1, RED.hi)
  p.r(ax, ty + 4, 3, 5, RED.lit)
  p.v(ax, ty + 4, ty + 8, RED.mid)
  p.r(ax, ty + 9, 3, 3, BLK.lit)                         // glove fist
  p.px(ax + 1, ty + 11, BLK.sh)
  p.px(ax + 2, ty + 9, BLK.hi)

  // --- collar knot at the throat, seen side-on
  p.r(tx + 1, ty - 1, 4, 2, CAPE.lit)
  p.px(tx + 4, ty - 1, CAPE.sh); p.px(tx + 2, ty, GOLD.lit)

  // --- sword hilt: the blade lies along his back, so from the side the ring
  // guard pokes up-left at shoulder height, under the hair's trailing spikes.
  const hb = b + breath
  const hx = tx + 1 + Math.round(lean * 0.5)             // head leads the lean
  swordHilt(p, hx - 15, 29 + hb, 1)
  swordGrip(p, hx - 13, 31 + hb, hx - 7, 34 + hb)

  // --- head in profile: face forward (+x), spike mass sweeping back (−x)
  p.disc(hx, 19 + hb, 11, 10, HAIR.lit)                  // skull
  p.disc(hx - 3, 20 + hb, 9, 8, HAIR.mid)                // rear volume shade
  p.disc(hx + 2, 18 + hb, 8, 7, HAIR.lit)
  // face plate: forward third
  p.r(hx + 4, 22 + hb, 7, 9, SKIN.lit)
  p.px(hx + 11, 24 + hb, SKIN.lit)                       // nose tip
  p.px(hx + 11, 25 + hb, SKIN.mid)
  p.h(hx + 4, hx + 10, 31 + hb, SKIN.mid)                // jaw
  p.h(hx + 5, hx + 9, 32 + hb, SKIN.mid)
  p.px(hx + 3, 27 + hb, SKIN.mid)                        // ear shadow nub
  p.px(hx + 2, 26 + hb, SKIN.sh)
  // fringe sweeping back over the brow
  p.h(hx + 4, hx + 10, 22 + hb, HAIR.deep)
  p.spikeDown(hx + 9, 22 + hb, 1, 3, 1, HAIR.mid)
  p.spikeDown(hx + 6, 22 + hb, 2, 4, -1, HAIR.mid)
  p.spikeDown(hx + 3, 22 + hb, 1, 3, -1, HAIR.lit)
  // rear spike cluster — swept back and slightly up; wind of motion
  p.spike(hx - 3, 12 + hb, 2, 6, -1, HAIR.lit)
  p.spike(hx + 1, 11 + hb, 2, 7, 1, HAIR.lit)
  p.spike(hx - 7, 14 + hb, 2, 5, -3, HAIR.mid)
  p.spike(hx - 10, 18 + hb, 2, 5, -4, HAIR.mid)
  p.spike(hx - 10, 22 + hb, 2, 3, -3, HAIR.sh)           // short nape flick — leaves
                                                         // room for the hilt below
  p.px(hx + 1, 4 + hb, HAIR.lit); p.px(hx + 1, 5 + hb, HAIR.mid)  // ahoge
  // shade + HI
  p.v(hx - 10, 24 + hb, 27 + hb, HAIR.deep)
  p.px(hx - 2, 8 + hb, HAIR.hi); p.px(hx - 6, 11 + hb, HAIR.hi); p.px(hx + 3, 9 + hb, HAIR.hi)
  // single profile eye — large, dark, glint top-left
  if (o.blink) {
    p.h(hx + 6, hx + 8, 26 + hb, BLK.lit)
    p.h(hx + 6, hx + 8, 27 + hb, SKIN.mid)
  } else {
    p.r(hx + 6, 24 + hb, 3, 4, BLK.lit)
    p.px(hx + 6, 25 + hb, EYE_WHITE)
    p.px(hx + 7, 27 + hb, BLK.sh)
  }
  p.h(hx + 6, hx + 9, 23 + hb, HAIR.deep)                // brow
  p.px(hx + 9, 30 + hb, BLK.lit)                         // mouth tick
}

// ---------------------------------------------------------------------------
// MOUNT — chocobo-like riding bird. Round golden body, long neck, huge eye,
// crest plume, strong legs. Saddle included; the hero is composited by the
// player module at `meta.saddle`.
// ---------------------------------------------------------------------------

// --- EAST profile
function mountEast(p, o) {
  const b = o.bob | 0
  const lean = o.lean | 0
  const neckX = o.neckX | 0             // head thrust (birds bob when walking)
  const neckY = o.neckY | 0
  const breath = o.breath | 0
  const tail = o.tailSway | 0

  const bx = 26 + lean                  // body centre x
  const by = 41 + b + breath            // body centre y (low-slung)

  // --- tail: a proper feather bustle — one frond arcs up over the back line,
  // three sweep down-left past the body edge so the silhouette reads
  p.spike(bx - 11 + tail, by - 8, 2, 8, -6, BODY.lit)    // lit frond over the back
  p.spike(bx - 14 + tail, by - 5, 2, 6, -6, BODY.mid)
  p.spikeDown(bx - 14 + tail, by - 7, 3, 10, -6, BODY.mid)
  p.spikeDown(bx - 16 + tail, by - 3, 3, 11, -6, BODY.sh)
  p.spikeDown(bx - 13 + tail, by - 1, 3, 9, -5, BODY.deep)
  p.px(bx - 18 + tail, by - 12, BODY.hi)                 // wind-caught tips
  p.px(bx - 16 + tail, by - 10, BODY.hi)

  // --- legs: short, thick, powerful; thigh bulges out of the belly line
  const legM = (footX, l, near) => {
    const thigh = near ? BODY.mid : BODY.sh
    const shin = near ? BEAK.lit : BEAK.mid
    const dark = near ? BEAK.mid : BEAK.sh
    const hipX = bx + 3
    const fx = hipX + footX
    p.disc(hipX + (footX >> 1), by + 7, 5, 4, thigh)     // feathered drumstick
    p.px(hipX + (footX >> 1) - 3, by + 5, near ? BODY.lit : BODY.mid)
    for (let y = by + 9; y <= GY - 1 - l; y++) {         // shin: 3 px, slanted
      const t = (y - (by + 9)) / Math.max(1, GY - 1 - l - (by + 9))
      const cx = hipX + (footX >> 1) + Math.round((fx - hipX - (footX >> 1)) * t)
      p.px(cx - 1, y, shin); p.px(cx, y, shin); p.px(cx + 1, y, dark)
    }
    p.h(fx - 3, fx + 4, GY - l, dark)                    // broad 3-toe foot
    p.px(fx + 4, GY - 1 - l, shin)                       // front toe knuckle
    p.px(fx + 1, GY - 1 - l, shin)                       // mid toe knuckle
    p.px(fx - 4, GY - l, dark)                           // rear spur
    if (l > 1) p.h(fx - 2, fx + 3, GY - l + 1, BEAK.sh)  // lifted sole line
  }
  legM(o.farX | 0, o.farL | 0, false)

  // --- body: one plump low mass; breast pushes forward-right
  p.disc(bx, by, 15, 10, BODY.lit)
  p.disc(bx + 6, by + 1, 11, 9, BODY.lit)                // breast
  p.disc(bx - 1, by + 5, 13, 5, BODY.mid)                // belly turn
  p.h(bx - 11, bx + 11, by + 8, BODY.sh)                 // belly core shadow
  p.h(bx - 9, bx + 9, by + 9, BODY.deep)
  p.h(bx - 7, bx + 7, by - 9, BODY.hi)                   // sunlit back line
  p.px(bx - 8, by - 8, BODY.hi); p.px(bx + 4, by - 9, BODY.hi)

  // --- folded wing: a leaf-shaped shelf with three trailing feather tips
  p.disc(bx - 3, by + 1, 9, 5, BODY.mid)
  p.disc(bx - 1, by, 7, 3, BODY.lit)                     // wing top catches sun
  p.spikeDown(bx - 10, by + 2, 2, 6, -3, BODY.sh)
  p.spikeDown(bx - 6, by + 4, 2, 6, -3, BODY.sh)
  p.spikeDown(bx - 2, by + 5, 2, 5, -2, BODY.deep)
  p.h(bx - 9, bx + 4, by - 2, BODY.mid)                  // wing crease line

  // --- near leg over the wing
  legM(o.nearX | 0, o.nearL | 0, true)

  // --- saddle: low-profile pad following the back curve + soft girth hint
  p.h(bx - 4, bx + 5, by - 10, RED.lit)
  p.h(bx - 5, bx + 6, by - 9, RED.lit)
  p.px(bx - 5, by - 9, RED.hi)
  p.h(bx - 5, bx + 6, by - 8, RED.mid)
  p.h(bx - 4, bx + 5, by - 7, RED.sh)
  p.px(bx - 5, by - 10, GOLD.lit); p.px(bx + 6, by - 10, GOLD.mid) // horn + cantle studs
  p.v(bx + 1, by + 6, by + 9, BODY.deep)                 // girth shadow, belly only
  p.px(bx + 1, by + 5, GOLD.mid)                         // girth buckle glint

  // --- neck: thick, rises forward out of the breast and bows into the head
  const nx = bx + 17 + neckX              // head centre
  const ny = 17 + b + neckY
  const rootX = bx + 11, rootY = by - 6   // where the neck leaves the breast
  p.disc(rootX, by - 4, 5, 5, BODY.lit)   // fill the breast→throat junction
  p.px(rootX - 2, by - 8, BODY.hi)
  for (let j = 0; j <= 12; j++) {
    const t = j / 12
    const cy = Math.round(rootY + (ny + 4 - rootY) * t)
    const cx = Math.round(rootX + (nx - 1 - rootX) * t * (2 - t)) // bows forward
    const w = 4 - Math.round(t)                          // 4 → 3 half-width
    p.h(cx - w, cx + w, cy, BODY.lit)
    p.px(cx - w, cy, BODY.mid)                           // mane-side shade
    if (t > 0.4) p.px(cx + w, cy, BODY.hi)               // sunlit throat edge
  }
  // --- head: big and cocky — the chibi read demands a heavy head
  p.disc(nx, ny, 7, 6, BODY.lit)
  p.disc(nx + 2, ny + 1, 5, 4, BODY.lit)                 // muzzle mass toward beak
  p.h(nx - 6, nx + 2, ny - 5, BODY.hi)                   // crown light
  p.px(nx - 6, ny + 2, BODY.mid); p.px(nx - 5, ny + 4, BODY.mid)
  p.h(nx - 3, nx - 1, ny + 5, BODY.mid)                  // jaw turn, rear only —
                                                         // a full bar reads as a collar seam
  // crest: three long swept-back plumes
  p.spike(nx - 4, ny - 5, 1, 6, -5, BODY.lit)
  p.spike(nx - 1, ny - 6, 2, 7, -4, BODY.lit)
  p.spike(nx + 2, ny - 5, 1, 5, -3, BODY.mid)
  p.px(nx - 8, ny - 10, BODY.hi)                         // lit plume tip
  p.px(nx - 4, ny - 11, BODY.hi)
  // beak: big, stout, slightly open — the chocobo grin
  p.h(nx + 6, nx + 12, ny - 2, BEAK.lit)
  p.h(nx + 6, nx + 14, ny - 1, BEAK.lit)
  p.h(nx + 6, nx + 14, ny, BEAK.mid)
  p.px(nx + 14, ny + 1, BEAK.mid)                        // downturned tip
  p.h(nx + 6, nx + 12, ny + 1, BLK.sh)                   // open mouth line
  p.h(nx + 6, nx + 10, ny + 2, BEAK.mid)                 // lower mandible
  p.px(nx + 11, ny + 2, BEAK.sh)
  p.px(nx + 7, ny - 2, BEAK.hi)                          // beak-root glint
  // the eye — huge, wet, alive
  p.r(nx, ny - 3, 4, 4, BLK.lit)
  p.px(nx, ny - 3, EYE_WHITE)
  p.px(nx + 1, ny - 2, EYE_WHITE)
  p.px(nx + 3, ny, BLK.sh)
  p.h(nx, nx + 3, ny - 4, BODY.mid)                      // lid
}

// --- SOUTH (front): round breast, head centre-high, both eyes visible
function mountSouth(p, o) {
  const b = o.bob | 0
  const lift = o.legs
  const breath = o.breath | 0
  const sway = o.sway | 0               // neck/head lateral sway while stepping

  const by = 41 + b + breath

  // tail tips peek at both sides behind the body
  p.px(16, by - 5, BODY.mid); p.r(15, by - 3, 2, 2, BODY.sh)
  p.px(47, by - 5, BODY.sh); p.r(47, by - 3, 2, 2, BODY.deep)

  // --- legs: short thick columns; lifted foot shows curled toes
  const legM = (x, l, shade) => {
    const shin = shade ? BEAK.mid : BEAK.lit
    const dark = shade ? BEAK.sh : BEAK.mid
    p.disc(x + 1, by + 8, 5, 4, shade ? BODY.sh : BODY.mid)  // drumstick
    p.px(x - 2, by + 6, shade ? BODY.mid : BODY.lit)
    p.r(x - 1, by + 10, 3, Math.max(1, GY - l - (by + 10)), shin)
    p.v(x + 1, by + 10, GY - 1 - l, dark)
    p.h(x - 3, x + 3, GY - l, dark)                          // toes spread wide
    p.px(x - 3, GY - 1 - l, shin)                            // outer toe knuckles
    p.px(x + 3, GY - 1 - l, shin)
    p.px(x, GY - 1 - l, shin)
    if (l > 0) p.h(x - 2, x + 2, GY - l + 1, BEAK.sh)
  }
  legM(25 + (lift.lx | 0), lift.ll, false)
  legM(38 + (lift.rx | 0), lift.rl, true)

  // --- body: big breast ellipse, wings folded at the flanks
  p.disc(31, by, 15, 11, BODY.lit)
  p.disc(31, by + 3, 13, 8, BODY.lit)
  p.disc(31, by + 6, 11, 5, BODY.mid)                    // under-breast turn
  p.h(23, 39, by + 9, BODY.sh)
  p.h(25, 37, by + 10, BODY.deep)
  p.h(21, 31, by - 10, BODY.hi)                          // sun-side crown of breast
  p.px(19, by - 8, BODY.hi); p.px(24, by - 11, BODY.hi)
  // wing folds: vertical scallops at the flanks, feather tips flicking out
  p.v(18, by - 4, by + 4, BODY.mid); p.v(17, by - 2, by + 3, BODY.sh)
  p.v(45, by - 4, by + 4, BODY.sh); p.v(46, by - 2, by + 3, BODY.deep)
  p.spikeDown(18, by + 4, 2, 5, -2, BODY.sh)             // wingtips
  p.spikeDown(45, by + 4, 2, 5, 2, BODY.deep)
  // breast feather chevrons — hand-placed, sparse
  p.px(27, by, BODY.mid); p.px(28, by + 1, BODY.mid)
  p.px(35, by + 1, BODY.mid); p.px(36, by, BODY.mid)
  p.px(31, by + 3, BODY.sh); p.px(30, by + 2, BODY.mid)

  // --- saddle: front rim arcs behind the neck
  p.h(24, 38, by - 9, RED.lit)
  p.px(24, by - 9, RED.hi)
  p.h(23, 39, by - 8, RED.mid)
  p.h(24, 38, by - 7, RED.sh)
  p.px(23, by - 8, GOLD.lit); p.px(39, by - 8, GOLD.mid)

  // --- neck + head above the breast — tapered: slim throat, flared base
  const hx = 31 + sway
  const hy = 18 + b + breath
  p.r(hx - 3, hy + 5, 7, 5, BODY.lit)                    // throat
  p.r(hx - 4, hy + 9, 9, 5, BODY.lit)                    // base flare
  p.v(hx - 3, hy + 5, hy + 8, BODY.mid)
  p.v(hx + 3, hy + 5, hy + 8, BODY.mid)
  p.v(hx - 4, hy + 9, hy + 13, BODY.mid)
  p.v(hx + 4, hy + 9, hy + 13, BODY.mid)
  p.px(hx - 3, hy + 6, BODY.hi)                          // sun edge
  p.disc(hx, hy, 7, 6, BODY.lit)                         // head ball
  p.h(hx - 6, hx + 1, hy - 5, BODY.hi)                   // crown light
  p.v(hx + 6, hy - 1, hy + 2, BODY.mid)                  // shade cheek
  p.px(hx + 5, hy + 3, BODY.mid)
  // crest: three plumes, centre tall — reads over the terrain
  p.spike(hx - 3, hy - 6, 1, 5, -2, BODY.lit)
  p.spike(hx, hy - 7, 2, 6, 0, BODY.lit)
  p.spike(hx + 3, hy - 6, 1, 5, 2, BODY.mid)
  p.px(hx - 5, hy - 9, BODY.hi); p.px(hx, hy - 12, BODY.hi)
  // both eyes — big, forward, glints top-left
  if (o.blink) {
    p.h(hx - 5, hx - 3, hy, BLK.lit); p.h(hx + 3, hx + 5, hy, BLK.lit)
  } else {
    p.r(hx - 5, hy - 2, 3, 4, BLK.lit); p.px(hx - 5, hy - 2, EYE_WHITE)
    p.r(hx + 3, hy - 2, 3, 4, BLK.lit); p.px(hx + 3, hy - 2, EYE_WHITE)
    p.px(hx - 3, hy + 1, BLK.sh); p.px(hx + 5, hy + 1, BLK.sh)
  }
  // beak: stout wedge pointing down at the viewer
  p.h(hx - 1, hx + 1, hy + 2, BEAK.lit)
  p.px(hx - 1, hy + 2, BEAK.hi)
  p.h(hx - 1, hx + 1, hy + 3, BEAK.mid)
  p.px(hx, hy + 4, BEAK.sh)
}

// --- NORTH (back): tail fan owns the drawing; saddle + nape of the neck
function mountNorth(p, o) {
  const b = o.bob | 0
  const lift = o.legs
  const breath = o.breath | 0
  const sway = o.sway | 0
  const tail = o.tailSway | 0

  const by = 41 + b + breath

  // --- legs (heels/spurs read from behind)
  const legM = (x, l, shade) => {
    const shin = shade ? BEAK.mid : BEAK.lit
    const dark = shade ? BEAK.sh : BEAK.mid
    p.disc(x + 1, by + 8, 5, 4, shade ? BODY.sh : BODY.mid)
    p.r(x - 1, by + 10, 3, Math.max(1, GY - l - (by + 10)), shin)
    p.v(x - 1, by + 10, GY - 1 - l, dark)                    // shadow leads (back view)
    p.h(x - 2, x + 2, GY - l, dark)
    p.px(x + 3, GY - l, BEAK.sh)                             // rear spur toward us
    if (l > 0) p.h(x - 2, x + 2, GY - l + 1, BEAK.sh)
  }
  legM(25 + (lift.lx | 0), lift.ll, false)
  legM(38 + (lift.rx | 0), lift.rl, true)

  // --- body seen from the rear: rump rounds away
  p.disc(31, by, 15, 11, BODY.lit)
  p.disc(31, by + 3, 13, 8, BODY.mid)
  p.h(23, 39, by + 9, BODY.sh)
  p.h(25, 37, by + 10, BODY.deep)
  p.h(21, 31, by - 10, BODY.hi)
  p.v(18, by - 4, by + 3, BODY.mid); p.v(45, by - 4, by + 3, BODY.sh) // wing edges
  p.px(17, by - 1, BODY.sh); p.px(46, by - 1, BODY.deep)

  // --- tail fan: five broad fronds spreading up — the N signature
  p.spike(31 + tail, by - 6, 3, 13, 0, BODY.lit)
  p.spike(25 + tail, by - 5, 3, 11, -4, BODY.lit)
  p.spike(37 + tail, by - 5, 3, 11, 4, BODY.mid)
  p.spike(21 + tail, by - 3, 2, 8, -6, BODY.mid)
  p.spike(41 + tail, by - 3, 2, 8, 6, BODY.sh)
  // frond spines + lit tips
  p.v(31 + tail, by - 15, by - 7, BODY.mid)
  p.v(26 + tail - 1, by - 12, by - 6, BODY.mid)
  p.v(36 + tail + 1, by - 12, by - 6, BODY.sh)
  p.px(29 + tail, by - 17, BODY.hi); p.px(24 + tail - 2, by - 14, BODY.hi)
  p.px(39 + tail, by - 13, BODY.sh)

  // --- saddle from behind: cantle arc sits proud of the rump
  p.h(26, 36, by - 9, RED.lit)
  p.px(26, by - 9, RED.hi)
  p.h(25, 37, by - 8, RED.mid)
  p.h(26, 36, by - 7, RED.sh)
  p.px(25, by - 8, GOLD.lit); p.px(37, by - 8, GOLD.mid)

  // --- nape of neck + back of head above the saddle — tapered like the front
  const hx = 31 + sway
  const hy = 18 + b + breath
  p.r(hx - 3, hy + 5, 7, 5, BODY.mid)                    // throat (faces away)
  p.r(hx - 4, hy + 9, 9, 5, BODY.mid)                    // base flare
  p.v(hx - 3, hy + 5, hy + 8, BODY.lit)                  // sun rakes its left edge
  p.v(hx - 4, hy + 9, hy + 13, BODY.lit)
  p.v(hx - 2, hy + 6, hy + 12, BODY.lit)
  p.disc(hx, hy, 7, 6, BODY.mid)
  p.disc(hx - 2, hy - 1, 5, 5, BODY.lit)
  p.h(hx - 6, hx, hy - 5, BODY.hi)
  p.px(hx + 5, hy + 2, BODY.sh)                          // occiput shade
  // crest tips forward, away from us: shorter, tips only
  p.spike(hx - 3, hy - 5, 1, 4, -1, BODY.lit)
  p.spike(hx, hy - 6, 2, 5, 0, BODY.mid)
  p.spike(hx + 3, hy - 5, 1, 4, 1, BODY.sh)
  p.px(hx - 4, hy - 8, BODY.hi)
  // cheek hints — no eyes from behind
  p.px(hx - 6, hy + 1, BODY.mid); p.px(hx + 6, hy + 1, BODY.sh)
}

// ---------------------------------------------------------------------------
// Frame orchestration
// ---------------------------------------------------------------------------

// Assemble legs for front/back views: screen-left leg = "near" cycle so both
// S and N alternate correctly; front view uses lift + a hint of x-spread.
function frontLegs(g, i) {
  return {
    lx: Math.round((g.nearX[i] || 0) * 0.15), ll: g.nearL[i],
    rx: Math.round((g.farX[i] || 0) * 0.15), rl: g.farL[i],
  }
}

const STAND_LEGS = { lx: 0, ll: 0, rx: 0, rl: 0 }

function heroFramePoses() {
  const F = { s: [], n: [], e: [] } // per facing: idle 4, walk 8, run 6 (in order)

  // idle
  for (let i = 0; i < IDLE.n; i++) {
    const o = {
      bob: 0, breath: IDLE.breath[i], blink: IDLE.blink[i], drift: IDLE.drift[i],
      legs: STAND_LEGS, hem: 0, armL: 0, armR: 0, capeFlare: 0,
      lean: 0, armSwing: 0, capeTrail: 0, capeFlut: 0, nearX: 0, nearL: 0, farX: 0, farL: 0,
    }
    // side idle: relaxed stance — near foot a touch forward so both boots read
    F.s.push({ ...o }); F.n.push({ ...o }); F.e.push({ ...o, nearX: 2, farX: -2 })
  }
  // walk + run
  for (const g of [WALK, RUN]) {
    const isRun = g === RUN
    for (let i = 0; i < g.n; i++) {
      const common = {
        bob: g.bob[i], breath: 0, blink: false, drift: 0,
        hem: g.hem[i], capeFlare: isRun ? 1 : 0,
        armL: Math.round(g.arm[i] * (isRun ? 0.5 : 0.4)),
        armR: -Math.round(g.arm[i] * (isRun ? 0.5 : 0.4)),
      }
      F.s.push({ ...common, legs: frontLegs(g, i) })
      F.n.push({ ...common, legs: frontLegs(g, i) })
      F.e.push({
        ...common, legs: STAND_LEGS,
        lean: g.lean, armSwing: g.arm[i],
        capeTrail: g.cape[i], capeFlut: (i % 2) * (isRun ? 2 : 1),
        nearX: g.nearX[i], nearL: g.nearL[i], farX: g.farX[i], farL: g.farL[i],
      })
    }
  }
  return F
}

function mountFramePoses() {
  const F = { s: [], n: [], e: [] }
  for (let i = 0; i < IDLE.n; i++) {
    const o = {
      bob: 0, breath: IDLE.breath[i], blink: IDLE.blink[i],
      legs: STAND_LEGS, sway: 0, tailSway: IDLE.drift[i],
      lean: 0, neckX: 0, neckY: IDLE.breath[i], nearX: 0, nearL: 0, farX: 0, farL: 0,
    }
    F.s.push({ ...o }); F.n.push({ ...o }); F.e.push({ ...o, nearX: 2, farX: -3 })
  }
  for (const g of [WALK, RUN]) {
    const isRun = g === RUN
    for (let i = 0; i < g.n; i++) {
      // head-bob: birds thrust the head forward on contact frames
      const thrust = isRun ? 3 : (g.nearL[i] === 0 && g.nearX[i] > 0 ? 2 : 0)
      const common = {
        bob: g.bob[i], breath: 0, blink: false,
        sway: Math.round((g.arm[i] || 0) * 0.25),
        tailSway: Math.round((g.hem[i] || 0)),
      }
      F.s.push({ ...common, legs: frontLegs(g, i) })
      F.n.push({ ...common, legs: frontLegs(g, i) })
      F.e.push({
        ...common, legs: STAND_LEGS,
        lean: isRun ? 2 : 0,
        neckX: thrust, neckY: isRun ? 3 : Math.round(-g.bob[i] * 0.5),
        nearX: Math.round(g.nearX[i] * (isRun ? 1.3 : 1.1)),
        nearL: Math.round(g.nearL[i] * (isRun ? 1.3 : 1)),
        farX: Math.round(g.farX[i] * (isRun ? 1.3 : 1.1)),
        farL: Math.round(g.farL[i] * (isRun ? 1.3 : 1)),
      })
    }
  }
  return F
}

// Sun-side rim + bounce, applied after outlining. Bands are fractions of the
// silhouette so they track bob without re-tuning.
function lightPass(p) {
  let top = CELL, bot = 0
  for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
    if (p.get(x, y)) { if (y < top) top = y; if (y > bot) bot = y; break }
  }
  if (top >= bot) return
  const h = bot - top
  p.edgeRim(-1, top + 1, top + Math.round(h * 0.62), RIM_SUN, 4)      // warm sun rim, upper-left
  p.edgeRim(1, top + Math.round(h * 0.45), bot - 2, RIM_BOUNCE, 3)    // cool bounce, lower-right
}

// HI speckle: a few deterministic single-pixel glints on the largest lit areas
// (hair / plumage), never structural.
function speckle(p, rng, ramp, count) {
  const litKey = key(ramp.lit)
  let placed = 0, guard = 0
  while (placed < count && guard++ < 200) {
    const x = 4 + Math.floor(rng() * (CELL - 8))
    const y = 4 + Math.floor(rng() * (CELL - 20))
    if (!p.get(x, y)) continue
    if (key(p.colAt(x, y)) !== litKey) continue
    // only on up-facing surfaces: pixel above must be same material or empty edge
    if (p.get(x, y - 1) && key(p.colAt(x, y - 1)) === litKey) continue
    p.px(x, y, ramp.hi)
    placed++
  }
}

// Frame cell layout (16 cols): row0 = idle s|n|e|w ×4, row1 = walk s|n,
// row2 = walk e|w, row3 = run s|n, row4 = run e|w.
const LAYOUT = {
  idle_s: [0, 4], idle_n: [4, 4], idle_e: [8, 4], idle_w: [12, 4],
  walk_s: [16, 8], walk_n: [24, 8], walk_e: [32, 8], walk_w: [40, 8],
  run_s: [48, 6], run_n: [54, 6], run_e: [64, 6], run_w: [70, 6],
}

function buildSheet(painters, poses, seed, speckleRamp, speckleCount) {
  const sheet = new Uint8ClampedArray(SHEET_W * SHEET_H * 4)
  const rng = mulberry32(seed)
  const p = new Pix()
  const m = new Pix()

  const paintInto = (facing, pose, cell) => {
    p.clear()
    painters[facing](p, pose)
    speckle(p, rng, speckleRamp, speckleCount)
    p.outline(OUT)
    lightPass(p)
    p.blitTo(sheet, cell)
  }
  const mirrorInto = (srcCell, dstCell) => {
    // rebuild source cell into m mirrored (reads back from the sheet)
    const cx = (srcCell % COLS) * CELL, cy = Math.floor(srcCell / COLS) * CELL
    for (let y = 0; y < CELL; y++) {
      const s = ((cy + y) * SHEET_W + cx) * 4
      for (let x = 0; x < CELL; x++) {
        const d = (y * CELL + (CELL - 1 - x)) * 4
        m.d[d] = sheet[s + x * 4]; m.d[d + 1] = sheet[s + x * 4 + 1]
        m.d[d + 2] = sheet[s + x * 4 + 2]; m.d[d + 3] = sheet[s + x * 4 + 3]
      }
    }
    m.blitTo(sheet, dstCell)
  }

  // idle (4): s n e, then w mirrors e
  for (let i = 0; i < 4; i++) {
    paintInto('s', poses.s[i], LAYOUT.idle_s[0] + i)
    paintInto('n', poses.n[i], LAYOUT.idle_n[0] + i)
    paintInto('e', poses.e[i], LAYOUT.idle_e[0] + i)
    mirrorInto(LAYOUT.idle_e[0] + i, LAYOUT.idle_w[0] + i)
  }
  // walk (8) at pose offset 4
  for (let i = 0; i < 8; i++) {
    paintInto('s', poses.s[4 + i], LAYOUT.walk_s[0] + i)
    paintInto('n', poses.n[4 + i], LAYOUT.walk_n[0] + i)
    paintInto('e', poses.e[4 + i], LAYOUT.walk_e[0] + i)
    mirrorInto(LAYOUT.walk_e[0] + i, LAYOUT.walk_w[0] + i)
  }
  // run (6) at pose offset 12
  for (let i = 0; i < 6; i++) {
    paintInto('s', poses.s[12 + i], LAYOUT.run_s[0] + i)
    paintInto('n', poses.n[12 + i], LAYOUT.run_n[0] + i)
    paintInto('e', poses.e[12 + i], LAYOUT.run_e[0] + i)
    mirrorInto(LAYOUT.run_e[0] + i, LAYOUT.run_w[0] + i)
  }
  return sheet
}

// ---------------------------------------------------------------------------
// Texture + Sheet assembly
// ---------------------------------------------------------------------------

function toTexture(sheetData) {
  const canvas = document.createElement('canvas')
  canvas.width = SHEET_W
  canvas.height = SHEET_H
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false
  const img = ctx.createImageData(SHEET_W, SHEET_H)
  img.data.set(sheetData)
  ctx.putImageData(img, 0, 0)

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  return tex
}

function animsFromLayout() {
  const seq = (start, n) => Array.from({ length: n }, (_, i) => start + i)
  const anims = {}
  for (const k of Object.keys(LAYOUT)) {
    const [start, n] = LAYOUT[k]
    if (k.startsWith('idle')) anims[k] = IDLE_ORDER.map((i) => start + i)
    else anims[k] = seq(start, n)
  }
  return anims
}

function makeSheet(painters, poses, seed, speckleRamp, speckleCount, meta) {
  const data = buildSheet(painters, poses, seed, speckleRamp, speckleCount)
  return {
    texture: toTexture(data),
    frameW: CELL,
    frameH: CELL,
    cols: COLS,
    rows: ROWS,
    anims: animsFromLayout(),
    fps: FPS,
    // Extra (non-contract, safe to ignore): compositing + scale guidance.
    meta,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function makeHeroSheet() {
  return makeSheet(
    { s: heroSouth, n: heroNorth, e: heroEast },
    heroFramePoses(),
    0x0a37b0c1,
    HAIR, 3,
    {
      kind: 'hero',
      texelsPerMeter: 35,          // 64 px cell → 1.83 m world plane
      bodyPx: 56,                  // reads 1.60 m
      groundRow: GY,               // feet baseline inside the cell
      planeMeters: { w: CELL / 35, h: CELL / 35 },
    },
  )
}

export function makeMountSheet() {
  return makeSheet(
    { s: mountSouth, n: mountNorth, e: mountEast },
    mountFramePoses(),
    0x00c0b0b0,
    BODY, 4,
    {
      kind: 'mount',
      texelsPerMeter: 35,
      bodyPx: 52,
      groundRow: GY,
      planeMeters: { w: CELL / 35, h: CELL / 35 },
      // Hero hips land here (cell px, y from cell top) when composited.
      saddle: {
        s: { x: 31, y: 31 }, n: { x: 31, y: 31 },
        e: { x: 27, y: 30 }, w: { x: 36, y: 30 },
      },
    },
  )
}

// Debug contact sheet: the packed texture at 2× on a checker, with grid lines
// and anim labels. Browser-only (uses canvas text); returns an HTMLCanvasElement.
export function sheetDebugCanvas(sheet) {
  const S = 2
  const c = document.createElement('canvas')
  c.width = SHEET_W * S
  c.height = SHEET_H * S + 20
  const ctx = c.getContext('2d')
  ctx.imageSmoothingEnabled = false
  // checkerboard
  for (let y = 0; y < SHEET_H * S; y += 8) for (let x = 0; x < SHEET_W * S; x += 8) {
    ctx.fillStyle = ((x + y) / 8) % 2 ? '#3a3f44' : '#2e3237'
    ctx.fillRect(x, y, 8, 8)
  }
  ctx.drawImage(sheet.texture.image, 0, 0, SHEET_W * S, SHEET_H * S)
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'
  ctx.lineWidth = 1
  for (let i = 1; i < sheet.cols; i++) {
    ctx.beginPath(); ctx.moveTo(i * sheet.frameW * S + 0.5, 0); ctx.lineTo(i * sheet.frameW * S + 0.5, SHEET_H * S); ctx.stroke()
  }
  for (let j = 1; j < sheet.rows; j++) {
    ctx.beginPath(); ctx.moveTo(0, j * sheet.frameH * S + 0.5); ctx.lineTo(SHEET_W * S, j * sheet.frameH * S + 0.5); ctx.stroke()
  }
  ctx.fillStyle = '#e8e4d8'
  ctx.font = '10px monospace'
  for (const [name, [start, n]] of Object.entries(LAYOUT)) {
    const col = start % sheet.cols, row = Math.floor(start / sheet.cols)
    ctx.fillText(`${name}[${n}]`, col * sheet.frameW * S + 3, row * sheet.frameH * S + 11)
  }
  ctx.fillText(`${SHEET_W}x${SHEET_H} cell ${CELL} fps ${sheet.fps}`, 4, SHEET_H * S + 14)
  return c
}
