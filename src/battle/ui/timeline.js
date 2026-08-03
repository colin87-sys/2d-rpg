// ---------------------------------------------------------------------------
// src/battle/ui/timeline.js — the top turn-order rail (BATTLE_BIBLE §7.1).
//
// Contract (docs/BATTLE_CONTRACT.md — frozen):
//   export function createTimeline({ units }): TimelineUI
//   TimelineUI = { dom: HTMLElement, update(dt): void }
//
// What this module renders (all numbers measured off frames 04/05, quoted in
// the bible as binding fractions of frame width/height — fw/fh):
//   * the 3 px steel track at y 0.089 fh, x 0.092 → 0.665 fw, #aebfc6 @ 80 %
//     with a 1 px darker under-edge; the last 0.05 fw fades to 0. Above the
//     left half of the line rides the soft teal "time wake" veil the plates
//     show (sampled #2a636e-class over the hall wall at rows 76–80).
//   * 18 px glass slot-tick diamonds, pitch 0.0336 fw, first at 0.120 fw —
//     dark-teal upper half, pale steel lower half.
//   * the ACTIVE diamond: 130 px point-to-point at (0.051 fw, 0.090 fh),
//     4 px near-white frame + inner 1 px cyan glass line, painted chibi bust,
//     soft drop shadow, and the icy cyan under-glow the plates show pooling
//     at its lower vertices. On turn start the arriving portrait morphs in
//     (scale 0.55 → 1.0 over 240 ms) under a 90 ms white flash.
//   * next-up seats: 56 px diamonds at (0.100, 0.072) and (0.091, 0.115),
//     2 px white frame, with a pale drop-nub marking their rail anchor.
//     Frame04 shows one seat filled with a four-portrait cluster on the rail;
//     seat B only fills when the queue is dense (frame05's census).
//   * queue portraits: 40 px diamonds perched ON the track (bottom vertex
//     kissing the line), positioned by unit.queueEta on a time ruler
//     (0.45 → 0.10 fw over ~6 s; beyond 6 s the ruler compresses so
//     neighbours land 0.0237 fw apart — the measured cluster pitch), and
//     they shrink/dim toward the right end of the track.
//   * crimson enemy markers 26×22 px hanging BELOW the track (centre y
//     0.112 fh), fill #9c2233 with a darker border, a pale painted enemy-head
//     glyph (frame04's dragon marker samples #b29a87 at its centre — the
//     glyph, not bare crimson), and a small steel hanger tab to the rail.
//     When the enemy is about to act the marker swells and pulses at the
//     rail head — frame05's sorcerer sitting under the active seat.
//   * re-sort slides over 240 ms cubic ease-out; continuous drift otherwise;
//     nothing ever teleports. Arrivals flash 90 ms.
//
// Busts are painted procedurally: chunky pixel-art heads on a 24×28 texel
// grid using the exact battler ramps (re-declared verbatim from
// src/battle/art/battlerSheet.js, the module's own established idiom — it
// exports only finished sheets, no palette symbols), nearest-neighbour
// upscaled so the portraits keep the plates' visible pixel crunch, hair
// overflowing the diamond's top edges exactly like the reference (the white
// frame reads only on the lower V under every bust).
//
// Ownership: DOM inside #ui, above the canvas. This module owns the timeline
// band only — nothing below y 0.16 fh except the active diamond's own lower
// vertex + glow, which the bible's geometry itself places at 0.161 fh.
// All state is read from units.roster / units.enemy (queueEta, hp, alive,
// statuses); no projection of its own, no writes to unit state.
// ---------------------------------------------------------------------------

'use strict'

// ---------------------------------------------------------------------------
// §7.1 geometry — the binding numbers (px values are quoted at 1630×921 and
// scaled by the live viewport; fractions are the truth).
// ---------------------------------------------------------------------------

const RAIL_Y = 0.089            // fh — track centre line
const TRACK_X0 = 0.092          // fw — track start (butts the active frame)
const TRACK_X1 = 0.665          // fw — track end
const TRACK_FADE = 0.05         // fw — end fade band
const TICK_X0 = 0.120           // fw — first slot tick
const TICK_PITCH = 0.0336       // fw
const TICK_PX = 18              // point-to-point @1630

const ACTIVE_PX = 130           // point-to-point @1630 (0.080 fw)
const ACTIVE_CX = 0.051         // fw
const ACTIVE_CY = 0.090         // fh
const SEAT_PX = 56
const SEAT_A = [0.100, 0.072]   // fw, fh
const SEAT_B = [0.091, 0.115]
const QUEUE_PX = 40
const MARKER_W = 26             // crimson enemy marker @1630
const MARKER_H = 22
const MARKER_Y = 0.112          // fh — marker centre

// Time ruler: portraits drift left toward the active seat, position ∝ eta.
// 0.10 → 0.45 fw across the first 6 s (the bible's typical traversal);
// beyond 6 s the ruler compresses to the measured queue pitch: 0.0237 fw
// per ~0.72 s of eta (the frame04 cluster spacing).
const RULER_X_HEAD = 0.100
const RULER_X_KNEE = 0.45
const RULER_T_KNEE = 6.0
const RULER_RATE_FAR = 0.0237 / 0.72   // fw per second past the knee
const RULER_X_CULL = 0.685             // gone past here
const SHRINK_X0 = 0.55                 // shrink/dim toward the right end

const SLIDE_S = 0.24            // §7.1 re-sort slide, cubic ease-out
const FLASH_S = 0.09            // §7.1 arrival flash
const SLIDE_TRIGGER = 0.030     // fw jump that reads as a re-sort, not drift
const SEATB_MAX_ETA = 5.5       // seat B fills only when the queue is dense
const ENEMY_DOUBLE_GAP = 0.9    // the dragon queues two beats 0.9 s apart
const GHOST_GAP = 0.75          // active unit's next-round re-entry gap

// ---------------------------------------------------------------------------
// Palette — §7 chrome + the battler ramps for the painted busts.
// Ramps are re-declared byte-for-byte from src/battle/art/battlerSheet.js
// (which itself re-declares Rain from ART_BIBLE §3): same character, same
// colours, on every screen. Do not touch these values.
// ---------------------------------------------------------------------------

function hx(h) {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const OUT = hx('#1d1410')                 // house colour-matched outline
const EYE_WHITE = hx('#f4f1e8')

const R_SKIN = { hi: hx('#f6dfc2'), lit: hx('#e8c9a8'), mid: hx('#cfa987'), sh: hx('#b08c6c') }
const R_HAIR = { hi: hx('#f8e9a2'), lit: hx('#e8cf6f'), mid: hx('#cda44e'), sh: hx('#b3873a'), deep: hx('#8a6428') }
const R_RED  = { hi: hx('#c04a38'), lit: hx('#a03028'), mid: hx('#7c241e'), sh: hx('#5c1c14') }
const R_BLK  = { hi: hx('#4e4642'), lit: hx('#37302e'), mid: hx('#2a2422'), sh: hx('#1d1815') }
const R_GOLD = { hi: hx('#ffe9a6'), lit: hx('#d9b542'), mid: hx('#b08f33'), sh: hx('#8a6d24') }
const R_CAPE = { hi: hx('#eef3f6'), lit: hx('#dce4ea'), mid: hx('#b5c4d2'), sh: hx('#8fa3b8') }

const L_MANE = { hi: hx('#565064'), lit: hx('#3a3547'), mid: hx('#262232'), sh: hx('#16141f'), deep: hx('#0e0c15') }
const L_PURP = { hi: hx('#b877e2'), lit: hx('#9349c8'), mid: hx('#6d3399'), sh: hx('#4a2169') }
const L_OBI  = { hi: hx('#f2b45c'), lit: hx('#d98f36'), mid: hx('#a96828'), sh: hx('#7c491c') }
const L_JADE = { hi: hx('#8cc86a'), lit: hx('#63a655'), mid: hx('#3f7a3c'), sh: hx('#285426') }

const F_HAIR = { hi: hx('#f9edc6'), lit: hx('#eed695'), mid: hx('#d1ab64'), sh: hx('#a97f45'), deep: hx('#83602f') }
const F_WHT  = { hi: hx('#fbf9f2'), lit: hx('#ece7da'), mid: hx('#c6bcb0'), sh: hx('#998e88') }
const F_PINK = { hi: hx('#ff9ecb'), lit: hx('#ea5f9d'), mid: hx('#bb3d74'), sh: hx('#8c2a54'), deep: hx('#6d1f44') }

const D_HAIR = { hi: hx('#ff7e4a'), lit: hx('#e04a2c'), mid: hx('#ab2f1a'), sh: hx('#7c2010'), deep: hx('#5a170b') }
const D_AMB  = { hi: hx('#f6c96a'), lit: hx('#dd9d3e'), mid: hx('#b3762e'), sh: hx('#855422') }
const D_STRAP= { hi: hx('#a87c46'), lit: hx('#8a6234'), mid: hx('#66452a'), sh: hx('#46301c') }
const D_GOGG = { hi: hx('#b4e284'), lit: hx('#8cc463'), mid: hx('#5d9440'), sh: hx('#3a6428') }

// Chrome (sampled / bible §7.1)
const C = {
  track: 'rgba(174,191,198,0.80)',          // #aebfc6 @80%
  trackHi: 'rgba(214,226,231,0.85)',
  trackUnder: 'rgba(38,50,58,0.65)',
  veil: 'rgba(56,118,132,0.42)',            // teal wake above the line
  tickTop0: '#10485f', tickTop1: '#1f4a5a',
  tickBot: '#a8bdc2',
  tickEdge: 'rgba(16,34,44,0.55)',
  glassTop0: '#0d3044', glassTop1: '#1e4757',
  glassBot0: '#a9bcc2', glassBot1: '#7d959e',
  frameWhite: 'rgba(238,242,245,0.95)',
  frameSteel: '#b2b5bc',
  frameLight: '#e6e8ec',
  innerCyan: 'rgba(126,222,250,0.55)',
  glowCyan: 'rgba(96,214,248,',             // + alpha)
  shadow: 'rgba(3,10,18,0.55)',
  marker: '#9c2233',
  markerHi: '#c25a66',
  markerLo: '#5f1620',
  markerEdge: '#43101a',
  hanger: 'rgba(186,201,209,0.85)',
  nub: 'rgba(212,222,228,0.92)',
}

// ---------------------------------------------------------------------------
// Small utils
// ---------------------------------------------------------------------------

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
const lerp = (a, b, t) => a + (b - a) * t
const easeOutCubic = (t) => 1 - (1 - t) * (1 - t) * (1 - t)
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`

function alive(u) {
  if (!u) return false
  if (u.alive === false) return false
  return !(u.hp <= 0)
}

/** eta → fw fraction on the time ruler. */
function rulerX(eta) {
  if (eta <= 0) return RULER_X_HEAD
  if (eta <= RULER_T_KNEE) {
    return RULER_X_HEAD + (eta / RULER_T_KNEE) * (RULER_X_KNEE - RULER_X_HEAD)
  }
  return RULER_X_KNEE + (eta - RULER_T_KNEE) * RULER_RATE_FAR
}

// ---------------------------------------------------------------------------
// Pixel bust painter — 24×28 texel grid, hand-placed, deterministic.
// Frontal chibi busts in the plates' grammar: huge head, small shoulders,
// hair overflowing the diamond frame, 1 px colour-matched outline.
// ---------------------------------------------------------------------------

const BW = 24
const BH = 28

class Grid {
  constructor() { this.d = new Uint8ClampedArray(BW * BH * 4) }
  px(x, y, c) {
    if (x < 0 || y < 0 || x >= BW || y >= BH) return
    const o = (y * BW + x) * 4
    this.d[o] = c[0]; this.d[o + 1] = c[1]; this.d[o + 2] = c[2]; this.d[o + 3] = 255
  }
  a(x, y) {
    if (x < 0 || y < 0 || x >= BW || y >= BH) return 0
    return this.d[(y * BW + x) * 4 + 3]
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
  spikeUp(cx, by, halfW, hgt, lean, c) {
    for (let j = 0; j < hgt; j++) {
      const t = j / hgt
      const w = Math.max(0, Math.round(halfW * (1 - t)))
      const off = Math.round(lean * t)
      this.h(cx - w + off, cx + w + off, by - j, c)
    }
  }
  spikeDown(cx, ty, halfW, hgt, lean, c) {
    for (let j = 0; j < hgt; j++) {
      const t = j / hgt
      const w = Math.max(0, Math.round(halfW * (1 - t)))
      const off = Math.round(lean * t)
      this.h(cx - w + off, cx + w + off, ty + j, c)
    }
  }
  outline(c) {
    const add = []
    for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) {
      if (this.a(x, y)) continue
      if (this.a(x - 1, y) || this.a(x + 1, y) || this.a(x, y - 1) || this.a(x, y + 1)) add.push(x, y)
    }
    for (let i = 0; i < add.length; i += 2) this.px(add[i], add[i + 1], c)
  }
}

/** Shared frontal face: skin block, two big eyes with glints, brows, mouth. */
function face(p, fy, skin, browC) {
  // skin mass with jaw taper
  p.r(6, fy, 12, 8, skin.lit)
  p.h(7, 16, fy + 8, skin.lit)
  p.h(8, 15, fy + 9, skin.mid)
  // side shade (form turns away right)
  p.v(16, fy + 1, fy + 7, skin.mid)
  p.v(17, fy + 1, fy + 6, skin.mid)
  p.v(6, fy + 1, fy + 6, skin.mid)
  p.px(6, fy + 1, skin.sh)
  // brows
  p.h(8, 10, fy + 2, browC)
  p.h(13, 15, fy + 2, browC)
  // eyes: 2×3 dark blocks, lash row, white glint
  for (const ex of [8, 14]) {
    p.h(ex, ex + 1, fy + 3, R_BLK.sh)          // lash
    p.r(ex, fy + 4, 2, 3, R_BLK.lit)
    p.px(ex, fy + 4, EYE_WHITE)
    p.px(ex, fy + 6, R_BLK.sh)
  }
  // nose tick + mouth
  p.px(11, fy + 6, skin.mid)
  p.h(11, 12, fy + 8, R_BLK.lit)
}

function bustRain(p) {
  // back hair mass + side locks (dome held low so the crown spikes have sky)
  p.disc(11, 7, 8, 6, R_HAIR.mid)
  p.disc(11, 6, 7, 5, R_HAIR.lit)
  p.v(4, 7, 13, R_HAIR.mid); p.v(5, 6, 14, R_HAIR.lit)
  p.v(19, 7, 13, R_HAIR.sh); p.v(18, 6, 14, R_HAIR.mid)
  // crown spikes (signature) — tips stay inside the grid
  p.spikeUp(4, 5, 2, 4, -2, R_HAIR.mid)
  p.spikeUp(8, 4, 2, 4, -1, R_HAIR.lit)
  p.spikeUp(12, 3, 2, 3, 0, R_HAIR.lit)
  p.spikeUp(16, 4, 2, 4, 1, R_HAIR.mid)
  p.spikeUp(19, 5, 2, 4, 2, R_HAIR.sh)
  p.px(12, 0, R_HAIR.lit); p.px(13, 0, R_HAIR.mid)   // ahoge flick
  face(p, 9, R_SKIN, R_HAIR.deep)
  // fringe cutting over the brow
  p.spikeDown(7, 8, 2, 3, -1, R_HAIR.lit)
  p.spikeDown(10, 8, 2, 4, 0, R_HAIR.mid)
  p.spikeDown(13, 8, 2, 3, 0, R_HAIR.lit)
  p.spikeDown(16, 8, 2, 4, 1, R_HAIR.mid)
  p.h(6, 17, 8, R_HAIR.mid)
  p.px(8, 3, R_HAIR.hi); p.px(12, 2, R_HAIR.hi)
  // shoulders: red coat, pale collar V, black under-tunic, gold placket
  p.r(3, 20, 18, 8, R_RED.lit)
  p.r(17, 20, 4, 8, R_RED.mid)
  p.h(3, 20, 20, R_RED.hi)
  p.px(3, 21, R_RED.mid)
  // collar V (cape white)
  p.h(9, 14, 19, R_CAPE.lit)
  p.h(9, 10, 20, R_CAPE.lit); p.h(13, 14, 20, R_CAPE.mid)
  // black under-tunic centre + gold
  p.r(10, 21, 4, 7, R_BLK.lit)
  p.v(13, 21, 27, R_BLK.mid)
  p.px(11, 22, R_GOLD.lit); p.px(11, 25, R_GOLD.mid)
}

function bustLasswell(p) {
  // the mane: a huge blue-black mass framing everything, falls to shoulders
  p.disc(11, 6, 9, 6, L_MANE.mid)
  p.disc(11, 5, 8, 5, L_MANE.lit)
  p.spikeUp(7, 2, 2, 3, -1, L_MANE.lit)
  p.spikeUp(12, 1, 2, 3, 0, L_MANE.lit)
  p.spikeUp(16, 2, 2, 3, 1, L_MANE.mid)
  for (const [x0, x1, cA, cB] of [[2, 3, L_MANE.mid, L_MANE.sh], [20, 21, L_MANE.sh, L_MANE.deep]]) {
    p.v(x0, 6, 23, cA)
    p.v(x1, 5, 24, cB)
  }
  p.v(4, 6, 20, L_MANE.lit)
  p.v(19, 6, 21, L_MANE.mid)
  p.px(2, 24, L_MANE.deep); p.px(21, 25, L_MANE.deep)   // ragged tips
  face(p, 9, R_SKIN, L_MANE.deep)
  // long crossing bangs
  p.spikeDown(6, 7, 2, 5, 0, L_MANE.lit)
  p.spikeDown(9, 8, 1, 4, 0, L_MANE.mid)
  p.spikeDown(14, 8, 1, 4, 0, L_MANE.mid)
  p.spikeDown(17, 7, 2, 5, 0, L_MANE.lit)
  p.h(6, 17, 8, L_MANE.mid)
  p.px(7, 3, L_MANE.hi); p.px(13, 3, L_MANE.hi)
  // violet kimono shoulders, lapel cross, obi hint
  p.r(4, 20, 16, 8, L_PURP.mid)
  p.r(4, 20, 9, 8, L_PURP.lit)
  p.h(4, 19, 20, L_PURP.hi)
  // lapels crossing left-over-right
  p.v(11, 20, 24, L_PURP.sh)
  p.px(10, 21, L_PURP.sh); p.px(12, 22, L_PURP.sh)
  p.h(6, 17, 26, L_OBI.mid)
  p.h(6, 17, 27, L_OBI.sh)
  p.px(11, 26, L_JADE.lit); p.px(12, 26, L_JADE.mid)
}

function bustFina(p) {
  // pale-gold bob with centre part and long side falls
  p.disc(11, 6, 8, 6, F_HAIR.mid)
  p.disc(11, 5, 7, 5, F_HAIR.lit)
  p.v(11, 1, 3, F_HAIR.sh)                       // part line
  p.v(4, 7, 18, F_HAIR.lit); p.v(5, 6, 19, F_HAIR.mid)
  p.v(18, 7, 19, F_HAIR.mid); p.v(19, 7, 18, F_HAIR.sh)
  p.px(3, 17, F_HAIR.mid); p.px(20, 17, F_HAIR.sh)   // curl tips
  face(p, 9, R_SKIN, F_HAIR.deep)
  // soft rounded fringe
  p.spikeDown(7, 8, 2, 3, 0, F_HAIR.lit)
  p.spikeDown(11, 8, 2, 3, 0, F_HAIR.mid)
  p.spikeDown(15, 8, 2, 3, 0, F_HAIR.lit)
  p.h(6, 17, 8, F_HAIR.mid)
  p.px(8, 3, F_HAIR.hi); p.px(14, 2, F_HAIR.hi)
  // the red hair flower at her right temple — big enough to read at 40 px
  p.r(16, 3, 3, 3, F_PINK.lit)
  p.px(16, 3, F_PINK.hi); p.px(18, 5, F_PINK.deep)
  p.px(17, 4, F_PINK.mid); p.px(19, 4, F_PINK.mid)
  // white bodice with gold trim + pink ribbon; bare neck row
  p.h(9, 14, 19, R_SKIN.lit)
  p.r(4, 20, 16, 8, F_WHT.lit)
  p.r(16, 20, 4, 8, F_WHT.mid)
  p.h(4, 19, 20, F_WHT.hi)
  p.h(6, 17, 22, R_GOLD.mid)
  p.px(7, 22, R_GOLD.hi)
  p.r(11, 23, 2, 2, F_PINK.lit)
  p.px(12, 24, F_PINK.mid)
}

function bustLid(p) {
  // twin red puffs + flared spikes + top burst
  p.disc(7, 6, 5, 4, D_HAIR.lit)
  p.disc(16, 6, 5, 4, D_HAIR.mid)
  p.r(8, 4, 8, 4, D_HAIR.lit)
  p.spikeUp(5, 3, 2, 3, -1, D_HAIR.lit)
  p.spikeUp(9, 3, 2, 3, 0, D_HAIR.lit)
  p.spikeUp(13, 3, 2, 3, 0, D_HAIR.lit)
  p.spikeUp(17, 3, 2, 3, 1, D_HAIR.mid)
  // side flares (the ponytail burst reads wider than the face)
  p.spikeUp(2, 8, 1, 3, -1, D_HAIR.mid)
  p.h(1, 3, 7, D_HAIR.mid)
  p.spikeUp(21, 8, 1, 3, 1, D_HAIR.sh)
  p.h(20, 22, 7, D_HAIR.sh)
  p.px(11, 5, D_HAIR.deep)                       // part shadow
  p.px(6, 2, D_HAIR.hi); p.px(13, 2, D_HAIR.hi)
  // goggle band across the brow
  p.h(6, 17, 8, D_GOGG.lit)
  p.h(6, 17, 9, D_GOGG.mid)
  p.px(5, 8, R_BLK.mid); p.px(18, 8, R_BLK.mid)  // strap ends
  p.px(9, 8, D_GOGG.hi); p.px(14, 8, D_GOGG.hi)  // lens glints
  face(p, 10, R_SKIN, D_HAIR.deep)
  // mustard engineer jacket + brown chest strap + pouch
  p.r(3, 21, 18, 7, D_AMB.lit)
  p.r(17, 21, 4, 7, D_AMB.mid)
  p.h(3, 20, 21, D_AMB.hi)
  for (let i = 0; i < 7; i++) {                  // strap diagonal
    p.px(7 + i, 21 + i, D_STRAP.mid)
    p.px(8 + i, 21 + i, D_STRAP.lit)
  }
  p.px(8, 25, D_STRAP.hi)                        // buckle
}

const BUST_PAINTERS = { rain: bustRain, lasswell: bustLasswell, fina: bustFina, lid: bustLid }

/** Fallback bust for unknown ids: hooded silhouette in steel. */
function bustGeneric(p) {
  p.disc(11, 6, 8, 6, R_CAPE.mid)
  p.disc(11, 5, 7, 5, R_CAPE.lit)
  face(p, 9, R_SKIN, R_CAPE.sh)
  p.h(6, 17, 8, R_CAPE.mid)
  p.r(4, 20, 16, 8, R_CAPE.sh)
  p.h(4, 19, 20, R_CAPE.mid)
}

/** Paint a bust to a small canvas (BW×BH), outlined. */
function bakeBustCells(id) {
  const p = new Grid()
  ;(BUST_PAINTERS[id] || bustGeneric)(p)
  p.outline(OUT)
  const c = document.createElement('canvas')
  c.width = BW
  c.height = BH
  const ctx = c.getContext('2d')
  const img = ctx.createImageData(BW, BH)
  img.data.set(p.d)
  ctx.putImageData(img, 0, 0)
  return c
}

// ---------------------------------------------------------------------------
// Portrait tile baking — diamond glass + frame + bust, at final pixel size.
// kind: 'active' | 'seat' | 'queue'
// Returns { canvas, w, h, ax, ay } with (ax, ay) = diamond centre (css px).
// ---------------------------------------------------------------------------

function diamondPath(ctx, cx, cy, hw, hh) {
  ctx.beginPath()
  ctx.moveTo(cx, cy - hh)
  ctx.lineTo(cx + hw, cy)
  ctx.lineTo(cx, cy + hh)
  ctx.lineTo(cx - hw, cy)
  ctx.closePath()
}

function bakePortrait(bustCells, S, kind, dpr) {
  const isActive = kind === 'active'
  const pad = Math.ceil(S * (isActive ? 0.30 : 0.16)) + 4
  const up = Math.ceil(S * 0.30)
  const w = Math.ceil(S + pad * 2)
  const h = Math.ceil(S + up + pad * 2)
  const ax = w / 2
  const ay = pad + up + S / 2

  const c = document.createElement('canvas')
  c.width = Math.max(2, Math.round(w * dpr))
  c.height = Math.max(2, Math.round(h * dpr))
  const ctx = c.getContext('2d')
  ctx.scale(dpr, dpr)

  const half = S / 2
  const frameW = isActive ? Math.max(2.5, S * 0.031) : Math.max(1.4, S * 0.036)
  const inset = frameW * 0.9

  // 1) drop shadow backing
  ctx.save()
  ctx.shadowColor = C.shadow
  ctx.shadowBlur = isActive ? S * 0.10 : S * 0.09
  ctx.shadowOffsetY = Math.max(1.5, S * 0.03)
  diamondPath(ctx, ax, ay, half, half)
  ctx.fillStyle = 'rgba(10,18,26,0.85)'
  ctx.fill()
  ctx.restore()

  // 2) glass fill (dark teal top half, pale steel sheen bottom half)
  ctx.save()
  diamondPath(ctx, ax, ay, half - inset, half - inset)
  ctx.clip()
  let g = ctx.createLinearGradient(0, ay - half, 0, ay)
  g.addColorStop(0, C.glassTop0)
  g.addColorStop(1, C.glassTop1)
  ctx.fillStyle = g
  ctx.fillRect(ax - half, ay - half, S, half)
  g = ctx.createLinearGradient(0, ay, 0, ay + half)
  g.addColorStop(0, C.glassBot0)
  g.addColorStop(1, C.glassBot1)
  ctx.fillStyle = g
  ctx.fillRect(ax - half, ay, S, half)
  // seam highlight at the midline
  ctx.fillStyle = 'rgba(235,244,247,0.35)'
  ctx.fillRect(ax - half, ay - 0.5, S, 1)
  ctx.restore()

  // 3) frame FIRST (bust may cover its upper edges, exactly like the plates)
  if (isActive) {
    diamondPath(ctx, ax, ay, half, half)
    ctx.lineWidth = frameW * 1.6
    ctx.strokeStyle = C.frameSteel
    ctx.stroke()
    // lit upper edges
    ctx.beginPath()
    ctx.moveTo(ax - half, ay)
    ctx.lineTo(ax, ay - half)
    ctx.lineTo(ax + half, ay)
    ctx.lineWidth = frameW * 0.8
    ctx.strokeStyle = C.frameLight
    ctx.stroke()
    // inner 1 px cyan glass line
    diamondPath(ctx, ax, ay, half - inset - 2.5, half - inset - 2.5)
    ctx.lineWidth = 1
    ctx.strokeStyle = C.innerCyan
    ctx.stroke()
  } else {
    diamondPath(ctx, ax, ay, half, half)
    ctx.lineWidth = frameW
    ctx.strokeStyle = C.frameWhite
    ctx.stroke()
  }

  // 4) the bust — clipped by the LOWER diamond edges only; hair overflows top
  ctx.save()
  const chw = half - inset
  ctx.beginPath()
  ctx.moveTo(ax - chw, ay)
  ctx.lineTo(ax, ay + chw)
  ctx.lineTo(ax + chw, ay)
  ctx.lineTo(ax + chw, 0)
  ctx.lineTo(ax - chw, 0)
  ctx.closePath()
  ctx.clip()
  // Bust scale per kind (calibrated against the plates): the active bust
  // fits comfortably inside its big diamond with the crown near the inner
  // top edge; the small queue busts fill their diamonds and overflow the
  // top, faces riding the upper half with chins near the midline.
  const t = isActive ? S / 28 : S / 23
  const bw = BW * t
  const bh = BH * t
  const bx = ax - bw / 2
  const by = ay + chw * (isActive ? 0.90 : 0.96) - bh   // shoulders sink into the lower V
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(bustCells, bx, by, bw, bh)
  ctx.restore()

  // 5) active extras: icy under-glow pooling at the lower vertices
  if (isActive) {
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    const gl = ctx.createRadialGradient(ax, ay + half * 0.72, 1, ax, ay + half * 0.72, S * 0.52)
    gl.addColorStop(0, C.glowCyan + '0.50)')
    gl.addColorStop(0.55, C.glowCyan + '0.16)')
    gl.addColorStop(1, C.glowCyan + '0)')
    ctx.fillStyle = gl
    ctx.fillRect(ax - S, ay - S * 0.1, S * 2, S * 1.4)
    // bright rim along the lower edges
    ctx.beginPath()
    ctx.moveTo(ax - half, ay)
    ctx.lineTo(ax, ay + half)
    ctx.lineTo(ax + half, ay)
    ctx.lineWidth = 2
    ctx.shadowColor = C.glowCyan + '0.9)'
    ctx.shadowBlur = 7
    ctx.strokeStyle = 'rgba(190,240,255,0.75)'
    ctx.stroke()
    ctx.restore()
  } else {
    // pale drop-nub at the bottom vertex (the rail contact tick)
    diamondPath(ctx, ax, ay + half - 1, S * 0.10, S * 0.085)
    ctx.fillStyle = C.nub
    ctx.fill()
  }

  return { canvas: c, w, h, ax, ay }
}

// ---------------------------------------------------------------------------
// Crimson enemy marker tile (26×22 @1630) — pale painted enemy-head glyph on
// crimson glass, darker border, steel hanger tab above (frame04 census).
// enemyKind: 'dragon' | 'sorcerer' | other
// ---------------------------------------------------------------------------

function bakeMarker(enemyKind, S, dpr) {
  const mw = Math.max(10, MARKER_W * S)
  const mh = Math.max(9, MARKER_H * S)
  const pad = Math.ceil(mw * 0.35)
  const w = Math.ceil(mw + pad * 2)
  const h = Math.ceil(mh + pad * 2)
  const ax = w / 2
  const ay = h / 2
  const c = document.createElement('canvas')
  c.width = Math.max(2, Math.round(w * dpr))
  c.height = Math.max(2, Math.round(h * dpr))
  const ctx = c.getContext('2d')
  ctx.scale(dpr, dpr)
  const hw = mw / 2
  const hh = mh / 2

  // drop shadow + crimson glass
  ctx.save()
  ctx.shadowColor = C.shadow
  ctx.shadowBlur = mw * 0.12
  ctx.shadowOffsetY = 1.5
  diamondPath(ctx, ax, ay, hw, hh)
  const g = ctx.createLinearGradient(0, ay - hh, 0, ay + hh)
  g.addColorStop(0, '#b13043')
  g.addColorStop(0.5, C.marker)
  g.addColorStop(1, '#701a29')
  ctx.fillStyle = g
  ctx.fill()
  ctx.restore()
  // border + top rim
  diamondPath(ctx, ax, ay, hw, hh)
  ctx.lineWidth = Math.max(1, mw * 0.055)
  ctx.strokeStyle = C.markerEdge
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(ax - hw + 1.5, ay)
  ctx.lineTo(ax, ay - hh + 1.2)
  ctx.lineWidth = 1
  ctx.strokeStyle = C.markerHi
  ctx.stroke()

  // pale enemy-head glyph (the frame04 marker samples #b29a87 at centre)
  ctx.save()
  diamondPath(ctx, ax, ay, hw - 1.5, hh - 1.5)
  ctx.clip()
  const k = mw / 23
  ctx.translate(ax, ay)
  if (enemyKind === 'sorcerer') {
    // hunched sage: dark hood arc, pale face, huge beard wedge, gold ticks
    ctx.fillStyle = '#20242a'
    ctx.beginPath()
    ctx.ellipse(0.5 * k, -4.5 * k, 6.5 * k, 4 * k, 0, Math.PI, 0)
    ctx.fill()
    ctx.fillStyle = '#c8c9b8'
    ctx.beginPath()
    ctx.moveTo(-6 * k, -3 * k)
    ctx.quadraticCurveTo(-7 * k, 4 * k, 0, 8.5 * k)
    ctx.quadraticCurveTo(7 * k, 4 * k, 6 * k, -3 * k)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = '#ccd0c2'
    ctx.fillRect(-2.5 * k, -1 * k, 5 * k, 6 * k)
    ctx.fillStyle = '#b08c6c'
    ctx.fillRect(-3 * k, -4 * k, 6 * k, 2.6 * k)
    ctx.fillStyle = '#1d1410'
    ctx.fillRect(-2.2 * k, -3.6 * k, 1.2 * k, 1.2 * k)
    ctx.fillRect(1.0 * k, -3.6 * k, 1.2 * k, 1.2 * k)
    ctx.fillStyle = '#84805a'
    ctx.fillRect(-6.5 * k, -1 * k, 1.4 * k, 1.4 * k)
    ctx.fillRect(5.1 * k, -1 * k, 1.4 * k, 1.4 * k)
  } else {
    // low wedge dragon head facing left: cream skull, maw notch, green crest
    ctx.fillStyle = '#3d6d54'
    ctx.beginPath()
    ctx.moveTo(2 * k, -5.5 * k)
    ctx.lineTo(6 * k, -1 * k)
    ctx.lineTo(8.5 * k, -5 * k)
    ctx.lineTo(9.5 * k, 0)
    ctx.lineTo(4 * k, 1.5 * k)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = '#ead9c4'
    ctx.beginPath()
    ctx.moveTo(-9.5 * k, 0.5 * k)
    ctx.lineTo(-2 * k, -4.5 * k)
    ctx.lineTo(6 * k, -3 * k)
    ctx.lineTo(7 * k, 2 * k)
    ctx.lineTo(-3 * k, 3 * k)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = '#c6a792'
    ctx.beginPath()
    ctx.moveTo(-9.5 * k, 0.5 * k)
    ctx.lineTo(-2 * k, 3.5 * k)
    ctx.lineTo(4 * k, 5 * k)
    ctx.lineTo(6.5 * k, 2.5 * k)
    ctx.lineTo(-3 * k, 3 * k)
    ctx.closePath()
    ctx.fill()
    // maw
    ctx.strokeStyle = '#a42f28'
    ctx.lineWidth = 1.3 * k
    ctx.beginPath()
    ctx.moveTo(-8.8 * k, 1.2 * k)
    ctx.lineTo(-1 * k, 2.6 * k)
    ctx.stroke()
    // eye + horn amber
    ctx.fillStyle = '#1d1410'
    ctx.fillRect(0.4 * k, -2.4 * k, 1.6 * k, 1.6 * k)
    ctx.fillStyle = '#d48c47'
    ctx.fillRect(0.8 * k, -2.0 * k, 0.8 * k, 0.8 * k)
    ctx.fillRect(5.4 * k, -4.2 * k, 1.4 * k, 1.4 * k)
  }
  ctx.restore()

  return { canvas: c, w, h, ax, ay, mw, mh }
}

// ---------------------------------------------------------------------------
// Slot tick tile — 18 px glass diamond, dark teal top / pale steel bottom.
// ---------------------------------------------------------------------------

function bakeTick(S, dpr) {
  const s = Math.max(6, TICK_PX * S)
  const pad = 3
  const w = Math.ceil(s + pad * 2)
  const c = document.createElement('canvas')
  c.width = Math.max(2, Math.round(w * dpr))
  c.height = c.width
  const ctx = c.getContext('2d')
  ctx.scale(dpr, dpr)
  const ax = w / 2
  const hw = s / 2
  ctx.save()
  diamondPath(ctx, ax, ax, hw, hw)
  ctx.clip()
  let g = ctx.createLinearGradient(0, ax - hw, 0, ax)
  g.addColorStop(0, C.tickTop0)
  g.addColorStop(1, C.tickTop1)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, ax)
  g = ctx.createLinearGradient(0, ax, 0, ax + hw)
  g.addColorStop(0, C.tickBot)
  g.addColorStop(1, '#7f98a2')
  ctx.fillStyle = g
  ctx.fillRect(0, ax, w, ax)
  ctx.restore()
  diamondPath(ctx, ax, ax, hw, hw)
  ctx.lineWidth = 1
  ctx.strokeStyle = C.tickEdge
  ctx.stroke()
  return { canvas: c, w, ax, ay: ax }
}

// ---------------------------------------------------------------------------
// createTimeline
// ---------------------------------------------------------------------------

const CSS_ID = 'bt-timeline-css'
const CSS = `
#bt-timeline{position:absolute;left:0;top:0;right:0;height:22%;pointer-events:none;overflow:visible;}
#bt-timeline canvas{position:absolute;left:0;top:0;display:block;}
`

export function createTimeline({ units }) {
  // ---- DOM ----------------------------------------------------------------
  if (!document.getElementById(CSS_ID)) {
    const style = document.createElement('style')
    style.id = CSS_ID
    style.textContent = CSS
    document.head.appendChild(style)
  }
  const mount = document.getElementById('ui') || document.body
  const root = document.createElement('div')
  root.id = 'bt-timeline'
  const canvas = document.createElement('canvas')
  root.appendChild(canvas)
  mount.appendChild(root)
  const ctx = canvas.getContext('2d')

  const roster = (units && units.roster) || []
  const enemy = units && units.enemy
  const enemyKind = enemy && /drag/i.test(enemy.id || '') ? 'dragon'
    : enemy && /sorc|sage|grim/i.test((enemy.id || '') + (enemy.name || '')) ? 'sorcerer'
    : (enemy ? 'sorcerer' : 'dragon')

  // one bust cell canvas per unit (id-keyed, painted once)
  const bustCells = {}
  for (const u of roster) bustCells[u.id] = bakeBustCells(u.id)

  // ---- layout + tile cache ------------------------------------------------
  const layout = { vw: 0, vh: 0, dpr: 1, s: 1, sy: 1, ch: 0 }
  const tiles = { active: {}, seat: {}, queue: {}, marker: null, tick: null }
  let veil = null

  function relayout() {
    const vw = window.innerWidth || 1600
    const vh = window.innerHeight || 900
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2.5)
    if (vw === layout.vw && vh === layout.vh && dpr === layout.dpr) return
    layout.vw = vw
    layout.vh = vh
    layout.dpr = dpr
    layout.s = vw / 1630            // bible px are quoted at 1630×921
    layout.sy = vh / 921
    layout.ch = Math.ceil(vh * 0.22)  // canvas band (glow bleed included)
    canvas.width = Math.round(vw * dpr)
    canvas.height = Math.round(layout.ch * dpr)
    canvas.style.width = vw + 'px'
    canvas.style.height = layout.ch + 'px'
    rebake()
  }

  function rebake() {
    const { s, dpr } = layout
    for (const u of roster) {
      tiles.active[u.id] = bakePortrait(bustCells[u.id], Math.max(28, ACTIVE_PX * s), 'active', dpr)
      tiles.seat[u.id] = bakePortrait(bustCells[u.id], Math.max(16, SEAT_PX * s), 'seat', dpr)
      tiles.queue[u.id] = bakePortrait(bustCells[u.id], Math.max(12, QUEUE_PX * s), 'queue', dpr)
    }
    tiles.marker = bakeMarker(enemyKind, s, dpr)
    tiles.tick = bakeTick(s, dpr)

    // the teal wake veil above the left half of the track (baked strip)
    const vwPx = Math.max(2, Math.round((0.62 - TRACK_X0) * layout.vw))
    const vhPx = 24
    veil = document.createElement('canvas')
    veil.width = Math.max(2, Math.round(vwPx * dpr))
    veil.height = Math.max(2, Math.round(vhPx * dpr))
    const vc = veil.getContext('2d')
    vc.scale(dpr, dpr)
    const gv = vc.createLinearGradient(0, 0, 0, vhPx)
    gv.addColorStop(0, 'rgba(56,118,132,0)')
    gv.addColorStop(0.7, 'rgba(62,128,142,0.50)')
    gv.addColorStop(1, 'rgba(70,140,154,0.62)')
    vc.fillStyle = gv
    vc.fillRect(0, 0, vwPx, vhPx)
    // fade the band out toward the right (the wake trails the active seat)
    vc.globalCompositeOperation = 'destination-out'
    const gh = vc.createLinearGradient(0, 0, vwPx, 0)
    gh.addColorStop(0, 'rgba(0,0,0,0)')
    gh.addColorStop(0.55, 'rgba(0,0,0,0.25)')
    gh.addColorStop(1, 'rgba(0,0,0,1)')
    vc.fillStyle = gh
    vc.fillRect(0, 0, vwPx, vhPx)
    veil._w = vwPx
    veil._h = vhPx
  }

  // ---- appearance tween store --------------------------------------------
  // key → { x (fw), slide: {from,to,t}|null, alpha, born, dying }
  const store = new Map()

  function stepEntry(key, targetX, dt) {
    let e = store.get(key)
    if (!e) {
      e = { x: targetX, slide: null, alpha: 0, born: true, dying: false }
      store.set(key, e)
    }
    e.seen = true
    e.dying = false
    // position: drift follows exactly; re-sort jumps slide 240 ms cubic-out
    if (e.slide) {
      e.slide.to = targetX
      e.slide.t += dt
      const q = clamp(e.slide.t / SLIDE_S, 0, 1)
      e.x = lerp(e.slide.from, e.slide.to, easeOutCubic(q))
      if (q >= 1) { e.slide = null; e.x = targetX }
    } else if (Math.abs(targetX - e.x) > SLIDE_TRIGGER) {
      e.slide = { from: e.x, to: targetX, t: 0 }
    } else {
      e.x = targetX
    }
    e.alpha = clamp(e.alpha + dt / 0.15, 0, 1)
    return e
  }

  function sweepEntries(dt) {
    for (const [key, e] of store) {
      if (e.seen) { e.seen = false; continue }
      e.dying = true
      e.alpha -= dt / 0.20
      if (e.alpha <= 0) store.delete(key)
    }
  }

  // ---- active-seat state --------------------------------------------------
  let activeId = null
  let flashT = 99
  let morphT = 99
  const seatState = [
    { id: null, mx: SEAT_A[0], my: SEAT_A[1], t: 99 },   // seat A
    { id: null, mx: SEAT_B[0], my: SEAT_B[1], t: 99 },   // seat B
  ]

  let tNow = 0

  // ---- draw helpers -------------------------------------------------------

  function drawTile(tile, cx, cy, scale, alpha) {
    if (!tile || alpha <= 0.004) return
    const dpr = layout.dpr
    const w = (tile.canvas.width / dpr) * scale
    const h = (tile.canvas.height / dpr) * scale
    ctx.globalAlpha = alpha
    ctx.drawImage(tile.canvas, cx - tile.ax * scale, cy - tile.ay * scale, w, h)
    ctx.globalAlpha = 1
  }

  function shrinkDim(xf) {
    const k = clamp((xf - SHRINK_X0) / (RULER_X_CULL - SHRINK_X0), 0, 1)
    return { scale: 1 - 0.30 * k, alpha: 1 - 0.55 * k }
  }

  // ---- per-frame ----------------------------------------------------------

  function update(dt) {
    const step = typeof dt === 'number' && isFinite(dt) ? clamp(dt, 0, 0.5) : 0.016
    tNow += step
    relayout()

    const { vw, vh, s, dpr } = layout
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, vw, layout.ch)

    const railY = RAIL_Y * vh

    // ---------------- data: who is where ----------------
    const living = []
    for (const u of roster) if (alive(u)) living.push(u)
    living.sort((a, b) => a.queueEta - b.queueEta)

    const act = living[0] || null
    if (act && act.id !== activeId) {
      // §7.1: the arriving portrait morphs into the active diamond with a
      // 90 ms white flash (and a 240 ms scale morph so it never teleports)
      activeId = act.id
      flashT = 0
      morphT = 0
    }
    flashT += step
    morphT += step

    // party seats: eta order #2 and #3; B only when the queue is dense
    const seatA = living[1] || null
    const seatB = living[2] && living[2].queueEta < SEATB_MAX_ETA ? living[2] : null
    for (let i = 0; i < 2; i++) {
      const occ = i === 0 ? seatA : seatB
      const st = seatState[i]
      const id = occ ? occ.id : null
      if (id !== st.id) { st.id = id; st.t = 0 }
      st.t += step
    }

    // max party eta → the active unit's next-round re-entry (his rail ghost —
    // frame04's fourth cluster portrait is exactly this)
    let maxEta = 0
    for (const u of living) if (u.queueEta > maxEta) maxEta = u.queueEta

    // ---------------- chrome: veil, track, ticks ----------------
    if (veil) {
      ctx.drawImage(veil, TRACK_X0 * vw, railY - veil._h + 2, veil._w, veil._h)
    }

    // track: 3 px #aebfc6 @80 %, 1 px darker under-edge, end fade
    const x0 = TRACK_X0 * vw
    const x1 = TRACK_X1 * vw
    const fade0 = (TRACK_X1 - TRACK_FADE) * vw
    let g = ctx.createLinearGradient(x0, 0, x1, 0)
    g.addColorStop(0, C.track)
    g.addColorStop(clamp((fade0 - x0) / (x1 - x0), 0, 1), C.track)
    g.addColorStop(1, 'rgba(174,191,198,0)')
    const th = Math.max(2, 3 * layout.sy)
    ctx.fillStyle = g
    ctx.fillRect(x0, railY - th / 2, x1 - x0, th)
    // bright top row + darker under-edge (the sampled 82/83/84 rows)
    let g2 = ctx.createLinearGradient(x0, 0, x1, 0)
    g2.addColorStop(0, C.trackHi)
    g2.addColorStop(clamp((fade0 - x0) / (x1 - x0), 0, 1), C.trackHi)
    g2.addColorStop(1, 'rgba(214,226,231,0)')
    ctx.fillStyle = g2
    ctx.fillRect(x0, railY - th / 2, x1 - x0, 1)
    let g3 = ctx.createLinearGradient(x0, 0, x1, 0)
    g3.addColorStop(0, C.trackUnder)
    g3.addColorStop(clamp((fade0 - x0) / (x1 - x0), 0, 1), C.trackUnder)
    g3.addColorStop(1, 'rgba(38,50,58,0)')
    ctx.fillStyle = g3
    ctx.fillRect(x0, railY + th / 2, x1 - x0, 1)

    // slot ticks
    if (tiles.tick) {
      for (let xf = TICK_X0; xf < TRACK_X1 - 0.008; xf += TICK_PITCH) {
        const endK = clamp((TRACK_X1 - xf) / TRACK_FADE, 0, 1)
        drawTile(tiles.tick, xf * vw, railY, 1, 0.9 * endK)
      }
    }

    // ---------------- enemy markers (below the rail) ----------------
    if (enemy && alive(enemy) && tiles.marker) {
      const e0 = Math.max(0, enemy.queueEta || 0)
      const etas = [e0, e0 + ENEMY_DOUBLE_GAP]
      for (let i = 0; i < etas.length; i++) {
        const eta = etas[i]
        const xf = clamp(rulerX(eta), 0.090, RULER_X_CULL)
        if (xf >= RULER_X_CULL) continue
        const e = stepEntry('e' + i, xf, step)
        const sd = shrinkDim(e.x)
        // imminent: the marker swells and pulses at the rail head
        // (frame05's sorcerer hanging under the active seat)
        const imm = i === 0 ? clamp(1 - eta / 1.5, 0, 1) : 0
        const scale = sd.scale * (1 + 0.45 * imm)
        const my = MARKER_Y * vh + imm * 4 * layout.sy
        const mx = e.x * vw
        // hanger tab to the rail underside
        ctx.fillStyle = C.hanger
        const tabW = Math.max(1.5, 3 * s)
        ctx.globalAlpha = e.alpha * sd.alpha
        ctx.beginPath()
        ctx.moveTo(mx - tabW, railY + 1)
        ctx.lineTo(mx + tabW, railY + 1)
        ctx.lineTo(mx, my - (MARKER_H * s * scale) / 2 + 2)
        ctx.closePath()
        ctx.fill()
        ctx.globalAlpha = 1
        if (imm > 0.01) {
          const pulse = 0.5 + 0.5 * Math.sin(tNow * 7)
          ctx.save()
          ctx.globalCompositeOperation = 'lighter'
          const gr = ctx.createRadialGradient(mx, my, 1, mx, my, MARKER_W * s * (1 + imm))
          gr.addColorStop(0, `rgba(220,70,90,${0.35 * imm * (0.6 + 0.4 * pulse)})`)
          gr.addColorStop(1, 'rgba(220,70,90,0)')
          ctx.fillStyle = gr
          ctx.fillRect(mx - MARKER_W * s * 2, my - MARKER_W * s * 2, MARKER_W * s * 4, MARKER_W * s * 4)
          ctx.restore()
        }
        drawTile(tiles.marker, mx, my, scale, e.alpha * sd.alpha)
      }
    }

    // ---------------- queue portraits on the rail ----------------
    // build target list: every living party unit except the active, plus the
    // active unit's next-round ghost; draw right→left so sooner turns overlap
    const rail = []
    for (const u of living) {
      if (u === act) continue
      rail.push({ key: 'p:' + u.id, id: u.id, eta: u.queueEta, ghost: false })
    }
    if (act) {
      const gEta = maxEta + GHOST_GAP
      if (rulerX(gEta) < RULER_X_CULL) {
        rail.push({ key: 'g:' + act.id, id: act.id, eta: gEta, ghost: true })
      }
    }
    const drawn = []
    for (const r of rail) {
      const xf = rulerX(Math.max(0, r.eta))
      if (xf >= RULER_X_CULL) continue
      const e = stepEntry(r.key, xf, step)
      drawn.push({ e, id: r.id, ghost: r.ghost })
    }
    drawn.sort((a, b) => b.e.x - a.e.x)
    const qHalf = (QUEUE_PX * s) / 2
    for (const d of drawn) {
      const sd = shrinkDim(d.e.x)
      const a = d.e.alpha * sd.alpha * (d.ghost ? 0.85 : 1)
      const cy = railY - qHalf * sd.scale + 2 * layout.sy   // bottom vertex kisses the line
      drawTile(tiles.queue[d.id], d.e.x * vw, cy, sd.scale * (d.ghost ? 0.94 : 1), a)
    }
    sweepEntries(step)

    // ---------------- next-up seats ----------------
    for (let i = 1; i >= 0; i--) {
      const st = seatState[i]
      if (!st.id || !tiles.seat[st.id]) continue
      // morph in from the rail head over 240 ms (never teleports)
      const q = easeOutCubic(clamp(st.t / SLIDE_S, 0, 1))
      const fromX = RULER_X_HEAD * vw
      const fromY = railY - qHalf
      const cx = lerp(fromX, st.mx * vw, q)
      const cy = lerp(fromY, st.my * vh, q)
      const sc = lerp(QUEUE_PX / SEAT_PX, 1, q)
      // seat drop-nub on the rail below (its anchor tick)
      if (q > 0.6 && i === 0) {
        ctx.fillStyle = C.nub
        ctx.globalAlpha = (q - 0.6) / 0.4 * 0.9
        const nw = 6 * s
        ctx.beginPath()
        ctx.moveTo(st.mx * vw - nw, railY - 1)
        ctx.lineTo(st.mx * vw + nw, railY - 1)
        ctx.lineTo(st.mx * vw, railY + 5 * layout.sy)
        ctx.closePath()
        ctx.fill()
        ctx.globalAlpha = 1
      }
      drawTile(tiles.seat[st.id], cx, cy, sc, Math.min(1, q * 1.6))
    }

    // ---------------- the active diamond ----------------
    if (activeId && tiles.active[activeId]) {
      const cx = ACTIVE_CX * vw
      const cy = ACTIVE_CY * vh
      const morph = 0.55 + 0.45 * easeOutCubic(clamp(morphT / SLIDE_S, 0, 1))
      drawTile(tiles.active[activeId], cx, cy, morph, 1)
      // 90 ms arrival flash — white diamond overlay
      if (flashT < FLASH_S) {
        const k = 1 - flashT / FLASH_S
        const half = (ACTIVE_PX * s * morph) / 2
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        diamondPath(ctx, cx, cy, half, half)
        ctx.fillStyle = `rgba(255,255,255,${0.85 * k})`
        ctx.fill()
        ctx.restore()
      }
      // faint idle shimmer on the lower glow (keeps the seat alive)
      const shim = 0.5 + 0.5 * Math.sin(tNow * 2.1)
      const half = (ACTIVE_PX * s) / 2
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      const gr = ctx.createRadialGradient(cx, cy + half * 0.8, 1, cx, cy + half * 0.8, half * 0.8)
      gr.addColorStop(0, C.glowCyan + (0.10 + 0.08 * shim) + ')')
      gr.addColorStop(1, C.glowCyan + '0)')
      ctx.fillStyle = gr
      ctx.fillRect(cx - half * 1.6, cy, half * 3.2, half * 1.8)
      ctx.restore()
    }
  }

  // prime one frame so the very first render is fully populated
  relayout()
  update(0)

  return { dom: root, update }
}
