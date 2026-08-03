// ---------------------------------------------------------------------------
// src/world/props.js — Aetherbound overworld landmarks (FRAMING.md round 4)
//
// Rebuilt to docs/FRAMING.md §4 / §8 (the binding tabletop-miniature solve).
// Everything sits within ~90 m of the boot camera; sizes are toy scale.
//
//   castle   — white-and-cobalt layered palace on the y 10.5 plateau.
//              Footprint x −28…−21.5, z +13…+19.3 (frontage ~6.5 m), S wall
//              at z +19, gate arch centre (−24.8, +19.3) facing S-SW.
//              Total height 6.0 m (curtain 2.4, roofline 3.9, gatehouse 3.1);
//              tallest spire at the SW corner (−28, +19.5), tip y 16.5.
//              Monumentality from spire COUNT and silhouette: seven slender
//              white towers with tall cobalt cone spires + gold finials,
//              plus mini pinnacles; the curtain ring is cut back to the S
//              frontage and two short returns so towers own the skyline.
//   paddocks — exactly three §4 wheat paddocks + P1's small W lobe:
//              P1 (−37, +15.5) 8×5.5 (road clips its W edge — the fence gap
//              comes straight from terrain.onRoad), W lobe (−40.5, +16) 3×4,
//              P2 (−36.5, +22.5) 12×7, big SE field (−29.5, +28.5) 14×9.
//              Two-rail toy fences: post 0.5 m, rails 0.22 / 0.42, span 1.3.
//              The old giant southern fields are DELETED.
//   bridges  — north timber trestle at (−41, −1), deck y 13.5, span 9,
//              oriented N–S (plainly visible at 0.44 fw / 0.145 fh: planks,
//              stringers, post-and-rail parapets, cribs and full trestle
//              bents down into the gorge). Inlet trestle at (−59, +9.5),
//              deck y 12, span 10, crossing NW–SE (hazed silhouette).
//   village  — hazy slate-roof hamlet at the village POI (−50.5, −16.5):
//              rooftop silhouettes (slate #3f4450, ridge caps, chimneys) —
//              no clutter, it reads at the top edge through fog.
//   signpost — road-fork signpost (−49.5, +8.5), 1.3 m, three arms.
//   pier     — (−64, −16), deck +0.4, 5 m, pointing WSW, moored rowboat.
//   shrine   — torii + lantern + hall at the shrine POI (fog-hidden).
//   camp     — tent, fire ring (animated flame/glow/light), crates — POI-
//              relative, below the boot frame.
//
// Every texture is painted in Canvas2D at runtime; geometry merges into one
// mesh per material. Painted-diorama read: 4-shade ramps, no gradients,
// colour-matched dark openings, contact-shadow blobs under everything.
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
  // castle stone: the FRAMING defect-5 ramp — white, never beige
  KEEP_LIT: rgb(0xe8e3d3), // CASTLE_STONE_LIT
  KEEP_MID: rgb(0xc2bdac), // CASTLE_STONE_MID
  KEEP_DARK: rgb(0x8e8b7d), // CASTLE_STONE_SHADOW
  KEEP_MORTAR: rgb(0xa5a191),
  PAVE_LIT: rgb(0xe0dac8),
  PAVE_MID: rgb(0xc7c1af),
  PAVE_DARK: rgb(0xa19d8b),
  PAVE_MORTAR: rgb(0x8d8a79),
  MOSS: rgb(0x5c7048),
  COBALT_LIT: rgb(0x5477c8), // ROOF_COBALT_LIT
  COBALT: rgb(0x35549c), // ROOF_COBALT
  COBALT_DARK: rgb(0x232f56), // ROOF_COBALT_SHADOW
  COBALT_SPEC: rgb(0xb9c6e4), // ROOF_SPEC streak
  SLATE: rgb(0x3f4450), // VILLAGE_ROOF
  SLATE_DARK: rgb(0x25272e),
  SLATE_CHIP: rgb(0x9aa0a8), // VILLAGE_ROOF_RIDGE
  WOOD_DARK: rgb(0x5d4226), // FENCE / TRESTLE WOOD
  WOOD_MID: rgb(0x7b5c3a),
  PLASTER: rgb(0xd9c9a8), // VILLAGE_WALL
  TIMBER: rgb(0x55402a),
  STONE_LIT: rgb(0x9aa38c),
  STONE_MID: rgb(0x7d8a76),
  STONE_DARK: rgb(0x5f6d5f),
  STONE_MORTAR: rgb(0x3f4a42),
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
      if (rnd() < (o.darkP === undefined ? 0.1 : o.darkP)) base = mixc(o.mid, o.dark, 0.4 + rnd() * 0.5)
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

// Roof tiles: offset rows, tint jitter, dark undersides, chipped edges.
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

// Cobalt spire roofing: vertical panel strips with shingle courses and
// guaranteed ROOF_SPEC #b9c6e4 streaks — the plate's signature roof glints.
function paintCobalt(g, S, rnd) {
  g.fillStyle = css(PAL.COBALT_LIT)
  g.fillRect(0, 0, S, S)
  const stripW = 26
  const rowH = 30
  for (let x = 0; x < S; x += stripW) {
    let base = mixc(PAL.COBALT_LIT, PAL.COBALT, Math.pow(rnd(), 1.6) * 0.6)
    if (rnd() < 0.08) base = mixc(PAL.COBALT, PAL.COBALT_DARK, 0.3)
    g.fillStyle = css(base)
    g.fillRect(x, 0, stripW - 1, S)
    g.fillStyle = css(shade(base, 1.14))
    g.fillRect(x, 0, 2, S) // strip edge catch-light
    const off = (x / stripW) % 2 ? rowH * 0.5 : 0
    for (let y = -rowH; y < S + rowH; y += rowH) {
      const yy = y + off
      g.fillStyle = css(mixc(base, PAL.COBALT_DARK, 0.55))
      g.fillRect(x, ((yy % S) + S) % S, stripW - 1, 1.6) // course shadow line
      g.fillStyle = css(shade(base, 1.12))
      g.fillRect(x + 1, (((yy + 2) % S) + S) % S, stripW * 0.6, 1.2)
    }
    if ((x / stripW) % 3 === 1 || rnd() < 0.12) {
      g.globalAlpha = 0.65
      g.fillStyle = css(PAL.COBALT_SPEC)
      g.fillRect(x + 3, 0, 3, S) // specular flute streak
      g.globalAlpha = 0.3
      g.fillRect(x + 7, 0, 2, S)
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
  const w = o.w || 0.24
  const h = o.h || 0.22
  const d = o.d || 0.16
  const pitch = o.pitch || 0.5
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

// ===========================================================================
// 4. THE CASTLE — white-and-cobalt palace, FRAMING §4 (defect 5 rebuild)
//
// World targets (poi at (−24.5, +16), plateau flat y 10.5):
//   footprint x −28…−21.5, z +13…+19.3  → local x −3.5…+3.0, z −3.0…+3.3
//   S wall z +19 (local +3.0); gate arch centre (−24.8, +19.3) local (−0.3, +3.3)
//   curtain 2.4 · gatehouse 3.1 · roofline 3.9 · SW spire (−28, +19.5) tip 6.0
// Silhouette = seven slender white towers with tall cobalt cones + gold
// finials; the curtain ring is only the S frontage + two short returns.
// ===========================================================================

function buildCastle(ctx, poi) {
  const { B, T, blob, pennant } = ctx
  const padY = T.height(poi.x, poi.z) // plateau flat ≈ 10.5
  const frame = new THREE.Matrix4().setPosition(poi.x, padY, poi.z)
  const put = makePut(B, frame)

  // -- slender white tower with a tall cobalt cone spire + gold finial.
  //    Finial cone top lands exactly at body + 0.07 + coneH + 0.33.
  const spire = (x, z, r, body, coneH, opts = {}) => {
    put.cyl('keep', r + 0.1, r + 0.2, 0.3, 9, x, -0.35, z, { uv: 1.1 }) // footing
    put.cyl('keep', r * 0.9, r, body, 9, x, 0, z, { uv: 1.1, vlock: true })
    put.cyl('keep', r * 1.14, r * 1.14, 0.07, 9, x, body, z, {}) // corbel ring
    put.cone('roofCobalt', r * 1.22, coneH, 10, x, body + 0.07, z, { uv: 0.9 })
    const tip = body + 0.07 + coneH
    put.sphere('gold', Math.max(0.05, r * 0.17), x, tip + 0.06, z, {})
    put.cone('gold', 0.042, 0.24, 6, x, tip + 0.09, z, {})
    // dark slit windows on the S face (toward camera)
    const nS = opts.slits === undefined ? 2 : opts.slits
    for (let i = 0; i < nS; i++) {
      put.box('dark', 0.09, 0.26, 0.05, x, body * (0.32 + i * 0.3), z + r * 0.96, {})
    }
    if (opts.flag) pennant(put.world(x, tip + 0.3, z), 0, opts.flag)
    return tip
  }

  // ---- the seven towers (heights all differ; SW is the 6.0 m landmark) ---
  spire(-3.5, 3.5, 0.42, 3.2, 2.4, { slits: 3, flag: 0x35549c }) // SW — tip y 16.5
  spire(3.0, 3.0, 0.36, 2.3, 1.55, { slits: 2 }) // SE corner
  spire(-3.5, 0.4, 0.3, 2.7, 1.5, { slits: 2 }) // W return
  spire(-3.3, -2.5, 0.36, 2.9, 1.9, { slits: 2 }) // NW rear
  spire(-0.9, -2.9, 0.32, 3.3, 1.75, { slits: 2, flag: 0xd9b542 }) // N centre — 2nd tallest
  spire(2.3, -2.6, 0.34, 2.5, 1.6, { slits: 2 }) // NE rear
  spire(3.0, 0.9, 0.27, 2.1, 1.3, { slits: 1 }) // E return, smallest

  // ---- main keep block: white walls, huge cobalt gable (roofline 3.9) ----
  const KX = -0.15
  const KZ = 0.1
  put.box('keep', 4.5, 2.7, 3.5, KX, 0, KZ, { uv: 1.4, vlock: true })
  put.box('keep', 4.8, 0.4, 3.8, KX, -0.3, KZ, { uv: 1.4 }) // plinth
  put.prism('roofCobalt', 4.6, 1.2, 3.6, KX, 2.7, KZ, { uv: 1.0 }) // ridge y 3.9
  put.box('gold', 0.1, 0.08, 3.65, KX, 3.86, KZ, { uv: 0.6 }) // gold ridge cap
  put.sphere('gold', 0.09, KX, 3.98, KZ + 1.8, {})
  put.sphere('gold', 0.09, KX, 3.98, KZ - 1.8, {})
  // S gable face: arched tracery window over a portal band
  put.arch('keep', 0.9, 1.05, 0.12, 0.56, 0.92, KX, 1.75, KZ + 1.79, { uv: 1.0 })
  put.box('dark', 0.6, 0.9, 0.05, KX, 1.78, KZ + 1.77, {})
  put.box('keep', 0.035, 0.7, 0.045, KX - 0.1, 1.8, KZ + 1.81, {})
  put.box('keep', 0.035, 0.7, 0.045, KX + 0.1, 1.8, KZ + 1.81, {})
  put.box('gold', 1.0, 0.05, 0.1, KX, 1.68, KZ + 1.79, {})
  // dark slit windows on the keep S + E/W faces
  for (const sx of [-1.6, -0.9, 0.7, 1.4]) put.box('dark', 0.11, 0.34, 0.05, KX + sx, 0.9, KZ + 1.77, {})
  for (const s of [-1, 1]) {
    for (const zz of [-0.9, 0.2, 1.0]) put.box('dark', 0.11, 0.3, 0.05, KX + s * 2.27, 0.85, KZ + zz, { ry: HPI })
  }
  // mini pinnacles on the keep's roof corners — spire-count silhouette
  for (const [px, pz] of [[KX - 2.05, KZ + 1.55], [KX + 2.05, KZ + 1.55], [KX - 2.05, KZ - 1.55], [KX + 2.05, KZ - 1.55]]) {
    put.cyl('keep', 0.085, 0.105, 0.55, 6, px, 2.55, pz, {})
    put.cone('roofCobalt', 0.13, 0.42, 6, px, 3.1, pz, {})
    put.sphere('gold', 0.045, px, 3.56, pz, {})
  }

  // ---- side wings (layered massing, lower cobalt gables) -----------------
  put.box('keep', 1.5, 1.7, 2.4, -2.85, 0, 0.5, { uv: 1.4, vlock: true }) // W wing
  put.prism('roofCobalt', 1.6, 0.7, 2.5, -2.85, 1.7, 0.5, { uv: 1.0 })
  put.box('dark', 0.11, 0.3, 0.05, -2.85, 0.8, 1.72, {})
  put.box('keep', 1.9, 1.9, 2.5, 2.15, 0, 0.4, { uv: 1.4, vlock: true }) // E wing
  put.prism('roofCobalt', 2.0, 0.8, 2.6, 2.15, 1.9, 0.4, { uv: 1.0 })
  put.box('dark', 0.11, 0.3, 0.05, 1.85, 0.85, 1.67, {})
  put.box('dark', 0.11, 0.3, 0.05, 2.55, 0.85, 1.67, {})

  // ---- curtain: S frontage (h 2.4) + two short returns, gate split -------
  const wallSeg = (ax, az, bx, bz) => {
    const dx = bx - ax
    const dz = bz - az
    const L = Math.hypot(dx, dz)
    const wy = yawX(dx / L, dz / L)
    const mx = (ax + bx) / 2
    const mz = (az + bz) / 2
    put.box('keep', L + 0.1, 2.4, 0.42, mx, 0, mz, { ry: wy, uv: 1.4, vlock: true })
    put.box('keep', L + 0.1, 0.45, 0.6, mx, -0.35, mz, { ry: wy, uv: 1.4 }) // batter
    put.box('keep', L + 0.1, 0.09, 0.56, mx, 2.4, mz, { ry: wy, uv: 1.4 }) // coping
    crenels(put, 'keep', ax, az, bx, bz, 2.49, { w: 0.22, h: 0.2, d: 0.15, pitch: 0.48 })
    // slits on the OUTER face, whatever the wall's orientation
    let nx = -dz / L
    let nz = dx / L
    if (nx * mx + nz * mz < 0) {
      nx = -nx
      nz = -nz
    }
    const nS = Math.max(1, Math.floor(L / 1.6))
    for (let k = 0; k < nS; k++) {
      const t = (k + 0.5) / nS
      put.box('dark', 0.1, 0.3, 0.05, ax + dx * t + nx * 0.24, 1.35, az + dz * t + nz * 0.24,
        { ry: Math.atan2(nx, nz) })
    }
  }
  wallSeg(-3.5, 3.0, -1.25, 3.0) // S wall, W of gate
  wallSeg(0.65, 3.0, 3.0, 3.0) // S wall, E of gate
  wallSeg(-3.5, 3.0, -3.5, 1.2) // short W return
  wallSeg(3.0, 3.0, 3.0, 1.5) // short E return

  // ---- gatehouse: h 3.1, arch centred at local (−0.3, +3.3) --------------
  const GX = -0.3
  for (const s of [-1, 1]) {
    const tx = GX + s * 0.78
    put.box('keep', 0.62, 3.1, 0.72, tx, 0, 3.12, { uv: 1.2, vlock: true })
    put.box('keep', 0.72, 0.08, 0.82, tx, 3.1, 3.12, {})
    crenels(put, 'keep', tx - 0.28, 3.12, tx + 0.28, 3.12, 3.22, { w: 0.16, h: 0.16, d: 0.13, pitch: 0.3 })
    put.cone('roofCobalt', 0.3, 0.85, 8, tx, 3.18, 3.12, { uv: 0.9 })
    put.sphere('gold', 0.06, tx, 4.1, 3.12, {})
    put.box('dark', 0.1, 0.3, 0.05, tx, 1.5, 3.5, {})
    put.box('dark', 0.09, 0.24, 0.05, tx, 2.35, 3.5, {})
  }
  put.arch('keep', 1.56, 2.55, 0.4, 0.92, 1.45, GX, 0, 3.3, { uv: 1.2 }) // gate wall
  put.box('keep', 2.2, 0.09, 0.5, GX, 2.55, 3.3, {})
  crenels(put, 'keep', GX - 0.5, 3.3, GX + 0.5, 3.3, 2.64, { w: 0.18, h: 0.18, d: 0.14, pitch: 0.34 })
  put.box('gold', 0.07, 0.4, 0.07, GX, 2.64, 3.3, {})
  put.sphere('gold', 0.07, GX, 3.08, 3.3, {})
  pennant(put.world(GX, 3.0, 3.3), 0, 0xb0453c)
  // raised portcullis bars in the arch head + dark passage behind
  for (let i = -2; i <= 2; i++) {
    put.box('dark', 0.04, 0.55, 0.04, GX + i * 0.17, 0.95, 3.34, {})
  }
  put.box('dark', 0.85, 0.04, 0.045, GX, 1.18, 3.34, {})
  put.box('dark', 0.95, 1.35, 0.1, GX, 0, 2.95, {}) // shadowed passage mouth

  // ---- courtyard pave + gate apron / steps down to the road --------------
  put.box('pave', 6.3, 0.05, 6.1, -0.25, 0.015, 0.1, { uv: 2.2 })
  // apron in front of the gate (plateau is flat to z +22) + two low steps,
  // each sampling terrain so the approach never floats
  const A = put.world(GX, 0, 3.75)
  const steps = [
    [A.x - 0.35, A.z + 0.55, 2.2, 1.1],
    [A.x - 0.7, A.z + 1.5, 2.0, 0.95],
  ]
  let prevTop = padY + 0.05
  const putW = makePut(B, null)
  for (const [sx, sz, sw, sd] of steps) {
    const gy = Math.min(T.height(sx, sz), prevTop - 0.09)
    putW.box('pave', sw, prevTop - gy + 0.35, sd, sx, gy - 0.35, sz, { ry: -0.35, uv: 1.1 })
    prevTop = gy
  }
  // gold-tipped red pennant posts framing the approach
  for (const s of [-1, 1]) {
    const bx = A.x - 0.5 + s * 1.35
    const bz = A.z + 1.1 - s * 0.35
    const by = T.height(bx, bz)
    putW.cyl('woodDark', 0.03, 0.04, 1.3, 6, bx, by - 0.05, bz, {})
    putW.sphere('gold', 0.045, bx, by + 1.3, bz, {})
    ctx.pennant(new THREE.Vector3(bx, by + 1.2, bz), -0.35, 0xb0453c)
    blob(bx, bz, 0.22, 0.18, 0.24, 0)
  }
  blob(poi.x - 0.25, poi.z + 0.2, 4.3, 3.9, 0.24, 0)
}

// ===========================================================================
// 5. VILLAGE — hazy slate hamlet at the POI: rooftop silhouettes only
// ===========================================================================

const HOUSE_PLANS = {
  A: { w: 2.5, d: 2.1, wallH: 1.15, rise: 0.95, chimney: true },
  B: { w: 2.7, d: 2.1, wallH: 1.2, rise: 1.0, chimney: true },
  C: { w: 3.6, d: 2.3, wallH: 1.3, rise: 1.05, chimney: true },
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
  const ph = hmax - hmin + 0.3
  const frame = new THREE.Matrix4().makeRotationY(rot)
  frame.setPosition(hx, baseY, hz)
  const put = makePut(B, frame)

  put.box('stoneBase', p.w + 0.2, ph, p.d + 0.2, 0, 0, 0, { uv: 1.1 })
  const GF = ph
  put.box(wallBk, p.w, p.wallH, p.d, 0, GF, 0, { uv: p.w + 0.001, vlock: true })
  put.prism(wallBk, p.w, p.rise, p.d, 0, GF + p.wallH, 0, { uv: p.w + 0.001 })
  gableRoof(put, 'roofSlate', p.w, p.d, p.rise, 0.22, 0.18, 0, GF + p.wallH, 0, { uv: 1.05 })

  // door + one window — silhouette dressing only, the hamlet is 70 m out
  put.box('dark', 0.5, 0.9, 0.07, 0, GF, p.d / 2 + 0.01, {})
  put.box(lit ? 'lit' : 'dark', 0.3, 0.36, 0.08, p.w * 0.28, GF + 0.42, p.d / 2 - 0.01, {})

  if (p.chimney) {
    const chx = -p.w * 0.22
    const chz = -p.d * 0.14
    put.box('stoneBase', 0.3, p.rise + 0.85, 0.3, chx, GF + p.wallH - 0.15, chz, { uv: 0.7 })
    put.box('stoneBase', 0.42, 0.07, 0.42, chx, GF + p.wallH + p.rise + 0.7, chz, { uv: 0.7 })
    put.box('dark', 0.16, 0.06, 0.16, chx, GF + p.wallH + p.rise + 0.77, chz, {})
  }
  blob(hx, hz, p.w * 0.62 + 0.5, p.d * 0.62 + 0.5, 0.34, rot)
}

function buildVillage(ctx, poi) {
  // FRAMING §4: hamlet at (−50.5, −16.5) y 11.5, projects to (0.30, 0.055) —
  // a tight cluster of slate ridgelines at the hazed top edge.
  const layout = [
    [-2.4, 1.6, 1.62, 'A', 'plaster', true],
    [2.2, -0.4, -1.45, 'B', 'timber', false],
    [-3.1, -2.6, 1.48, 'C', 'timber', false],
    [3.3, -3.0, -1.72, 'A', 'plaster', false],
    [0.2, -4.4, 3.02, 'A', 'timber', false],
    [-1.6, 3.9, -0.51, 'D', 'plaster', false],
    [4.7, 1.9, 0.78, 'B', 'plaster', false],
    [-5.3, -0.4, 3.05, 'D', 'timber', false],
    [0.4, -0.9, 0.35, 'C', 'plaster', false],
  ]
  for (const [ox, oz, rot, plan, wall, lit] of layout) {
    buildHouse(ctx, poi.x + ox, poi.z + oz, rot, plan, wall, lit)
  }
}

// ===========================================================================
// 6. SHRINE — torii, stone lanterns, tiled hall (fog-hidden POI, kept alive)
// ===========================================================================

function buildShrine(ctx, poi) {
  const { B, T, blob } = ctx
  const ax = -0.6
  const az = -0.8
  const yaw = Math.atan2(ax, az)
  const px2 = poi.x - ax * 0.6
  const pz2 = poi.z - az * 0.6
  const py = T.height(px2, pz2)
  const frame = new THREE.Matrix4().makeRotationY(yaw)
  frame.setPosition(px2, py, pz2)
  const put = makePut(B, frame)

  put.box('stoneBase', 4.4, 0.28, 3.4, 0, 0, 0, { uv: 1.0 })
  put.box('stoneBase', 3.7, 0.26, 2.8, 0, 0.28, 0, { uv: 1.0 })
  for (const [hx2, hz2] of [[-0.88, -0.66], [0.88, -0.66], [-0.88, 0.66], [0.88, 0.66]]) {
    put.cyl('red', 0.055, 0.07, 0.98, 7, hx2, 0.54, hz2, {})
  }
  put.box('woodDark', 1.7, 0.95, 1.25, 0, 0.6, 0, { uv: 1.2, vlock: true })
  put.box('dark', 0.34, 0.66, 0.05, -0.19, 0.72, 0.63, {})
  put.box('dark', 0.34, 0.66, 0.05, 0.19, 0.72, 0.63, {})
  put.box('gold', 0.035, 0.66, 0.06, 0, 0.72, 0.63, {})
  put.box('woodDark', 1.85, 0.12, 1.4, 0, 0.48, 0, { uv: 1.2 })
  put.prism('woodDark', 2.4, 0.72, 1.5, 0, 1.55, 0, { uv: 1.2 })
  const yr = gableRoof(put, 'roofSlate', 2.4, 1.5, 0.72, 0.42, 0.34, 0, 1.55, 0, { uv: 1.05, ridgeW: 0.16 })
  put.sphere('gold', 0.05, 0, yr + 0.02, 1.12, {})
  put.sphere('gold', 0.05, 0, yr + 0.02, -1.12, {})
  blob(px2, pz2, 2.6, 2.1, 0.32, yaw)

  // torii astride the approach
  const tx = poi.x + ax * 4.2
  const tz = poi.z + az * 4.2
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

  // one stone lantern beside the path
  const lx = poi.x + ax * 2.6 - az * 1.0
  const lz = poi.z + az * 2.6 + ax * 1.0
  const ly = T.height(lx, lz)
  const fl = new THREE.Matrix4().makeRotationY(yaw)
  fl.setPosition(lx, ly, lz)
  const putL = makePut(B, fl)
  putL.box('stoneBase', 0.34, 0.14, 0.34, 0, 0, 0, { uv: 0.6 })
  putL.cyl('stoneBase', 0.05, 0.068, 0.4, 7, 0, 0.14, 0, {})
  putL.box('stoneBase', 0.26, 0.24, 0.26, 0, 0.54, 0, { uv: 0.6 })
  putL.box('lit', 0.11, 0.12, 0.28, 0, 0.6, 0, {})
  putL.cone('stoneBase', 0.3, 0.2, 4, 0, 0.78, 0, { ry: Math.PI / 4, uv: 0.6 })
  blob(lx, lz, 0.3, 0.3, 0.3, 0)
}

// ===========================================================================
// 7. TRESTLE BRIDGES — timber post-and-rail with full bents into the gorge
// ===========================================================================

function buildTrestle(ctx, A, Bp, deckSpec) {
  const { B, T, rnd, blob } = ctx
  const put = makePut(B, null)
  let dx = Bp.x - A.x
  let dz = Bp.z - A.z
  const span = Math.hypot(dx, dz)
  dx /= span
  dz /= span
  const px = -dz
  const pz = dx
  const yawP = yawX(px, pz)
  const yawD = yawX(dx, dz)
  // never bury the deck: honour the spec height but clear both abutments
  const hA = T.height(A.x, A.z)
  const hB = T.height(Bp.x, Bp.z)
  const deckY = Math.max(deckSpec, hA + 0.12, hB + 0.12)
  const sag = 0.12
  const deckAt = (t) => deckY - sag * 4 * t * (1 - t)

  // planks riding the shallow sag, slight age jitter
  const step = 0.36
  const n = Math.floor(span / step)
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const x = A.x + dx * t * span
    const z = A.z + dz * t * span
    const slope = Math.atan2(-sag * 4 * (1 - 2 * t), span)
    put.box('woodMid', 1.18, 0.05, step * 0.72, x, deckAt(t), z,
      { ry: yawP + (rnd() - 0.5) * 0.03, rx: slope, c: true, uv: 0.9 })
  }
  // stringers under the planks
  for (const s of [-1, 1]) {
    const off = s * 0.42
    const segN = 8
    for (let i = 0; i < segN; i++) {
      const t0 = i / segN
      const t1 = (i + 1) / segN
      const x0 = A.x + dx * t0 * span + px * off
      const z0 = A.z + dz * t0 * span + pz * off
      const x1 = A.x + dx * t1 * span + px * off
      const z1 = A.z + dz * t1 * span + pz * off
      const y0 = deckAt(t0) - 0.08
      const y1 = deckAt(t1) - 0.08
      const seg = Math.hypot(x1 - x0, z1 - z0)
      put.box('woodDark', seg + 0.06, 0.11, 0.13, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2,
        { rz: Math.atan2(y1 - y0, seg), ry: yawD, c: true, uv: 0.9 })
    }
  }
  // post-and-rail parapets both sides — the frame01 timber-trestle read
  for (const s of [-1, 1]) {
    const off = s * 0.56
    const posts = Math.max(3, Math.round(span / 1.4))
    const top = []
    const mid = []
    for (let i = 0; i <= posts; i++) {
      const t = i / posts
      const x = A.x + dx * t * span + px * off
      const z = A.z + dz * t * span + pz * off
      const y = deckAt(t)
      put.cyl('woodDark', 0.032, 0.042, 0.78, 5, x, y - 0.04, z, {})
      top.push(new THREE.Vector3(x, y + 0.74, z))
      mid.push(new THREE.Vector3(x, y + 0.4, z))
    }
    put.tube('woodDark', top, 0.028, {})
    put.tube('woodDark', mid, 0.024, {})
  }
  // trestle bents: paired legs + cross beam down into the gorge — these are
  // what make the bridge read as a trestle at 40 px
  for (let d = 1.4; d < span - 1.0; d += 2.1) {
    const t = d / span
    const bx = A.x + dx * t * span
    const bz = A.z + dz * t * span
    const dy = deckAt(t) - 0.14
    let legMax = 0
    for (const s of [-1, 1]) {
      const lx = bx + px * s * 0.44
      const lz = bz + pz * s * 0.44
      const gy = T.height(lx, lz)
      const h = Math.min(6.5, Math.max(0.35, dy - gy + 0.3))
      put.cyl('woodDark', 0.055, 0.075, h, 6, lx, dy - h, lz, {})
      if (h > legMax) legMax = h
    }
    if (legMax > 0.9) {
      put.box('woodDark', 1.1, 0.09, 0.09, bx, dy - legMax * 0.55, bz, { ry: yawP, c: true, uv: 0.9 })
      put.box('woodDark', 1.25, 0.07, 0.07, bx, dy - legMax * 0.2, bz,
        { ry: yawP, rz: 0.5, c: true, uv: 0.9 })
    }
  }
  // abutment cribs
  for (const [ex, ez] of [[A.x, A.z], [Bp.x, Bp.z]]) {
    const gy = T.height(ex, ez)
    for (let lay = 0; lay < 2; lay++) {
      put.cyl('woodDark', 0.08, 0.08, 1.5, 6, ex, Math.max(gy - 0.1, deckY - 0.3) - lay * 0.19, ez,
        { rz: HPI, ry: yawP, c: true })
    }
    blob(ex, ez, 0.9, 0.7, 0.26, yawD)
  }
}

// ===========================================================================
// 8. FARM PADDOCK FENCES — the §4 accent paddocks and NOTHING more
//
// Toy fences (§5 unchanged): post 0.5 m, rails at 0.22 / 0.42, span ~1.3.
// The gap on P1's W edge falls out of terrain.onRoad — the road clips it,
// so wheat + fence read on BOTH of the hero's shoulders.
// ===========================================================================

function fenceLoop(ctx, cx, cz, w, d, rot, opt = {}) {
  const { B, T, rnd, blob } = ctx
  const put = makePut(B, null)
  const a = w / 2
  const b = d / 2
  const cr = Math.cos(rot)
  const sr = Math.sin(rot)
  const per = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)))
  const n = Math.max(10, Math.round(per / 1.28))
  const p = 3.0 // superellipse exponent: rounded-rectangle paddock
  const pts = []
  for (let i = 0; i < n; i++) {
    const th = (i / n) * TAU
    const ct = Math.cos(th)
    const st = Math.sin(th)
    const wob = 1 + 0.03 * Math.sin(th * 3 + cx) + 0.02 * Math.sin(th * 7 + cz)
    const lx = Math.sign(ct) * a * Math.pow(Math.abs(ct), 2 / p) * wob
    const lz = Math.sign(st) * b * Math.pow(Math.abs(st), 2 / p) * wob
    const x = cx + lx * cr - lz * sr
    const z = cz + lx * sr + lz * cr
    // outward normal in world space (for partial-fence keep rules)
    let ox = lx / a
    let oz = lz / b
    const ol = Math.hypot(ox, oz) || 1
    ox /= ol
    oz /= ol
    const nx = ox * cr - oz * sr
    const nz = ox * sr + oz * cr
    let keep = T.onRoad(x, z) < 0.3 && !T.isWater(x, z) && T.slope(x, z) < 0.5
    if (keep && opt.keepFn) keep = opt.keepFn(nx, nz, x, z)
    pts.push({ x, z, keep })
  }
  for (let i = 0; i < n; i++) {
    const q = pts[i]
    if (!q.keep) continue
    const y = T.height(q.x, q.z)
    const hJ = 0.5 * (0.92 + rnd() * 0.16) // §5 fence post 0.5 m — toy scale
    put.box('woodDark', 0.065, hJ, 0.065, q.x, y - 0.06, q.z,
      { rx: (rnd() - 0.5) * 0.07, rz: (rnd() - 0.5) * 0.07, ry: rnd() * TAU, uv: 0.6 })
    blob(q.x, q.z, 0.18, 0.14, 0.22, 0)
    const r = pts[(i + 1) % n]
    if (!r.keep) continue
    const dx = r.x - q.x
    const dz = r.z - q.z
    const flat = Math.hypot(dx, dz)
    if (flat > 1.8) continue
    const y2 = T.height(r.x, r.z)
    const yawR = yawX(dx / flat, dz / flat)
    const pitch = Math.atan2(y2 - y, flat)
    for (const rh of [0.22, 0.42]) {
      put.box('woodDark', flat + 0.09, 0.05, 0.036, (q.x + r.x) / 2, (y + y2) / 2 + rh - 0.05, (q.z + r.z) / 2,
        { rz: pitch, ry: yawR, c: true, uv: 0.6 })
    }
  }
}

function buildFarm(ctx, poi) {
  const { rnd } = ctx
  // poi = P1 centre (−37, +15.5); the other paddocks are authored offsets so
  // the whole set tracks the farm POI if terrain lands it a hair off.
  const px = poi.x
  const pz = poi.z
  // P1 (−37, +15.5) ~8 × 5.5 — hero's shoulder paddock, road clips its W edge
  fenceLoop(ctx, px, pz, 8, 5.5, 0.08)
  // P1's small W lobe (−40.5, +16) 3 × 4 — wheat on the hero's other shoulder
  fenceLoop(ctx, px - 3.5, pz + 0.5, 3, 4, -0.12)
  // P2 (−36.5, +22.5) ~12 × 7
  fenceLoop(ctx, px + 0.5, pz + 7, 12, 7, -0.1)
  // big SE field (−29.5, +28.5) ~14 × 9 — PARTIAL rails only (N + W arcs
  // facing the eye path, plus a few strays), per §4
  fenceLoop(ctx, px + 7.5, pz + 13, 14, 9, 0.3, {
    keepFn: (nx, nz) => nz < -0.25 || nx < -0.35 || rnd() < 0.12,
  })
}

// ===========================================================================
// 9. CAMP — tent, fire ring, crates (POI-relative; below the boot frame)
// ===========================================================================

function buildCamp(ctx, poi) {
  const { B, T, rnd, blob } = ctx
  const tx = poi.x - 1.0
  const tz = poi.z - 0.9
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
  blob(tx, tz, 1.35, 1.45, 0.36, rot)

  // fire ring — flame + glow + light are added by createProps at firePos
  const fx = poi.x + 0.7
  const fz = poi.z + 0.6
  const fy = T.height(fx, fz)
  ctx.firePos = new THREE.Vector3(fx, fy, fz)
  const putW = makePut(B, null)
  for (let i = 0; i < 7; i++) {
    const th = (i / 7) * TAU + 0.3
    const sx = fx + Math.cos(th) * 0.42
    const sz = fz + Math.sin(th) * 0.42
    putW.box('stoneBase', 0.15 + rnd() * 0.08, 0.14 + rnd() * 0.06, 0.13 + rnd() * 0.07,
      sx, T.height(sx, sz) - 0.03, sz, { ry: rnd() * TAU, rz: (rnd() - 0.5) * 0.2, uv: 0.5 })
  }
  putW.cyl('dark', 0.3, 0.34, 0.05, 9, fx, fy - 0.02, fz, {})
  for (let i = 0; i < 3; i++) {
    const th = (i / 3) * TAU + 0.8
    putW.cyl('woodDark', 0.045, 0.05, 0.62, 5, fx + Math.cos(th) * 0.16, fy + 0.16, fz + Math.sin(th) * 0.16,
      { rz: 0.95, ry: -th, c: true })
  }
  blob(fx, fz, 0.6, 0.6, 0.3, 0)

  // crates + a log bench
  const cx = poi.x - 1.1
  const cz = poi.z + 1.4
  const cy = T.height(cx, cz)
  putW.box('woodMid', 0.55, 0.55, 0.55, cx, cy, cz, { ry: 0.35, uv: 0.55 })
  putW.box('woodDark', 0.59, 0.07, 0.59, cx, cy + 0.24, cz, { ry: 0.35 })
  blob(cx, cz, 0.5, 0.5, 0.32, 0.35)
  const lx = poi.x + 0.1
  const lz = poi.z + 1.9
  const ly = T.height(lx, lz)
  putW.cyl('woodDark', 0.09, 0.09, 1.15, 7, lx, ly + 0.09, lz, { rz: HPI, ry: 0.5, c: true })
  blob(lx, lz, 0.65, 0.25, 0.28, 0.5)
}

// ===========================================================================
// 10. DRESSING — the fork signpost and the coastal pier
// ===========================================================================

function buildSignpost(ctx) {
  const { B, T, rnd, blob } = ctx
  // FRAMING §4: road-fork signpost at (−49.5, +8.5), 1.3 m (§5 unchanged)
  const sx = -49.5
  const sz = 8.5
  const put = makePut(B, null)
  const y = T.height(sx, sz)
  put.box('woodDark', 0.09, 1.32, 0.09, sx, y - 0.05, sz, { ry: rnd() * TAU, rz: (rnd() - 0.5) * 0.05, uv: 0.6 })
  put.cone('woodDark', 0.085, 0.12, 4, sx, y + 1.27, sz, { ry: 0.4 })
  const arms = [
    { d: [25, 7.5], h: 1.12 }, // → castle (E)
    { d: [-1, -25], h: 0.92 }, // → village / north bridge
    { d: [-9.5, 1], h: 0.72 }, // → inlet bridge (W)
  ]
  for (const arm of arms) {
    const L = Math.hypot(arm.d[0], arm.d[1])
    const ux = arm.d[0] / L
    const uz = arm.d[1] / L
    const ry = yawX(ux, uz)
    const axc = sx + ux * 0.26
    const azc = sz + uz * 0.26
    put.box('woodMid', 0.56, 0.14, 0.045, axc, y + arm.h, azc, { ry, c: true, uv: 0.6 })
    put.cone('woodMid', 0.07, 0.11, 4, sx + ux * 0.56, y + arm.h, sz + uz * 0.56, { rz: -HPI, ry, c: true })
    put.box('dark', 0.15, 0.024, 0.055, axc, y + arm.h + 0.025, azc, { ry, c: true })
    put.box('dark', 0.11, 0.02, 0.055, axc + ux * 0.02, y + arm.h - 0.025, azc + uz * 0.02, { ry, c: true })
  }
  blob(sx, sz, 0.28, 0.22, 0.3, 0)
}

function buildPier(ctx) {
  const { B, T, rnd, blob } = ctx
  // FRAMING §4: pier at (−64, −16), pointing WSW, deck +0.4, 5 m long —
  // haze-veiled, it barely reads, but the coastal silhouette needs it.
  const angle = 2.75 // WSW
  const dx = Math.cos(angle)
  const dz = Math.sin(angle)
  let sx = -64
  let sz = -16
  // walk the root seaward until it clears the cliff base (terrain lands the
  // exact shoreline; the pier must start at the water, never inside rock)
  for (let i = 0; i < 10 && T.height(sx, sz) > 1.4; i++) {
    sx += dx * 1.1
    sz += dz * 1.1
  }
  const put = makePut(B, null)
  const px = -dz
  const pz = dx
  const deck = 0.4
  const len = 5
  const yawP = yawX(px, pz)
  const yawD = yawX(dx, dz)
  const n = Math.floor(len / 0.3)
  for (let i = 0; i <= n; i++) {
    const t = i * 0.3
    put.box('woodMid', 1.15, 0.05, 0.235, sx + dx * t, deck + (rnd() - 0.5) * 0.012, sz + dz * t,
      { ry: yawP + (rnd() - 0.5) * 0.04, c: true, uv: 0.9 })
  }
  for (const s of [-1, 1]) {
    put.box('woodDark', len + 0.5, 0.1, 0.12,
      sx + dx * len * 0.5 + px * s * 0.4, deck - 0.1, sz + dz * len * 0.5 + pz * s * 0.4,
      { ry: yawD, c: true, uv: 0.9 })
  }
  // piles down into the shallows, X-braced where tall enough
  for (let t = 0.3; t < len + 0.3; t += 1.25) {
    for (const s of [-1, 1]) {
      const qx = sx + dx * t + px * s * 0.52
      const qz = sz + dz * t + pz * s * 0.52
      const gy = Math.min(T.height(qx, qz), deck - 0.35)
      const h = Math.max(0.3, deck + 0.14 - (gy - 0.3))
      put.cyl('woodDark', 0.05, 0.065, h, 6, qx, gy - 0.3, qz, {})
    }
  }
  // mooring posts + the rowboat
  const ex = sx + dx * len
  const ez = sz + dz * len
  put.cyl('woodDark', 0.055, 0.07, 0.5, 6, ex + px * 0.45, deck, ez + pz * 0.45, { rz: 0.08 })
  put.cyl('woodDark', 0.055, 0.07, 0.42, 6, ex - px * 0.45, deck, ez - pz * 0.45, { rz: -0.06 })
  const bx = ex + dx * 1.7 + px * 1.35
  const bz = ez + dz * 1.7 + pz * 1.35
  const byaw = angle + 0.35
  const fb = new THREE.Matrix4().makeRotationY(yawX(Math.cos(byaw), Math.sin(byaw)))
  fb.setPosition(bx, 0, bz)
  const putB = makePut(B, fb)
  putB.box('woodMid', 1.55, 0.3, 0.62, 0, 0.04, 0, { c: true, uv: 0.8 })
  putB.prism('woodMid', 0.62, 0.62, 0.3, 0.95, 0.04, 0, { rx: -HPI, ry: -HPI, uv: 0.8 })
  putB.prism('woodMid', 0.62, 0.4, 0.3, -0.86, 0.04, 0, { rx: -HPI, ry: HPI, uv: 0.8 })
  putB.box('dark', 1.3, 0.05, 0.44, 0, 0.1, 0, { c: true })
  putB.box('woodDark', 1.6, 0.05, 0.07, 0, 0.17, 0.29, { c: true })
  putB.box('woodDark', 1.6, 0.05, 0.07, 0, 0.17, -0.29, { c: true })
  addG(B.rope, gTube(catPts(ex + px * 0.45, deck + 0.45, ez + pz * 0.45, bx + dx * 0.6, 0.2, bz + dz * 0.6, 0.35, 8), 0.018, {}), null)
}

// ===========================================================================
// 11. createProps — textures, materials, build, merge, animate
// ===========================================================================

const BUCKET_KEYS = [
  'keep', 'pave', 'roofCobalt', 'roofSlate', 'woodDark', 'woodMid',
  'plaster', 'timber', 'stoneBase', 'canvas', 'red', 'gold', 'dark', 'lit', 'rope',
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
    courseH: 16, blockW: 30, chip: 0.26, grime: 0.08, moss: null, darkP: 0.05,
  }))
  const tPave = canvasTex(256, aniso, (g, S) => paintMasonry(g, S, rnd, {
    lit: PAL.PAVE_LIT, mid: PAL.PAVE_MID, dark: PAL.PAVE_DARK, mortar: PAL.PAVE_MORTAR,
    courseH: 30, blockW: 44, chip: 0.2, grime: 0.16, moss: null, darkP: 0.08,
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
  const tWoodD = canvasTex(256, aniso, (g, S) => paintWood(g, S, rnd, PAL.WOOD_DARK, 0.36))
  const tWoodM = canvasTex(256, aniso, (g, S) => paintWood(g, S, rnd, PAL.WOOD_MID, 0.42))
  const tPlaster = canvasTex(256, aniso, (g, S) => paintPlaster(g, S, rnd))
  const tTimber = canvasTex(256, aniso, (g, S) => paintTimber(g, S, rnd))
  const tCanvas = canvasTex(128, aniso, (g, S) => paintCanvas(g, S, rnd))
  const tRed = canvasTex(128, aniso, (g, S) => paintRed(g, S, rnd))
  const tBlob = canvasTex(64, 1, (g, S) => paintBlob(g, S))
  const tGlow = canvasTex(128, 1, (g, S) => paintGlow(g, S))

  const std = (map, roughness, extra) => new THREE.MeshStandardMaterial(
    Object.assign({ map, roughness, metalness: 0 }, extra || {}))
  const MAT = {
    keep: std(tKeep, 0.92),
    pave: std(tPave, 0.95),
    roofCobalt: std(tCobalt, 0.45),
    roofSlate: std(tSlate, 0.85),
    woodDark: std(tWoodD, 0.9),
    woodMid: std(tWoodM, 0.88),
    plaster: std(tPlaster, 0.96),
    timber: std(tTimber, 0.96),
    stoneBase: std(tStone, 0.95),
    canvas: std(tCanvas, 0.92, { side: THREE.DoubleSide }),
    red: std(tRed, 0.8),
    // bright enough that sun glints push past the 0.72 bloom threshold
    gold: new THREE.MeshStandardMaterial({
      color: 0xd9b542, metalness: 0.5, roughness: 0.32,
      emissive: 0xc79a2e, emissiveIntensity: 0.55,
    }),
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
  const ctx = {
    B,
    T,
    meta,
    rnd,
    firePos: null,
    blob: (x, z, rx, rz, a, yaw) => blobs.push({ x, z, rx, rz, a, yaw }),
    pennant: (v, yaw, color) => pennants.push({ x: v.x, y: v.y, z: v.z, yaw, color }),
  }

  // ---- landmarks from terrain.meta.poi -----------------------------------
  // FRAMING §8: bridge POIs are (−41, −1) north gorge (deck 13.5, span 9,
  // ~N–S) and (−59, +9.5) inlet (deck 12, span 10, NW–SE). Distinguish by z.
  let builtNorth = false
  let builtInlet = false
  const bridgeAt = (poi) => {
    if (poi.z < 4) {
      buildTrestle(ctx, { x: poi.x, z: poi.z + 4.5 }, { x: poi.x, z: poi.z - 4.5 }, 13.5)
      builtNorth = true
    } else {
      const u = Math.SQRT1_2 * 5 // half-span along the NW–SE axis
      buildTrestle(ctx, { x: poi.x + u, z: poi.z + u }, { x: poi.x - u, z: poi.z - u }, 12)
      builtInlet = true
    }
  }
  for (const poi of meta.poi || []) {
    if (poi.kind === 'castle') buildCastle(ctx, poi)
    else if (poi.kind === 'village') buildVillage(ctx, poi)
    else if (poi.kind === 'shrine') buildShrine(ctx, poi)
    else if (poi.kind === 'farm') buildFarm(ctx, poi)
    else if (poi.kind === 'camp') buildCamp(ctx, poi)
    else if (poi.kind === 'bridge') bridgeAt(poi)
  }
  // Both crossings are in frame01 — build them even if terrain publishes no
  // bridge POIs (north at 0.44 fw / 0.145 fh is plainly visible).
  if (!builtNorth) bridgeAt({ x: -41, z: -1, kind: 'bridge' })
  if (!builtInlet) bridgeAt({ x: -59, z: 9.5, kind: 'bridge' })
  buildSignpost(ctx)
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
