// ---------------------------------------------------------------------------
// battlerSheet.js — the four battle chibi sheets, 100% procedural.
//
// Contract (docs/BATTLE_CONTRACT.md — frozen):
//   export function makeBattlerSheet(id): Sheet   // 'rain'|'lasswell'|'fina'|'lid'
//   Sheet = { texture, frameW, frameH, cols, rows, anims, fps,
//             meta: { texelsPerMeter: 52.5, bodyPx, groundRow } }
//   anim keys: idle ready attack cast hit ko victory
//   (west-facing profile; victory faces south)
//
// Art direction (docs/BATTLE_BIBLE.md §5/§9 + frames 04/05):
//   - 96×96 cells, body ≈ 84 px tall → at 52.5 texels/m the plane is
//     96/52.5 = 1.829 m and the body reads 1.60 m.
//   - 4-shade ramps per material + HI accents, zero gradients, zero dithering,
//     1 px colour-matched warm near-black outline #1d1410 (hero-class outline
//     for all four battlers). NearestFilter, sRGB, power-of-two sheet.
//   - Battle sprites are lit and rimmed AT RUNTIME by units.js from arena.rim,
//     so cells bake only neutral form shading (soft top-front bias, shadow
//     pooling low and on the away side) — no baked sun rim like the overworld.
//   - Anim frame counts per BIBLE §5: idle(4) ready(4) attack(6) cast(6)
//     hit(2) ko(3) victory(4). Timing per §9 is encoded as repeat orders over
//     one sheet-wide FPS clock, exactly the overworld IDLE_ORDER idiom.
//
// Identity (studied off the reference crops, the binding source):
//   rain     — blond spike crown, red knee coat with pale trim, black under-
//              tunic and gloves, gold plackets, huge pale fork-tipped great-
//              sword held low-forward (frame05). His SKIN/HAIR/RED/BLK/GOLD/
//              CAPE ramps BYTE-MATCH ART_BIBLE §3 / src/art/characterSprite.js
//              so the same character reads as the same character on both
//              screens. (That module exports only finished sheets — no palette
//              symbols — so the ramps are re-declared here verbatim; the hex
//              table below is copied character-for-character from
//              characterSprite.js lines 60–69.)
//   lasswell — wild blue-black mane past the shoulders, bright violet kimono
//              jacket, gold-orange obi with a jade knot, wide hakama with pale
//              fur shin trim, thin katana held low and level in a draw stance
//              (frame04 front rank).
//   fina     — soft pale-blonde bob with long back falls and a red hair
//              flower, white bodice with gold trim and pink accents, violet
//              pleated skirt, pink boots, a big magenta recurve bow (frame04
//              back rank).
//   lid      — red spiky ponytail burst, green goggles on the brow, mustard
//              engineer jacket over brown chest strap and belt pouches, slate
//              baggy knickers, rust boots with green sock tops, a big steel
//              open-jaw wrench carried over the shoulder (frame04 back rank).
//
// Everything is authored: explicit silhouettes, hand-placed pixels for faces,
// trim and weapons; the seeded PRNG is used only for single-pixel HI speckle
// and cast-glow mote scatter, so output is fully deterministic per id.
// ---------------------------------------------------------------------------

import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Sheet geometry
// ---------------------------------------------------------------------------

const CELL = 96                 // px per frame cell (BIBLE §5, binding)
const COLS = 10                 // logical grid columns (index → col/row math)
const ROWS = 5
const SHEET_W = 1024            // power-of-two sheet (BIBLE §5, binding)
const SHEET_H = 512
const FPS = 12                  // one clock; per-anim pacing via repeat orders

// NOTE FOR THE CONSUMER (units.js): 96 px cells cannot tile a power-of-two
// sheet exactly (96 = 2^5·3), so cols·frameW = 960 < 1024. Frame UVs MUST be
// computed from pixels, not from 1/cols:
//   repeat = (frameW / texW, frameH / texH)
//   offset = (col·frameW / texW, 1 − (row+1)·frameH / texH)
// meta.uv carries these numbers ready-made; meta.cellUV(i) returns the offset.

const GY = 90                   // ground row inside a cell (soles rest here;
                                // the 1 px outline lands on 91, rows 92–95
                                // stay clear so units.js can sink feet 2–3
                                // texels into the floor's ambient)
const BODY_PX = 84              // crown-to-sole standing → 1.60 m at 52.5 t/m

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

function hex(h) {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const key = (c) => (c[0] << 16) | (c[1] << 8) | c[2]

const OUT = hex('#1d1410')      // hero-class warm near-black outline (binding)
const EYE_WHITE = hex('#f4f1e8')

// --- RAIN — byte-for-byte the overworld hero ramps (ART_BIBLE §3 /
// characterSprite.js). Do not touch these values; identity depends on them.
const R_SKIN = { hi: hex('#f6dfc2'), lit: hex('#e8c9a8'), mid: hex('#cfa987'), sh: hex('#b08c6c') }
const R_HAIR = { hi: hex('#f8e9a2'), lit: hex('#e8cf6f'), mid: hex('#cda44e'), sh: hex('#b3873a'), deep: hex('#8a6428') }
const R_RED  = { hi: hex('#c04a38'), lit: hex('#a03028'), mid: hex('#7c241e'), sh: hex('#5c1c14') }
const R_BLK  = { hi: hex('#4e4642'), lit: hex('#37302e'), mid: hex('#2a2422'), sh: hex('#1d1815') }
const R_GOLD = { hi: hex('#ffe9a6'), lit: hex('#d9b542'), mid: hex('#b08f33'), sh: hex('#8a6d24') }
const R_CAPE = { hi: hex('#eef3f6'), lit: hex('#dce4ea'), mid: hex('#b5c4d2'), sh: hex('#8fa3b8'), deep: hex('#6b8093') }

// Shared blade steel = the hero cape ramp (pale blue-white metal — keeps the
// battle party inside one material family and Rain's bytes untouched).
const STEEL = R_CAPE

// --- LASSWELL
const L_MANE = { hi: hex('#565064'), lit: hex('#3a3547'), mid: hex('#262232'), sh: hex('#16141f'), deep: hex('#0e0c15') }
const L_PURP = { hi: hex('#b877e2'), lit: hex('#9349c8'), mid: hex('#6d3399'), sh: hex('#4a2169') }
const L_OBI  = { hi: hex('#f2b45c'), lit: hex('#d98f36'), mid: hex('#a96828'), sh: hex('#7c491c') }
const L_JADE = { hi: hex('#8cc86a'), lit: hex('#63a655'), mid: hex('#3f7a3c'), sh: hex('#285426') }
const L_FUR  = { hi: hex('#eceaf2'), lit: hex('#d8d4e2'), mid: hex('#a9a6bc'), sh: hex('#7b7890') }

// --- FINA
const F_HAIR = { hi: hex('#f9edc6'), lit: hex('#eed695'), mid: hex('#d1ab64'), sh: hex('#a97f45'), deep: hex('#83602f') }
const F_WHT  = { hi: hex('#fbf9f2'), lit: hex('#ece7da'), mid: hex('#c6bcb0'), sh: hex('#998e88') }
const F_PINK = { hi: hex('#ff9ecb'), lit: hex('#ea5f9d'), mid: hex('#bb3d74'), sh: hex('#8c2a54'), deep: hex('#6d1f44') }
const F_VIO  = { hi: hex('#c08ad6'), lit: hex('#9a63b8'), mid: hex('#71458c'), sh: hex('#4e2f63') }
const F_BOOT = { hi: hex('#e2707c'), lit: hex('#c94b58'), mid: hex('#973341'), sh: hex('#6b232f') }

// --- LID
const D_HAIR = { hi: hex('#ff7e4a'), lit: hex('#e04a2c'), mid: hex('#ab2f1a'), sh: hex('#7c2010'), deep: hex('#5a170b') }
const D_AMB  = { hi: hex('#f6c96a'), lit: hex('#dd9d3e'), mid: hex('#b3762e'), sh: hex('#855422') }
const D_STRAP= { hi: hex('#a87c46'), lit: hex('#8a6234'), mid: hex('#66452a'), sh: hex('#46301c') }
const D_SLATE= { hi: hex('#5c6170'), lit: hex('#4a4e5a'), mid: hex('#363944'), sh: hex('#23252e') }
const D_BOOT = { hi: hex('#b45c3c'), lit: hex('#9a4a30'), mid: hex('#713524'), sh: hex('#4e2418') }
const D_GOGG = { hi: hex('#b4e284'), lit: hex('#8cc463'), mid: hex('#5d9440'), sh: hex('#3a6428') }

// Cast-glow energy colours per character (post-outline sparkle pixels only).
const GLOW = {
  rain:     [hex('#fff0cf'), hex('#ffe9a6'), hex('#f2cd7a')],   // warm white-gold
  lasswell: [hex('#efe2ff'), hex('#cda6f0'), hex('#a76fe0')],   // violet-white
  fina:     [hex('#ffe4f1'), hex('#ffb3d9'), hex('#f183b8')],   // pink-white
  lid:      [hex('#e8f8ff'), hex('#aadcf2'), hex('#ffd977')],   // arc-spark cyan + amber
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — speckle + mote scatter only, never
// structure. Same generator as the overworld sheets.
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

const SEEDS = { rain: 0xba771e01, lasswell: 0xba771e02, fina: 0xba771e03, lid: 0xba771e04 }

// ---------------------------------------------------------------------------
// Pix — a 96×96 RGBA scratch cell with pixel-art primitives. Integer
// coordinates, painters overwrite back-to-front, no canvas, no AA, ever.
// ---------------------------------------------------------------------------

class Pix {
  constructor() { this.d = new Uint8ClampedArray(CELL * CELL * 4) }
  clear() { this.d.fill(0) }
  px(x, y, c) {
    if (x < 0 || y < 0 || x >= CELL || y >= CELL) return
    const o = (y * CELL + x) * 4
    this.d[o] = c[0]; this.d[o + 1] = c[1]; this.d[o + 2] = c[2]; this.d[o + 3] = 255
  }
  cut(x, y) {                                        // punch alpha (weapon jaws)
    if (x < 0 || y < 0 || x >= CELL || y >= CELL) return
    this.d[(y * CELL + x) * 4 + 3] = 0
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
  disc(cx, cy, rx, ry, c) {
    for (let dy = -ry; dy <= ry; dy++) {
      const t = dy / (ry + 0.35)
      const hw = Math.floor(rx * Math.sqrt(Math.max(0, 1 - t * t)) + 0.5)
      this.h(cx - hw, cx + hw, cy + dy, c)
    }
  }
  ring(cx, cy, r, c) {                        // 1 px circle outline (goggles)
    for (let a = 0; a < 64; a++) {
      const t = (a / 64) * Math.PI * 2
      this.px(Math.round(cx + Math.cos(t) * r), Math.round(cy + Math.sin(t) * r), c)
    }
  }
  spike(cx, by, halfW, hgt, lean, c) {        // upward taper
    for (let j = 0; j < hgt; j++) {
      const t = j / hgt
      const hw = Math.max(0, Math.round(halfW * (1 - t)))
      const off = Math.round(lean * t)
      this.h(cx - hw + off, cx + hw + off, by - j, c)
    }
  }
  spikeDown(cx, ty, halfW, hgt, lean, c) {    // downward taper
    for (let j = 0; j < hgt; j++) {
      const t = j / hgt
      const hw = Math.max(0, Math.round(halfW * (1 - t)))
      const off = Math.round(lean * t)
      this.h(cx - hw + off, cx + hw + off, ty + j, c)
    }
  }
  // Thick bresenham stroke with a square nib — blades, poles, limbs, straps.
  line(x0, y0, x1, y1, c, w = 1) {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0)
    const n = Math.max(dx, dy, 1)
    const half = Math.floor((w - 1) / 2)
    for (let i = 0; i <= n; i++) {
      const x = Math.round(x0 + ((x1 - x0) * i) / n)
      const y = Math.round(y0 + ((y1 - y0) * i) / n)
      for (let oy = 0; oy < w; oy++) for (let ox = 0; ox < w; ox++) {
        this.px(x + ox - half, y + oy - half, c)
      }
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
// Shared small parts
// ---------------------------------------------------------------------------

// Chunky west-pointing boot: long toe toward −x, dark sole on the ground row.
// (fx, fy) = sole reference under the ankle; h = shaft height above the sole.
function bootW(p, fx, fy, ramp, h = 5) {
  p.r(fx - 2, fy - h, 8, h, ramp.lit)                // shaft + foot block
  p.r(fx + 3, fy - h, 3, h, ramp.mid)                // heel side turns away
  p.r(fx - 4, fy - 3, 3, 3, ramp.lit)                // toe cap forward
  p.px(fx - 4, fy - 3, ramp.hi)
  p.px(fx - 4, fy - 1, ramp.mid)
  p.h(fx - 4, fx + 5, fy, ramp.sh)                   // sole
  p.px(fx - 2, fy - h, ramp.hi)                      // cuff catchlight
  p.h(fx - 2, fx + 4, fy - h, ramp.hi === ramp.lit ? ramp.lit : ramp.hi)
}

// Front-view boot (victory): symmetric block under the trouser.
function bootS(p, cx, fy, ramp, h = 4) {
  p.r(cx - 3, fy - h, 7, h, ramp.lit)
  p.v(cx + 2, fy - h, fy - 1, ramp.mid)
  p.v(cx + 3, fy - h, fy - 1, ramp.mid)
  p.h(cx - 3, cx + 3, fy, ramp.sh)
  p.px(cx - 3, fy - h, ramp.hi)
}

// One profile eye + brow + mouth. (ex, ey) = eye block top-left. The eye is
// BIG — a third of the face — per the reference chibi grammar. States:
// 'open' 'blink' 'x' 'shut' 'happy'. Mouth: 'set' 'open' 'grit' 'smile'.
function faceW(p, ex, ey, skin, browC, o) {
  const eye = o.eye || 'open'
  if (eye === 'open') {
    p.r(ex, ey, 4, 6, R_BLK.lit)                     // iris block
    p.r(ex, ey + 1, 2, 2, EYE_WHITE)                 // wet glint
    p.px(ex + 1, ey + 4, R_BLK.sh)
    p.px(ex + 2, ey + 4, R_BLK.sh)
    p.h(ex, ex + 3, ey - 1, R_BLK.sh)                // lash line
  } else if (eye === 'blink' || eye === 'shut') {
    p.h(ex, ex + 3, ey + 3, R_BLK.lit)
    p.h(ex, ex + 3, ey + 4, skin.mid)
  } else if (eye === 'x') {
    p.px(ex, ey, R_BLK.lit); p.px(ex + 3, ey, R_BLK.lit)
    p.px(ex + 1, ey + 1, R_BLK.sh); p.px(ex + 2, ey + 1, R_BLK.sh)
    p.px(ex + 1, ey + 2, R_BLK.sh); p.px(ex + 2, ey + 2, R_BLK.sh)
    p.px(ex, ey + 3, R_BLK.lit); p.px(ex + 3, ey + 3, R_BLK.lit)
  } else if (eye === 'happy') {                      // ∪ closed-happy arc
    p.px(ex, ey + 1, R_BLK.lit); p.px(ex + 3, ey + 1, R_BLK.lit)
    p.h(ex, ex + 3, ey + 2, R_BLK.lit)
  }
  p.h(ex, ex + 4, ey - 3, browC)                     // brow
  const mouth = o.mouth || 'set'
  const mx = ex + 1, my = ey + 8
  if (mouth === 'set') p.h(mx - 1, mx, my, R_BLK.lit)
  else if (mouth === 'open') { p.r(mx - 1, my, 2, 2, R_BLK.mid); p.px(mx - 1, my + 1, R_RED.mid) }
  else if (mouth === 'grit') { p.h(mx - 2, mx + 1, my, R_BLK.mid); p.px(mx - 1, my, EYE_WHITE) }
  else if (mouth === 'smile') { p.px(mx - 2, my - 1, R_BLK.lit); p.h(mx - 1, mx, my, R_BLK.lit) }
}

// Front-view face for the victory cells: two big eyes around cx.
function faceS(p, cx, ey, skin, browC, o) {
  const eye = o.eye || 'open'
  const L = cx - 7, Rr = cx + 3
  if (eye === 'open') {
    for (const x of [L, Rr]) {
      p.r(x, ey, 4, 6, R_BLK.lit)
      p.r(x, ey + 1, 2, 2, EYE_WHITE)
      p.px(x + 1, ey + 4, R_BLK.sh); p.px(x + 2, ey + 4, R_BLK.sh)
      p.h(x, x + 3, ey - 1, R_BLK.sh)
    }
  } else if (eye === 'happy') {
    for (const x of [L, Rr]) {
      p.px(x, ey + 1, R_BLK.lit); p.px(x + 3, ey + 1, R_BLK.lit); p.h(x, x + 3, ey + 2, R_BLK.lit)
    }
  } else {
    p.h(L, L + 3, ey + 3, R_BLK.lit); p.h(Rr, Rr + 3, ey + 3, R_BLK.lit)
  }
  p.h(L, L + 4, ey - 3, browC); p.h(Rr, Rr + 4, ey - 3, browC)
  const mouth = o.mouth || 'smile'
  if (mouth === 'smile') { p.px(cx - 3, ey + 8, R_BLK.lit); p.h(cx - 2, cx + 1, ey + 9, R_BLK.lit); p.px(cx + 2, ey + 8, R_BLK.lit) }
  else if (mouth === 'open') { p.r(cx - 2, ey + 8, 4, 3, R_BLK.mid); p.h(cx - 1, cx, ey + 10, R_RED.mid) }
  else p.h(cx - 2, cx + 1, ey + 8, R_BLK.lit)
}

// HI speckle: deterministic single-pixel glints on the largest lit areas.
function speckle(p, rng, ramp, count) {
  const litKey = key(ramp.lit)
  let placed = 0, guard = 0
  while (placed < count && guard++ < 300) {
    const x = 6 + Math.floor(rng() * (CELL - 12))
    const y = 6 + Math.floor(rng() * (CELL - 28))
    if (!p.get(x, y)) continue
    if (key(p.colAt(x, y)) !== litKey) continue
    if (p.get(x, y - 1) && key(p.colAt(x, y - 1)) === litKey) continue
    p.px(x, y, ramp.hi)
    placed++
  }
}

// ---------------------------------------------------------------------------
// Post-outline passes — pure light/motion pixels with NO outline ring, so
// they read as light and speed, not as bodies.
// ---------------------------------------------------------------------------

// Cast glow: mote cloud + plus-sparkles + a broken gathering ring around the
// raised hand. lvl 1..4 ramps count and radius; deterministic via sheet rng.
function glowPass(p, rng, at, lvl, cols) {
  if (!at || lvl <= 0) return
  const [gx, gy] = at
  const n = 4 + lvl * 4
  const rad = 4 + lvl * 2.4
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2
    const rr = (0.35 + 0.65 * rng()) * rad
    const x = Math.round(gx + Math.cos(a) * rr)
    const y = Math.round(gy + Math.sin(a) * rr * 0.9 - lvl * 0.6)  // drift up
    const c = cols[Math.min(cols.length - 1, Math.floor(rng() * cols.length))]
    p.px(x, y, c)
    if (rng() < 0.3 + lvl * 0.12) { p.px(x + 1, y, c); p.px(x, y - 1, c) }
  }
  if (lvl >= 2) {                                    // core plus-sparkle
    const s = lvl - 1
    p.h(gx - s, gx + s, gy, cols[0])
    p.v(gx, gy - s, gy + s, cols[0])
    p.px(gx - 1, gy - 1, cols[1]); p.px(gx + 1, gy + 1, cols[1])
  }
  if (lvl >= 3) {                                    // broken gathering ring
    const rr = lvl + 3
    for (let a = 0; a < 16; a++) {
      if (a % 2) continue
      const t = (a / 16) * Math.PI * 2
      p.px(Math.round(gx + Math.cos(t) * rr), Math.round(gy + Math.sin(t) * rr * 0.8), cols[2])
    }
  }
  if (lvl >= 4) {                                    // peak: satellite sparkle
    p.h(gx - 9, gx - 7, gy - 6, cols[1])
    p.v(gx - 8, gy - 7, gy - 5, cols[1])
    p.px(gx + 7, gy + 4, cols[1])
  }
}

// Motion smear: broken horizontal ghosts trailing a moving edge.
function smearPass(p, segs) {
  for (const [x, y, len, c] of segs) {
    for (let i = 0; i < len; i++) {
      if (i % 4 === 3) continue                      // broken dashes, not bars
      p.px(x + i, y, c)
    }
  }
}

// ---------------------------------------------------------------------------
// Pose tables — one shared semantic skeleton per anim beat; each character's
// painter interprets it. All west-profile beats face −x (screen left).
//   bob      +down px (whole body)         breath  −1 = chest/head risen
//   lean     +west px (toward the enemy; negative = recoil east)
//   crouch   +down px on hips (knees bend, stance widens)
//   kneel    0 stand · 1 knees-down · 2 full slump (torso shears west)
//   headDrop +down px on the head only (negative = thrown back)
//   hairSw   hair thrown px: + = east (behind), − = west (over the face)
//   wind / strike / follow   attack anticipation / extension / carry-through
//   raise 0|1|2, release     cast arm; glow 0..4 mote intensity
//   smear    bake dash ghosts       arms:'limp'  ko arms
// ---------------------------------------------------------------------------

const POSE = {
  idle: [
    { breath: 0 }, { breath: -1 }, { breath: -1, sway: 1 }, { breath: 0, eye: 'blink' },
  ],
  ready: [
    { lean: 2, crouch: 1, guard: 1 },
    { lean: 3, crouch: 2, guard: 1 },
    { lean: 4, crouch: 2, guard: 1, breath: -1 },
    { lean: 4, crouch: 2, guard: 1 },
  ],
  attack: [
    { lean: -3, crouch: 2, wind: 1, hairSw: 3, mouth: 'grit' },
    { lean: 7, crouch: 1, wind: 1, smear: 1, hairSw: 5, mouth: 'grit' },
    { lean: 6, crouch: 2, strike: 1, hairSw: 2, mouth: 'open' },
    { lean: 5, crouch: 3, follow: 1, hairSw: -4, mouth: 'grit' },
    { lean: 2, crouch: 1, follow: 0.5, hairSw: -1 },
    { lean: 2, crouch: 1, guard: 1 },
  ],
  cast: [
    { crouch: 1, headDrop: 1, raise: 0, glow: 0, eye: 'shut' },
    { crouch: 1, raise: 1, glow: 1 },
    { crouch: 1, raise: 2, glow: 2 },
    { crouch: 1, raise: 2, glow: 3, hairLift: 1 },   // held pose, glow ramps
    { crouch: 1, raise: 2, glow: 4, hairLift: 2 },   // held pose, glow peaks
    { lean: 3, crouch: 1, release: 1, glow: 2, mouth: 'open' },
  ],
  hit: [
    { lean: -6, headDrop: -1, hairSw: -5, eye: 'x', mouth: 'grit', flinch: 1 },
    { lean: -2, hairSw: -2, eye: 'blink', mouth: 'grit', flinch: 0.5 },
  ],
  ko: [
    { crouch: 4, headDrop: 2, hairSw: -2, eye: 'shut', arms: 'limp', mouth: 'grit' },
    { kneel: 1, headDrop: 3, hairSw: -3, eye: 'shut', arms: 'limp', mouth: 'set' },
    { kneel: 2, headDrop: 5, hairSw: -4, eye: 'shut', arms: 'limp', mouth: 'set' },
  ],
  victory: [                                          // south-facing
    { bob: 0, eye: 'open', mouth: 'smile', vArm: 0 },
    { bob: -2, eye: 'open', mouth: 'smile', vArm: 1 },
    { bob: -3, eye: 'happy', mouth: 'open', vArm: 2 },
    { bob: 0, eye: 'happy', mouth: 'smile', vArm: 2 },
  ],
}

// Sheet cell layout: contract anims packed tight from cell 0 on the 10-col
// grid. 29 authored cells; the rest of the 1024×512 sheet stays transparent.
const LAYOUT = {
  idle: [0, 4], ready: [4, 4], attack: [8, 6], cast: [14, 6],
  hit: [20, 2], ko: [22, 3], victory: [25, 4],
}

// Playback orders over the 12 fps clock (overworld IDLE_ORDER idiom) —
// timings land on BIBLE §9: idle 6 fps, cast ≈0.9 s with the VFX-peak hold,
// hit 250 ms, ko falls then stays slumped, victory ≈6 fps celebration loop.
const ORDERS = {
  idle:    [0, 0, 1, 1, 2, 2, 3, 3],
  ready:   [0, 1, 2, 3, 2, 3, 2, 3],
  attack:  [0, 0, 1, 2, 3, 3, 4, 5],
  cast:    [0, 1, 2, 2, 3, 3, 4, 4, 4, 5, 5],
  hit:     [0, 0, 1],
  ko:      [0, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2],
  victory: [0, 0, 1, 1, 2, 2, 3, 3],
}

// ---------------------------------------------------------------------------
// Rig math shared by all four west painters.
// Standing skeleton (before pose offsets):
//   soles GY=90 · hips y 62 · torso top y 38 · head centre (44, 23)
//   front (west) foot x≈36 · back foot x≈58 · torso centre x≈48
// crouch drops hips/torso/head and widens the stance. kneel rebuilds the legs
// and shears the torso west (shear(y) gives the per-row x shift, biggest at
// the shoulders) so the slump actually folds instead of sitting.
// ---------------------------------------------------------------------------

function rigW(o) {
  const bob = (o.bob | 0) + (o.breath | 0)
  const lean = o.lean | 0
  const crouch = o.crouch | 0
  const kneel = o.kneel | 0
  let hipY = 62 + crouch + bob
  let topY = 38 + crouch + bob - Math.round(crouch * 0.3)
  let headX = 44 - lean
  let headY = 23 + crouch + bob + (o.headDrop | 0)
  let hipX = 48 - Math.round(lean * 0.6)
  let shearAmt = 0
  if (kneel === 1) {
    hipY = 76 + bob; topY = 54 + bob; shearAmt = 3
    headY = 42 + bob + (o.headDrop | 0); headX = 42 - lean
  } else if (kneel === 2) {
    hipY = 78 + bob; topY = 60 + bob; shearAmt = 8
    headY = 50 + bob + (o.headDrop | 0); headX = 36 - lean
  }
  const g = { bob, lean, crouch, kneel, hipY, topY, headX, headY, hipX }
  g.shear = (y) => -Math.round(((hipY - y) / Math.max(1, hipY - topY)) * shearAmt)
  return g
}

// Draw a torso block row-by-row through the shear (kneel fold).
function torsoRows(p, g, x0, x1, y0, y1, fn) {
  for (let y = y0; y <= y1; y++) {
    const s = g.shear(y)
    fn(y, x0 + s, x1 + s)
  }
}

function legsW(p, g, o, drawLeg) {
  if (g.kneel) { drawLeg(p, g, 'kneelFar'); drawLeg(p, g, 'kneelNear'); return }
  drawLeg(p, g, 'far')
  drawLeg(p, g, 'near')
}

// ---------------------------------------------------------------------------
// RAIN — blond swordsman. West profile.
// ---------------------------------------------------------------------------

// The fork-tipped greatsword: pale two-tone blade with a carved notch near
// the tip (frame05 signature), gold cross-guard, black wrapped grip.
function rainSword(p, gx, gy, tx, ty) {
  const dx = tx - gx, dy = ty - gy
  const len = Math.max(Math.abs(dx), Math.abs(dy), 1)
  const ux = dx / len, uy = dy / len
  const px_ = -uy, py_ = ux
  p.line(Math.round(gx + ux * 4), Math.round(gy + uy * 4), tx, ty, STEEL.mid, 3)
  p.line(Math.round(gx + ux * 4 + px_ * 1.5), Math.round(gy + uy * 4 + py_ * 1.5), Math.round(tx + px_ * 1.5), Math.round(ty + py_ * 1.5), STEEL.sh, 1)
  p.line(Math.round(gx + ux * 4 - px_ * 1.5), Math.round(gy + uy * 4 - py_ * 1.5), Math.round(tx - px_), Math.round(ty - py_), STEEL.lit, 2)
  p.px(Math.round(gx + ux * 7 - px_ * 2), Math.round(gy + uy * 7 - py_ * 2), STEEL.hi)
  p.px(Math.round(gx + ux * 12 - px_ * 2), Math.round(gy + uy * 12 - py_ * 2), STEEL.hi)
  // fork notch ~70% out: bite carved from the shaded edge
  const nx = Math.round(gx + dx * 0.7), ny = Math.round(gy + dy * 0.7)
  p.cut(nx + Math.round(px_ * 2), ny + Math.round(py_ * 2))
  p.cut(nx + Math.round(px_ * 1), ny + Math.round(py_ * 1))
  p.cut(nx + Math.round(px_ * 2) + Math.round(ux), ny + Math.round(py_ * 2) + Math.round(uy))
  p.px(nx, ny, STEEL.hi)
  p.px(tx, ty, STEEL.hi)
  p.px(Math.round(tx - ux), Math.round(ty - uy), STEEL.lit)
  // gold cross-guard
  p.line(Math.round(gx + ux * 3 + px_ * 4), Math.round(gy + uy * 3 + py_ * 4),
         Math.round(gx + ux * 3 - px_ * 4), Math.round(gy + uy * 3 - py_ * 4), R_GOLD.mid, 2)
  p.px(Math.round(gx + ux * 3 - px_ * 3), Math.round(gy + uy * 3 - py_ * 3), R_GOLD.hi)
  p.px(Math.round(gx + ux * 3 + px_ * 3), Math.round(gy + uy * 3 + py_ * 3), R_GOLD.sh)
  // wrapped grip + pommel
  p.line(gx, gy, Math.round(gx + ux * 3), Math.round(gy + uy * 3), R_BLK.mid, 2)
  p.px(gx, gy, R_GOLD.sh)
  p.px(Math.round(gx - ux), Math.round(gy - uy), R_GOLD.lit)
}

function rainWest(p, o) {
  const g = rigW(o)
  const guard = o.guard || 0
  const sw = (o.hairSw | 0)
  const hx = g.headX, hy = g.headY

  // ---- legs first (black trousers + black boots with a lit cuff)
  const drawLeg = (p2, gg, which) => {
    if (which.startsWith('kneel')) {
      const near = which === 'kneelNear'
      const base = near ? R_BLK.lit : R_BLK.mid
      const kx = near ? 34 : 48                      // knee on the ground
      // shin flat along the floor, boot toe behind (east)
      p2.r(kx, GY - 4, 13, 4, base)
      p2.r(kx + 11, GY - 5, 4, 5, near ? R_BLK.mid : R_BLK.sh)   // heel block
      p2.h(kx, kx + 14, GY, R_BLK.sh)
      // thigh: hip down-forward to the knee
      p2.line(gg.hipX + (near ? -1 : 4), gg.hipY - 2, kx + 2, GY - 5, base, 4)
      p2.px(kx + 1, GY - 5, near ? R_BLK.hi : R_BLK.lit)
      return
    }
    const near = which === 'near'
    const spread = 3 + Math.min(gg.crouch, 3) * 2
    const fx = (near ? 36 - spread : 58 + Math.round(spread * 0.5)) - Math.round(gg.lean * 0.4)
    const base = near ? R_BLK.lit : R_BLK.mid
    const hipPx = gg.hipX + (near ? -2 : 5)
    for (let y = gg.hipY; y <= GY - 6; y++) {
      const t = (y - gg.hipY) / Math.max(1, GY - 6 - gg.hipY)
      const cx = Math.round(hipPx + (fx + 1 - hipPx) * t * t)
      p2.h(cx - 2, cx + 2, y, base)
      p2.px(cx - 2, y, near ? R_BLK.hi : R_BLK.lit)  // shin light edge
    }
    bootW(p2, fx, GY, near ? R_BLK : { hi: R_BLK.lit, lit: R_BLK.mid, mid: R_BLK.sh, sh: R_BLK.sh })
  }
  legsW(p, g, o, drawLeg)

  // ---- red coat hem: SHORT skirt swept back so the legs read; pale trim
  const hemTop = g.hipY - 4
  const hemBot = g.kneel ? g.hipY + 2 : g.hipY + 8
  const sway = Math.round(sw * 0.5)
  for (let y = hemTop; y <= hemBot; y++) {
    const t = (y - hemTop) / Math.max(1, hemBot - hemTop)
    const s = g.shear(y)
    const back = g.hipX + 6 + Math.round(t * (7 + Math.max(0, sway))) + s
    const front = g.hipX - 7 + Math.round(t * 2) + Math.min(0, sway) + s
    p.h(front, back, y, R_RED.lit)
    p.h(front + Math.round((back - front) * 0.55), back, y, R_RED.mid)
    if (t > 0.6) p.px(back, y, R_RED.sh)
  }
  p.h(g.hipX - 5 + Math.min(0, sway), g.hipX + 12 + Math.max(0, sway), hemBot + 1, R_CAPE.mid)
  p.px(g.hipX - 4 + Math.min(0, sway), hemBot + 1, R_CAPE.lit)
  p.spikeDown(g.hipX + 10 + Math.max(0, sway), hemBot + 1, 2, 4, 2, R_RED.sh)  // trailing point

  // ---- torso: red coat, black under-panel front, gold placket, belt
  const ty = g.topY
  torsoRows(p, g, g.hipX - 8, g.hipX + 7, ty, g.hipY - 1, (y, x0, x1) => {
    p.h(x0, x1, y, R_RED.lit)
    p.h(x1 - 4, x1, y, R_RED.mid)                    // away side shade
    if (y >= ty + 2 && y <= g.hipY - 3) {
      p.h(x0, x0 + 3, y, R_BLK.lit)                  // under-tunic front
      p.px(x0 + 4, y, R_GOLD.mid)                    // placket
    }
  })
  p.px(g.hipX - 4 + g.shear(ty + 3), ty + 3, R_GOLD.hi)
  p.h(g.hipX - 8 + g.shear(g.hipY - 2), g.hipX + 7 + g.shear(g.hipY - 2), g.hipY - 2, R_BLK.mid)  // belt
  p.px(g.hipX - 4 + g.shear(g.hipY - 2), g.hipY - 2, R_GOLD.lit)                                  // buckle
  p.h(g.hipX - 8 + g.shear(ty), g.hipX + 6 + g.shear(ty), ty, R_RED.hi)                           // shoulder light
  // pale collar at the throat
  p.r(g.headX - 3, ty - 2, 7, 2, R_CAPE.lit)
  p.px(g.headX + 4, ty - 2, R_CAPE.sh)

  // ---- arms + THE SWORD
  const shX = g.hipX - 2 + g.shear(ty + 3), shY = ty + 3
  const drawArm = (bx, by) => {
    p.line(shX, shY, bx, by, R_RED.lit, 3)
    p.line(shX + 1, shY + 1, bx + 1, by + 1, R_RED.mid, 1)
    p.r(shX - 1, shY - 1, 4, 3, R_RED.lit)           // shoulder puff
    p.px(shX - 1, shY - 1, R_RED.hi)
    p.r(bx - 1, by - 1, 4, 4, R_BLK.lit)             // glove
    p.px(bx + 1, by + 2, R_BLK.sh)
    p.px(bx - 1, by - 1, R_BLK.hi)
  }
  if (o.arms === 'limp') {
    if (g.kneel) {
      drawArm(shX - 6, GY - 3)                       // propping to the floor
      p.h(shX - 8, shX - 4, GY - 1, R_BLK.lit)       // splayed glove
    } else {
      drawArm(shX - 2, g.hipY + 6)
    }
    // dropped sword lying FLAT: low blade line, guard poking up, no ground sink
    p.h(g.hipX - 12, g.hipX + 10, GY - 2, STEEL.mid)
    p.h(g.hipX - 12, g.hipX + 4, GY - 3, STEEL.lit)
    p.px(g.hipX - 13, GY - 2, STEEL.hi)              // tip
    p.px(g.hipX - 4, GY - 3, STEEL.hi)
    p.r(g.hipX + 10, GY - 5, 2, 4, R_GOLD.mid)       // cross-guard up
    p.px(g.hipX + 10, GY - 5, R_GOLD.hi)
    p.h(g.hipX + 12, g.hipX + 15, GY - 2, R_BLK.mid) // wrapped grip
    p.px(g.hipX + 16, GY - 2, R_GOLD.sh)             // pommel
  } else if (o.release) {
    rainSword(p, g.hipX + 10, GY - 2, g.hipX + 14, g.hipY - 28)  // planted
    drawArm(shX - 13, shY + 1)
    p.px(shX - 14, shY + 1, R_SKIN.lit)              // open palm
    p.px(shX - 14, shY + 2, R_SKIN.mid)
  } else if ((o.raise | 0) > 0) {
    rainSword(p, g.hipX + 10, GY - 2, g.hipX + 14, g.hipY - 28)  // planted aside
    const bx = o.raise === 2 ? shX - 11 : shX - 8
    const by = o.raise === 2 ? shY - 12 : shY - 5
    drawArm(bx, by)
    p.px(bx - 1, by - 2, R_SKIN.lit)                 // upturned fingers
    o._hand = [bx - 2, by - 5]
  } else if (o.wind) {
    drawArm(shX + 6, shY - 5)
    rainSword(p, shX + 7, shY - 6, shX + 28, shY - 24)
  } else if (o.strike) {
    drawArm(shX - 10, shY + 3)
    rainSword(p, shX - 10, shY + 3, shX - 36, shY + 7)
  } else if (o.follow) {
    drawArm(shX - 8, g.hipY - 1)
    rainSword(p, shX - 8, g.hipY - 1, shX - 30, GY - 3)
  } else if (o.flinch) {
    drawArm(shX + 7, shY - 3)
    rainSword(p, shX + 8, shY - 4, shX + 26, shY - 18)
  } else if (guard) {
    drawArm(shX - 9, shY + 5)
    rainSword(p, shX - 7, shY + 6, shX - 30, shY - 4)
  } else {
    drawArm(shX - 7, g.hipY - 4)
    rainSword(p, shX - 7, g.hipY - 3, shX - 27, GY - 5)
  }

  // ---- head: big skull, spike crown, face plate forward
  p.disc(hx, hy, 14, 12, R_HAIR.lit)                 // skull mass
  p.disc(hx + 5, hy + 2, 10, 9, R_HAIR.mid)          // rear volume
  p.disc(hx - 3, hy - 2, 10, 9, R_HAIR.lit)
  // face plate: forward third, tall
  p.r(hx - 13, hy - 3, 10, 14, R_SKIN.lit)
  p.px(hx - 14, hy + 1, R_SKIN.lit)                  // nose tip
  p.px(hx - 14, hy + 2, R_SKIN.mid)
  p.h(hx - 13, hx - 5, hy + 11, R_SKIN.mid)          // jaw
  p.h(hx - 12, hx - 6, hy + 12, R_SKIN.mid)
  p.px(hx - 3, hy + 4, R_SKIN.sh)                    // ear nub
  p.px(hx - 4, hy + 3, R_SKIN.mid)
  // fringe cutting over the brow
  p.h(hx - 13, hx - 4, hy - 4, R_HAIR.deep)
  p.spikeDown(hx - 12, hy - 4, 2, 5, -1, R_HAIR.lit)
  p.spikeDown(hx - 9, hy - 4, 2, 6, 0, R_HAIR.mid)
  p.spikeDown(hx - 6, hy - 4, 2, 5, 1, R_HAIR.lit)
  // crown + swept-back spikes (signature), thrown by hairSw
  p.spike(hx - 6, hy - 10, 3, 8, -3, R_HAIR.lit)
  p.spike(hx - 1, hy - 11, 3, 9, 0 + Math.round(sw * 0.3), R_HAIR.lit)
  p.spike(hx + 4, hy - 10, 3, 9, 3 + Math.round(sw * 0.5), R_HAIR.mid)
  p.spike(hx + 9, hy - 6, 3, 8, 5 + sw, R_HAIR.mid)
  p.spike(hx + 12, hy - 1, 3, 7, 6 + sw, R_HAIR.sh)
  p.spike(hx + 13, hy + 5, 2, 6, 5 + sw, R_HAIR.sh)  // nape flick
  p.px(hx, hy - 20, R_HAIR.lit); p.px(hx, hy - 19, R_HAIR.mid)   // ahoge
  p.v(hx + 9, hy - 1, hy + 3, R_HAIR.sh)
  p.px(hx - 6, hy - 14, R_HAIR.hi); p.px(hx - 1, hy - 16, R_HAIR.hi)
  p.px(hx + 4, hy - 13, R_HAIR.hi)
  faceW(p, hx - 12, hy + 1, R_SKIN, R_HAIR.deep, o)
}

function rainSouth(p, o) {
  const b = (o.bob | 0)
  const v = o.vArm | 0
  const cx = 47
  // legs
  const legY = 61 + b
  for (const [lx, shade] of [[cx - 7, false], [cx + 3, true]]) {
    p.r(lx, legY, 5, GY - 4 - legY, shade ? R_BLK.mid : R_BLK.lit)
    p.px(lx, legY + 2, shade ? R_BLK.lit : R_BLK.hi)
    bootS(p, lx + 2, GY, shade ? { hi: R_BLK.lit, lit: R_BLK.mid, mid: R_BLK.sh, sh: R_BLK.sh } : R_BLK)
  }
  // coat hem: front split skirt with pale trim
  const hy = 57 + b
  for (let j = 0; j < 7; j++) {
    const w = 10 + (j >> 1)
    p.h(cx - w, cx + w, hy + j, R_RED.lit)
    p.h(cx + 3, cx + w, hy + j, R_RED.mid)
    if (j > 2) { p.px(cx, hy + j, R_RED.sh); p.px(cx + 1, hy + j, R_RED.sh) }
  }
  p.h(cx - 12, cx + 12, hy + 7, R_CAPE.mid)
  p.px(cx - 11, hy + 7, R_CAPE.lit)
  // torso
  const ty = 43 + b
  p.r(cx - 9, ty, 19, 15, R_RED.lit)
  p.r(cx + 5, ty + 1, 5, 14, R_RED.mid)
  p.r(cx - 3, ty + 2, 7, 13, R_BLK.lit)
  p.r(cx + 1, ty + 2, 3, 13, R_BLK.mid)
  p.v(cx - 4, ty + 2, ty + 13, R_GOLD.mid)
  p.v(cx + 4, ty + 2, ty + 13, R_GOLD.sh)
  p.px(cx - 4, ty + 3, R_GOLD.hi)
  p.r(cx - 9, ty + 13, 19, 2, R_BLK.mid)
  p.r(cx - 1, ty + 13, 3, 2, R_GOLD.lit)
  p.h(cx - 9, cx + 9, ty, R_RED.hi)
  // arms (weapon painted after the head so it rides over the hair)
  const armL = () => {
    p.r(cx - 14, ty + 2, 4, 9, R_RED.lit)
    p.px(cx - 14, ty + 2, R_RED.hi)
    p.r(cx - 14, ty + 10, 4, 4, R_BLK.lit)
  }
  armL()
  if (v === 0) {
    p.r(cx + 10, ty + 2, 4, 9, R_RED.mid)
    p.r(cx + 10, ty + 10, 4, 4, R_BLK.lit)
  } else {
    p.line(cx + 11, ty + 4, cx + 15, ty - 7, R_RED.mid, 3)
    p.r(cx + 14, ty - 10, 4, 4, R_BLK.lit)
  }
  // head
  const hy2 = 27 + b
  p.disc(cx, hy2, 14, 12, R_HAIR.lit)
  p.disc(cx + 5, hy2 + 2, 10, 9, R_HAIR.mid)
  p.disc(cx - 2, hy2 - 2, 10, 9, R_HAIR.lit)
  p.r(cx - 10, hy2 + 1, 21, 12, R_SKIN.lit)
  p.h(cx - 10, cx + 10, hy2 + 13, R_SKIN.mid)
  p.h(cx - 8, cx + 8, hy2 + 14, R_SKIN.lit)
  p.h(cx - 6, cx + 6, hy2 + 15, R_SKIN.mid)
  p.r(cx + 8, hy2 + 2, 2, 10, R_SKIN.mid)
  p.px(cx - 11, hy2 + 5, R_SKIN.mid); p.px(cx + 11, hy2 + 5, R_SKIN.sh)
  p.h(cx - 10, cx + 10, hy2, R_HAIR.deep)
  for (const [sx, sw2, sh2, ln] of [[cx - 8, 2, 4, -1], [cx - 4, 2, 5, 0], [cx, 2, 4, 0], [cx + 4, 2, 5, 1], [cx + 8, 1, 4, 1]]) {
    p.spikeDown(sx, hy2, sw2, sh2, ln, R_HAIR.mid)
  }
  p.spikeDown(cx - 6, hy2, 1, 4, -1, R_HAIR.lit)
  p.spike(cx - 10, hy2 - 8, 3, 7, -3, R_HAIR.lit)
  p.spike(cx - 5, hy2 - 10, 3, 8, -1, R_HAIR.lit)
  p.spike(cx, hy2 - 11, 3, 9, 0, R_HAIR.lit)
  p.spike(cx + 5, hy2 - 10, 3, 8, 2, R_HAIR.mid)
  p.spike(cx + 10, hy2 - 7, 3, 7, 4, R_HAIR.mid)
  p.px(cx + 1, hy2 - 21, R_HAIR.lit); p.px(cx + 1, hy2 - 20, R_HAIR.mid)
  p.px(cx - 6, hy2 - 14, R_HAIR.hi); p.px(cx - 1, hy2 - 16, R_HAIR.hi)
  faceS(p, cx, hy2 + 5, R_SKIN, R_HAIR.deep, o)
  // raised greatsword LAST — in front of the hair
  if (v === 1) rainSword(p, cx + 16, ty - 11, cx + 20, ty - 32)
  else if (v >= 2) rainSword(p, cx + 16, ty - 11, cx + 18, ty - 38)
}

// ---------------------------------------------------------------------------
// LASSWELL — dark samurai. West profile, low iai stance, level katana.
// ---------------------------------------------------------------------------

function katana(p, gx, gy, tx, ty) {
  const dx = tx - gx, dy = ty - gy
  const len = Math.max(Math.abs(dx), Math.abs(dy), 1)
  const ux = dx / len, uy = dy / len
  const px_ = -uy, py_ = ux
  p.line(Math.round(gx + ux * 5), Math.round(gy + uy * 5), tx, ty, STEEL.lit, 1)
  p.line(Math.round(gx + ux * 5 + px_), Math.round(gy + uy * 5 + py_), Math.round(tx + px_), Math.round(ty + py_), STEEL.mid, 1)
  p.px(tx, ty, STEEL.hi)
  p.px(Math.round(gx + ux * 10), Math.round(gy + uy * 10), STEEL.hi)
  p.r(Math.round(gx + ux * 4) - 1, Math.round(gy + uy * 4) - 1, 3, 3, R_GOLD.sh)  // tsuba
  p.px(Math.round(gx + ux * 4) - 1, Math.round(gy + uy * 4) - 1, R_GOLD.lit)
  for (let i = 0; i <= 4; i++) {                     // wrapped grip
    const x = Math.round(gx + ux * i), y = Math.round(gy + uy * i)
    p.px(x, y, i % 2 ? L_MANE.mid : L_PURP.sh)
    p.px(x, y + 1, L_MANE.sh)
  }
}

function lasswellWest(p, o) {
  const g = rigW(o)
  const sw = (o.hairSw | 0)
  const hx = g.headX, hy = g.headY

  // ---- the mane BACK sheet first — a big black fall clearly EAST of the
  // torso, plus a crest above; half his silhouette.
  const maneBot = g.kneel ? g.hipY + 4 : g.hipY + 10
  for (let y = hy - 10; y <= maneBot; y++) {
    const t = (y - (hy - 10)) / Math.max(1, maneBot - (hy - 10))
    const x0 = hx + 3 + Math.round(t * (6 + sw))
    const w = Math.round(9 + t * 7 - t * t * 4)
    p.h(x0, x0 + w, y, L_MANE.mid)
    p.h(x0 + Math.round(w * 0.4), x0 + w, y, L_MANE.sh)
    if (y % 3 === 0) p.px(x0 + 2, y, L_MANE.lit)     // strand lights
    if (y % 5 === 2) p.px(x0 + w - 1, y, L_MANE.deep)
    if (y % 7 === 3) p.px(x0 + w + 1, y, L_MANE.sh)  // ragged east edge ticks
    if (y % 7 === 5) p.px(x0 + w + 1, y, L_MANE.deep)
  }
  // ragged tips
  p.spikeDown(hx + 12 + sw, maneBot, 3, 6, 2, L_MANE.sh)
  p.spikeDown(hx + 17 + sw, maneBot - 3, 2, 6, 3, L_MANE.deep)
  p.spikeDown(hx + 7 + Math.round(sw * 0.5), maneBot + 1, 2, 5, 0, L_MANE.mid)

  // ---- legs: the WIDEST stance of the four — ballooning hakama
  const drawLeg = (p2, gg, which) => {
    if (which.startsWith('kneel')) {
      const near = which === 'kneelNear'
      const kx = near ? 33 : 47
      p2.r(kx, GY - 4, 14, 4, near ? L_PURP.mid : L_PURP.sh)
      p2.h(kx, kx + 15, GY, L_MANE.sh)
      p2.line(gg.hipX + (near ? -1 : 4), gg.hipY - 2, kx + 3, GY - 5, near ? L_PURP.mid : L_PURP.sh, 5)
      p2.r(kx - 1, GY - 5, 5, 3, near ? L_FUR.lit : L_FUR.mid)   // fur cuff
      p2.px(kx - 1, GY - 5, L_FUR.hi)
      return
    }
    const near = which === 'near'
    const spread = 5 + Math.min(gg.crouch, 3) * 2
    const fx = (near ? 34 - spread : 61 + Math.round(spread * 0.5)) - Math.round(gg.lean * 0.4)
    const cMain = near ? L_PURP.mid : L_PURP.sh
    const cLit = near ? L_PURP.lit : L_PURP.mid
    const hipPx = gg.hipX + (near ? -2 : 5)
    for (let y = gg.hipY; y <= GY - 8; y++) {
      const t = (y - gg.hipY) / Math.max(1, GY - 8 - gg.hipY)
      const cx = Math.round(hipPx + (fx + 1 - hipPx) * t)
      const w = 3 + Math.round(t * 4)                 // balloons downward
      p2.h(cx - w, cx + w, y, cMain)
      p2.h(cx - w, cx - w + 2, y, cLit)
      if (t > 0.5) p2.px(cx + w, y, near ? L_PURP.sh : L_MANE.sh)
    }
    p2.r(fx - 4, GY - 8, 10, 4, near ? L_FUR.lit : L_FUR.mid)    // fur shin cuff
    p2.px(fx - 4, GY - 8, L_FUR.hi)
    p2.px(fx + 5, GY - 6, L_FUR.sh)
    p2.r(fx - 3, GY - 4, 8, 4, near ? L_MANE.lit : L_MANE.mid)   // dark boot
    p2.h(fx - 4, fx + 5, GY, L_MANE.sh)
  }
  legsW(p, g, o, drawLeg)

  // ---- torso: violet kimono, crossed lapel, obi + jade knot
  const ty = g.topY
  torsoRows(p, g, g.hipX - 8, g.hipX + 7, ty, g.hipY - 1, (y, x0, x1) => {
    p.h(x0, x1, y, L_PURP.lit)
    p.h(x1 - 4, x1, y, L_PURP.mid)
    const t = y - ty
    if (t >= 1 && t <= 9) {                          // crossed lapel diagonal
      p.px(x0 + 9 - t, y, L_PURP.sh)
      p.px(x0 + 8 - t, y, L_MANE.sh)
    }
  })
  p.h(g.hipX - 8 + g.shear(ty), g.hipX + 7 + g.shear(ty), ty, L_PURP.hi)
  const obiY = g.hipY - 3
  const obiS = g.shear(obiY)
  p.r(g.hipX - 8 + obiS, obiY, 16, 3, L_OBI.mid)
  p.h(g.hipX - 8 + obiS, g.hipX + 7 + obiS, obiY, L_OBI.lit)
  p.px(g.hipX - 8 + obiS, obiY, L_OBI.hi)
  p.r(g.hipX - 6 + obiS, obiY - 1, 4, 4, L_JADE.mid)             // jade knot
  p.px(g.hipX - 6 + obiS, obiY - 1, L_JADE.lit)
  p.px(g.hipX - 4 + obiS, obiY + 2, L_JADE.sh)

  // ---- arms + katana
  const shX = g.hipX - 2 + g.shear(g.topY + 3), shY = g.topY + 3
  const drawArm = (bx, by) => {
    p.line(shX, shY, bx, by, L_PURP.lit, 3)
    p.line(shX + 1, shY + 1, bx + 1, by + 1, L_PURP.mid, 1)
    p.r(shX - 1, shY - 1, 4, 3, L_PURP.lit)          // kimono shoulder
    p.px(shX - 1, shY - 1, L_PURP.hi)
    p.r(bx - 1, by - 1, 3, 3, R_SKIN.lit)            // bare hand
    p.px(bx, by + 1, R_SKIN.mid)
  }
  if (o.arms === 'limp') {
    if (g.kneel) {
      drawArm(shX - 6, GY - 3)
      p.h(shX - 8, shX - 4, GY - 1, R_SKIN.lit)
    } else {
      drawArm(shX - 2, g.hipY + 5)
    }
    katana(p, g.hipX + 16, GY - 2, g.hipX - 14, GY - 2)
  } else if (o.release) {
    katana(p, g.hipX + 7, g.hipY - 5, g.hipX + 20, g.hipY - 28)
    drawArm(shX - 13, shY)
    p.px(shX - 14, shY - 1, R_SKIN.lit); p.px(shX - 14, shY + 1, R_SKIN.lit)  // seal
  } else if ((o.raise | 0) > 0) {
    katana(p, g.hipX + 7, g.hipY - 5, g.hipX + 20, g.hipY - 28)
    const bx = o.raise === 2 ? shX - 10 : shX - 7
    const by = o.raise === 2 ? shY - 12 : shY - 5
    drawArm(bx, by)
    p.px(bx - 1, by - 2, R_SKIN.lit)                 // two-finger seal up
    p.px(bx - 1, by - 3, R_SKIN.lit)
    o._hand = [bx - 2, by - 5]
  } else if (o.wind) {
    drawArm(shX - 2, g.hipY - 5)
    katana(p, shX - 2, g.hipY - 5, shX + 32, g.hipY - 9)
  } else if (o.strike) {
    drawArm(shX - 12, shY + 5)
    katana(p, shX - 12, shY + 5, shX - 36, shY + 3)
  } else if (o.follow) {
    drawArm(shX - 10, shY - 2)
    katana(p, shX - 10, shY - 2, shX - 30, shY - 16)
  } else if (o.flinch) {
    drawArm(shX + 5, shY - 4)
    katana(p, shX + 6, shY - 5, shX + 28, shY - 12)
  } else if (o.guard) {
    drawArm(shX - 6, g.hipY - 6)
    katana(p, shX - 6, g.hipY - 6, shX + 30, g.hipY - 8)
  } else {
    drawArm(shX - 5, g.hipY - 5)
    katana(p, shX - 5, g.hipY - 5, shX + 28, g.hipY - 7)
  }

  // ---- head: pale face, heavy fringe, mane crown + a front shoulder lock
  p.disc(hx, hy, 13, 12, L_MANE.mid)
  p.disc(hx - 2, hy - 3, 10, 9, L_MANE.lit)
  p.r(hx - 13, hy - 2, 9, 13, R_SKIN.lit)            // face plate
  p.px(hx - 14, hy + 2, R_SKIN.lit)
  p.px(hx - 14, hy + 3, R_SKIN.mid)
  p.h(hx - 13, hx - 6, hy + 10, R_SKIN.mid)
  p.h(hx - 12, hx - 7, hy + 11, R_SKIN.mid)
  // heavy fringe: long licks over brow and cheek
  p.h(hx - 13, hx - 4, hy - 3, L_MANE.sh)
  p.spikeDown(hx - 12, hy - 3, 1, 7, -1, L_MANE.mid)
  p.spikeDown(hx - 9, hy - 3, 2, 6, 0, L_MANE.lit)
  p.spikeDown(hx - 5, hy - 3, 2, 9, 1, L_MANE.mid)   // long cheek lick
  // front shoulder lock falling over the chest (his crop look)
  p.spikeDown(hx - 3, hy + 8, 2, 12, -1, L_MANE.mid)
  p.px(hx - 4, hy + 12, L_MANE.lit)
  // crest: swept up-back + short topknot
  p.spike(hx - 3, hy - 11, 3, 6, -1, L_MANE.lit)
  p.spike(hx + 2, hy - 11, 3, 8, 2, L_MANE.mid)
  p.spike(hx + 7, hy - 8, 3, 7, 3 + Math.round(sw * 0.5), L_MANE.mid)
  p.spike(hx + 11, hy - 4, 2, 6, 4 + sw, L_MANE.sh)
  p.px(hx + 1, hy - 17, L_MANE.lit); p.px(hx + 2, hy - 16, L_MANE.mid)
  p.px(hx - 4, hy - 13, L_MANE.hi); p.px(hx + 1, hy - 14, L_MANE.hi)
  faceW(p, hx - 12, hy + 1, R_SKIN, L_MANE.deep, o)
}

function lasswellSouth(p, o) {
  const b = (o.bob | 0)
  const v = o.vArm | 0
  const cx = 47
  // wide hakama columns
  const legY = 59 + b
  for (const [lx, shade] of [[cx - 10, false], [cx + 2, true]]) {
    const c = shade ? L_PURP.sh : L_PURP.mid
    for (let y = legY; y <= GY - 8; y++) {
      const t = (y - legY) / Math.max(1, GY - 8 - legY)
      const w = 3 + Math.round(t * 2)
      p.h(lx + 4 - w, lx + 4 + w, y, c)
      p.h(lx + 4 - w, lx + 4 - w + 2, y, shade ? L_PURP.mid : L_PURP.lit)
    }
    p.r(lx, GY - 8, 9, 4, shade ? L_FUR.mid : L_FUR.lit)
    p.px(lx, GY - 8, L_FUR.hi)
    p.r(lx + 1, GY - 4, 7, 4, shade ? L_MANE.mid : L_MANE.lit)
    p.h(lx, lx + 8, GY, L_MANE.sh)
  }
  // mane falls both sides
  const hy2 = 27 + b
  p.r(cx - 16, hy2 + 2, 5, 32, L_MANE.mid)
  p.v(cx - 16, hy2 + 4, hy2 + 30, L_MANE.lit)
  p.spikeDown(cx - 14, hy2 + 33, 2, 6, -1, L_MANE.sh)
  p.r(cx + 12, hy2 + 2, 5, 32, L_MANE.sh)
  p.spikeDown(cx + 14, hy2 + 33, 2, 6, 1, L_MANE.deep)
  // torso
  const ty = 43 + b
  p.r(cx - 9, ty, 19, 15, L_PURP.lit)
  p.r(cx + 5, ty + 1, 5, 14, L_PURP.mid)
  p.line(cx + 5, ty + 1, cx - 5, ty + 10, L_PURP.sh, 1)
  p.line(cx - 5, ty + 10, cx - 9, ty + 13, L_MANE.sh, 1)
  p.h(cx - 9, cx + 9, ty, L_PURP.hi)
  p.r(cx - 9, ty + 12, 19, 3, L_OBI.mid)
  p.h(cx - 9, cx + 9, ty + 12, L_OBI.lit)
  p.r(cx - 2, ty + 11, 4, 4, L_JADE.mid)
  p.px(cx - 2, ty + 11, L_JADE.lit)
  // arms
  p.r(cx - 14, ty + 2, 4, 9, L_PURP.lit); p.px(cx - 14, ty + 2, L_PURP.hi)
  p.r(cx - 14, ty + 10, 3, 3, R_SKIN.lit)
  if (v === 0) {
    p.r(cx + 10, ty + 2, 4, 9, L_PURP.mid)
    p.r(cx + 11, ty + 10, 3, 3, R_SKIN.lit)
  } else {
    p.line(cx + 11, ty + 3, cx + 14, ty - 8, L_PURP.mid, 3)
    p.r(cx + 13, ty - 10, 3, 3, R_SKIN.lit)
  }
  // head
  p.disc(cx, hy2, 13, 12, L_MANE.mid)
  p.disc(cx - 2, hy2 - 3, 10, 9, L_MANE.lit)
  p.r(cx - 9, hy2 + 1, 19, 12, R_SKIN.lit)
  p.h(cx - 9, cx + 9, hy2 + 12, R_SKIN.mid)
  p.h(cx - 7, cx + 7, hy2 + 13, R_SKIN.lit)
  p.h(cx - 5, cx + 5, hy2 + 14, R_SKIN.mid)
  p.h(cx - 9, cx + 9, hy2, L_MANE.sh)
  p.spikeDown(cx - 7, hy2, 2, 6, -1, L_MANE.mid)
  p.spikeDown(cx - 2, hy2, 2, 7, 0, L_MANE.lit)
  p.spikeDown(cx + 3, hy2, 2, 6, 1, L_MANE.mid)
  p.spikeDown(cx + 7, hy2, 1, 5, 1, L_MANE.sh)
  p.spike(cx - 7, hy2 - 10, 3, 7, -2, L_MANE.lit)
  p.spike(cx - 1, hy2 - 12, 3, 8, 0, L_MANE.lit)
  p.spike(cx + 5, hy2 - 10, 3, 7, 2, L_MANE.mid)
  p.px(cx, hy2 - 18, L_MANE.lit)
  p.px(cx - 5, hy2 - 14, L_MANE.hi)
  faceS(p, cx, hy2 + 4, R_SKIN, L_MANE.deep, o)
  // katana raised in salute LAST — over the hair
  if (v === 1) katana(p, cx + 14, ty - 11, cx + 17, ty - 32)
  else if (v >= 2) katana(p, cx + 14, ty - 11, cx + 15, ty - 36)
}

// ---------------------------------------------------------------------------
// FINA — white-and-pink archer. West profile, big magenta recurve bow.
// ---------------------------------------------------------------------------

// The bow: a tall magenta crescent bulging west of the grip; string east.
// flex 0 = braced, 1 = full draw (string kinked to the draw hand + arrow).
function finaBow(p, gx, gy, span, flex, drawToX, drawToY) {
  const half = span >> 1
  const bulge = 10 - Math.round(flex * 4)
  for (let dy = -half; dy <= half; dy++) {
    const t = Math.abs(dy) / half
    const x = Math.round(gx - bulge * (1 - t * t))
    const c = dy < -2 ? F_PINK.lit : dy > 2 ? F_PINK.mid : F_PINK.hi
    p.px(x, gy + dy, c)
    p.px(x + 1, gy + dy, F_PINK.mid)
    if (Math.abs(gy + dy - gy) > half - 3) p.px(x + 2, gy + dy, F_PINK.sh)
  }
  // recurve tips flick away from the string
  p.px(gx - 2, gy - half - 1, F_PINK.sh); p.px(gx - 3, gy - half - 2, F_PINK.deep)
  p.px(gx - 2, gy + half + 1, F_PINK.sh); p.px(gx - 3, gy + half + 2, F_PINK.deep)
  p.r(gx - 1, gy - 2, 3, 5, F_WHT.lit)               // wrapped grip
  p.px(gx - 1, gy - 2, F_WHT.hi)
  if (flex > 0 && drawToX !== undefined) {
    p.line(gx, gy - half, drawToX, drawToY, F_WHT.mid, 1)
    p.line(gx, gy + half, drawToX, drawToY, F_WHT.mid, 1)
    p.line(drawToX, drawToY, gx - bulge - 5, gy, F_HAIR.hi, 1)   // light arrow
    p.px(gx - bulge - 6, gy, GLOW.fina[0])
    p.px(gx - bulge - 7, gy, GLOW.fina[1])
  } else {
    p.line(gx, gy - half, gx, gy + half, F_WHT.sh, 1)
  }
}

function finaWest(p, o) {
  const g = rigW(o)
  const sw = (o.hairSw | 0)
  const hx = g.headX, hy = g.headY

  // ---- long back falls first: two soft blonde sheets clearly east
  const fall = g.kneel ? g.hipY : g.hipY + 6
  for (let y = hy - 6; y <= fall; y++) {
    const t = (y - (hy - 6)) / Math.max(1, fall - (hy - 6))
    const x0 = hx + 5 + Math.round(t * (3 + sw * 0.6))
    const w = Math.round(8 - t * 3)
    p.h(x0, x0 + w, y, F_HAIR.mid)
    p.px(x0 + w, y, F_HAIR.sh)
    if (y % 4 === 1) p.px(x0 + 1, y, F_HAIR.lit)
  }
  p.spikeDown(hx + 9 + Math.round(sw * 0.5), fall, 3, 5, 1, F_HAIR.sh)
  p.spikeDown(hx + 5, fall + 1, 2, 4, 0, F_HAIR.mid)

  // ---- legs: white socks + pink boots, thicker than round 1
  const drawLeg = (p2, gg, which) => {
    if (which.startsWith('kneel')) {
      const near = which === 'kneelNear'
      const kx = near ? 35 : 49
      p2.r(kx, GY - 4, 12, 4, near ? F_BOOT.lit : F_BOOT.mid)
      p2.h(kx, kx + 12, GY, F_BOOT.sh)
      p2.line(gg.hipX + (near ? -1 : 4), gg.hipY - 2, kx + 3, GY - 5, near ? F_WHT.lit : F_WHT.mid, 4)
      return
    }
    const near = which === 'near'
    const spread = 2 + gg.crouch
    const fx = (near ? 38 - spread : 56 + Math.round(spread * 0.4)) - Math.round(gg.lean * 0.4)
    const sock = near ? F_WHT.lit : F_WHT.mid
    const hipPx = gg.hipX + (near ? -2 : 4)
    for (let y = gg.hipY; y <= GY - 6; y++) {
      const t = (y - gg.hipY) / Math.max(1, GY - 6 - gg.hipY)
      const cx = Math.round(hipPx + (fx + 1 - hipPx) * t * t)
      p2.h(cx - 2, cx + 1, y, sock)
      p2.px(cx + 1, y, near ? F_WHT.mid : F_WHT.sh)
    }
    bootW(p2, fx, GY, near ? F_BOOT : { hi: F_BOOT.lit, lit: F_BOOT.mid, mid: F_BOOT.sh, sh: F_BOOT.sh }, 6)
    p2.h(fx - 2, fx + 4, GY - 6, F_WHT.lit)          // pale boot cuff
  }
  legsW(p, g, o, drawLeg)

  // ---- violet pleated skirt: a real flare at the hips
  const skTop = g.hipY - 4
  const skBot = g.kneel ? g.hipY + 2 : g.hipY + 7
  const sway2 = Math.round(sw * 0.4)
  for (let y = skTop; y <= skBot; y++) {
    const t = (y - skTop) / Math.max(1, skBot - skTop)
    const s = g.shear(y)
    const back = g.hipX + 6 + Math.round(t * 5) + Math.max(0, sway2) + s
    const front = g.hipX - 8 - Math.round(t * 4) + Math.min(0, sway2) + s
    p.h(front, back, y, F_VIO.lit)
    p.h(front + Math.round((back - front) * 0.5), back, y, F_VIO.mid)
  }
  for (let i = 0; i < 5; i++) {                      // pleat cuts
    const x = g.hipX - 8 + i * 4 + sway2
    p.v(x, skTop + 2, skBot, F_VIO.sh)
  }
  p.h(g.hipX - 10 + Math.min(0, sway2), g.hipX + 9 + Math.max(0, sway2), skBot + 1, F_VIO.sh)

  // ---- torso: white bodice + gold waist trim + pink chest knot
  const ty = g.topY + 1                               // petite: shorter torso
  torsoRows(p, g, g.hipX - 6, g.hipX + 5, ty, g.hipY - 2, (y, x0, x1) => {
    p.h(x0, x1, y, F_WHT.lit)
    p.h(x1 - 3, x1, y, F_WHT.mid)
  })
  p.h(g.hipX - 6 + g.shear(g.hipY - 4), g.hipX + 5 + g.shear(g.hipY - 4), g.hipY - 4, R_GOLD.mid)
  p.px(g.hipX - 6 + g.shear(g.hipY - 4), g.hipY - 4, R_GOLD.hi)
  p.h(g.hipX - 6 + g.shear(ty), g.hipX + 5 + g.shear(ty), ty, F_WHT.hi)
  p.r(g.hipX - 6 + g.shear(ty + 3), ty + 3, 3, 3, F_PINK.lit)    // chest knot
  p.px(g.hipX - 6 + g.shear(ty + 3), ty + 3, F_PINK.hi)
  p.px(g.hipX - 5 + g.shear(ty + 6), ty + 6, F_PINK.mid)

  // ---- arms + bow (bare arms, white puff at the shoulder)
  const shX = g.hipX - 2 + g.shear(g.topY + 4), shY = g.topY + 4
  const drawArm = (bx, by) => {
    p.line(shX, shY, bx, by, R_SKIN.lit, 2)
    p.r(shX - 1, shY - 2, 4, 3, F_WHT.lit)           // puff sleeve
    p.px(shX - 1, shY - 2, F_WHT.hi)
    p.px(bx, by - 1, F_WHT.lit)                      // cuff
    p.r(bx - 1, by, 3, 3, R_SKIN.lit)                // hand
  }
  if (o.arms === 'limp') {
    if (g.kneel) {
      drawArm(shX - 5, GY - 3)
      p.h(shX - 7, shX - 3, GY - 1, R_SKIN.lit)
    } else {
      drawArm(shX - 2, g.hipY + 4)
    }
    // fallen bow lying FLAT on the floor: a low horizontal crescent
    for (let dx = -11; dx <= 11; dx++) {
      const t = Math.abs(dx) / 11
      const y = GY - 1 - Math.round(3 * (1 - t * t))
      p.px(g.hipX - 16 + dx, y, dx < -2 ? F_PINK.mid : dx > 2 ? F_PINK.sh : F_PINK.lit)
      p.px(g.hipX - 16 + dx, y + 1, F_PINK.sh)
    }
    p.h(g.hipX - 27, g.hipX - 5, GY - 1, F_WHT.sh)   // slack string on the ground
    p.r(g.hipX - 17, GY - 3, 3, 2, F_WHT.lit)        // grip
  } else if (o.release) {
    drawArm(shX - 12, shY - 5)
    p.px(shX - 13, shY - 6, R_SKIN.lit)
    finaBow(p, g.hipX + 9, g.hipY - 22, 24, 0)       // rested aside
  } else if ((o.raise | 0) > 0) {
    finaBow(p, g.hipX + 9, g.hipY - 22, 24, 0)
    const bx = o.raise === 2 ? shX - 10 : shX - 7
    const by = o.raise === 2 ? shY - 12 : shY - 5
    drawArm(bx, by)
    p.px(bx - 2, by - 1, R_SKIN.lit)                 // cupped hands
    p.px(bx + 1, by - 2, R_SKIN.lit)
    o._hand = [bx - 2, by - 5]
  } else if (o.wind) {
    // full draw: bow arm long west, draw hand at the cheek
    drawArm(shX - 17, shY + 2)
    finaBow(p, shX - 17, shY + 2, 34, 1, shX - 3, shY + 1)
    p.r(shX - 4, shY, 3, 3, R_SKIN.lit)
  } else if (o.strike) {
    drawArm(shX - 18, shY + 2)
    finaBow(p, shX - 18, shY + 2, 34, 0)
    p.px(shX - 5, shY + 5, R_SKIN.lit)               // recoiled draw hand
  } else if (o.follow) {
    drawArm(shX - 13, shY + 10)
    finaBow(p, shX - 13, shY + 11, 28, 0)
  } else if (o.flinch) {
    drawArm(shX + 4, shY - 4)
    finaBow(p, shX + 7, shY - 7, 24, 0)
  } else if (o.guard) {
    drawArm(shX - 14, shY + 3)
    finaBow(p, shX - 14, shY + 3, 30, 0)
    p.r(shX - 6, shY + 2, 3, 3, R_SKIN.lit)          // string hand
  } else {
    drawArm(shX - 11, g.hipY - 5)
    finaBow(p, shX - 13, g.hipY - 3, 26, 0)
  }

  // ---- head: soft rounded bob + side fall + red flower
  p.disc(hx, hy, 14, 12, F_HAIR.lit)
  p.disc(hx + 4, hy + 2, 10, 9, F_HAIR.mid)
  p.disc(hx - 3, hy - 2, 10, 9, F_HAIR.lit)
  p.r(hx - 13, hy - 2, 10, 13, R_SKIN.lit)           // face
  p.px(hx - 14, hy + 2, R_SKIN.lit)
  p.px(hx - 14, hy + 3, R_SKIN.mid)
  p.h(hx - 13, hx - 6, hy + 10, R_SKIN.mid)
  p.h(hx - 12, hx - 7, hy + 11, R_SKIN.mid)
  // rounded scalloped fringe (no spikes — the anti-Rain)
  p.h(hx - 13, hx - 3, hy - 3, F_HAIR.mid)
  p.disc(hx - 10, hy - 4, 3, 2, F_HAIR.lit)
  p.disc(hx - 5, hy - 5, 3, 2, F_HAIR.lit)
  p.px(hx - 12, hy - 1, F_HAIR.mid)
  p.spikeDown(hx - 12, hy - 2, 1, 5, 0, F_HAIR.mid)  // cheek strand
  // crown dome + sheen + side fall over the ear
  p.disc(hx + 2, hy - 7, 9, 4, F_HAIR.lit)
  p.h(hx - 6, hx + 7, hy - 11, F_HAIR.hi)            // sheen band
  p.r(hx + 7, hy - 3, 4, 11, F_HAIR.mid)             // side fall
  p.px(hx + 10, hy + 7, F_HAIR.sh)
  p.spikeDown(hx + 8, hy + 8, 2, 4, 0, F_HAIR.sh)
  // red flower on the west temple — her tell
  p.r(hx - 9, hy - 8, 4, 4, F_PINK.lit)
  p.px(hx - 9, hy - 8, F_PINK.hi)
  p.px(hx - 6, hy - 5, F_PINK.mid)
  p.px(hx - 10, hy - 6, F_PINK.deep)
  p.px(hx - 7, hy - 9, F_PINK.mid)
  faceW(p, hx - 12, hy + 1, R_SKIN, F_HAIR.deep, o)
}

function finaSouth(p, o) {
  const b = (o.bob | 0)
  const v = o.vArm | 0
  const cx = 47
  // legs
  const legY = 61 + b
  for (const [lx, shade] of [[cx - 6, false], [cx + 2, true]]) {
    p.r(lx, legY, 4, GY - 5 - legY, shade ? F_WHT.mid : F_WHT.lit)
    bootS(p, lx + 1, GY, shade ? { hi: F_BOOT.lit, lit: F_BOOT.mid, mid: F_BOOT.sh, sh: F_BOOT.sh } : F_BOOT, 5)
  }
  // skirt
  const hy = 56 + b
  for (let j = 0; j < 7; j++) {
    const w = 8 + (j >> 1)
    p.h(cx - w, cx + w, hy + j, F_VIO.lit)
    p.h(cx + 1, cx + w, hy + j, F_VIO.mid)
  }
  for (let i = -2; i <= 2; i++) p.v(cx + i * 4, hy + 2, hy + 6, F_VIO.sh)
  p.h(cx - 10, cx + 10, hy + 7, F_VIO.sh)
  // torso
  const ty = 44 + b
  p.r(cx - 8, ty, 17, 13, F_WHT.lit)
  p.r(cx + 4, ty + 1, 5, 12, F_WHT.mid)
  p.h(cx - 8, cx + 8, ty + 11, R_GOLD.mid)
  p.px(cx - 8, ty + 11, R_GOLD.hi)
  p.h(cx - 8, cx + 8, ty, F_WHT.hi)
  p.r(cx - 2, ty + 2, 4, 3, F_PINK.lit)
  p.px(cx - 2, ty + 2, F_PINK.hi)
  p.px(cx - 3, ty + 4, F_PINK.mid); p.px(cx + 2, ty + 4, F_PINK.mid)
  // arms: west arm reaches to the side-held bow on v≥1, far arm waves up
  if (v === 0) {
    p.line(cx - 10, ty + 3, cx - 12, ty + 11, R_SKIN.lit, 2)
    p.line(cx + 10, ty + 3, cx + 12, ty + 11, R_SKIN.mid, 2)
    p.r(cx - 11, ty + 1, 4, 3, F_WHT.lit)
    p.r(cx + 8, ty + 1, 4, 3, F_WHT.mid)
  } else {
    p.line(cx - 10, ty + 3, cx - 17, ty + (v === 2 ? -4 : 0), R_SKIN.lit, 2)
    p.line(cx + 10, ty + 3, cx + 13, ty - 7, R_SKIN.mid, 2)
    p.px(cx + 14, ty - 8, R_SKIN.lit)                // waving hand
    p.px(cx + 13, ty - 9, R_SKIN.lit)
    p.r(cx - 11, ty + 1, 4, 3, F_WHT.lit)
    p.r(cx + 8, ty + 1, 4, 3, F_WHT.mid)
  }
  // head
  const hy2 = 28 + b
  p.disc(cx, hy2, 14, 12, F_HAIR.lit)
  p.disc(cx + 4, hy2 + 2, 10, 9, F_HAIR.mid)
  p.disc(cx - 2, hy2 - 2, 11, 9, F_HAIR.lit)
  p.r(cx - 9, hy2 + 1, 19, 12, R_SKIN.lit)
  p.h(cx - 9, cx + 9, hy2 + 12, R_SKIN.mid)
  p.h(cx - 7, cx + 7, hy2 + 13, R_SKIN.lit)
  p.h(cx - 5, cx + 5, hy2 + 14, R_SKIN.mid)
  p.h(cx - 9, cx + 9, hy2, F_HAIR.mid)
  p.disc(cx - 5, hy2 - 1, 3, 2, F_HAIR.lit)
  p.disc(cx, hy2 - 2, 3, 2, F_HAIR.lit)
  p.disc(cx + 5, hy2 - 1, 3, 2, F_HAIR.lit)
  p.h(cx - 6, cx + 6, hy2 - 10, F_HAIR.hi)
  p.r(cx - 16, hy2, 5, 14, F_HAIR.mid)               // side falls
  p.r(cx + 12, hy2, 5, 14, F_HAIR.mid)
  p.v(cx - 16, hy2 + 2, hy2 + 12, F_HAIR.lit)
  p.spikeDown(cx - 14, hy2 + 14, 2, 5, 0, F_HAIR.sh)
  p.spikeDown(cx + 14, hy2 + 14, 2, 5, 0, F_HAIR.sh)
  p.r(cx - 11, hy2 - 7, 4, 4, F_PINK.lit)            // flower
  p.px(cx - 11, hy2 - 7, F_PINK.hi)
  p.px(cx - 8, hy2 - 4, F_PINK.mid)
  faceS(p, cx, hy2 + 4, R_SKIN, F_HAIR.deep, o)
  // the bow held out at arm's length to her side LAST — the signature
  // crescent stays clear of the face and reads in silhouette
  if (v >= 1) {
    const gx = cx - 19, gy = ty + (v === 2 ? -6 : -2)
    const half = 12
    for (let dy = -half; dy <= half; dy++) {
      const t = Math.abs(dy) / half
      const x = Math.round(gx - 9 * (1 - t * t))
      p.px(x, gy + dy, dy < -2 ? F_PINK.lit : dy > 2 ? F_PINK.mid : F_PINK.hi)
      p.px(x + 1, gy + dy, F_PINK.mid)
    }
    p.px(gx - 2, gy - half - 1, F_PINK.sh); p.px(gx - 2, gy + half + 1, F_PINK.sh)
    p.line(gx, gy - half, gx, gy + half, F_WHT.sh, 1)
    p.r(gx - 1, gy - 2, 3, 5, F_WHT.lit)             // grip
    p.px(gx - 1, gy - 2, F_WHT.hi)
  }
}

// ---------------------------------------------------------------------------
// LID — redhead engineer. West profile, goggles, shouldered open-jaw wrench.
// ---------------------------------------------------------------------------

// Big steel wrench: 2 px handle + a head with a REAL open jaw — two chunky
// parallel prongs around a carved slot, the jaw pointing away from the handle.
function wrench(p, hx0, hy0, tx, ty) {
  const dx = hx0 - tx, dy = hy0 - ty
  const len = Math.max(Math.abs(dx), Math.abs(dy), 1)
  const ux = dx / len, uy = dy / len                  // handle → head dir
  const sx = Math.abs(ux) > 0.4 ? Math.sign(ux) : 0   // step dir for the jaw
  const sy = Math.abs(uy) > 0.4 ? Math.sign(uy) : 0
  p.line(tx, ty, hx0, hy0, STEEL.mid, 2)              // handle
  p.line(tx, ty, Math.round((tx + hx0) / 2), Math.round((ty + hy0) / 2), STEEL.lit, 1)
  p.px(tx, ty, STEEL.sh)                              // butt
  p.px(tx + 1, ty, R_GOLD.sh)                         // hanging ring hint
  const cx = hx0 + sx, cy = hy0 + sy                  // head root
  const jx = sx || (sy === 0 ? -1 : 0), jy = sy       // jaw axis (default west)
  const pxd = -jy, pyd = jx                           // perpendicular
  // rounded base
  p.disc(cx, cy, 4, 4, STEEL.lit)
  p.disc(cx + 1, cy + 1, 3, 3, STEEL.mid)
  p.px(cx - 2, cy - 2, STEEL.hi)
  // two chunky prongs extending past the base along the jaw axis
  for (let t = 0; t <= 7; t++) {
    for (const s of [-1, 1]) {
      const bx = cx + jx * t + pxd * s * 2, by = cy + jy * t + pyd * s * 2
      p.px(bx, by, t < 3 ? STEEL.lit : STEEL.mid)
      p.px(bx + pxd * s, by + pyd * s, STEEL.mid)     // outer thickness
    }
  }
  // carve the slot clean between the prongs
  for (let t = 2; t <= 8; t++) {
    p.cut(cx + jx * t, cy + jy * t)
    p.cut(cx + jx * t + pxd, cy + jy * t + pyd)
    p.cut(cx + jx * t - pxd, cy + jy * t - pyd)
  }
  // prong tips + specular
  p.px(cx + jx * 7 + pxd * 2, cy + jy * 7 + pyd * 2, STEEL.hi)
  p.px(cx + jx * 7 - pxd * 2, cy + jy * 7 - pyd * 2, STEEL.lit)
  p.px(cx + jx * 2 + pxd * 3, cy + jy * 2 + pyd * 3, STEEL.hi)
}

function lidWest(p, o) {
  const g = rigW(o)
  const sw = (o.hairSw | 0)
  const hx = g.headX, hy = g.headY

  // ---- ponytail burst BEHIND first: a clearly separate spray up-east
  const pbx = hx + 11, pby = hy - 8
  p.disc(pbx + 2 + Math.round(sw * 0.5), pby - 1, 6, 6, D_HAIR.mid)
  p.spike(pbx + Math.round(sw * 0.6), pby + 3, 4, 14, 4 + sw, D_HAIR.lit)
  p.spike(pbx + 4 + sw, pby + 3, 3, 11, 7 + sw, D_HAIR.mid)
  p.spike(pbx - 2, pby + 1, 3, 10, -1 + Math.round(sw * 0.4), D_HAIR.lit)
  p.spike(pbx + 2, pby + 2, 2, 12, 1 + Math.round(sw * 0.5), D_HAIR.hi === D_HAIR.lit ? D_HAIR.lit : D_HAIR.mid)
  p.spikeDown(pbx + 6 + sw, pby + 3, 3, 11, 4, D_HAIR.sh)      // falling lick
  p.px(pbx + 1, pby - 9, D_HAIR.hi); p.px(pbx + 6 + sw, pby - 6, D_HAIR.hi)

  // ---- legs: baggy knickers to the knee, bare shin, rust boots + green sock
  const drawLeg = (p2, gg, which) => {
    if (which.startsWith('kneel')) {
      const near = which === 'kneelNear'
      const kx = near ? 35 : 49
      p2.r(kx, GY - 4, 12, 4, near ? D_BOOT.lit : D_BOOT.mid)
      p2.h(kx, kx + 12, GY, D_BOOT.sh)
      p2.line(gg.hipX + (near ? -1 : 4), gg.hipY - 2, kx + 3, GY - 5, near ? D_SLATE.lit : D_SLATE.mid, 5)
      return
    }
    const near = which === 'near'
    const spread = 3 + gg.crouch
    const fx = (near ? 36 - spread : 57 + Math.round(spread * 0.4)) - Math.round(gg.lean * 0.4)
    const knee = GY - 13
    const cMain = near ? D_SLATE.lit : D_SLATE.mid
    const hipPx = gg.hipX + (near ? -2 : 5)
    for (let y = gg.hipY; y <= knee; y++) {          // ballooning knicker
      const t = (y - gg.hipY) / Math.max(1, knee - gg.hipY)
      const cx = Math.round(hipPx + (fx + 1 - hipPx) * t * t)
      const w = 3 + Math.round(t * 2.4)
      p2.h(cx - w, cx + w, y, cMain)
      p2.px(cx - w, y, near ? D_SLATE.hi : D_SLATE.lit)
      if (t > 0.5) p2.px(cx + w, y, D_SLATE.sh)
    }
    p2.h(fx - 3, fx + 4, knee + 1, D_SLATE.sh)        // gathered cuff
    p2.r(fx - 1, knee + 2, 4, 2, D_GOGG.mid)          // green sock top
    p2.px(fx - 1, knee + 2, D_GOGG.lit)
    for (let y = knee + 4; y <= GY - 6; y++) p2.h(fx - 1, fx + 1, y, near ? R_SKIN.mid : R_SKIN.sh)
    bootW(p2, fx, GY, near ? D_BOOT : { hi: D_BOOT.lit, lit: D_BOOT.mid, mid: D_BOOT.sh, sh: D_BOOT.sh })
  }
  legsW(p, g, o, drawLeg)

  // ---- torso: mustard jacket, chest strap, belt with pouches
  const ty = g.topY
  torsoRows(p, g, g.hipX - 7, g.hipX + 6, ty, g.hipY - 1, (y, x0, x1) => {
    p.h(x0, x1, y, D_AMB.lit)
    p.h(x1 - 4, x1, y, D_AMB.mid)
    const t = y - ty
    if (t >= 1 && t <= 9) p.px(x0 + 10 - t, y, D_STRAP.mid)      // chest strap
  })
  p.px(g.hipX - 1 + g.shear(ty + 5), ty + 5, D_STRAP.hi)          // strap stud
  p.h(g.hipX - 7 + g.shear(ty), g.hipX + 5 + g.shear(ty), ty, D_AMB.hi)
  const beltY = g.hipY - 3
  const beltS = g.shear(beltY)
  p.r(g.hipX - 7 + beltS, beltY, 14, 2, D_STRAP.mid)
  p.h(g.hipX - 7 + beltS, g.hipX + 6 + beltS, beltY + 1, D_STRAP.sh)
  p.r(g.hipX - 7 + beltS, beltY - 2, 4, 5, D_STRAP.lit)           // front pouch
  p.px(g.hipX - 7 + beltS, beltY - 2, D_STRAP.hi)
  p.h(g.hipX - 6 + beltS, g.hipX - 5 + beltS, beltY, R_GOLD.lit)  // clasp
  p.r(g.hipX + 3 + beltS, beltY - 2, 4, 5, D_STRAP.mid)           // rear pouch
  p.px(g.hipX + 3 + beltS, beltY - 2, D_STRAP.lit)

  // ---- arms + wrench per beat (amber sleeves, brown work gloves)
  const shX = g.hipX - 2 + g.shear(ty + 3), shY = ty + 3
  const drawArm = (bx, by) => {
    p.line(shX, shY, bx, by, D_AMB.lit, 3)
    p.line(shX + 1, shY + 1, bx + 1, by + 1, D_AMB.mid, 1)
    p.r(shX - 1, shY - 1, 4, 3, D_AMB.lit)           // shoulder cap
    p.px(shX - 1, shY - 1, D_AMB.hi)
    p.r(bx - 1, by - 1, 4, 4, D_STRAP.lit)           // work glove
    p.px(bx + 1, by + 2, D_STRAP.sh)
    p.px(bx - 1, by - 1, D_STRAP.hi)
  }
  if (o.arms === 'limp') {
    if (g.kneel) {
      drawArm(shX - 6, GY - 3)
      p.h(shX - 8, shX - 4, GY - 1, D_STRAP.lit)
    } else {
      drawArm(shX - 2, g.hipY + 5)
    }
    wrench(p, g.hipX - 16, GY - 5, g.hipX + 8, GY - 3)  // dropped
  } else if (o.release) {
    wrench(p, g.hipX + 11, g.hipY - 24, g.hipX + 7, g.hipY - 6)   // parked
    drawArm(shX - 13, shY + 1)
    p.px(shX - 14, shY + 1, D_STRAP.lit)
  } else if ((o.raise | 0) > 0) {
    wrench(p, g.hipX + 11, g.hipY - 24, g.hipX + 7, g.hipY - 6)
    const bx = o.raise === 2 ? shX - 10 : shX - 7
    const by = o.raise === 2 ? shY - 12 : shY - 5
    drawArm(bx, by)
    o._hand = [bx - 2, by - 5]
  } else if (o.wind) {
    drawArm(shX + 5, shY - 7)
    wrench(p, shX + 22, shY - 22, shX + 6, shY - 8)
  } else if (o.strike) {
    drawArm(shX - 10, shY + 7)
    wrench(p, shX - 28, GY - 16, shX - 11, shY + 8)
  } else if (o.follow) {
    drawArm(shX - 9, g.hipY + 1)
    wrench(p, shX - 26, GY - 13, shX - 10, g.hipY + 2)
  } else if (o.flinch) {
    drawArm(shX + 6, shY - 3)
    wrench(p, shX + 24, shY - 14, shX + 7, shY - 4)
  } else if (o.guard) {
    drawArm(shX - 8, shY + 9)
    wrench(p, shX - 20, shY + 2, shX - 7, shY + 10)
  } else {
    drawArm(shX + 3, shY - 3)
    wrench(p, shX + 18, shY - 16, shX + 4, shY - 4)
  }

  // ---- head: round skull, goggles on the brow, short fringe, tie knot
  p.disc(hx, hy, 13, 12, D_HAIR.lit)
  p.disc(hx + 4, hy + 2, 10, 9, D_HAIR.mid)
  p.disc(hx - 3, hy - 1, 10, 9, D_HAIR.lit)
  p.r(hx - 13, hy - 2, 10, 13, R_SKIN.lit)           // face
  p.px(hx - 14, hy + 2, R_SKIN.lit)
  p.px(hx - 14, hy + 3, R_SKIN.mid)
  p.h(hx - 13, hx - 6, hy + 10, R_SKIN.mid)
  p.h(hx - 12, hx - 7, hy + 11, R_SKIN.mid)
  // short jagged fringe under the band
  p.h(hx - 13, hx - 4, hy - 3, D_HAIR.deep)
  p.spikeDown(hx - 12, hy - 3, 2, 5, -1, D_HAIR.mid)
  p.spikeDown(hx - 8, hy - 3, 2, 4, 0, D_HAIR.lit)
  p.spikeDown(hx - 5, hy - 3, 1, 4, 1, D_HAIR.mid)
  // goggle band + big west lens with green glass + second lens peeking
  p.h(hx - 13, hx + 9, hy - 6, D_STRAP.mid)
  p.h(hx - 13, hx + 9, hy - 5, D_STRAP.sh)
  p.ring(hx - 8, hy - 7, 4, D_STRAP.sh)              // lens rim
  p.disc(hx - 8, hy - 7, 3, 3, D_GOGG.mid)
  p.disc(hx - 9, hy - 8, 2, 2, D_GOGG.lit)
  p.px(hx - 10, hy - 9, D_GOGG.hi)
  p.disc(hx - 1, hy - 8, 2, 2, D_GOGG.mid)           // far lens sliver
  p.px(hx - 2, hy - 9, D_GOGG.lit)
  // crown spikes above the band + the tie knot east
  p.spike(hx - 4, hy - 10, 3, 6, -1, D_HAIR.lit)
  p.spike(hx + 1, hy - 10, 3, 6, 2, D_HAIR.lit)
  p.spike(hx + 6, hy - 8, 2, 5, 3, D_HAIR.mid)
  p.r(hx + 8, hy - 8, 3, 4, D_STRAP.lit)             // hair tie
  p.px(hx + 8, hy - 8, D_STRAP.hi)
  p.px(hx - 6, hy - 12, D_HAIR.hi)
  faceW(p, hx - 12, hy + 1, R_SKIN, D_HAIR.deep, o)
}

function lidSouth(p, o) {
  const b = (o.bob | 0)
  const v = o.vArm | 0
  const cx = 47
  // ponytail peeking over the crown from behind
  const hy2 = 28 + b
  p.disc(cx + 10, hy2 - 10, 6, 5, D_HAIR.mid)
  p.spike(cx + 12, hy2 - 12, 3, 8, 4, D_HAIR.lit)
  p.spike(cx + 8, hy2 - 13, 2, 6, 1, D_HAIR.mid)
  // legs
  const legY = 60 + b
  const knee = GY - 13
  for (const [lx, shade] of [[cx - 8, false], [cx + 2, true]]) {
    const c = shade ? D_SLATE.mid : D_SLATE.lit
    for (let y = legY; y <= knee; y++) {
      const t = (y - legY) / Math.max(1, knee - legY)
      const w = 2 + Math.round(t * 2)
      p.h(lx + 3 - w, lx + 3 + w, y, c)
      p.px(lx + 3 - w, y, shade ? D_SLATE.lit : D_SLATE.hi)
    }
    p.h(lx - 1, lx + 6, knee + 1, D_SLATE.sh)
    p.r(lx + 1, knee + 2, 4, 2, D_GOGG.mid)
    p.r(lx + 1, knee + 4, 4, GY - 4 - (knee + 4), shade ? R_SKIN.sh : R_SKIN.mid)
    bootS(p, lx + 3, GY, shade ? { hi: D_BOOT.lit, lit: D_BOOT.mid, mid: D_BOOT.sh, sh: D_BOOT.sh } : D_BOOT)
  }
  // torso: jacket + X strap + belt pouches
  const ty = 44 + b
  p.r(cx - 8, ty, 17, 15, D_AMB.lit)
  p.r(cx + 4, ty + 1, 5, 14, D_AMB.mid)
  p.h(cx - 8, cx + 8, ty, D_AMB.hi)
  p.line(cx - 7, ty + 1, cx + 7, ty + 10, D_STRAP.mid, 2)
  p.line(cx + 7, ty + 1, cx - 7, ty + 10, D_STRAP.mid, 2)
  p.px(cx, ty + 5, D_STRAP.hi)
  p.h(cx - 8, cx + 8, ty + 12, D_STRAP.mid)
  p.h(cx - 8, cx + 8, ty + 13, D_STRAP.sh)
  p.r(cx - 7, ty + 11, 4, 4, D_STRAP.lit)
  p.r(cx + 4, ty + 11, 4, 4, D_STRAP.mid)
  p.px(cx - 1, ty + 12, R_GOLD.lit)
  // arms
  if (v === 0) {
    p.r(cx - 12, ty + 2, 4, 8, D_AMB.lit); p.px(cx - 12, ty + 2, D_AMB.hi)
    p.r(cx - 12, ty + 9, 4, 4, D_STRAP.lit)
    p.r(cx + 9, ty + 2, 4, 8, D_AMB.mid)
    p.r(cx + 9, ty + 9, 4, 4, D_STRAP.lit)
  } else {
    p.line(cx - 10, ty + 2, cx - 6, ty - 9, D_AMB.lit, 3)
    p.line(cx + 10, ty + 2, cx + 6, ty - 9, D_AMB.mid, 3)
    p.r(cx - 7, ty - 12, 4, 4, D_STRAP.lit)          // fists right under the bar
    p.r(cx + 4, ty - 12, 4, 4, D_STRAP.lit)
  }
  // head
  p.disc(cx, hy2, 13, 12, D_HAIR.lit)
  p.disc(cx + 4, hy2 + 2, 10, 9, D_HAIR.mid)
  p.disc(cx - 2, hy2 - 1, 10, 9, D_HAIR.lit)
  p.r(cx - 9, hy2 + 1, 19, 12, R_SKIN.lit)
  p.h(cx - 9, cx + 9, hy2 + 12, R_SKIN.mid)
  p.h(cx - 7, cx + 7, hy2 + 13, R_SKIN.lit)
  p.h(cx - 5, cx + 5, hy2 + 14, R_SKIN.mid)
  p.h(cx - 9, cx + 9, hy2, D_HAIR.deep)
  p.spikeDown(cx - 7, hy2, 2, 4, -1, D_HAIR.mid)
  p.spikeDown(cx - 2, hy2, 2, 3, 0, D_HAIR.lit)
  p.spikeDown(cx + 3, hy2, 2, 4, 1, D_HAIR.mid)
  // goggles: band + two green lenses
  p.h(cx - 10, cx + 10, hy2 - 4, D_STRAP.mid)
  p.h(cx - 10, cx + 10, hy2 - 3, D_STRAP.sh)
  p.ring(cx - 4, hy2 - 6, 4, D_STRAP.sh)
  p.disc(cx - 4, hy2 - 6, 3, 3, D_GOGG.mid)
  p.disc(cx - 5, hy2 - 7, 2, 2, D_GOGG.lit)
  p.px(cx - 6, hy2 - 8, D_GOGG.hi)
  p.ring(cx + 4, hy2 - 6, 4, D_STRAP.sh)
  p.disc(cx + 4, hy2 - 6, 3, 3, D_GOGG.mid)
  p.disc(cx + 3, hy2 - 7, 2, 2, D_GOGG.lit)
  p.px(cx + 2, hy2 - 8, D_GOGG.hi)
  p.spike(cx - 9, hy2 - 9, 2, 5, -2, D_HAIR.lit)
  p.spike(cx + 9, hy2 - 9, 2, 5, 2, D_HAIR.mid)
  faceS(p, cx, hy2 + 4, R_SKIN, D_HAIR.deep, o)
  // wrench hoisted overhead LAST — over the hair
  if (v >= 1) {
    const wy = ty - 14 - (v === 2 ? 2 : 0)
    p.line(cx - 11, wy, cx + 9, wy, STEEL.mid, 2)
    p.line(cx - 11, wy, cx - 1, wy, STEEL.lit, 1)
    p.disc(cx + 13, wy, 5, 5, STEEL.lit)
    p.disc(cx + 14, wy + 1, 4, 4, STEEL.mid)
    p.px(cx + 11, wy - 2, STEEL.hi)
    for (let t = 0; t <= 7; t++) for (let w = -1; w <= 1; w++) p.cut(cx + 13 + t, wy + w)
    p.px(cx + 17, wy - 2, STEEL.hi)
    p.px(cx + 17, wy + 2, STEEL.lit)
  }
}

// ---------------------------------------------------------------------------
// Character registry
// ---------------------------------------------------------------------------

const CHARS = {
  rain: {
    name: 'Rain', west: rainWest, south: rainSouth,
    speckleRamp: R_HAIR, speckleN: 3, glow: GLOW.rain,
    smearColour: STEEL.lit, bodyPx: 84,
  },
  lasswell: {
    name: 'Lasswell', west: lasswellWest, south: lasswellSouth,
    speckleRamp: L_PURP, speckleN: 3, glow: GLOW.lasswell,
    smearColour: STEEL.lit, bodyPx: 84,
  },
  fina: {
    name: 'Fina', west: finaWest, south: finaSouth,
    speckleRamp: F_HAIR, speckleN: 3, glow: GLOW.fina,
    smearColour: F_PINK.hi, bodyPx: 83,
  },
  lid: {
    name: 'Lid', west: lidWest, south: lidSouth,
    speckleRamp: D_HAIR, speckleN: 4, glow: GLOW.lid,
    smearColour: STEEL.lit, bodyPx: 84,
  },
}

// ---------------------------------------------------------------------------
// Sheet assembly
// ---------------------------------------------------------------------------

function buildCell(p, ch, facing, o, rng) {
  p.clear()
  o._hand = null
  ch[facing](p, o)
  speckle(p, rng, ch.speckleRamp, ch.speckleN)
  p.outline(OUT)
  // post-outline passes: pure light/motion pixels, never ringed
  if (o.smear) {
    smearPass(p, [
      [66, 44 + (o.crouch | 0), 16, ch.smearColour],
      [70, 54 + (o.crouch | 0), 18, ch.smearColour],
      [68, 66 + (o.crouch | 0), 13, ch.smearColour],
    ])
  }
  if (o.strike && ch.name === 'Fina') {
    smearPass(p, [                                    // the loosed light-arrow
      [4, 44 + (o.crouch | 0), 20, GLOW.fina[0]],
      [8, 45 + (o.crouch | 0), 12, GLOW.fina[1]],
    ])
  }
  if ((o.glow | 0) > 0) glowPass(p, rng, o._hand || [30, 38], o.glow, ch.glow)
}

function buildSheetData(id) {
  const ch = CHARS[id]
  if (!ch) throw new Error(`makeBattlerSheet: unknown id '${id}' (rain|lasswell|fina|lid)`)
  const data = new Uint8ClampedArray(SHEET_W * SHEET_H * 4)
  const rng = mulberry32(SEEDS[id])
  const p = new Pix()
  for (const [anim, [start, n]] of Object.entries(LAYOUT)) {
    for (let i = 0; i < n; i++) {
      const o = { ...POSE[anim][i] }
      buildCell(p, ch, anim === 'victory' ? 'south' : 'west', o, rng)
      p.blitTo(data, start + i)
    }
  }
  return data
}

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

function animsFromOrders() {
  const anims = {}
  for (const [k, [start]] of Object.entries(LAYOUT)) {
    anims[k] = ORDERS[k].map((i) => start + i)
  }
  return anims
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function makeBattlerSheet(id) {
  const ch = CHARS[id]
  if (!ch) throw new Error(`makeBattlerSheet: unknown id '${id}' (rain|lasswell|fina|lid)`)
  const data = buildSheetData(id)
  return {
    texture: toTexture(data),
    frameW: CELL,
    frameH: CELL,
    cols: COLS,
    rows: ROWS,
    anims: animsFromOrders(),
    fps: FPS,
    meta: {
      // --- contract fields
      texelsPerMeter: 52.5,        // 96 px cell → 1.829 m plane; body 1.60 m
      bodyPx: ch.bodyPx,
      groundRow: GY,               // soles; outline on 91; 92–95 clear to sink
      // --- extras (additive, safe to ignore)
      kind: 'battler',
      id,
      name: ch.name,
      planeMeters: { w: CELL / 52.5, h: CELL / 52.5 },
      sheetPx: { w: SHEET_W, h: SHEET_H },
      // 96 px cells cannot tile a POT sheet: cols·frameW = 960 < 1024, so UVs
      // MUST come from these pixel ratios, never from 1/cols.
      uv: { u: CELL / SHEET_W, v: CELL / SHEET_H },
      cellUV: (i) => ({
        u: ((i % COLS) * CELL) / SHEET_W,
        v: 1 - ((Math.floor(i / COLS) + 1) * CELL) / SHEET_H,
      }),
    },
  }
}

// Test/debug-only hook (non-contract): the raw RGBA sheet without touching
// DOM/THREE, so tooling can snapshot cells deterministically.
export function makeBattlerSheetData(id) {
  return { data: buildSheetData(id), width: SHEET_W, height: SHEET_H, layout: LAYOUT, cell: CELL, cols: COLS }
}

// Debug contact sheet: the packed texture at 2× on a checker, with grid lines
// and anim labels. Browser-only (canvas text); returns an HTMLCanvasElement.
export function battlerDebugCanvas(sheet) {
  const S = 2
  const c = document.createElement('canvas')
  c.width = SHEET_W * S
  c.height = SHEET_H * S + 20
  const ctx = c.getContext('2d')
  ctx.imageSmoothingEnabled = false
  for (let y = 0; y < SHEET_H * S; y += 8) for (let x = 0; x < SHEET_W * S; x += 8) {
    ctx.fillStyle = ((x + y) / 8) % 2 ? '#3a3f44' : '#2e3237'
    ctx.fillRect(x, y, 8, 8)
  }
  ctx.drawImage(sheet.texture.image, 0, 0, SHEET_W * S, SHEET_H * S)
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'
  ctx.lineWidth = 1
  for (let i = 1; i * sheet.frameW < SHEET_W; i++) {
    ctx.beginPath(); ctx.moveTo(i * sheet.frameW * S + 0.5, 0); ctx.lineTo(i * sheet.frameW * S + 0.5, SHEET_H * S); ctx.stroke()
  }
  for (let j = 1; j * sheet.frameH < SHEET_H; j++) {
    ctx.beginPath(); ctx.moveTo(0, j * sheet.frameH * S + 0.5); ctx.lineTo(SHEET_W * S, j * sheet.frameH * S + 0.5); ctx.stroke()
  }
  ctx.fillStyle = '#e8e4d8'
  ctx.font = '10px monospace'
  for (const [name, [start, n]] of Object.entries(LAYOUT)) {
    const col = start % sheet.cols, row = Math.floor(start / sheet.cols)
    ctx.fillText(`${name}[${n}]`, col * sheet.frameW * S + 3, row * sheet.frameH * S + 11)
  }
  ctx.fillText(`${SHEET_W}x${SHEET_H} cell ${CELL} fps ${sheet.fps} (${sheet.meta && sheet.meta.id})`, 4, SHEET_H * S + 14)
  return c
}
