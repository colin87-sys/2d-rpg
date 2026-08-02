// ---------------------------------------------------------------------------
// src/world/props.js — Aetherbound overworld landmarks
//
// Hand-built diorama architecture derived from terrain.meta.poi, matched to
// docs/reference/frame01.png:
//
//   castle  — cream gothic keep on a balustraded motte behind a grey
//             crenellated curtain wall: huge frontal cobalt gable with an
//             arched tracery window, twin facade towers, asymmetric round
//             spires (tallest tip 6.5 m), gatehouse with arch + raised
//             portcullis, buttresses, gold finials, wind-waved pennants,
//             and a flagstone stair approach that meets the road.
//   village — 11 houses of 4 plans (plaster / timber-framed), slate tile
//             roofs with ridge caps and chimneys, well, red-awning market
//             stall, barrels, a few warm lit windows.
//   shrine  — vermilion torii (shimenawa + paper shide), stone lanterns,
//             tiled shrine hall on a stepped stone base.
//   bridges — west timber trestle (post-and-rail, sagging plank deck, per
//             ART_BIBLE §10.7 and the frame01 upper-left crossing), the
//             north gorge rope suspension bridge (catenary mains, hangers,
//             individually placed planks), and a small stone arch
//             footbridge over the river east of the castle.
//   farm    — two-rail fences tracing the road-facing arcs of the wheat
//             paddocks (each post samples terrain, rails follow the slope),
//             a barn with lean-to, hay bales, a cart.
//   camp    — canvas tent, stone fire ring with animated flame + point
//             light + additive glow, crates, a log bench.
//   extras  — signposts at forks, road milestones, a coastal pier with a
//             moored rowboat, soft contact-shadow blobs under everything.
//
// Every texture is painted in Canvas2D at runtime (masonry, cobalt roof,
// slate, shingles, planks, plaster, timber framing, hay, canvas, flag
// stone). All geometry merges into one mesh per material (~20 draw calls).
//
// Contract: export function createProps({ terrain, atlas, renderer }): Props
//           Props = { object3D, update(t, camera) }   — signature frozen.
// ---------------------------------------------------------------------------

import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

// ===========================================================================
// 1. Utilities
// ===========================================================================

const TAU = Math.PI * 2
const HPI = Math.PI / 2

function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function rgb(hex) {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255]
}
function css(c) {
  return 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')'
}
function mixc(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}
function shade(c, s) {
  return [Math.min(255, c[0] * s), Math.min(255, c[1] * s), Math.min(255, c[2] * s)]
}

// ART_BIBLE §3 — architecture & prop palette (authored sRGB albedo)
const PAL = {
  KEEP_LIT: rgb(0xe8e3d3),
  KEEP_MID: rgb(0xd6d0bd),
  KEEP_DARK: rgb(0xb2ad9b),
  KEEP_MORTAR: rgb(0x9b9787),
  CURT_LIT: rgb(0xbfc5b2),
  CURT_MID: rgb(0x9aa392),
  CURT_DARK: rgb(0x77816f),
  CURT_MORTAR: rgb(0x525d4c),
  MOSS: rgb(0x5c7048),
  COBALT_LIT: rgb(0x5477c8),
  COBALT: rgb(0x35549c),
  COBALT_DARK: rgb(0x232f56),
  COBALT_SPEC: rgb(0xb9c6e4),
  SLATE: rgb(0x3f4450),
  SLATE_DARK: rgb(0x25272e),
  SLATE_CHIP: rgb(0x9aa0a8),
  SHINGLE: rgb(0x6f4530),
  SHINGLE_DARK: rgb(0x38221a),
  SHINGLE_CHIP: rgb(0x9a6a45),
  WOOD_DARK: rgb(0x5d4226),
  WOOD_MID: rgb(0x7b5c3a),
  PLASTER: rgb(0xd9c9a8),
  TIMBER: rgb(0x55402a),
  STONE_LIT: rgb(0x9aa38c),
  STONE_MID: rgb(0x7d8a76),
  STONE_DARK: rgb(0x5f6d5f),
  STONE_MORTAR: rgb(0x3f4a42),
  HAY_BASE: rgb(0xc9a34f),
  HAY_LIT: rgb(0xe0c26e),
  HAY_TIP: rgb(0xeed794),
  HAY_DARK: rgb(0x8a6a2e),
  CANVAS: rgb(0xe8dcc0),
  RED: rgb(0xb0453c),
  RED_DARK: rgb(0x86322b),
}

// ===========================================================================
// 2. Canvas2D texture painters — every map is authored here at runtime
// ===========================================================================

function canvasTex(size, aniso, painter) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  painter(c.getContext('2d'), size)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.magFilter = THREE.NearestFilter
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.generateMipmaps = true
  t.anisotropy = aniso
  return t
}

// A rect that wraps across the horizontal tile seam.
function wrapRect(g, S, x, y, w, h) {
  g.fillRect(x, y, w, h)
  if (x < 0) g.fillRect(x + S, y, w, h)
  if (x + w > S) g.fillRect(x - S, y, w, h)
}

// Coursed masonry: running-bond blocks, per-block tint, bevelled edges,
// grime pooling at block feet, chips, cracks, optional moss at low courses.
function paintMasonry(g, S, rnd, o) {
  g.fillStyle = css(o.mortar)
  g.fillRect(0, 0, S, S)
  const rows = Math.round(S / o.courseH)
  const ch = S / rows
  for (let r = 0; r < rows; r++) {
    const y = r * ch
    let x = -((r % 2) * o.blockW * 0.5 + rnd() * 6)
    while (x < S) {
      const bw = o.blockW * (0.75 + rnd() * 0.6)
      let base = mixc(o.lit, o.mid, Math.pow(rnd(), 1.4))
      if (rnd() < 0.1) base = mixc(o.mid, o.dark, 0.4 + rnd() * 0.5)
      // slight hue wobble so courses never read flat
      base = mixc(base, [base[0] + 8, base[1] + 4, base[2] - 6], rnd() * 0.5)
      g.fillStyle = css(base)
      wrapRect(g, S, x + 1, y + 1, bw - 2, ch - 2)
      g.fillStyle = css(shade(base, 1.14))
      wrapRect(g, S, x + 1, y + 1, bw - 2, 1.6) // top bevel catches light
      g.fillStyle = css(shade(base, 1.07))
      wrapRect(g, S, x + 1, y + 1, 1.4, ch - 2) // left bevel
      g.fillStyle = css(shade(base, 0.78))
      wrapRect(g, S, x + 1, y + ch - 2.6, bw - 2, 1.6) // foot shadow
      g.fillStyle = css(shade(base, 0.88))
      wrapRect(g, S, x + bw - 2.4, y + 1, 1.4, ch - 2) // right shade
      if (rnd() < o.chip) {
        g.fillStyle = css(shade(base, 1.2))
        wrapRect(g, S, x + 2 + rnd() * (bw - 8), y + 2, 2 + rnd() * 3, 1.5)
      }
      if (rnd() < o.grime) {
        g.globalAlpha = 0.22 + rnd() * 0.2
        g.fillStyle = css(shade(o.dark, 0.62))
        wrapRect(g, S, x + 2 + rnd() * bw * 0.4, y + ch * 0.55, bw * (0.3 + rnd() * 0.3), ch * 0.4)
        g.globalAlpha = 1
      }
      if (rnd() < 0.05) {
        g.strokeStyle = css(shade(o.mortar, 0.75))
        g.lineWidth = 1
        g.beginPath()
        const cx = x + bw * (0.3 + rnd() * 0.4)
        g.moveTo(cx, y + 2)
        g.lineTo(cx + (rnd() - 0.5) * 6, y + ch * 0.6)
        g.stroke()
      }
      if (o.moss && r > rows * 0.55 && rnd() < 0.3) {
        g.globalAlpha = 0.24 + rnd() * 0.22
        g.fillStyle = css(o.moss)
        wrapRect(g, S, x + rnd() * bw * 0.5, y + ch * (0.4 + rnd() * 0.4), bw * (0.25 + rnd() * 0.4), ch * 0.5)
        g.globalAlpha = 1
      }
      x += bw
    }
  }
  // large-scale value patches kill any wallpaper read
  for (let i = 0; i < 5; i++) {
    g.globalAlpha = 0.05
    g.fillStyle = i % 2 ? '#000000' : '#ffffff'
    const px = rnd() * S
    const py = rnd() * S
    const pr = S * (0.2 + rnd() * 0.25)
    for (let ox = -1; ox <= 1; ox++)
      for (let oy = -1; oy <= 1; oy++) {
        g.beginPath()
        g.arc(px + ox * S, py + oy * S, pr, 0, TAU)
        g.fill()
      }
    g.globalAlpha = 1
  }
}

// Roof tiles / shingles: offset rows of tiles, tint jitter, dark undersides,
// bright chipped leading edges. Used for slate (village) and shingle (barn).
function paintTiles(g, S, rnd, o) {
  g.fillStyle = css(o.gap)
  g.fillRect(0, 0, S, S)
  const rows = Math.round(S / o.rowH)
  const rh = S / rows
  for (let r = 0; r < rows; r++) {
    const y = r * rh
    let x = -((r % 2) * o.tileW * 0.5 + rnd() * 4)
    while (x < S) {
      const tw = o.tileW * (0.85 + rnd() * 0.3)
      let base = mixc(o.lit, o.dark, Math.pow(rnd(), 1.2) * 0.85)
      base = mixc(base, [base[0] + 6, base[1] + 2, base[2] - 4], rnd() * 0.4)
      g.fillStyle = css(base)
      wrapRect(g, S, x + 0.8, y, tw - 1.6, rh - 2)
      g.fillStyle = css(shade(base, 1.16))
      wrapRect(g, S, x + 0.8, y, tw - 1.6, 1.6) // lit leading edge
      g.fillStyle = css(shade(base, 0.72))
      wrapRect(g, S, x + 0.8, y + rh - 3.4, tw - 1.6, 1.6) // under-shadow
      if (rnd() < 0.16) {
        g.fillStyle = css(o.chip)
        g.globalAlpha = 0.75
        wrapRect(g, S, x + 1.5 + rnd() * (tw - 6), y + 0.5, 2 + rnd() * 2.5, 1.4)
        g.globalAlpha = 1
      }
      if (o.moss && rnd() < 0.06) {
        g.globalAlpha = 0.35
        g.fillStyle = css(PAL.MOSS)
        wrapRect(g, S, x + rnd() * tw * 0.6, y + rnd() * rh * 0.5, 3, 2.4)
        g.globalAlpha = 1
      }
      x += tw
    }
  }
}

// Cobalt spire roofing: vertical panel strips with shingle courses, a few
// near-white specular streak panels (the plate's signature roof glints).
function paintCobalt(g, S, rnd) {
  g.fillStyle = css(PAL.COBALT)
  g.fillRect(0, 0, S, S)
  const stripW = 18
  const rowH = 24
  for (let x = 0; x < S; x += stripW) {
    let base = mixc(PAL.COBALT, PAL.COBALT_LIT, Math.pow(rnd(), 1.3) * 0.9)
    if (rnd() < 0.12) base = mixc(PAL.COBALT, PAL.COBALT_DARK, 0.45)
    g.fillStyle = css(base)
    g.fillRect(x, 0, stripW - 1, S)
    g.fillStyle = css(shade(base, 1.12))
    g.fillRect(x, 0, 1.6, S) // strip edge catch-light
    const off = (x / stripW) % 2 ? rowH * 0.5 : 0
    for (let y = -rowH; y < S + rowH; y += rowH) {
      const yy = y + off
      g.fillStyle = css(mixc(base, PAL.COBALT_DARK, 0.75))
      g.fillRect(x, ((yy % S) + S) % S, stripW - 1, 2) // course shadow line
      g.fillStyle = css(shade(base, 1.1))
      g.fillRect(x + 1, (((yy + 2) % S) + S) % S, stripW * 0.55, 1.2)
      if (rnd() < 0.1) {
        g.globalAlpha = 0.25
        g.fillStyle = css(PAL.COBALT_DARK)
        g.fillRect(x + 2, (((yy + 4) % S) + S) % S, stripW - 5, rowH * 0.6)
        g.globalAlpha = 1
      }
    }
    if (rnd() < 0.2) {
      g.globalAlpha = 0.5
      g.fillStyle = css(PAL.COBALT_SPEC)
      g.fillRect(x + 2, 0, 2.6, S) // specular flute streak
      g.globalAlpha = 0.22
      g.fillRect(x + 5, 0, 2, S)
      g.globalAlpha = 1
    }
  }
}

// Vertical planking with grain, knots and per-plank tone.
function paintWood(g, S, rnd, base, contrast) {
  g.fillStyle = css(shade(base, 0.55))
  g.fillRect(0, 0, S, S)
  const pw = 16
  for (let x = 0; x < S; x += pw) {
    const tone = shade(base, 1 - contrast * 0.5 + rnd() * contrast)
    g.fillStyle = css(tone)
    g.fillRect(x + 1, 0, pw - 2, S)
    for (let i = 0; i < 7; i++) {
      g.globalAlpha = 0.14 + rnd() * 0.12
      g.strokeStyle = css(shade(tone, rnd() < 0.7 ? 0.72 : 1.25))
      g.lineWidth = 1
      g.beginPath()
      const gx = x + 2 + rnd() * (pw - 4)
      g.moveTo(gx, 0)
      for (let y = 0; y <= S; y += S / 6) g.lineTo(gx + Math.sin(y * 0.05 + rnd() * 6) * 1.6, y)
      g.stroke()
      g.globalAlpha = 1
    }
    if (rnd() < 0.5) {
      const kx = x + 3 + rnd() * (pw - 7)
      const ky = rnd() * S
      g.fillStyle = css(shade(tone, 0.55))
      g.beginPath()
      g.ellipse(kx, ky, 2.2, 3.2, 0, 0, TAU)
      g.fill()
      g.strokeStyle = css(shade(tone, 0.8))
      g.beginPath()
      g.ellipse(kx, ky, 3.4, 4.6, 0, 0, TAU)
      g.stroke()
    }
    if (rnd() < 0.4) {
      g.fillStyle = css(shade(tone, 0.7))
      g.fillRect(x + 1, rnd() * S, pw - 2, 1.4) // butt joint
    }
  }
}

// Weathered plaster: mottle, speckle, hairline cracks, damp foot band.
function paintPlaster(g, S, rnd) {
  g.fillStyle = css(PAL.PLASTER)
  g.fillRect(0, 0, S, S)
  for (let i = 0; i < 14; i++) {
    g.globalAlpha = 0.05
    g.fillStyle = i % 2 ? css(shade(PAL.PLASTER, 0.8)) : css(shade(PAL.PLASTER, 1.12))
    g.beginPath()
    g.arc(rnd() * S, rnd() * S, S * (0.1 + rnd() * 0.2), 0, TAU)
    g.fill()
    g.globalAlpha = 1
  }
  for (let i = 0; i < 420; i++) {
    g.globalAlpha = 0.1 + rnd() * 0.08
    g.fillStyle = rnd() < 0.6 ? css(shade(PAL.PLASTER, 0.82)) : css(shade(PAL.PLASTER, 1.14))
    g.fillRect(rnd() * S, rnd() * S, 1.4, 1.4)
    g.globalAlpha = 1
  }
  for (let i = 0; i < 4; i++) {
    g.globalAlpha = 0.28
    g.strokeStyle = css(shade(PAL.PLASTER, 0.6))
    g.lineWidth = 1
    g.beginPath()
    let cx = rnd() * S
    let cy = rnd() * S * 0.5
    g.moveTo(cx, cy)
    for (let s = 0; s < 4; s++) {
      cx += (rnd() - 0.5) * 14
      cy += 8 + rnd() * 14
      g.lineTo(cx, cy)
    }
    g.stroke()
    g.globalAlpha = 1
  }
  const grad = g.createLinearGradient(0, S, 0, S * 0.8)
  grad.addColorStop(0, 'rgba(96,84,58,0.30)')
  grad.addColorStop(1, 'rgba(96,84,58,0)')
  g.fillStyle = grad
  g.fillRect(0, S * 0.8, S, S * 0.2) // rising damp at the wall foot (v=0)
}

// Timber-framed plaster: sill, posts, one brace per bay.
function paintTimber(g, S, rnd) {
  paintPlaster(g, S, rnd)
  const beam = css(PAL.TIMBER)
  const beamLit = css(shade(PAL.TIMBER, 1.25))
  const bay = 52
  g.fillStyle = beam
  g.fillRect(0, S - 13, S, 13) // sill at the wall foot
  g.fillStyle = beamLit
  g.fillRect(0, S - 13, S, 1.6)
  for (let x = 0; x < S; x += bay) {
    g.fillStyle = beam
    g.fillRect(x, 0, 9, S)
    g.fillStyle = beamLit
    g.fillRect(x, 0, 1.6, S)
    // diagonal brace
    g.strokeStyle = beam
    g.lineWidth = 8
    g.beginPath()
    if (rnd() < 0.5) {
      g.moveTo(x + 9, S - 13)
      g.lineTo(x + bay, S * (0.25 + rnd() * 0.2))
    } else {
      g.moveTo(x + bay, S - 13)
      g.lineTo(x + 9, S * (0.25 + rnd() * 0.2))
    }
    g.stroke()
  }
}

// Directional straw for hay bales.
function paintHay(g, S, rnd) {
  g.fillStyle = css(PAL.HAY_BASE)
  g.fillRect(0, 0, S, S)
  const cols = [PAL.HAY_LIT, PAL.HAY_BASE, PAL.HAY_DARK, PAL.HAY_TIP, shade(PAL.HAY_DARK, 0.8)]
  for (let i = 0; i < 1500; i++) {
    const x = rnd() * S
    const y = rnd() * S
    const len = 5 + rnd() * 11
    const lean = (rnd() - 0.5) * 0.5
    g.strokeStyle = css(cols[(rnd() * cols.length) | 0])
    g.globalAlpha = 0.55 + rnd() * 0.4
    g.lineWidth = 1
    for (let ox = -1; ox <= 1; ox++)
      for (let oy = -1; oy <= 1; oy++) {
        g.beginPath()
        g.moveTo(x + ox * S, y + oy * S)
        g.lineTo(x + Math.sin(lean) * len + ox * S, y + Math.cos(lean) * len + oy * S)
        g.stroke()
      }
    g.globalAlpha = 1
  }
}

// Tent canvas: weave, seams with stitches, patched repairs.
function paintCanvas(g, S, rnd) {
  g.fillStyle = css(PAL.CANVAS)
  g.fillRect(0, 0, S, S)
  g.globalAlpha = 0.045
  g.fillStyle = '#5b4a30'
  for (let y = 0; y < S; y += 3) g.fillRect(0, y, S, 1)
  for (let x = 0; x < S; x += 3) g.fillRect(x, 0, 1, S)
  g.globalAlpha = 1
  for (let i = 0; i < 2; i++) {
    const px = rnd() * S * 0.7
    const py = rnd() * S * 0.7
    g.fillStyle = css(shade(PAL.CANVAS, 0.93))
    g.fillRect(px, py, 26 + rnd() * 14, 20 + rnd() * 10)
  }
  for (const sx of [S * 0.33, S * 0.78]) {
    g.strokeStyle = 'rgba(90,74,48,0.5)'
    g.lineWidth = 1.4
    g.setLineDash([4, 3])
    g.beginPath()
    g.moveTo(sx, 0)
    g.lineTo(sx, S)
    g.stroke()
    g.setLineDash([])
  }
}

// Vermilion torii lacquer with grain and pale weathering.
function paintRed(g, S, rnd) {
  g.fillStyle = css(PAL.RED)
  g.fillRect(0, 0, S, S)
  for (let x = 0; x < S; x += 3) {
    g.globalAlpha = 0.1 + rnd() * 0.1
    g.fillStyle = rnd() < 0.7 ? css(PAL.RED_DARK) : css(shade(PAL.RED, 1.18))
    g.fillRect(x, 0, 1.4, S)
    g.globalAlpha = 1
  }
  for (let i = 0; i < 8; i++) {
    g.globalAlpha = 0.08
    g.fillStyle = '#e8cfa8'
    const x = rnd() * S
    g.fillRect(x, 0, 3 + rnd() * 5, S * (0.2 + rnd() * 0.4))
    g.globalAlpha = 1
  }
}

// Soft elliptical contact-shadow blob (white alpha mask; tint via vColor).
function paintBlob(g, S) {
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2)
  grad.addColorStop(0, 'rgba(255,255,255,0.66)')
  grad.addColorStop(0.55, 'rgba(255,255,255,0.42)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, S, S)
}

function paintGlow(g, S) {
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2)
  grad.addColorStop(0, 'rgba(255,170,80,0.6)')
  grad.addColorStop(0.4, 'rgba(255,130,50,0.24)')
  grad.addColorStop(1, 'rgba(255,110,40,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, S, S)
}

// ===========================================================================
// 3. Geometry kit — primitives with world-scaled UVs, merged per material
// ===========================================================================

// Scale a BoxGeometry's per-face UVs so `s` metres = one texture repeat.
function worldizeBoxUV(geo, w, h, d, s, u0, v0) {
  const dims = [
    [d, h], [d, h], [w, d], [w, d], [w, h], [w, h],
  ]
  const uv = geo.attributes.uv
  for (let f = 0; f < 6; f++) {
    const dw = dims[f][0] / s
    const dh = dims[f][1] / s
    for (let i = f * 4; i < f * 4 + 4; i++) {
      uv.setXY(i, uv.getX(i) * dw + u0, uv.getY(i) * dh + v0)
    }
  }
}

function autoU(x, y, z) {
  const v = x * 7.31 + z * 3.97 + y * 1.71
  return v - Math.floor(v)
}

// Shared finishing: optional rotations (Z, then X, then Y), then translate.
function gFinish(geo, x, y, z, o) {
  if (o.rz) geo.rotateZ(o.rz)
  if (o.rx) geo.rotateX(o.rx)
  if (o.ry) geo.rotateY(o.ry)
  geo.translate(x, y, z)
  return geo
}

// Box. Base-anchored on y unless o.c (centred). o.uv = metres per repeat.
function gBox(w, h, d, x, y, z, o = {}) {
  const geo = new THREE.BoxGeometry(w, h, d)
  const s = o.uv || 1.5
  worldizeBoxUV(geo, w, h, d, s, o.u0 !== undefined ? o.u0 : autoU(x, y, z), o.vlock ? 0 : (o.v0 || 0))
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

function gCone(r, h, seg, x, y, z, o = {}) {
  const geo = new THREE.ConeGeometry(r, h, seg)
  const s = o.uv || 1.5
  const uv = geo.attributes.uv
  const cu = (TAU * r * 0.5) / s
  const cv = Math.hypot(r, h) / s
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * cu, uv.getY(i) * cv)
  return gFinish(geo, x, o.c ? y : y + h / 2, z, o)
}

function gSphere(r, x, y, z, o = {}) {
  const geo = new THREE.SphereGeometry(r, o.seg || 8, o.seg ? o.seg - 2 : 6)
  return gFinish(geo, x, y, z, o)
}

function gTorus(r, tube, x, y, z, o = {}) {
  const geo = new THREE.TorusGeometry(r, tube, o.tseg || 6, o.seg || 12)
  return gFinish(geo, x, y, z, o)
}

// Triangular gable prism: base w on the ground, `rise` to the ridge, ridge
// running along local Z with length `depth`. Base-anchored at y.
function gPrism(w, rise, depth, x, y, z, o = {}) {
  const shp = new THREE.Shape()
  shp.moveTo(-w / 2, 0)
  shp.lineTo(w / 2, 0)
  shp.lineTo(0, rise)
  shp.closePath()
  const geo = new THREE.ExtrudeGeometry(shp, { depth, bevelEnabled: false })
  geo.translate(0, 0, -depth / 2)
  const s = o.uv || 1.5
  const uv = geo.attributes.uv
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / s, uv.getY(i) / s)
  return gFinish(geo, x, y, z, o)
}

// Wall slab with an arched opening (round-top portal), front face on +Z.
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

// Tube along a point list (used for ropes, rails, struts).
function gTube(pts, r, o = {}) {
  const curve = new THREE.CatmullRomCurve3(pts)
  return new THREE.TubeGeometry(curve, o.seg || Math.max(6, pts.length * 2), r, o.rad || 5, false)
}

function gLathe(profile, seg, x, y, z, o = {}) {
  const pts = profile.map((p) => new THREE.Vector2(p[0], p[1]))
  const geo = new THREE.LatheGeometry(pts, seg)
  return gFinish(geo, x, y, z, o)
}

// Catenary-ish sag between two points (parabolic dip, fine at these scales).
function catPts(ax, ay, az, bx, by, bz, sag, n) {
  const out = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    out.push(new THREE.Vector3(
      ax + (bx - ax) * t,
      ay + (by - ay) * t - sag * 4 * t * (1 - t),
      az + (bz - az) * t
    ))
  }
  return out
}

// Yaw that maps a box's length axis (+X) onto direction (ux, uz).
function yawX(ux, uz) {
  return Math.atan2(-uz, ux)
}

// Buckets: one geometry list per material key; addG normalises + transforms.
function addG(list, geo, frame) {
  let g = geo
  if (g.index) g = g.toNonIndexed()
  if (frame) g.applyMatrix4(frame)
  list.push(g)
}

// A `put` bound to a bucket set and an optional local frame (Matrix4).
function makePut(B, frame) {
  const A = (bk, g) => addG(B[bk], g, frame)
  return {
    box: (bk, w, h, d, x, y, z, o) => A(bk, gBox(w, h, d, x, y, z, o)),
    cyl: (bk, rT, rB, h, seg, x, y, z, o) => A(bk, gCyl(rT, rB, h, seg, x, y, z, o)),
    cone: (bk, r, h, seg, x, y, z, o) => A(bk, gCone(r, h, seg, x, y, z, o)),
    sphere: (bk, r, x, y, z, o) => A(bk, gSphere(r, x, y, z, o)),
    torus: (bk, r, tube, x, y, z, o) => A(bk, gTorus(r, tube, x, y, z, o)),
    prism: (bk, w, rise, depth, x, y, z, o) => A(bk, gPrism(w, rise, depth, x, y, z, o)),
    arch: (bk, w, h, t, aw, ah, x, y, z, o) => A(bk, gArchWall(w, h, t, aw, ah, x, y, z, o)),
    tube: (bk, pts, r, o) => A(bk, gTube(pts, r, o || {})),
    lathe: (bk, profile, seg, x, y, z, o) => A(bk, gLathe(profile, seg, x, y, z, o)),
    raw: (bk, g) => A(bk, g),
    world: (lx, ly, lz) => {
      const v = new THREE.Vector3(lx, ly, lz)
      if (frame) v.applyMatrix4(frame)
      return v
    },
  }
}

// Gable roof: two overhanging slabs + light ridge cap. Ridge along local Z.
// yEave = top of the walls; W = wall span across the ridge; D = wall depth.
function gableRoof(put, bkRoof, W, D, R, ovS, ovE, x, yEave, z, o = {}) {
  const th = Math.atan2(R, W / 2)
  const runX = W / 2 + ovS
  const drop = runX * (R / (W / 2))
  const L = Math.hypot(runX, drop) + 0.04
  const yr = yEave + R
  const dd = D + ovE * 2
  const thick = o.thick || 0.07
  for (const sgn of [1, -1]) {
    const cx = x + sgn * runX * 0.5
    const cy = yr - drop * 0.5 + thick * 0.4
    put.box(bkRoof, L, thick, dd, cx, cy, z, { rz: -sgn * th, c: true, uv: o.uv || 1.3 })
  }
  put.box(o.bkRidge || 'stoneBase', o.ridgeW || 0.13, 0.075, dd + 0.05, x, yr - 0.005, z, { uv: 0.6 })
  return yr
}

// Crenellated parapet run between two local points.
function crenels(put, bk, ax, az, bx, bz, y, o = {}) {
  const w = o.w || 0.3
  const h = o.h || 0.32
  const d = o.d || 0.2
  const pitch = o.pitch || 0.6
  const dx = bx - ax
  const dz = bz - az
  const L = Math.hypot(dx, dz)
  const ux = dx / L
  const uz = dz / L
  const yaw = yawX(ux, uz)
  const n = Math.max(2, Math.floor(L / pitch))
  for (let i = 0; i <= n; i++) {
    const t = (i + 0.5) / (n + 1)
    put.box(bk, w, h, d, ax + ux * t * L, y, az + uz * t * L, { ry: yaw, uv: 0.8 })
  }
}

// Balustrade: white rail on little posts (the plate's terrace strip).
function balustrade(put, bk, ax, az, bx, bz, y, o = {}) {
  const h = o.h || 0.3
  const dx = bx - ax
  const dz = bz - az
  const L = Math.hypot(dx, dz)
  const ux = dx / L
  const uz = dz / L
  const yaw = yawX(ux, uz)
  const n = Math.max(2, Math.round(L / (o.pitch || 0.34)))
  for (let i = 0; i <= n; i++) {
    const t = i / n
    put.cyl(bk, 0.026, 0.034, h - 0.06, 5, ax + ux * t * L, y, az + uz * t * L, {})
  }
  put.box(bk, L + 0.08, 0.055, 0.09, ax + dx * 0.5, y + h - 0.055, az + dz * 0.5, { ry: yaw, uv: 0.9 })
  put.box(bk, L + 0.08, 0.04, 0.07, ax + dx * 0.5, y - 0.01, az + dz * 0.5, { ry: yaw, uv: 0.9 })
}

// ===========================================================================
// 4. THE CASTLE — the frame's terminal focal point (frame01 right third)
//
// Proportions read off the plate: total base->tip 6.5 m over a 15 x 12 m
// octagonal curtain ring; low grey wall (~2.0 with merlons), white
// balustraded motte just proud of the wall top, cream keep with one huge
// frontal cobalt gable, twin facade towers, and asymmetric round spires.
// ===========================================================================

function buildCastle(ctx, poi) {
  const { B, T, meta, rnd, blob, pennant } = ctx
  const padY = T.height(poi.x, poi.z)

  // Gate axis: aim at the castle road's end, pulled toward the camera side
  // (south) so the facade fronts the shot like the plate.
  let ex = -2
  let ez = 1.5
  const road = (meta.roads || []).find((r) => r.name === 'castle')
  const LP = road && road.points.length ? road.points[road.points.length - 1] : null
  if (LP) {
    ex = LP.x - poi.x
    ez = LP.z - poi.z
  }
  let gl = Math.hypot(ex, ez) || 1
  let gdx = (ex / gl) * 0.62
  let gdz = (ez / gl) * 0.62 + 0.38
  gl = Math.hypot(gdx, gdz)
  gdx /= gl
  gdz /= gl
  const yaw = Math.atan2(gdx, gdz)
  const frame = new THREE.Matrix4().makeRotationY(yaw)
  frame.setPosition(poi.x, padY, poi.z)
  const put = makePut(B, frame)

  // ---- curtain wall: chamfered 15 x 12 octagon, gate opening on +Z -------
  const P = [
    [-7.5, 3.6], [-7.5, -3.6], [-5.1, -6], [5.1, -6],
    [7.5, -3.6], [7.5, 3.6], [5.1, 6], [-5.1, 6],
  ]
  const gx = 0.5
  const segs = []
  for (let i = 0; i < 8; i++) {
    if (i === 6) continue // front wall is split around the gatehouse
    segs.push([P[i], P[(i + 1) % 8]])
  }
  segs.push([P[6], [gx + 1.4, 6]])
  segs.push([[gx - 1.4, 6], P[7]])

  const WALL_H = 1.6
  for (const [a, b] of segs) {
    const dx = b[0] - a[0]
    const dz = b[1] - a[1]
    const L = Math.hypot(dx, dz)
    const ux = dx / L
    const uz = dz / L
    const mx = (a[0] + b[0]) / 2
    const mz = (a[1] + b[1]) / 2
    const wy = yawX(ux, uz)
    put.box('curtain', L + 0.15, WALL_H, 0.6, mx, 0, mz, { ry: wy, uv: 1.45, vlock: true })
    put.box('curtain', L + 0.15, 0.5, 0.84, mx, -0.22, mz, { ry: wy, uv: 1.45 })
    put.box('curtain', L + 0.15, 0.1, 0.8, mx, WALL_H, mz, { ry: wy, uv: 1.45 })
    // merlons ride the outer lip
    let nx = -uz
    let nz = ux
    if (nx * mx + nz * mz < 0) {
      nx = -nx
      nz = -nz
    }
    crenels(put, 'curtain', a[0] + nx * 0.29, a[1] + nz * 0.29, b[0] + nx * 0.29, b[1] + nz * 0.29,
      WALL_H + 0.1, { w: 0.3, h: 0.3, d: 0.19, pitch: 0.62 })
  }

  // ---- wall turrets with cobalt caps (heights all differ) ----------------
  const turret = (x, z, r, hb, hc, slits) => {
    put.cyl('curtain', r + 0.08, r + 0.17, 0.45, 10, x, -0.2, z, { uv: 1.2 })
    put.cyl('curtain', r * 0.93, r + 0.05, hb, 10, x, 0, z, { uv: 1.2, vlock: true })
    put.cyl('curtain', r + 0.12, r + 0.12, 0.06, 10, x, hb, z, {})
    put.cone('roofCobalt', r + 0.16, hc, 10, x, hb + 0.06, z, { uv: 1.1 })
    put.sphere('gold', 0.05, x, hb + hc + 0.1, z, {})
    put.cone('gold', 0.028, 0.13, 6, x, hb + hc + 0.13, z, {})
    if (slits) {
      const ol = Math.hypot(x, z) || 1
      const ox = x / ol
      const oz = z / ol
      put.box('dark', 0.09, 0.3, 0.05, x + ox * (r + 0.02), hb * 0.45, z + oz * (r + 0.02),
        { ry: Math.atan2(ox, oz) })
    }
  }
  turret(-5.1, 6, 0.5, 2.35, 0.8, true) // front-left, tallest on the wall
  turret(5.1, 6, 0.48, 2.2, 0.75, true)
  turret(-7.5, -3.6, 0.44, 2.05, 0.7, false)
  turret(7.5, -3.6, 0.44, 2.0, 0.68, false)
  turret(0, -6, 0.4, 1.85, 0.62, false)

  // ---- gatehouse: arched portal + raised portcullis, corbelled turrets ---
  put.box('curtain', 0.78, 2.1, 1.9, gx - 1.02, 0, 6.05, { uv: 1.45, vlock: true })
  put.box('curtain', 0.78, 2.1, 1.9, gx + 1.02, 0, 6.05, { uv: 1.45, vlock: true })
  put.arch('curtain', 2.85, 2.1, 0.3, 1.15, 1.35, gx, 0, 6.85, { uv: 1.45 })
  put.arch('curtain', 2.85, 2.1, 0.3, 1.15, 1.35, gx, 0, 5.25, { uv: 1.45 })
  put.box('curtain', 3.0, 0.12, 2.1, gx, 2.1, 6.05, { uv: 1.45 })
  crenels(put, 'curtain', gx - 1.35, 7.0, gx + 1.35, 7.0, 2.22, { w: 0.28, h: 0.3, d: 0.18, pitch: 0.5 })
  crenels(put, 'curtain', gx - 1.42, 6.75, gx - 1.42, 5.35, 2.22, { w: 0.24, h: 0.26, d: 0.18, pitch: 0.5 })
  crenels(put, 'curtain', gx + 1.42, 6.75, gx + 1.42, 5.35, 2.22, { w: 0.24, h: 0.26, d: 0.18, pitch: 0.5 })
  for (const s of [-1, 1]) {
    const tx = gx + s * 1.28
    put.cyl('curtain', 0.2, 0.25, 1.5, 8, tx, 1.35, 6.9, { uv: 1.2 })
    put.cyl('curtain', 0.26, 0.26, 0.05, 8, tx, 2.85, 6.9, {})
    put.cone('roofCobalt', 0.3, 0.52, 8, tx, 2.9, 6.9, { uv: 1.1 })
    put.sphere('gold', 0.04, tx, 3.46, 6.9, {})
  }
  // portcullis, raised: spiked bars visible in the arch head
  for (let i = -2; i <= 2; i++) {
    const bx2 = gx + i * 0.21
    put.box('dark', 0.045, 0.72, 0.045, bx2, 0.62, 6.42, {})
    put.cone('dark', 0.04, 0.12, 4, bx2, 0.52, 6.42, { rx: Math.PI, c: true })
  }
  put.box('dark', 1.05, 0.045, 0.05, gx, 0.85, 6.42, {})
  put.box('dark', 1.05, 0.045, 0.05, gx, 1.15, 6.42, {})
  put.box('stoneBase', 1.9, 0.08, 1.7, gx, -0.03, 6.35, { uv: 1.1 })

  // stair turret left of the gate (plate: slender spire by the portal)
  put.cyl('curtain', 0.44, 0.52, 0.4, 9, -1.75, -0.15, 6.3, { uv: 1.2 })
  put.cyl('curtain', 0.36, 0.44, 2.7, 9, -1.75, 0, 6.3, { uv: 1.2, vlock: true })
  put.cyl('curtain', 0.48, 0.48, 0.06, 9, -1.75, 2.7, 6.3, {})
  put.cone('roofCobalt', 0.52, 0.85, 9, -1.75, 2.76, 6.3, { uv: 1.1 })
  put.sphere('gold', 0.045, -1.75, 3.66, 6.3, {})
  put.box('dark', 0.08, 0.26, 0.05, -1.75, 0.8, 6.78, {})
  put.box('dark', 0.08, 0.26, 0.05, -1.75, 1.7, 6.78, {})
  pennant(put.world(-1.75, 3.62, 6.3), yaw, 0xd9b542)

  // ---- courtyard + balustraded motte -------------------------------------
  put.box('stoneBase', 12.6, 0.06, 9.6, 0, 0.01, -0.2, { uv: 2.3 })
  put.box('keep', 9.8, 1.85, 6.6, 0.15, 0, -1.55, { uv: 1.5, vlock: true })
  put.box('keep', 10.3, 0.55, 7.1, 0.15, -0.2, -1.55, { uv: 1.5 })
  const TY = 1.85
  balustrade(put, 'keep', -4.55, 1.71, -0.75, 1.71, TY, { h: 0.3 })
  balustrade(put, 'keep', 1.45, 1.71, 4.85, 1.71, TY, { h: 0.3 })
  for (let i = 0; i < 8; i++) {
    put.box('stoneBase', 1.9, TY - i * (TY / 8), 0.27, 0.35, 0, 1.75 + (i + 0.5) * 0.27, { uv: 1.1 })
  }
  for (const s of [-1, 1]) {
    put.box('keep', 0.34, 0.8, 0.34, 0.35 + s * 1.25, 0, 2.7, { uv: 1.0 })
    put.sphere('gold', 0.08, 0.35 + s * 1.25, 0.88, 2.7, {})
  }

  // ---- the keep ----------------------------------------------------------
  // nave + the huge frontal cobalt gable
  put.box('keep', 3.2, 1.15, 3.1, 0.2, TY, -1.4, { uv: 1.5, vlock: true })
  put.prism('roofCobalt', 3.44, 1.4, 3.3, 0.2, TY + 1.13, -1.4, { uv: 1.15 })
  put.sphere('gold', 0.05, 0.2, TY + 2.58, 0.15, {})
  put.cone('gold', 0.03, 0.16, 6, 0.2, TY + 2.6, 0.15, {})
  // tracery window on the gable face
  put.arch('keep', 0.8, 1.0, 0.1, 0.5, 0.86, 0.2, TY + 1.25, 0.28, { uv: 1.0 })
  put.box('dark', 0.48, 0.8, 0.05, 0.2, TY + 1.27, 0.26, {})
  put.box('keep', 0.035, 0.68, 0.04, 0.11, TY + 1.29, 0.3, {})
  put.box('keep', 0.035, 0.68, 0.04, 0.29, TY + 1.29, 0.3, {})
  put.box('gold', 0.9, 0.05, 0.1, 0.2, TY + 1.2, 0.28, {})
  // portal: two nested cream arches over a dark doorway
  put.arch('keep', 1.15, 1.08, 0.12, 0.72, 0.98, 0.2, TY, 0.22, { uv: 1.0 })
  put.arch('keep', 0.9, 1.0, 0.1, 0.56, 0.9, 0.2, TY, 0.3, { uv: 1.0 })
  put.box('dark', 0.58, 0.88, 0.06, 0.2, TY, 0.2, {})
  // aisles with cobalt shed roofs
  for (const s of [-1, 1]) {
    put.box('keep', 1.05, 0.75, 2.9, 0.2 + s * 2.12, TY, -1.35, { uv: 1.5, vlock: true })
    put.box('roofCobalt', 1.35, 0.055, 3.15, 0.2 + s * 2.17, TY + 0.92, -1.35,
      { rz: -s * 0.28, c: true, uv: 1.15 })
    put.box('dark', 0.1, 0.32, 0.05, 0.2 + s * 2.12, TY + 0.22, 0.12, {})
  }
  // buttresses
  const buttress = (x, z, h) => {
    put.box('keep', 0.18, h, 0.26, x, TY, z, { uv: 1.0 })
    put.box('keep', 0.14, h * 0.55, 0.2, x, TY + h * 0.9, z - 0.02, { uv: 1.0 })
    put.prism('keep', 0.18, 0.15, 0.2, x, TY + h * 0.9 + h * 0.55, z - 0.02, { uv: 1.0 })
  }
  buttress(-1.35, 0.32, 0.8)
  buttress(1.75, 0.32, 0.8)
  buttress(-2.46, -0.6, 0.55)
  buttress(2.86, -0.6, 0.55)
  buttress(-2.46, -2.1, 0.55)
  buttress(2.86, -2.1, 0.55)
  // twin facade towers with cobalt pyramids
  for (const s of [-1, 1]) {
    const tx = 0.2 + s * 2.5
    put.box('keep', 0.8, 2.05, 0.8, tx, TY, 0.35, { uv: 1.4, vlock: true })
    put.box('keep', 0.95, 0.08, 0.95, tx, TY + 2.05, 0.35, { uv: 1.0 })
    put.cone('roofCobalt', 0.62, 1.0, 4, tx, TY + 2.13, 0.35, { ry: Math.PI / 4, uv: 1.1 })
    put.sphere('gold', 0.05, tx, TY + 3.18, 0.35, {})
    put.cone('gold', 0.03, 0.14, 6, tx, TY + 3.21, 0.35, {})
    put.box('dark', 0.1, 0.3, 0.05, tx, TY + 0.5, 0.78, {})
    put.box('dark', 0.1, 0.3, 0.05, tx, TY + 1.15, 0.78, {})
    pennant(put.world(tx, TY + 3.1, 0.35), yaw, 0x35549c)
  }
  // grand rear spire — the 6.5 m tip
  put.cyl('keep', 0.55, 0.64, 0.5, 9, -1.5, TY - 0.2, -3.0, { uv: 1.3 })
  put.cyl('keep', 0.46, 0.54, 3.15, 9, -1.5, TY, -3.0, { uv: 1.3, vlock: true })
  put.cyl('keep', 0.52, 0.52, 0.06, 9, -1.5, TY + 1.5, -3.0, {})
  put.cyl('keep', 0.6, 0.6, 0.07, 9, -1.5, TY + 3.15, -3.0, {})
  put.cone('roofCobalt', 0.66, 1.42, 10, -1.5, TY + 3.22, -3.0, { uv: 1.1 })
  put.sphere('gold', 0.055, -1.5, TY + 4.68, -3.0, {})
  put.cone('gold', 0.032, 0.16, 6, -1.5, TY + 4.7, -3.0, {})
  pennant(put.world(-1.5, TY + 4.6, -3.0), yaw, 0x35549c)
  for (const s of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
    const px = -1.5 + s[0] * 0.52
    const pz = -3.0 + s[1] * 0.52
    put.cyl('keep', 0.05, 0.068, 0.42, 6, px, TY + 2.9, pz, {})
    put.cone('roofCobalt', 0.095, 0.24, 6, px, TY + 3.32, pz, {})
    put.sphere('gold', 0.028, px, TY + 3.58, pz, {})
  }
  for (let i = 0; i < 3; i++) put.box('dark', 0.09, 0.28, 0.05, -1.5, TY + 0.5 + i * 0.8, -2.44, {})
  // rear-right and mid-left round towers (asymmetric heights)
  put.cyl('keep', 0.36, 0.45, 2.6, 9, 2.6, TY, -2.75, { uv: 1.3, vlock: true })
  put.cyl('keep', 0.5, 0.5, 0.06, 9, 2.6, TY + 2.6, -2.75, {})
  put.cone('roofCobalt', 0.55, 1.05, 10, 2.6, TY + 2.66, -2.75, { uv: 1.1 })
  put.sphere('gold', 0.05, 2.6, TY + 3.75, -2.75, {})
  put.box('dark', 0.09, 0.28, 0.05, 2.6, TY + 0.7, -2.3, {})
  put.box('dark', 0.09, 0.28, 0.05, 2.6, TY + 1.5, -2.3, {})
  put.cyl('keep', 0.34, 0.42, 1.95, 9, -2.75, TY, -0.5, { uv: 1.3, vlock: true })
  put.cyl('keep', 0.46, 0.46, 0.06, 9, -2.75, TY + 1.95, -0.5, {})
  put.cone('roofCobalt', 0.5, 0.9, 10, -2.75, TY + 2.01, -0.5, { uv: 1.1 })
  put.sphere('gold', 0.045, -2.75, TY + 2.95, -0.5, {})
  // rear connecting wing
  put.box('keep', 3.0, 1.0, 1.3, 0.6, TY, -3.55, { uv: 1.5, vlock: true })
  put.prism('roofCobalt', 1.45, 0.5, 3.2, 0.6, TY + 0.98, -3.55, { ry: HPI, uv: 1.15 })
  // nave flank slit rows
  for (const s of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      put.box('dark', 0.06, 0.3, 0.1, 0.2 + s * 1.62, TY + 0.38, -0.65 - i * 0.75, {})
    }
  }

  // ---- flagstone approach: gate -> pad, then a curve to meet the road ----
  for (let i = 0; i < 4; i++) {
    put.box('stoneBase', 1.6, 0.06, 0.5, gx, -0.02, 7.3 + i * 0.56, { uv: 1.1 })
  }
  for (const s of [-1, 1]) {
    put.cyl('woodDark', 0.035, 0.045, 1.5, 6, gx + s * 1.3, 0, 7.9, {})
    put.sphere('gold', 0.035, gx + s * 1.3, 1.54, 7.9, {})
    pennant(put.world(gx + s * 1.3, 1.44, 7.9), yaw, 0xb0453c)
  }
  if (LP) {
    const A = put.world(gx, 0, 9.35)
    const bx2 = LP.x
    const bz2 = LP.z
    const cxp = A.x + gdx * 2.2
    const czp = A.z + gdz * 2.2
    const n = Math.max(3, Math.round(Math.hypot(bx2 - A.x, bz2 - A.z) / 0.62))
    let px = A.x
    let pz = A.z
    for (let i = 1; i <= n; i++) {
      const t = i / n
      const qx = (1 - t) * (1 - t) * A.x + 2 * (1 - t) * t * cxp + t * t * bx2
      const qz = (1 - t) * (1 - t) * A.z + 2 * (1 - t) * t * czp + t * t * bz2
      const wy2 = yawX(qx - px, qz - pz)
      addG(B.stoneBase, gBox(0.62, 0.055, 1.35, (qx + px) / 2, T.height((qx + px) / 2, (qz + pz) / 2) + 0.02,
        (qz + pz) / 2, { ry: wy2, uv: 1.1 }), null)
      px = qx
      pz = qz
    }
  }

  // grounding shade at the gate mouth (the courtyard floor slab shades itself)
  const gw = put.world(gx, 0, 6.4)
  blob(gw.x, gw.z, 2.2, 1.6, 0.26, yaw)
}

// ===========================================================================
// 5. VILLAGE — Ferren Hamlet: 11 houses, 4 plans, organic lane, well, stall
// ===========================================================================

const HOUSE_PLANS = {
  A: { w: 2.5, d: 2.1, wallH: 1.15, rise: 0.95, chimney: true },
  B: { w: 2.7, d: 2.1, wallH: 1.2, rise: 1.0, chimney: true, ell: true },
  C: { w: 3.6, d: 2.3, wallH: 1.3, rise: 1.05, chimney: true, porch: true },
  D: { w: 1.9, d: 1.7, wallH: 0.95, rise: 0.8 },
}

function buildHouse(ctx, hx, hz, rot, planKey, wallBk, lit) {
  const { B, T, rnd, blob } = ctx
  const p = HOUSE_PLANS[planKey]
  const cr = Math.cos(rot)
  const sr = Math.sin(rot)
  let hmin = Infinity
  let hmax = -Infinity
  for (const [ox, oz] of [[-p.w / 2, -p.d / 2], [p.w / 2, -p.d / 2], [-p.w / 2, p.d / 2], [p.w / 2, p.d / 2], [0, 0]]) {
    const h = T.height(hx + ox * cr + oz * sr, hz - ox * sr + oz * cr)
    if (h < hmin) hmin = h
    if (h > hmax) hmax = h
  }
  const baseY = hmin - 0.03
  const ph = hmax - hmin + 0.42
  const frame = new THREE.Matrix4().makeRotationY(rot)
  frame.setPosition(hx, baseY, hz)
  const put = makePut(B, frame)

  put.box('stoneBase', p.w + 0.24, ph, p.d + 0.24, 0, 0, 0, { uv: 1.1 })
  const GF = ph
  put.box(wallBk, p.w, p.wallH, p.d, 0, GF, 0, { uv: p.w + 0.001, vlock: true })
  put.prism(wallBk, p.w, p.rise, p.d, 0, GF + p.wallH, 0, { uv: p.w + 0.001 })
  const yr = gableRoof(put, 'roofSlate', p.w, p.d, p.rise, 0.22, 0.18, 0, GF + p.wallH, 0, { uv: 1.05 })

  // door + trim on the front (+Z) face
  const dxo = p.porch ? -p.w * 0.18 : 0
  put.box('dark', 0.5, 0.9, 0.07, dxo, GF, p.d / 2 + 0.01, {})
  put.box('woodDark', 0.07, 0.98, 0.055, dxo - 0.3, GF, p.d / 2 + 0.02, {})
  put.box('woodDark', 0.07, 0.98, 0.055, dxo + 0.3, GF, p.d / 2 + 0.02, {})
  put.box('woodDark', 0.7, 0.07, 0.055, dxo, GF + 0.95, p.d / 2 + 0.02, {})

  // windows — a couple lit warm (assignment: a few lit windows)
  const win = (bk, x, z, ry) => {
    put.box(bk, 0.3, 0.36, 0.08, x, GF + 0.42, z, { ry })
    put.box('woodDark', 0.42, 0.05, 0.1, x, GF + 0.36, z, { ry })
  }
  win(lit ? 'lit' : 'dark', p.w * 0.28, p.d / 2 - 0.01, 0)
  if (p.w > 2.2 && rnd() < 0.8) win('dark', -p.w * 0.3, p.d / 2 - 0.01, 0)
  if (rnd() < 0.7) win(lit && rnd() < 0.4 ? 'lit' : 'dark', p.w / 2 - 0.01, -p.d * 0.1, HPI)

  if (p.chimney) {
    const chx = -p.w * 0.22
    const chz = -p.d * 0.14
    put.box('stoneBase', 0.3, p.rise + 0.85, 0.3, chx, GF + p.wallH - 0.15, chz, { uv: 0.7 })
    put.box('stoneBase', 0.42, 0.07, 0.42, chx, GF + p.wallH + p.rise + 0.7, chz, { uv: 0.7 })
    put.box('dark', 0.16, 0.06, 0.16, chx, GF + p.wallH + p.rise + 0.77, chz, {})
  }
  if (p.porch) {
    for (const s of [-1, 1]) put.cyl('woodDark', 0.045, 0.055, 0.92, 6, p.w * 0.3 + s * 0.55, GF, p.d / 2 + 0.72, {})
    put.box('roofSlate', 1.5, 0.05, 1.05, p.w * 0.3, GF + 1.06, p.d / 2 + 0.45, { rx: 0.3, c: true, uv: 1.05 })
  }
  if (p.ell) {
    put.box(wallBk, 1.5, 1.0, 1.3, 0.75, GF, p.d / 2 + 0.5, { uv: 1.501, vlock: true })
    put.prism(wallBk, 1.5, 0.7, 1.3, 0.75, GF + 1.0, p.d / 2 + 0.5, { uv: 1.501 })
    gableRoof(put, 'roofSlate', 1.5, 1.3, 0.7, 0.18, 0.15, 0.75, GF + 1.0, p.d / 2 + 0.5, { uv: 1.05 })
    put.box('dark', 0.3, 0.34, 0.06, 0.75, GF + 0.3, p.d / 2 + 1.16, {})
  }
  blob(hx, hz, p.w * 0.62 + 0.55, p.d * 0.62 + 0.55, 0.36, rot)
  return yr
}

function buildVillage(ctx, poi) {
  const { B, T, rnd, blob } = ctx
  const houses = [
    [-75.0, -124.5, 1.62, 'A', 'plaster', true],
    [-65.2, -126.5, -1.45, 'B', 'timber', false],
    [-76.2, -130.8, 1.48, 'C', 'timber', true],
    [-64.0, -131.6, -1.72, 'A', 'plaster', false],
    [-70.8, -135.8, 3.02, 'A', 'timber', false],
    [-66.0, -138.2, -0.51, 'D', 'plaster', false],
    [-75.8, -137.0, 0.78, 'B', 'plaster', true],
    [-69.0, -121.8, 3.05, 'D', 'timber', false],
    [-60.8, -124.0, -2.2, 'A', 'plaster', false],
    [-74.0, -142.2, 1.75, 'C', 'plaster', false],
    [-59.6, -129.8, -1.9, 'D', 'timber', false],
  ]
  for (const [hx, hz, rot, plan, wall, lit] of houses) buildHouse(ctx, hx, hz, rot, plan, wall, lit)

  // lane of worn flags from the road mouth through the well plaza
  const lane = [[-70, -125.4], [-70.2, -128.2], [-70.4, -131], [-70.9, -133.5], [-71.4, -136]]
  const putW = makePut(B, null)
  for (let i = 0; i < lane.length - 1; i++) {
    const [ax, az] = lane[i]
    const [bx2, bz2] = lane[i + 1]
    const n = Math.max(2, Math.round(Math.hypot(bx2 - ax, bz2 - az) / 0.7))
    for (let j = 0; j < n; j++) {
      const t = (j + 0.5) / n
      const x = ax + (bx2 - ax) * t + (rnd() - 0.5) * 0.2
      const z = az + (bz2 - az) * t + (rnd() - 0.5) * 0.2
      putW.box('stoneBase', 0.6 + rnd() * 0.25, 0.05, 1.15, x, T.height(x, z) + 0.02, z,
        { ry: yawX(bx2 - ax, bz2 - az), uv: 1.1 })
    }
  }

  // the well: stone ring, twin posts, little slate roof, windlass + bucket
  const wx = -69.5
  const wz = -130.6
  const wy = T.height(wx, wz)
  const fw = new THREE.Matrix4().makeRotationY(0.35)
  fw.setPosition(wx, wy, wz)
  const putV = makePut(B, fw)
  putV.cyl('stoneBase', 0.6, 0.68, 0.55, 10, 0, 0, 0, { uv: 0.9 })
  putV.cyl('dark', 0.48, 0.48, 0.05, 10, 0, 0.52, 0, {})
  for (const s of [-1, 1]) putV.box('woodDark', 0.09, 1.25, 0.09, s * 0.58, 0.1, 0, {})
  putV.cyl('woodDark', 0.05, 0.05, 1.16, 6, 0, 1.02, 0, { rz: HPI, c: true })
  putV.box('woodDark', 0.12, 0.3, 0.04, 0.62, 0.9, 0.14, { rz: 0.5 })
  putV.tube('rope', [new THREE.Vector3(0, 1.02, 0), new THREE.Vector3(0, 0.62, 0)], 0.018, {})
  putV.box('woodDark', 0.17, 0.15, 0.17, 0, 0.52, 0, {})
  gableRoof(putV, 'roofSlate', 1.5, 1.0, 0.42, 0.12, 0.15, 0, 1.28, 0, { uv: 1.05 })
  for (const s of [-1, 1]) putV.prism('woodDark', 1.5, 0.42, 0.06, 0, 1.28, s * 0.5, { uv: 1.0 })
  blob(wx, wz, 1.05, 0.95, 0.35, 0)

  // market stall with the village-red awning
  const sx = -67.4
  const sz = -128.9
  const sy = T.height(sx, sz)
  const fs = new THREE.Matrix4().makeRotationY(0.5)
  fs.setPosition(sx, sy, sz)
  const putS = makePut(B, fs)
  putS.box('woodMid', 1.5, 0.72, 0.55, 0, 0.06, 0.3, { uv: 1.0 })
  for (const s of [-1, 1]) {
    putS.box('woodDark', 0.07, 1.6, 0.07, s * 0.7, 0, -0.32, {})
    putS.box('woodDark', 0.07, 1.32, 0.07, s * 0.7, 0, 0.52, {})
  }
  putS.box('red', 1.74, 0.045, 1.16, 0, 1.44, 0.1, { rx: 0.26, c: true, uv: 0.9 })
  putS.box('hay', 0.42, 0.2, 0.3, -0.3, 0.78, 0.3, { ry: 0.2, uv: 0.5 })
  putS.box('woodMid', 0.34, 0.3, 0.34, 0.4, 0.78, 0.28, { ry: -0.15, uv: 0.6 })
  blob(sx, sz, 1.1, 0.8, 0.3, 0.5)

  // barrels + a crate tucked against walls
  const barrel = (x, z, lean) => {
    const y = T.height(x, z)
    const fb = new THREE.Matrix4().makeRotationY(rnd() * TAU)
    fb.setPosition(x, y, z)
    const pb = makePut(B, fb)
    pb.lathe('woodMid', [[0.16, 0], [0.21, 0.09], [0.235, 0.3], [0.21, 0.5], [0.16, 0.58]], 9, 0, 0, 0,
      lean ? { rz: 0.12 } : {})
    pb.cyl('dark', 0.15, 0.15, 0.025, 9, 0, 0.575, 0, lean ? { rz: 0.12 } : {})
    pb.cyl('woodDark', 0.242, 0.242, 0.035, 9, 0, 0.12, 0, lean ? { rz: 0.12 } : {})
    pb.cyl('woodDark', 0.242, 0.242, 0.035, 9, 0, 0.44, 0, lean ? { rz: 0.12 } : {})
    blob(x, z, 0.32, 0.32, 0.3, 0)
  }
  barrel(-64.55, -127.6, false)
  barrel(-75.7, -125.7, true)
  barrel(-67.9, -128.2, false)
  const cy = T.height(-70.6, -134.6)
  putW.box('woodMid', 0.5, 0.5, 0.5, -70.6, cy, -134.6, { ry: 0.4, uv: 0.55 })
  putW.box('woodDark', 0.54, 0.07, 0.54, -70.6, cy + 0.22, -134.6, { ry: 0.4 })
  blob(-70.6, -134.6, 0.42, 0.42, 0.3, 0.4)
}

// ===========================================================================
// 6. SHRINE — torii, stone lanterns, tiled hall on a stepped stone base
// ===========================================================================

function buildShrine(ctx, poi) {
  const { B, T, meta, blob } = ctx
  let ax = -0.6
  let az = -0.8
  const road = (meta.roads || []).find((r) => r.name === 'shrine')
  if (road && road.points.length > 4) {
    const LPp = road.points[road.points.length - 1]
    const PPp = road.points[road.points.length - 4]
    const dx = PPp.x - LPp.x
    const dz = PPp.z - LPp.z
    const L = Math.hypot(dx, dz) || 1
    ax = dx / L
    az = dz / L
  }
  const yaw = Math.atan2(ax, az)
  const px2 = poi.x - ax * 0.6
  const pz2 = poi.z - az * 0.6
  const py = T.height(px2, pz2)
  const frame = new THREE.Matrix4().makeRotationY(yaw)
  frame.setPosition(px2, py, pz2)
  const put = makePut(B, frame)

  // stepped stone base + approach steps
  put.box('stoneBase', 4.4, 0.28, 3.4, 0, 0, 0, { uv: 1.0 })
  put.box('stoneBase', 3.7, 0.26, 2.8, 0, 0.28, 0, { uv: 1.0 })
  put.box('stoneBase', 1.6, 0.36, 0.36, 0, 0, 1.88, { uv: 0.8 })
  put.box('stoneBase', 1.6, 0.18, 0.36, 0, 0, 2.24, { uv: 0.8 })

  // the hall: posts, dark timber body, sliding doors, tiled gable roof
  for (const [hx2, hz2] of [[-0.88, -0.66], [0.88, -0.66], [-0.88, 0.66], [0.88, 0.66]]) {
    put.cyl('red', 0.055, 0.07, 0.98, 7, hx2, 0.54, hz2, {})
  }
  put.box('woodDark', 1.7, 0.95, 1.25, 0, 0.6, 0, { uv: 1.2, vlock: true })
  put.box('dark', 0.34, 0.66, 0.05, -0.19, 0.72, 0.63, {})
  put.box('dark', 0.34, 0.66, 0.05, 0.19, 0.72, 0.63, {})
  put.box('gold', 0.035, 0.66, 0.06, 0, 0.72, 0.63, {})
  put.box('woodDark', 1.85, 0.12, 1.4, 0, 0.48, 0, { uv: 1.2 }) // floor slab
  put.prism('woodDark', 2.4, 0.72, 1.5, 0, 1.55, 0, { uv: 1.2 })
  const yr = gableRoof(put, 'roofSlate', 2.4, 1.5, 0.72, 0.42, 0.34, 0, 1.55, 0, { uv: 1.05, ridgeW: 0.16 })
  put.sphere('gold', 0.05, 0, yr + 0.02, 1.12, {})
  put.sphere('gold', 0.05, 0, yr + 0.02, -1.12, {})
  put.box('woodDark', 0.5, 0.3, 0.32, 0, 0.54, 1.05, { uv: 0.7 })
  blob(px2, pz2, 2.6, 2.1, 0.32, yaw)

  // torii astride the approach
  const tx = poi.x + ax * 4.6
  const tz = poi.z + az * 4.6
  const ty = T.height(tx, tz)
  const ft = new THREE.Matrix4().makeRotationY(yaw)
  ft.setPosition(tx, ty, tz)
  const putT = makePut(B, ft)
  putT.cyl('red', 0.075, 0.095, 2.0, 8, -0.82, 0, 0, { rz: -0.05 })
  putT.cyl('red', 0.075, 0.095, 2.0, 8, 0.82, 0, 0, { rz: 0.05 })
  putT.box('red', 2.1, 0.13, 0.09, 0, 1.32, 0, {})
  putT.box('red', 0.09, 0.34, 0.08, 0, 1.45, 0, {})
  putT.box('red', 2.35, 0.12, 0.14, 0, 1.77, 0, {})
  putT.box('red', 2.6, 0.13, 0.17, 0, 1.89, 0, {})
  putT.box('dark', 2.62, 0.05, 0.19, 0, 2.02, 0, {})
  putT.tube('rope', catPts(-0.7, 1.28, 0.07, 0.7, 1.28, 0.07, 0.1, 7), 0.028, {})
  putT.box('canvas', 0.07, 0.16, 0.012, -0.35, 1.06, 0.08, { rz: 0.1 })
  putT.box('canvas', 0.07, 0.16, 0.012, 0.35, 1.06, 0.08, { rz: -0.1 })
  blob(tx, tz, 1.35, 0.5, 0.38, yaw)

  // stone lanterns flanking the path, softly lit
  for (const s of [-1, 1]) {
    const lx = poi.x + ax * 2.9 - az * 1.05 * s
    const lz = poi.z + az * 2.9 + ax * 1.05 * s
    const ly = T.height(lx, lz)
    const fl = new THREE.Matrix4().makeRotationY(yaw)
    fl.setPosition(lx, ly, lz)
    const putL = makePut(B, fl)
    putL.box('stoneBase', 0.34, 0.14, 0.34, 0, 0, 0, { uv: 0.6 })
    putL.cyl('stoneBase', 0.05, 0.068, 0.4, 7, 0, 0.14, 0, {})
    putL.box('stoneBase', 0.26, 0.24, 0.26, 0, 0.54, 0, { uv: 0.6 })
    putL.box('lit', 0.11, 0.12, 0.28, 0, 0.6, 0, {})
    putL.cone('stoneBase', 0.3, 0.2, 4, 0, 0.78, 0, { ry: Math.PI / 4, uv: 0.6 })
    putL.sphere('gold', 0.04, 0, 1.0, 0, {})
    blob(lx, lz, 0.3, 0.3, 0.3, 0)
  }

  // path flags torii -> steps
  const putW = makePut(B, null)
  for (let i = 1; i <= 5; i++) {
    const t = i / 6
    const fx2 = tx + (poi.x + ax * 1.6 - tx) * t
    const fz2 = tz + (poi.z + az * 1.6 - tz) * t
    putW.box('stoneBase', 0.55, 0.05, 1.05, fx2, T.height(fx2, fz2) + 0.02, fz2, { ry: yaw + HPI, uv: 1.0 })
  }
}

// ===========================================================================
// 7. BRIDGES — timber trestle (west), rope suspension (north gorge), and a
//    stone arch footbridge over the river. Decks sag; planks are individual.
// ===========================================================================

function buildPlankBridge(ctx, A, Bp, deckY, style) {
  const { B, T, rnd } = ctx
  const put = makePut(B, null)
  let dx = Bp.x - A.x
  let dz = Bp.z - A.z
  const span = Math.hypot(dx, dz)
  dx /= span
  dz /= span
  const px2 = -dz
  const pz2 = dx
  const inset = style === 'rope' ? 0.25 : 1.0
  const ax = A.x + dx * inset
  const az = A.z + dz * inset
  const L = span - inset * 2
  const sag = style === 'rope' ? 0.5 : 0.32
  const yawP = yawX(px2, pz2)
  const yawD = yawX(dx, dz)
  const deckAt = (t) => deckY - sag * 4 * t * (1 - t)
  const wood = style === 'rope' ? 'woodMid' : 'woodMid'

  // individually placed planks riding the sag, with age jitter
  const step = style === 'rope' ? 0.34 : 0.36
  const n = Math.floor(L / step)
  for (let i = 0; i <= n; i++) {
    const t = i / n
    if (style === 'rope' && (i === ((n * 0.32) | 0) || i === ((n * 0.71) | 0))) continue // missing planks
    const x = ax + dx * t * L
    const z = az + dz * t * L
    const slope = Math.atan2(-sag * 4 * (1 - 2 * t), L)
    const w = style === 'rope' ? 0.98 : 1.18
    put.box(wood, w, 0.045, step * 0.72, x, deckAt(t), z,
      { ry: yawP + (rnd() - 0.5) * (style === 'rope' ? 0.09 : 0.03), rx: slope, c: true, uv: 0.9 })
  }

  if (style === 'trestle') {
    // stringers under the planks
    for (const s of [-1, 1]) {
      const off = s * 0.42
      for (let i = 0; i < 8; i++) {
        const t0 = i / 8
        const t1 = (i + 1) / 8
        const x0 = ax + dx * t0 * L + px2 * off
        const z0 = az + dz * t0 * L + pz2 * off
        const x1 = ax + dx * t1 * L + px2 * off
        const z1 = az + dz * t1 * L + pz2 * off
        const y0 = deckAt(t0) - 0.08
        const y1 = deckAt(t1) - 0.08
        const seg = Math.hypot(x1 - x0, z1 - z0)
        put.box('woodDark', seg + 0.06, 0.11, 0.13, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2,
          { rz: Math.atan2(y1 - y0, seg), ry: yawD, c: true, uv: 0.9 })
      }
    }
    // post-and-rail parapets both sides (the bible's timber trestle read)
    for (const s of [-1, 1]) {
      const off = s * 0.56
      const posts = Math.max(3, Math.round(L / 1.45))
      const top = []
      const mid = []
      for (let i = 0; i <= posts; i++) {
        const t = i / posts
        const x = ax + dx * t * L + px2 * off
        const z = az + dz * t * L + pz2 * off
        const y = deckAt(t)
        put.cyl('woodDark', 0.032, 0.042, 0.82, 5, x, y - 0.04, z, {})
        top.push(new THREE.Vector3(x, y + 0.78, z))
        mid.push(new THREE.Vector3(x, y + 0.42, z))
      }
      put.tube('woodDark', top, 0.028, {})
      put.tube('woodDark', mid, 0.024, {})
    }
    // abutment cribs + raking struts down to the rock
    for (const [ex, ez, sgn] of [[ax, az, 1], [ax + dx * L, az + dz * L, -1]]) {
      for (let lay = 0; lay < 2; lay++) {
        put.cyl('woodDark', 0.08, 0.08, 1.5, 6, ex - dx * sgn * 0.15, deckY - 0.22 - lay * 0.19, ez - dz * sgn * 0.15,
          { rz: HPI, ry: yawP, c: true })
      }
      for (const s of [-1, 1]) {
        const bx3 = ex + dx * sgn * 1.7 + px2 * s * 0.4
        const bz3 = ez + dz * sgn * 1.7 + pz2 * s * 0.4
        const gx2 = ex - dx * sgn * 0.6 + px2 * s * 0.4
        const gz2 = ez - dz * sgn * 0.6 + pz2 * s * 0.4
        put.tube('woodDark', [
          new THREE.Vector3(bx3, deckY - 0.12, bz3),
          new THREE.Vector3(gx2, Math.min(deckY - 1.6, T.height(gx2, gz2) + 0.4), gz2),
        ], 0.06, {})
      }
    }
  } else {
    // rope suspension: pylons, catenary mains, hangers, anchors
    const ends = [[ax, az, 1], [ax + dx * L, az + dz * L, -1]]
    for (const [ex, ez, sgn] of ends) {
      for (const s of [-1, 1]) {
        put.cyl('woodDark', 0.05, 0.065, 1.3, 6, ex + px2 * s * 0.52, deckY - 0.08, ez + pz2 * s * 0.52, {})
      }
      put.box('woodDark', 1.3, 0.09, 0.09, ex, deckY + 1.12, ez, { ry: yawP })
      // anchor stakes + tie-back ropes
      const sx2 = ex - dx * sgn * 1.1
      const sz2 = ez - dz * sgn * 1.1
      const sy = T.height(sx2, sz2)
      put.box('woodDark', 0.1, 0.5, 0.1, sx2, sy - 0.05, sz2, { rz: 0.2 * sgn })
      for (const s of [-1, 1]) {
        put.tube('rope', [
          new THREE.Vector3(ex + px2 * s * 0.52, deckY + 1.18, ez + pz2 * s * 0.52),
          new THREE.Vector3(sx2 + px2 * s * 0.2, sy + 0.35, sz2 + pz2 * s * 0.2),
        ], 0.02, {})
      }
    }
    for (const s of [-1, 1]) {
      const dr = catPts(ax + px2 * s * 0.44, deckY - 0.03, az + pz2 * s * 0.44,
        ax + dx * L + px2 * s * 0.44, deckY - 0.03, az + dz * L + pz2 * s * 0.44, sag, 16)
      put.tube('rope', dr, 0.032, { seg: 22 })
      const hr = catPts(ax + px2 * s * 0.5, deckY + 1.12, az + pz2 * s * 0.5,
        ax + dx * L + px2 * s * 0.5, deckY + 1.12, az + dz * L + pz2 * s * 0.5, 0.34, 16)
      put.tube('rope', hr, 0.024, { seg: 22 })
      const hangers = Math.round(L / 0.85)
      for (let i = 1; i < hangers; i++) {
        const t = i / hangers
        const hx3 = ax + dx * t * L + px2 * s * 0.5
        const hz3 = az + dz * t * L + pz2 * s * 0.5
        const yTop = deckY + 1.12 - 0.34 * 4 * t * (1 - t)
        const yBot = deckAt(t) + 0.02
        put.tube('rope', [new THREE.Vector3(hx3, yTop, hz3), new THREE.Vector3(hx3, yBot, hz3)], 0.013, { seg: 4 })
      }
    }
  }
}

function buildArchBridge(ctx) {
  const { B, T } = ctx
  const cx2 = 6
  const cz2 = -23
  const rdx = 0.953
  const rdz = 0.303
  const px2 = -rdz
  const pz2 = rdx
  const waterY = T.waterHeight(cx2, cz2)
  const hA = T.height(cx2 - px2 * 3.9, cz2 - pz2 * 3.9)
  const hB = T.height(cx2 + px2 * 3.9, cz2 + pz2 * 3.9)
  const y0 = waterY - 1.0
  const deckTop = Math.max(hA, hB) + 0.3
  const H = Math.max(1.6, deckTop - y0)
  const ah = Math.min(H - 0.45, waterY - y0 + 1.5)
  const fy = Math.atan2(-pz2, px2)
  const frame = new THREE.Matrix4().makeRotationY(fy)
  frame.setPosition(cx2, y0, cz2)
  const put = makePut(B, frame)
  put.arch('stoneBase', 7.6, H, 1.7, 3.0, ah, 0, 0, 0, { uv: 1.15 })
  // humped deck + parapets + end caps
  put.box('stoneBase', 3.0, 0.1, 1.8, 0, H, 0, { uv: 1.0 })
  put.box('stoneBase', 2.6, 0.09, 1.75, -2.55, H - 0.16, 0, { rz: 0.12, c: true, uv: 1.0 })
  put.box('stoneBase', 2.6, 0.09, 1.75, 2.55, H - 0.16, 0, { rz: -0.12, c: true, uv: 1.0 })
  for (const s of [-1, 1]) {
    put.box('stoneBase', 2.9, 0.4, 0.14, 0, H + 0.08, s * 0.82, { uv: 0.8 })
    put.box('stoneBase', 2.3, 0.36, 0.13, -2.5, H - 0.14, s * 0.82, { rz: 0.12, c: true, uv: 0.8 })
    put.box('stoneBase', 2.3, 0.36, 0.13, 2.5, H - 0.14, s * 0.82, { rz: -0.12, c: true, uv: 0.8 })
    put.box('stoneBase', 0.3, 0.62, 0.24, -3.65, H - 0.5, s * 0.82, { uv: 0.6 })
    put.box('stoneBase', 0.3, 0.62, 0.24, 3.65, H - 0.5, s * 0.82, { uv: 0.6 })
  }
}

// ===========================================================================
// 8. FARM — paddock fences that hug the road-facing arcs, barn, cart, bales
// ===========================================================================

// Wheat paddock ellipses — mirrors terrain.js PADDOCKS (authored constants).
const PADDOCKS = [
  { x: -34, z: 14, rx: 6.0, rz: 3.6, rot: 0.30 },
  { x: -42, z: 26, rx: 8.0, rz: 4.6, rot: -0.18 },
  { x: -30, z: 30, rx: 6.6, rz: 4.0, rot: 0.42 },
  { x: -20, z: 52, rx: 8.2, rz: 4.6, rot: 0.12 },
  { x: 1, z: 36, rx: 9.0, rz: 5.0, rot: -0.30 },
]

function buildFences(ctx) {
  const { B, T, rnd, blob, roadPts } = ctx
  const put = makePut(B, null)
  const roadNear = (x, z) => {
    let best = 1e9
    for (let i = 0; i < roadPts.length; i += 2) {
      const dx = roadPts[i] - x
      const dz = roadPts[i + 1] - z
      const d2 = dx * dx + dz * dz
      if (d2 < best) best = d2
    }
    return Math.sqrt(best)
  }
  for (let pi = 0; pi < PADDOCKS.length; pi++) {
    const p = PADDOCKS[pi]
    const k = 1.14
    const a = p.rx * k
    const b = p.rz * k
    const per = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)))
    const n = Math.max(10, Math.round(per / 1.32))
    const cr = Math.cos(p.rot)
    const sr = Math.sin(p.rot)
    const pts = []
    for (let i = 0; i < n; i++) {
      const th = (i / n) * TAU
      const wob = 1 + 0.035 * Math.sin(th * 3 + pi * 2.1) + 0.02 * Math.sin(th * 7 + pi)
      const lx = Math.cos(th) * a * wob
      const lz = Math.sin(th) * b * wob
      const x = p.x + lx * cr - lz * sr
      const z = p.z + lx * sr + lz * cr
      // outward normal (approx): radial direction
      let ox = lx / a
      let oz = lz / b
      const ol = Math.hypot(ox, oz) || 1
      ox /= ol
      oz /= ol
      const wx2 = ox * cr - oz * sr
      const wz2 = ox * sr + oz * cr
      const facing = wx2 * -0.32 + wz2 * 0.95 // bias fences to the S/SW arcs
      const keep = (roadNear(x, z) < 8.0 || facing > 0.3) &&
        T.slope(x, z) < 0.5 && !T.isWater(x, z) && T.onRoad(x, z) < 0.35
      pts.push({ x, z, keep })
    }
    // dilate keeps by one so runs end past corners
    const keep2 = pts.map((q, i) => q.keep || pts[(i + 1) % n].keep || pts[(i + n - 1) % n].keep)
    for (let i = 0; i < n; i++) pts[i].keep = keep2[i]
    // posts + rails over contiguous runs
    for (let i = 0; i < n; i++) {
      const q = pts[i]
      if (!q.keep) continue
      const y = T.height(q.x, q.z)
      const hJ = 0.5 * (0.92 + rnd() * 0.16)
      put.box('woodDark', 0.07, hJ, 0.07, q.x, y - 0.06, q.z,
        { rx: (rnd() - 0.5) * 0.07, rz: (rnd() - 0.5) * 0.07, ry: rnd() * TAU, uv: 0.6 })
      blob(q.x, q.z, 0.2, 0.15, 0.22, 0)
      const r = pts[(i + 1) % n]
      if (!r.keep) continue
      const dx = r.x - q.x
      const dz = r.z - q.z
      const flat = Math.hypot(dx, dz)
      if (flat > 1.9) continue
      const y2 = T.height(r.x, r.z)
      const yawR = yawX(dx / flat, dz / flat)
      const pitch = Math.atan2(y2 - y, flat)
      for (const rh of [0.21, 0.4]) {
        put.box('woodDark', flat + 0.1, 0.055, 0.038, (q.x + r.x) / 2, (y + y2) / 2 + rh - 0.06, (q.z + r.z) / 2,
          { rz: pitch, ry: yawR, c: true, uv: 0.6 })
      }
    }
  }
}

function buildFarm(ctx, poi) {
  const { B, T, rnd, blob } = ctx
  buildFences(ctx)

  // barn against the western tree line (kept out of the boot framing)
  const bx2 = -62
  const bz2 = 25
  const rot = 1.25
  const cr = Math.cos(rot)
  const sr = Math.sin(rot)
  let hmin = Infinity
  let hmax = -Infinity
  for (const [ox, oz] of [[-2.3, -1.7], [2.3, -1.7], [-2.3, 1.7], [2.3, 1.7], [0, 0]]) {
    const h = T.height(bx2 + ox * cr + oz * sr, bz2 - ox * sr + oz * cr)
    if (h < hmin) hmin = h
    if (h > hmax) hmax = h
  }
  const frame = new THREE.Matrix4().makeRotationY(rot)
  frame.setPosition(bx2, hmin - 0.03, bz2)
  const put = makePut(B, frame)
  const ph = hmax - hmin + 0.4
  put.box('stoneBase', 4.85, ph, 3.65, 0, 0, 0, { uv: 1.1 })
  put.box('woodMid', 4.6, 2.0, 3.4, 0, ph, 0, { uv: 2.301, vlock: true })
  put.prism('woodMid', 4.6, 1.3, 3.4, 0, ph + 2.0, 0, { uv: 2.301 })
  gableRoof(put, 'roofShingle', 4.6, 3.4, 1.3, 0.28, 0.24, 0, ph + 2.0, 0, { uv: 1.2, ridgeW: 0.15, bkRidge: 'woodDark' })
  // big double door + hayloft on the gable front (+Z)
  put.box('dark', 1.5, 1.65, 0.08, 0, ph, 1.71, {})
  put.box('woodDark', 0.09, 1.75, 0.06, -0.82, ph, 1.73, {})
  put.box('woodDark', 0.09, 1.75, 0.06, 0.82, ph, 1.73, {})
  put.box('woodDark', 1.74, 0.09, 0.06, 0, ph + 1.72, 1.73, {})
  put.box('woodDark', 0.06, 1.62, 0.05, 0, ph + 0.01, 1.74, {})
  put.box('dark', 0.62, 0.62, 0.08, 0, ph + 2.25, 1.71, {})
  put.box('woodDark', 0.72, 0.07, 0.07, 0, ph + 2.9, 1.74, {})
  put.box('dark', 0.32, 0.36, 0.07, -1.6, ph + 0.5, 1.71, {})
  // lean-to shelter on the east flank with hay inside
  for (const zz of [-1.2, 1.2]) put.cyl('woodDark', 0.05, 0.06, 1.15, 6, 3.25, 0.1, zz, {})
  put.box('roofShingle', 1.6, 0.05, 3.1, 2.85, 1.7, 0, { rz: 0.42, c: true, uv: 1.2 })
  put.box('hay', 0.62, 0.5, 0.62, 3.0, 0.12, -0.5, { ry: 0.3, uv: 0.7 })
  blob(bx2, bz2, 3.1, 2.5, 0.38, rot)

  // hay bales — two out by the visible paddock, the rest in the yard
  const bale = (x, z, ry, standing) => {
    const y = T.height(x, z)
    addG(B.hay, gCyl(0.32, 0.32, 0.56, 9, x, standing ? y - 0.02 : y + 0.3, z,
      standing ? { ry } : { rz: HPI, ry, c: true, uv: 0.8 }), null)
    blob(x, z, 0.42, 0.36, 0.3, ry)
  }
  bale(-46.6, 27.6, 0.5, false)
  bale(-45.7, 26.2, 2.3, false)
  bale(-60.6, 27.1, 1.1, false)
  bale(-63.2, 22.4, 0.2, true)

  // the cart, parked by the barn yard
  const cx3 = -59.6
  const cz3 = 23.2
  const cy3 = T.height(cx3, cz3)
  const fc = new THREE.Matrix4().makeRotationY(-0.5)
  fc.setPosition(cx3, cy3, cz3)
  const putC = makePut(B, fc)
  putC.box('woodMid', 1.4, 0.1, 0.85, 0, 0.5, 0, { uv: 0.9 })
  for (const s of [-1, 1]) {
    putC.box('woodMid', 1.4, 0.22, 0.05, 0, 0.6, s * 0.42, { uv: 0.9 })
    putC.box('woodMid', 0.05, 0.22, 0.78, s * 0.68, 0.6, 0, { uv: 0.9 })
  }
  putC.cyl('woodDark', 0.035, 0.035, 1.15, 6, 0, 0.34, 0, { rz: HPI, c: true })
  for (const s of [-1, 1]) {
    putC.torus('woodDark', 0.3, 0.045, s * 0.58, 0.34, 0, { ry: HPI, c: true })
    for (let sp = 0; sp < 3; sp++) {
      putC.box('woodDark', 0.05, 0.56, 0.04, s * 0.58, 0.34, 0, { rx: sp * (Math.PI / 3), c: true })
    }
    putC.cyl('woodDark', 0.06, 0.06, 0.08, 6, s * 0.62, 0.34, 0, { rz: HPI, c: true })
  }
  for (const s of [-1, 1]) putC.box('woodDark', 0.05, 0.05, 1.1, s * 0.3, 0.42, 0.95, { rx: 0.18, c: true })
  blob(cx3, cz3, 0.95, 0.7, 0.32, -0.5)
}

// ===========================================================================
// 9. CAMP — tent, fire ring (animated flame lives in createProps), crates
// ===========================================================================

function buildCamp(ctx, poi) {
  const { B, T, rnd, blob } = ctx
  // tent
  const tx = 7.0
  const tz = 87.1
  const ty = T.height(tx, tz)
  const rot = 2.2
  const ft = new THREE.Matrix4().makeRotationY(rot)
  ft.setPosition(tx, ty, tz)
  const put = makePut(B, ft)
  put.prism('canvas', 1.75, 1.15, 2.05, 0, 0.02, 0, { uv: 1.4 })
  put.prism('dark', 0.8, 0.62, 0.06, 0, 0.02, 1.02, {})
  for (const s of [-1, 1]) {
    put.cyl('woodDark', 0.028, 0.034, 1.42, 5, 0.28 * s, 0, s * 0.98, { rz: s * 0.4 })
  }
  put.cyl('woodDark', 0.03, 0.03, 2.5, 5, 0, 1.19, 0, { rx: HPI, c: true })
  for (const s of [-1, 1]) {
    const gx2 = s * 1.15
    put.tube('rope', [new THREE.Vector3(0, 1.16, s * 1.22), new THREE.Vector3(gx2 * 0.4, 0.02, s * 1.75)], 0.012, { seg: 4 })
    put.box('woodDark', 0.05, 0.16, 0.05, gx2 * 0.4, -0.02, s * 1.75, { rz: 0.3 })
  }
  blob(tx, tz, 1.35, 1.45, 0.36, rot)

  // fire ring — flame + glow + light are added by createProps at firePos
  const fx2 = 8.7
  const fz2 = 88.6
  const fy2 = T.height(fx2, fz2)
  ctx.firePos = new THREE.Vector3(fx2, fy2, fz2)
  const putW = makePut(B, null)
  for (let i = 0; i < 7; i++) {
    const th = (i / 7) * TAU + 0.3
    const sx2 = fx2 + Math.cos(th) * 0.42
    const sz2 = fz2 + Math.sin(th) * 0.42
    putW.box('stoneBase', 0.15 + rnd() * 0.08, 0.14 + rnd() * 0.06, 0.13 + rnd() * 0.07,
      sx2, T.height(sx2, sz2) - 0.03, sz2, { ry: rnd() * TAU, rz: (rnd() - 0.5) * 0.2, uv: 0.5 })
  }
  putW.cyl('dark', 0.3, 0.34, 0.05, 9, fx2, fy2 - 0.02, fz2, {})
  for (let i = 0; i < 3; i++) {
    const th = (i / 3) * TAU + 0.8
    putW.cyl('woodDark', 0.045, 0.05, 0.62, 5, fx2 + Math.cos(th) * 0.16, fy2 + 0.16, fz2 + Math.sin(th) * 0.16,
      { rz: 0.95, ry: -th, c: true })
  }
  blob(fx2, fz2, 0.6, 0.6, 0.3, 0)

  // crates, barrel, log bench
  const cy2 = T.height(6.9, 89.4)
  putW.box('woodMid', 0.55, 0.55, 0.55, 6.9, cy2, 89.4, { ry: 0.35, uv: 0.55 })
  putW.box('woodDark', 0.59, 0.07, 0.59, 6.9, cy2 + 0.24, 89.4, { ry: 0.35 })
  putW.box('woodMid', 0.4, 0.4, 0.4, 6.75, cy2 + 0.55, 89.25, { ry: 0.7, uv: 0.55 })
  blob(6.9, 89.4, 0.5, 0.5, 0.32, 0.35)
  const by2 = T.height(9.6, 87.5)
  addG(B.woodMid, gLathe([[0.16, 0], [0.21, 0.09], [0.235, 0.3], [0.21, 0.5], [0.16, 0.58]], 9, 9.6, by2, 87.5, {}), null)
  addG(B.woodDark, gCyl(0.242, 0.242, 0.035, 9, 9.6, by2 + 0.1, 87.5, {}), null)
  addG(B.dark, gCyl(0.15, 0.15, 0.025, 9, 9.6, by2 + 0.57, 87.5, {}), null)
  blob(9.6, 87.5, 0.32, 0.32, 0.3, 0)
  const ly2 = T.height(8.1, 89.9)
  putW.cyl('woodDark', 0.09, 0.09, 1.15, 7, 8.1, ly2 + 0.09, 89.9, { rz: HPI, ry: 0.5, c: true })
  blob(8.1, 89.9, 0.65, 0.25, 0.28, 0.5)
}

// ===========================================================================
// 10. DRESSING — signposts, milestones, the pier and its rowboat
// ===========================================================================

function buildSignposts(ctx) {
  const { B, T, rnd, blob } = ctx
  const posts = [
    { x: -45.9, z: 3.6, arms: [{ d: [7, 4.5], h: 1.12 }, { d: [-6, -6], h: 0.92 }, { d: [-2, -10], h: 0.72 }] },
    { x: -63.4, z: -21.2, arms: [{ d: [-0.5, -1], h: 1.02 }] },
    { x: -31.4, z: 86.2, arms: [{ d: [1, 0.05], h: 1.0 }, { d: [-0.2, -1], h: 0.78 }] },
    { x: -67.6, z: -119.0, arms: [{ d: [-0.25, -1], h: 1.0 }] },
  ]
  const put = makePut(B, null)
  for (const sp of posts) {
    const y = T.height(sp.x, sp.z)
    put.box('woodDark', 0.09, 1.32, 0.09, sp.x, y - 0.05, sp.z, { ry: rnd() * TAU, rz: (rnd() - 0.5) * 0.05, uv: 0.6 })
    put.cone('woodDark', 0.085, 0.12, 4, sp.x, y + 1.27, sp.z, { ry: 0.4 })
    for (const arm of sp.arms) {
      const L = Math.hypot(arm.d[0], arm.d[1])
      const ux = arm.d[0] / L
      const uz = arm.d[1] / L
      const ry = yawX(ux, uz)
      const axc = sp.x + ux * 0.26
      const azc = sp.z + uz * 0.26
      put.box('woodMid', 0.56, 0.14, 0.045, axc, y + arm.h, azc, { ry, c: true, uv: 0.6 })
      put.cone('woodMid', 0.07, 0.11, 4, sp.x + ux * 0.56, y + arm.h, sp.z + uz * 0.56, { rz: -HPI, ry, c: true })
      // carved text suggestion
      put.box('dark', 0.15, 0.024, 0.055, axc, y + arm.h + 0.025, azc, { ry, c: true })
      put.box('dark', 0.11, 0.02, 0.055, axc + ux * 0.02, y + arm.h - 0.025, azc + uz * 0.02, { ry, c: true })
    }
    blob(sp.x, sp.z, 0.28, 0.22, 0.3, 0)
  }
}

function buildMilestones(ctx) {
  const { B, T, meta, rnd, blob } = ctx
  const put = makePut(B, null)
  const pois = meta.poi || []
  let side = 1
  for (const name of ['south', 'west', 'castle', 'shrine']) {
    const road = (meta.roads || []).find((r) => r.name === name)
    if (!road) continue
    for (let i = 9; i < road.points.length - 6; i += 18) {
      const p = road.points[i]
      const q = road.points[i + 1]
      let dx = q.x - p.x
      let dz = q.z - p.z
      const L = Math.hypot(dx, dz) || 1
      dx /= L
      dz /= L
      side = -side
      const mx = p.x - dz * 2.15 * side
      const mz = p.z + dx * 2.15 * side
      if (Math.hypot(mx + 44, mz - 2) < 12) continue
      let nearPoi = false
      for (const pp of pois) if (Math.hypot(mx - pp.x, mz - pp.z) < 13) nearPoi = true
      if (nearPoi) continue
      if (T.slope(mx, mz) > 0.42 || T.isWater(mx, mz) || T.onRoad(mx, mz) > 0.55) continue
      const y = T.height(mx, mz)
      const ry = yawX(dx, dz)
      const lean = (rnd() - 0.5) * 0.12
      put.box('stoneBase', 0.24, 0.36, 0.15, mx, y - 0.06, mz, { ry, rz: lean, uv: 0.5 })
      put.box('stoneBase', 0.18, 0.13, 0.12, mx, y + 0.29, mz, { ry, rz: lean, uv: 0.5 })
      blob(mx, mz, 0.2, 0.16, 0.25, ry)
    }
  }
}

function buildPier(ctx) {
  const { B, T, meta, rnd, blob } = ctx
  const pier = meta.extras && meta.extras.pier
  if (!pier) return
  const put = makePut(B, null)
  const dx = Math.cos(pier.angle)
  const dz = Math.sin(pier.angle)
  const px2 = -dz
  const pz2 = dx
  const deck = pier.y
  const len = pier.length || 5
  const yawP = yawX(px2, pz2)
  const yawD = yawX(dx, dz)
  // planks + stringers
  const n = Math.floor(len / 0.3)
  for (let i = 0; i <= n; i++) {
    const t = i * 0.3
    put.box('woodMid', 1.15, 0.05, 0.235, pier.x + dx * t, deck + (rnd() - 0.5) * 0.012, pier.z + dz * t,
      { ry: yawP + (rnd() - 0.5) * 0.04, c: true, uv: 0.9 })
  }
  for (const s of [-1, 1]) {
    put.box('woodDark', len + 0.5, 0.1, 0.12,
      pier.x + dx * len * 0.5 + px2 * s * 0.4, deck - 0.1, pier.z + dz * len * 0.5 + pz2 * s * 0.4,
      { ry: yawD, c: true, uv: 0.9 })
  }
  // piles down into the shallows, X-braced where tall enough
  for (let t = 0.3; t < len + 0.3; t += 1.25) {
    for (const s of [-1, 1]) {
      const qx = pier.x + dx * t + px2 * s * 0.52
      const qz = pier.z + dz * t + pz2 * s * 0.52
      const gy = T.height(qx, qz)
      const h = deck + 0.14 - (gy - 0.3)
      put.cyl('woodDark', 0.05, 0.065, h, 6, qx, gy - 0.3, qz, {})
    }
    const mxp = pier.x + dx * t
    const mzp = pier.z + dz * t
    const gym = T.height(mxp, mzp)
    if (deck - gym > 0.75) {
      put.box('woodDark', 1.15, 0.05, 0.045, mxp, (deck + gym) * 0.5, mzp, { ry: yawP, rz: 0.5, c: true })
      put.box('woodDark', 1.15, 0.05, 0.045, mxp, (deck + gym) * 0.5, mzp, { ry: yawP, rz: -0.5, c: true })
    }
  }
  // mooring posts, rope coil, crate
  const ex = pier.x + dx * len
  const ez = pier.z + dz * len
  put.cyl('woodDark', 0.055, 0.07, 0.5, 6, ex + px2 * 0.45, deck, ez + pz2 * 0.45, { rz: 0.08 })
  put.cyl('woodDark', 0.055, 0.07, 0.42, 6, ex - px2 * 0.45, deck, ez - pz2 * 0.45, { rz: -0.06 })
  put.torus('rope', 0.13, 0.028, pier.x + dx * 1.1 + px2 * 0.3, deck + 0.05, pier.z + dz * 1.1 + pz2 * 0.3,
    { rx: HPI, c: true })
  put.box('woodMid', 0.42, 0.42, 0.42, pier.x + dx * 0.55 - px2 * 0.3, deck + 0.02, pier.z + dz * 0.55 - pz2 * 0.3,
    { ry: 0.5, uv: 0.55 })

  // the moored rowboat
  const bx2 = ex + dx * 1.7 + px2 * 1.35
  const bz2 = ez + dz * 1.7 + pz2 * 1.35
  const byaw = pier.angle + 0.35
  const fb = new THREE.Matrix4().makeRotationY(yawX(Math.cos(byaw), Math.sin(byaw)))
  fb.setPosition(bx2, 0, bz2)
  const putB = makePut(B, fb)
  putB.box('woodMid', 1.55, 0.3, 0.62, 0, 0.04, 0, { c: true, uv: 0.8 })
  putB.prism('woodMid', 0.62, 0.62, 0.3, 0.95, 0.04, 0, { rx: -HPI, ry: -HPI, uv: 0.8 })
  putB.prism('woodMid', 0.62, 0.4, 0.3, -0.86, 0.04, 0, { rx: -HPI, ry: HPI, uv: 0.8 })
  putB.box('dark', 1.3, 0.05, 0.44, 0, 0.1, 0, { c: true })
  putB.box('woodDark', 1.6, 0.05, 0.07, 0, 0.17, 0.29, { c: true })
  putB.box('woodDark', 1.6, 0.05, 0.07, 0, 0.17, -0.29, { c: true })
  putB.box('woodDark', 0.12, 0.04, 0.56, 0.25, 0.14, 0, { c: true })
  putB.box('woodDark', 0.12, 0.04, 0.56, -0.35, 0.14, 0, { c: true })
  addG(B.rope, gTube(catPts(ex + px2 * 0.45, deck + 0.45, ez + pz2 * 0.45, bx2 + dx * 0.6, 0.2, bz2 + dz * 0.6, 0.35, 8), 0.018, {}), null)
}

// ===========================================================================
// 11. createProps — textures, materials, build, merge, animate
// ===========================================================================

const BUCKET_KEYS = [
  'keep', 'curtain', 'roofCobalt', 'roofSlate', 'roofShingle', 'woodDark', 'woodMid',
  'plaster', 'timber', 'stoneBase', 'hay', 'canvas', 'red', 'gold', 'dark', 'lit', 'rope',
]

export function createProps({ terrain, atlas, renderer } = {}) {
  const group = new THREE.Group()
  group.name = 'propsRoot'
  if (typeof document === 'undefined' || !terrain) {
    return { object3D: group, update() {} }
  }
  const T = terrain
  const meta = T.meta || {}
  const aniso = renderer && renderer.capabilities ? renderer.capabilities.getMaxAnisotropy() : 4
  const rnd = mulberry32(0x5eed ^ 20260802)

  // ---- procedural material set -------------------------------------------
  const tKeep = canvasTex(256, aniso, (g, S) => paintMasonry(g, S, rnd, {
    lit: PAL.KEEP_LIT, mid: PAL.KEEP_MID, dark: PAL.KEEP_DARK, mortar: PAL.KEEP_MORTAR,
    courseH: 16, blockW: 30, chip: 0.3, grime: 0.22, moss: null,
  }))
  const tCurtain = canvasTex(256, aniso, (g, S) => paintMasonry(g, S, rnd, {
    lit: PAL.CURT_LIT, mid: PAL.CURT_MID, dark: PAL.CURT_DARK, mortar: PAL.CURT_MORTAR,
    courseH: 18, blockW: 34, chip: 0.18, grime: 0.4, moss: PAL.MOSS,
  }))
  const tStone = canvasTex(256, aniso, (g, S) => paintMasonry(g, S, rnd, {
    lit: PAL.STONE_LIT, mid: PAL.STONE_MID, dark: PAL.STONE_DARK, mortar: PAL.STONE_MORTAR,
    courseH: 26, blockW: 46, chip: 0.2, grime: 0.32, moss: PAL.MOSS,
  }))
  const tCobalt = canvasTex(256, aniso, (g, S) => paintCobalt(g, S, rnd))
  const tSlate = canvasTex(256, aniso, (g, S) => paintTiles(g, S, rnd, {
    lit: shade(PAL.SLATE, 1.28), dark: PAL.SLATE, gap: PAL.SLATE_DARK, chip: PAL.SLATE_CHIP,
    rowH: 18, tileW: 24, moss: true,
  }))
  const tShingle = canvasTex(256, aniso, (g, S) => paintTiles(g, S, rnd, {
    lit: shade(PAL.SHINGLE, 1.18), dark: PAL.SHINGLE, gap: PAL.SHINGLE_DARK, chip: PAL.SHINGLE_CHIP,
    rowH: 14, tileW: 20, moss: false,
  }))
  const tWoodD = canvasTex(256, aniso, (g, S) => paintWood(g, S, rnd, PAL.WOOD_DARK, 0.36))
  const tWoodM = canvasTex(256, aniso, (g, S) => paintWood(g, S, rnd, PAL.WOOD_MID, 0.42))
  const tPlaster = canvasTex(256, aniso, (g, S) => paintPlaster(g, S, rnd))
  const tTimber = canvasTex(256, aniso, (g, S) => paintTimber(g, S, rnd))
  const tHay = canvasTex(128, aniso, (g, S) => paintHay(g, S, rnd))
  const tCanvas = canvasTex(128, aniso, (g, S) => paintCanvas(g, S, rnd))
  const tRed = canvasTex(128, aniso, (g, S) => paintRed(g, S, rnd))
  const tBlob = canvasTex(64, 1, (g, S) => paintBlob(g, S))
  const tGlow = canvasTex(128, 1, (g, S) => paintGlow(g, S))

  const std = (map, roughness, extra) => new THREE.MeshStandardMaterial(
    Object.assign({ map, roughness, metalness: 0 }, extra || {}))
  const MAT = {
    keep: std(tKeep, 0.92),
    curtain: std(tCurtain, 0.95),
    roofCobalt: std(tCobalt, 0.55),
    roofSlate: std(tSlate, 0.85),
    roofShingle: std(tShingle, 0.9),
    woodDark: std(tWoodD, 0.9),
    woodMid: std(tWoodM, 0.88),
    plaster: std(tPlaster, 0.96),
    timber: std(tTimber, 0.96),
    stoneBase: std(tStone, 0.95),
    hay: std(tHay, 1.0),
    canvas: std(tCanvas, 0.92, { side: THREE.DoubleSide }),
    red: std(tRed, 0.8),
    gold: new THREE.MeshStandardMaterial({ color: 0xd9b542, metalness: 0.55, roughness: 0.38 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x14171d, roughness: 1 }),
    lit: new THREE.MeshStandardMaterial({
      color: 0x4a3418, emissive: 0xffc668, emissiveIntensity: 2.0, roughness: 0.8,
    }),
    rope: new THREE.MeshStandardMaterial({ color: 0x6b5335, roughness: 1 }),
  }

  // ---- build context ------------------------------------------------------
  const B = {}
  for (const k of BUCKET_KEYS) B[k] = []
  const blobs = []
  const pennants = []
  const roadPts = []
  for (const road of meta.roads || []) {
    for (let i = 0; i < road.points.length; i += 2) {
      roadPts.push(road.points[i].x, road.points[i].z)
    }
  }
  const ctx = {
    B,
    T,
    meta,
    rnd,
    roadPts,
    firePos: null,
    blob: (x, z, rx, rz, a, yaw) => blobs.push({ x, z, rx, rz, a, yaw }),
    pennant: (v, yaw, color) => pennants.push({ x: v.x, y: v.y, z: v.z, yaw, color }),
  }

  // ---- landmarks from terrain.meta.poi -----------------------------------
  for (const poi of meta.poi || []) {
    if (poi.kind === 'castle') buildCastle(ctx, poi)
    else if (poi.kind === 'village') buildVillage(ctx, poi)
    else if (poi.kind === 'shrine') buildShrine(ctx, poi)
    else if (poi.kind === 'farm') buildFarm(ctx, poi)
    else if (poi.kind === 'camp') buildCamp(ctx, poi)
    else if (poi.kind === 'bridge') {
      if (poi.name && poi.name.indexOf('Trestle') >= 0) {
        buildPlankBridge(ctx, { x: -84, z: -59.8 }, { x: -85, z: -73.2 }, poi.y || 18, 'trestle')
      } else {
        buildPlankBridge(ctx, { x: -34.3, z: -117.9 }, { x: -25.7, z: -118.3 }, poi.y || 26, 'rope')
      }
    }
  }
  buildArchBridge(ctx)
  buildSignposts(ctx)
  buildMilestones(ctx)
  buildPier(ctx)

  // ---- merge one mesh per material ---------------------------------------
  for (const k of BUCKET_KEYS) {
    if (!B[k].length) continue
    const merged = mergeGeometries(B[k], false)
    if (!merged) continue
    const mesh = new THREE.Mesh(merged, MAT[k])
    mesh.name = 'props_' + k
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
    for (const g of B[k]) g.dispose()
    B[k].length = 0
  }

  // ---- contact-shadow blobs (one merged transparent mesh) ----------------
  if (blobs.length) {
    const cLin = new THREE.Color(0x241611).convertSRGBToLinear()
    const up = new THREE.Vector3(0, 1, 0)
    const nrm = new THREE.Vector3()
    const q = new THREE.Quaternion()
    const parts = []
    for (const e of blobs) {
      const gg = new THREE.PlaneGeometry(e.rx * 2, e.rz * 2).toNonIndexed()
      gg.rotateX(-HPI)
      if (e.yaw) gg.rotateY(e.yaw)
      T.normal(e.x, e.z, nrm)
      q.setFromUnitVectors(up, nrm)
      gg.applyQuaternion(q)
      gg.translate(e.x, T.height(e.x, e.z) + 0.06, e.z)
      const nv = gg.attributes.position.count
      const col = new Float32Array(nv * 4)
      for (let i = 0; i < nv; i++) {
        col[i * 4] = cLin.r
        col[i * 4 + 1] = cLin.g
        col[i * 4 + 2] = cLin.b
        col[i * 4 + 3] = e.a
      }
      gg.setAttribute('color', new THREE.BufferAttribute(col, 4))
      parts.push(gg)
    }
    const bg = mergeGeometries(parts, false)
    if (bg) {
      const bm = new THREE.Mesh(bg, new THREE.MeshBasicMaterial({
        map: tBlob, transparent: true, depthWrite: false, vertexColors: true,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      }))
      bm.name = 'props_contactShadows'
      bm.renderOrder = 1
      group.add(bm)
      for (const g of parts) g.dispose()
    }
  }

  // ---- pennants: one merged mesh with a wind wave in the vertex stage ----
  const timeU = { value: 0 }
  if (pennants.length) {
    const parts = []
    let pi = 0
    for (const e of pennants) {
      const gg = new THREE.PlaneGeometry(0.42, 0.13, 7, 1)
      const pos = gg.attributes.position
      const uv = gg.attributes.uv
      for (let i = 0; i < pos.count; i++) {
        const u = uv.getX(i)
        pos.setY(i, pos.getY(i) * (1 - u * 0.72))
        pos.setX(i, pos.getX(i) + 0.21)
      }
      const ng = gg.toNonIndexed()
      gg.dispose()
      ng.rotateY(e.yaw + 2.4)
      ng.translate(e.x, e.y - 0.04, e.z)
      const nv = ng.attributes.position.count
      const cc = new THREE.Color(e.color).convertSRGBToLinear()
      const col = new Float32Array(nv * 3)
      const ph = new Float32Array(nv)
      for (let i = 0; i < nv; i++) {
        col[i * 3] = cc.r
        col[i * 3 + 1] = cc.g
        col[i * 3 + 2] = cc.b
        ph[i] = pi * 1.73
      }
      ng.setAttribute('color', new THREE.BufferAttribute(col, 3))
      ng.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1))
      parts.push(ng)
      pi++
    }
    const pg = mergeGeometries(parts, false)
    if (pg) {
      const pm = new THREE.MeshStandardMaterial({
        vertexColors: true, side: THREE.DoubleSide, roughness: 0.85, metalness: 0,
      })
      pm.onBeforeCompile = (sh) => {
        sh.uniforms.uTime = timeU
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime;\nattribute float aPhase;')
          .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  float fl = uv.x;
  transformed.z += (sin(uTime * 5.2 + aPhase + uv.x * 6.5) * 0.075
                  + sin(uTime * 3.4 + aPhase * 1.7 + uv.x * 3.1) * 0.03) * fl;
  transformed.y += cos(uTime * 4.1 + aPhase + uv.x * 5.0) * 0.028 * fl;
}`)
      }
      pm.customProgramCacheKey = () => 'aetherbound-props-pennant'
      const pmesh = new THREE.Mesh(pg, pm)
      pmesh.name = 'props_pennants'
      group.add(pmesh)
      for (const g of parts) g.dispose()
    }
  }

  // ---- campfire: flame cones + additive glow + flickering point light ----
  let flameA = null
  let flameB = null
  let glow = null
  let fireLight = null
  if (ctx.firePos) {
    const fp = ctx.firePos
    flameA = new THREE.Mesh(
      new THREE.ConeGeometry(0.17, 0.52, 7),
      new THREE.MeshStandardMaterial({ color: 0x2a1206, emissive: 0xff7a26, emissiveIntensity: 2.6, roughness: 1 })
    )
    flameA.position.set(fp.x, fp.y + 0.3, fp.z)
    flameB = new THREE.Mesh(
      new THREE.ConeGeometry(0.095, 0.34, 7),
      new THREE.MeshStandardMaterial({ color: 0x3a2006, emissive: 0xffd977, emissiveIntensity: 3.2, roughness: 1 })
    )
    flameB.position.set(fp.x + 0.02, fp.y + 0.22, fp.z - 0.01)
    glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tGlow, color: 0xffa04c, blending: THREE.AdditiveBlending,
      transparent: true, depthWrite: false, opacity: 0.5,
    }))
    glow.position.set(fp.x, fp.y + 0.5, fp.z)
    glow.scale.set(2.6, 2.0, 1)
    fireLight = new THREE.PointLight(0xff9040, 2.2, 11, 2)
    fireLight.position.set(fp.x, fp.y + 0.75, fp.z)
    group.add(flameA, flameB, glow, fireLight)
  }

  // ---- per-frame animation ------------------------------------------------
  function update(t /*, camera */) {
    timeU.value = t
    if (flameA) {
      const s1 = 1 + 0.1 * Math.sin(t * 12.7) + 0.05 * Math.sin(t * 29.3)
      const s2 = 1 + 0.16 * Math.sin(t * 9.1 + 1.3)
      flameA.scale.set(s1, s2, s1)
      flameA.rotation.y = t * 1.7
      flameB.scale.set(2 - s1, 1 + 0.2 * Math.sin(t * 11.3 + 0.6), 2 - s1)
      flameB.rotation.y = -t * 2.3
      fireLight.intensity = 2.1 + 0.36 * (Math.sin(t * 11.3) + Math.sin(t * 7.1 + 1.7) + Math.sin(t * 23.7 + 0.4)) / 3
      glow.material.opacity = 0.42 + 0.09 * Math.sin(t * 10.7 + 0.7)
    }
  }

  return { object3D: group, update }
}
