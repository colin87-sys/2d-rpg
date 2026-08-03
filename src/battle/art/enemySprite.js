// ---------------------------------------------------------------------------
// enemySprite.js — the painterly enemy wall (BATTLE_BIBLE §6, BATTLE_CONTRACT).
//
//   export function makeDragonArt(): EnemyArt     — hall enemy   (frame04)
//   export function makeSorcererArt(): EnemyArt   — highland boss (frame05)
//
//   EnemyArt = { texture, px, py, anchor: 'feet'|'center', worldHeight,
//                floatOffset, meta: { name, palette, ... } }
//
//   `px, py` are the ANCHOR PIXEL inside the canvas (canvas coords, y down):
//   the point that `units` plants at the world anchor. For the dragon that is
//   the ground-contact point between its forefeet (so the beast composes like
//   frame04: feet at 0.330 fw while the tail coil hangs far left of them —
//   bottom-CENTRE anchoring would shove the head across the 0.50 fw duel
//   line; frame04's own dragon has its feet ~2/3 across its bbox, and the
//   images win). For the sorcerer it is the visual mass centre. Everything
//   else an integrator could want (canvas size, silhouette bbox, px-per-metre,
//   quad size in metres, anchor as a UV) is in `meta`.
//
//   These are the largest objects on screen and deliberately the OPPOSITE
//   rendering language from the chibi party: hand-painted, 8–12 tone ramps,
//   soft airbrushed volume, fur/strand brushwork, a dark edge glaze melting
//   into shadow plus a scene-keyed rim — LinearFilter + mipmaps + sRGB,
//   NO NearestFilter, NO pixel outlines. (BIBLE §6: the FFBE sandwich.)
//
//   Every mark is placed through one seeded PRNG per enemy — output is
//   byte-stable across reloads. This module owns textures only; it places
//   nothing and lights nothing.
// ---------------------------------------------------------------------------

import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Deterministic PRNG
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// Colour — ramps are arrays of hex stops (shadow → lit), sampled smoothly.
// 8–12 usable tones per material come from interpolation across the stops.
// ---------------------------------------------------------------------------

function hx(h) {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function css(c, a = 1) {
  return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`
}

/** ramp(['#..',..]) -> f(t, alpha) -> css ; f.rgb(t) -> [r,g,b] */
function ramp(stops) {
  const cs = stops.map(hx)
  const rgb = (t) => {
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const f = t * (cs.length - 1)
    const i = Math.min(cs.length - 2, f | 0)
    const u = f - i
    const a = cs[i], b = cs[i + 1]
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]
  }
  const f = (t, alpha = 1) => css(rgb(t), alpha)
  f.rgb = rgb
  f.stops = stops
  return f
}

// ---------------------------------------------------------------------------
// Geometry — smooth organic paths from sparse control points.
// ---------------------------------------------------------------------------

/** Catmull-Rom spline through pts -> Path2D (closed or open). */
function spline(pts, closed = false) {
  const p = new Path2D()
  const n = pts.length
  if (n < 2) return p
  const P = (i) => pts[closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i))]
  p.moveTo(pts[0][0], pts[0][1])
  const last = closed ? n : n - 1
  for (let i = 0; i < last; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2)
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6
    p.bezierCurveTo(c1x, c1y, c2x, c2y, p2[0], p2[1])
  }
  if (closed) p.closePath()
  return p
}

/** Per-point unit normals of a polyline (central differences). */
function normals(pts) {
  const out = []
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)]
    let dx = b[0] - a[0], dy = b[1] - a[1]
    const l = Math.hypot(dx, dy) || 1
    out.push([-dy / l, dx / l])
  }
  return out
}

/** Tapered ribbon polygon around a spine. wfn(t 0..1) -> half-width. */
function ribbon(spine, wfn) {
  const nrm = normals(spine)
  const L = [], R = []
  for (let i = 0; i < spine.length; i++) {
    const t = i / (spine.length - 1)
    const w = wfn(t)
    L.push([spine[i][0] + nrm[i][0] * w, spine[i][1] + nrm[i][1] * w])
    R.push([spine[i][0] - nrm[i][0] * w, spine[i][1] - nrm[i][1] * w])
  }
  return spline(L.concat(R.reverse()), true)
}

/** Walk a polyline, invoking cb(pos, tangent, normal, t01) every `step` px. */
function walk(spine, step, cb) {
  let total = 0
  for (let i = 1; i < spine.length; i++) total += Math.hypot(spine[i][0] - spine[i - 1][0], spine[i][1] - spine[i - 1][1])
  if (total <= 0) return
  let next = step * 0.5, travelled = 0
  for (let i = 1; i < spine.length; i++) {
    const ax = spine[i - 1][0], ay = spine[i - 1][1]
    const dx = spine[i][0] - ax, dy = spine[i][1] - ay
    const seg = Math.hypot(dx, dy) || 1e-6
    const tx = dx / seg, ty = dy / seg
    while (next <= travelled + seg) {
      const d = next - travelled
      cb([ax + tx * d, ay + ty * d], [tx, ty], [-ty, tx], next / total)
      next += step
    }
    travelled += seg
  }
}

/** Point + tangent + normal at t01 along a polyline (linear between knots). */
function along(pts, t) {
  const n = pts.length - 1
  const f = Math.max(0, Math.min(n - 1e-6, t * n))
  const i = f | 0, u = f - i
  const a = pts[i], b = pts[i + 1]
  let dx = b[0] - a[0], dy = b[1] - a[1]
  const l = Math.hypot(dx, dy) || 1
  dx /= l; dy /= l
  return { x: a[0] + (b[0] - a[0]) * u, y: a[1] + (b[1] - a[1]) * u, tx: dx, ty: dy, nx: -dy, ny: dx }
}

// ---------------------------------------------------------------------------
// Brushes
// ---------------------------------------------------------------------------

function mkCanvas(w, h) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

/** Soft airbrush dab (elliptical radial falloff). */
function puff(ctx, x, y, r, color, a = 0.3, ry = r, rot = 0) {
  if (!(r > 0.5)) return
  let c
  if (color[0] === '#') c = [...hx(color), 1]
  else c = color.match(/rgba?\(([^)]+)\)/)[1].split(',').map(Number)
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(rot)
  ctx.scale(1, Math.max(0.05, ry / r))
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r)
  g.addColorStop(0, css(c, Math.min(1, (c[3] ?? 1) * a)))
  g.addColorStop(1, css(c, 0))
  ctx.fillStyle = g
  ctx.fillRect(-r, -r, r * 2, r * 2)
  ctx.restore()
}

/** Linear gradient helper: stops = [[off, css], ...]. */
function lin(ctx, x0, y0, x1, y1, stops) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1)
  for (const [o, c] of stops) g.addColorStop(o, c)
  return g
}

/** Paint inside a clip. */
function shadeIn(ctx, path, fn) {
  ctx.save()
  ctx.clip(path)
  fn()
  ctx.restore()
}

/** Paint only over already-painted pixels (whole-canvas glaze). */
function wash(ctx, fn) {
  ctx.save()
  ctx.globalCompositeOperation = 'source-atop'
  fn()
  ctx.restore()
}

/** Tapered single stroke (strand of hair / fur / vein). */
function strand(ctx, pts, w0, w1, fill) {
  ctx.fillStyle = fill
  ctx.fill(ribbon(pts, (t) => Math.max(0.3, w0 + (w1 - w0) * t) / 2))
}

/**
 * A curved horn / spike / thorn: base at (x,y), length len along angle ang
 * (radians, screen coords), curling by `curl` radians over its length.
 * Painted with a shadow flank + lit flank + tip accent for instant volume.
 */
function horn(ctx, x, y, ang, len, w, curl, rampF, opts = {}) {
  const n = 7
  const pts = []
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1)
    const a = ang + curl * t * t
    const r = len * t
    pts.push([x + Math.cos(a) * r, y + Math.sin(a) * r])
  }
  const shape = ribbon(pts, (t) => (w * (1 - t * 0.92)) / 2)
  const tip = pts[n - 1]
  ctx.fillStyle = lin(ctx, x, y, tip[0], tip[1], [
    [0, rampF(opts.rootT ?? 0.18)],
    [0.55, rampF(opts.midT ?? 0.55)],
    [1, rampF(opts.tipT ?? 0.9)],
  ])
  ctx.fill(shape)
  const nrm = normals(pts)
  const side = (s, w2, col, al) => {
    const off = pts.map((p, i) => [p[0] + nrm[i][0] * s * w * 0.22, p[1] + nrm[i][1] * s * w * 0.22])
    ctx.save()
    ctx.clip(shape)
    ctx.globalAlpha = al
    ctx.fillStyle = col
    ctx.fill(ribbon(off, (t) => (w2 * (1 - t * 0.9)) / 2))
    ctx.restore()
  }
  side(+1, w * 0.6, rampF(0.06), 0.5)
  side(-1, w * 0.42, rampF(0.98), 0.55)
  if (opts.tipCss) {
    ctx.save()
    ctx.globalAlpha = 0.9
    strand(ctx, pts.slice(4), w * 0.3, 0.4, opts.tipCss)
    ctx.restore()
  }
}

/**
 * Fur pass: many short curved strokes inside a region, direction from a flow
 * field, colour from a shading field. Deterministic via rnd.
 */
function fur(ctx, rnd, region, bbox, o) {
  const { count, angleAt, colAt, len = [9, 16], width = [1.2, 2.4], alpha = [0.08, 0.2], curl = 0.5, spread = 0.5 } = o
  ctx.save()
  ctx.lineCap = 'round'
  for (let i = 0; i < count; i++) {
    let x, y, ok = false
    for (let k = 0; k < 8 && !ok; k++) {
      x = bbox[0] + rnd() * (bbox[2] - bbox[0])
      y = bbox[1] + rnd() * (bbox[3] - bbox[1])
      ok = ctx.isPointInPath(region, x, y)
    }
    if (!ok) continue
    const a0 = angleAt(x, y) + (rnd() - 0.5) * spread
    const l = len[0] + rnd() * (len[1] - len[0])
    const c = (rnd() - 0.5) * curl
    const mx = x + Math.cos(a0) * l * 0.5, my = y + Math.sin(a0) * l * 0.5
    const ex = x + Math.cos(a0 + c) * l, ey = y + Math.sin(a0 + c) * l
    ctx.strokeStyle = colAt(x, y, rnd)
    ctx.globalAlpha = alpha[0] + rnd() * (alpha[1] - alpha[0])
    ctx.lineWidth = width[0] + rnd() * (width[1] - width[0])
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.quadraticCurveTo(mx, my, ex, ey)
    ctx.stroke()
  }
  ctx.restore()
}

/**
 * Fluff pass: small filled tufts planted along a path's rim so a silhouette
 * reads furry instead of vector-smooth. `outPts` is an open/closed polyline;
 * tufts lean along `leanFn(pos)` and take colour from `colFn(pos)`.
 */
function fluffEdge(ctx, rnd, outPts, step, o) {
  const { size = [7, 15], leanFn, colFn, alpha = 0.9 } = o
  walk(outPts, step, (p, tg, n) => {
    if (rnd() < 0.15) return
    const l = size[0] + rnd() * (size[1] - size[0])
    const lean = leanFn ? leanFn(p, n) : Math.atan2(n[1], n[0])
    const a = lean + (rnd() - 0.5) * 0.6
    ctx.save()
    ctx.globalAlpha = alpha * (0.7 + rnd() * 0.3)
    strand(ctx, [
      [p[0] - Math.cos(a) * l * 0.25, p[1] - Math.sin(a) * l * 0.25],
      [p[0] + Math.cos(a) * l * 0.45, p[1] + Math.sin(a) * l * 0.45],
      [p[0] + Math.cos(a + (rnd() - 0.5) * 0.8) * l, p[1] + Math.sin(a + (rnd() - 0.5) * 0.8) * l],
    ], l * 0.55, 0.6, colFn(p))
    ctx.restore()
  })
}

/**
 * Planar brush modelling: n overlapping bristle strokes laid along a spine at
 * ONE stepped ramp value (± small jitter) — visible layered paint with stroke
 * edges, the anti-airbrush. Used everywhere the round-1 dragon read as a
 * smooth radial-gradient vector blob.
 */
function strokeBand(ctx, rnd, spinePts, w, rampF, t, alpha, n = 4, spread = 1.0) {
  const nrm = normals(spinePts)
  for (let k = 0; k < n; k++) {
    const off = n > 1 ? (k / (n - 1) - 0.5) * w * spread : 0
    const pts = spinePts.map((p, i) => [
      p[0] + nrm[i][0] * off + (rnd() - 0.5) * 4,
      p[1] + nrm[i][1] * off + (rnd() - 0.5) * 4,
    ])
    const tv = Math.max(0, Math.min(1, t + (rnd() - 0.5) * 0.09))
    strand(ctx, pts, (w / n) * (1.5 + rnd() * 0.9), (w / n) * (0.4 + rnd() * 0.5),
      rampF(tv, alpha * (0.75 + rnd() * 0.5)))
  }
}

/**
 * Rooted spike: a dark socket pool under the base, the horn, then a lap of
 * hide pulled over the root — the spike grows FROM the body instead of being
 * glued onto the silhouette (the round-1 "thorn sticker" failure).
 */
function rootedHorn(ctx, rnd, x, y, ang, len, w, curl, rampF, hideF, hideT, opts = {}) {
  puff(ctx, x, y + 2, w * 0.8, hideF(Math.max(0, hideT - 0.3)), 0.5, w * 0.5)
  horn(ctx, x, y, ang, len, w, curl, rampF, opts)
  const a = ang + Math.PI / 2
  strand(ctx, [
    [x - Math.cos(a) * w * 0.55, y - Math.sin(a) * w * 0.55 + 3],
    [x + Math.cos(ang) * w * 0.4, y + Math.sin(ang) * w * 0.4 + 2],
    [x + Math.cos(a) * w * 0.55, y + Math.sin(a) * w * 0.55 + 3],
  ], w * 0.55, w * 0.3, hideF(hideT, 0.8))
}

/**
 * A draped bat/demon wing, painted as a pleated curtain: leading edge
 * root→carpal→spike, finger tips fanning off the carpal, trailing edge
 * sagging between tips with per-gap depth + ragged jitter. Inside: broad
 * alternating fold bands radiating from the carpal, soft CURVED spars (wide
 * dark understroke, faint lit crest), membrane wrinkles, soft volume pools,
 * elongated bites torn from the trailing edge, claw hooks on tips.
 */
function drapedWing(ctx, rnd, o) {
  const {
    root, carpal, spike, tips, sag = 0.42, rampF, sheen, alpha = 1, jag = 10,
    claws = true, clawRamp = null, brightT = 0.62, darkT = 0.07,
  } = o
  const outline = [root, [(root[0] + carpal[0]) / 2, (root[1] + carpal[1]) / 2 - 14], carpal]
  if (spike) outline.push(spike)
  let prev = spike || carpal
  for (const t of tips) {
    const mx = (prev[0] + t[0]) / 2, my = (prev[1] + t[1]) / 2
    const s = sag * (0.72 + rnd() * 0.66)
    outline.push([mx + (carpal[0] - mx) * s + (rnd() - 0.5) * jag, my + (carpal[1] - my) * s + (rnd() - 0.5) * jag])
    outline.push([t[0] + (rnd() - 0.5) * 4, t[1] + (rnd() - 0.5) * 4])
    prev = t
  }
  outline.push([(prev[0] + root[0]) / 2 + (carpal[0] - prev[0]) * 0.3, (prev[1] + root[1]) / 2 + (rnd() - 0.5) * jag])
  const shape = spline(outline, true)
  const mtip = tips[Math.floor(tips.length / 2)]
  const A = Math.atan2(mtip[1] - carpal[1], mtip[0] - carpal[0])
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.fillStyle = lin(ctx, carpal[0], carpal[1], (mtip[0] + carpal[0]) / 2, (mtip[1] + carpal[1]) / 2, [
    [0, rampF(brightT * 0.75)], [0.5, rampF(0.28)], [1, rampF(darkT + 0.03)],
  ])
  ctx.fill(shape)
  shadeIn(ctx, shape, () => {
    // broad alternating fold bands radiating from the carpal — the curtain
    for (let i = 0; i < tips.length; i++) {
      const t = tips[i]
      const u = i / Math.max(1, tips.length - 1)
      const brightBand = i % 2 === 0
      const w0 = 30 + rnd() * 24
      const bow = 10 + rnd() * 18
      const mx = carpal[0] + (t[0] - carpal[0]) * 0.55 + Math.cos(A + 1.57) * bow
      const my = carpal[1] + (t[1] - carpal[1]) * 0.55 + Math.sin(A + 1.57) * bow
      strand(ctx, [[carpal[0], carpal[1]], [mx, my], [t[0], t[1]]], w0, w0 * 0.5,
        rampF(brightBand ? Math.min(1, brightT * (0.72 + 0.4 * (1 - u))) : darkT + 0.05, brightBand ? 0.32 : 0.4))
    }
    // volumes: glow pool under the carpal, root shadow, tip-side shadow
    puff(ctx, carpal[0] + (mtip[0] - carpal[0]) * 0.24, carpal[1] + (mtip[1] - carpal[1]) * 0.24, 74, rampF(brightT), 0.4, 48, A)
    puff(ctx, (root[0] + carpal[0]) / 2, (root[1] + carpal[1]) / 2 + 24, 66, rampF(darkT), 0.46)
    puff(ctx, mtip[0], mtip[1], 110, rampF(darkT), 0.4, 80, A)
    // soft curved spars: wide dark understroke + faint lit crest near carpal
    for (const t of tips) {
      const bowN = (rnd() - 0.5) * 28
      const mx = carpal[0] + (t[0] - carpal[0]) * 0.52 + Math.cos(A + 1.57) * bowN
      const my = carpal[1] + (t[1] - carpal[1]) * 0.52 + Math.sin(A + 1.57) * bowN
      strand(ctx, [[carpal[0], carpal[1]], [mx + 4, my + 4], [t[0], t[1]]], 15, 5, rampF(darkT + 0.02, 0.45))
      strand(ctx, [[carpal[0] + 2, carpal[1] - 3], [(carpal[0] + mx) / 2 + 2, (carpal[1] + my) / 2 - 3]], 5, 1.5, rampF(brightT + 0.18, 0.5))
    }
    // membrane wrinkles: short soft arcs scattered off the carpal
    for (let i = 0; i < tips.length * 3; i++) {
      const t = tips[(rnd() * tips.length) | 0]
      const u0 = 0.16 + rnd() * 0.45
      const px0 = carpal[0] + (t[0] - carpal[0]) * u0 + (rnd() - 0.5) * 20
      const py0 = carpal[1] + (t[1] - carpal[1]) * u0 + (rnd() - 0.5) * 20
      const wl = 14 + rnd() * 24
      strand(ctx, [[px0, py0], [px0 + Math.cos(A + 0.45) * wl, py0 + Math.sin(A + 0.45) * wl]], 3.5, 0.8,
        rampF(rnd() < 0.5 ? darkT + 0.06 : brightT * 0.8, 0.28))
    }
    // leading edge: heavy dark arm + thin hot top line
    strand(ctx, outline.slice(0, spike ? 4 : 3), 17, 8, rampF(darkT + 0.06, 0.95))
    strand(ctx, outline.slice(0, spike ? 4 : 3).map((p) => [p[0] + 2, p[1] - 4]), 6, 2, rampF(brightT + 0.22, 0.6))
    if (sheen) sheen(shape)
  })
  // ragged bites torn from the trailing edge — elongated, angled, irregular
  ctx.globalCompositeOperation = 'destination-out'
  let pv = spike || carpal
  for (const t of tips) {
    for (let k = 0; k < 3; k++) {
      const u = 0.22 + rnd() * 0.56
      const mx = pv[0] + (t[0] - pv[0]) * u, my = pv[1] + (t[1] - pv[1]) * u
      puff(ctx, mx, my, 5 + rnd() * 11, 'rgba(0,0,0,1)', 0.8, 2.5 + rnd() * 4, A + 1.57 + (rnd() - 0.5) * 0.8)
    }
    pv = t
  }
  ctx.globalCompositeOperation = 'source-over'
  ctx.restore()
  if (spike) horn(ctx, spike[0], spike[1], Math.atan2(spike[1] - carpal[1], spike[0] - carpal[0]), 26, 9, 0.25, rampF, {})
  if (claws) {
    const cr = clawRamp || rampF
    for (const t of tips) {
      const a = Math.atan2(t[1] - carpal[1], t[0] - carpal[0])
      horn(ctx, t[0], t[1], a, 13 + rnd() * 7, 6, 0.5 + rnd() * 0.3, cr, { rootT: 0.12, midT: 0.3, tipT: 0.55 })
    }
  }
}

// ---------------------------------------------------------------------------
// Whole-canvas finishing: silhouette-mask morphology for the dark edge glaze
// (a ring eroded inward from the alpha silhouette) and the directional
// scene-keyed rim (a crescent on the lit side). BIBLE §6: "no outline — a
// 2–4 px dark edge glaze melting into shadow, plus a rim on the keyed side."
// ---------------------------------------------------------------------------

function solidMask(src, color) {
  const m = mkCanvas(src.width, src.height)
  const c = m.getContext('2d')
  c.drawImage(src, 0, 0)
  c.globalCompositeOperation = 'source-in'
  c.fillStyle = color
  c.fillRect(0, 0, m.width, m.height)
  return m
}

function erodeMask(mask, r) {
  const core = mkCanvas(mask.width, mask.height)
  const c = core.getContext('2d')
  c.drawImage(mask, 0, 0)
  c.globalCompositeOperation = 'destination-in'
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    c.drawImage(mask, Math.cos(a) * r, Math.sin(a) * r)
  }
  return core
}

/** Dark glaze hugging the whole silhouette edge, blurred inward. */
function edgeGlaze(canvas, ctx, color, r, alpha, blur) {
  const mask = solidMask(canvas, color)
  const core = erodeMask(mask, r)
  const ring = mkCanvas(canvas.width, canvas.height)
  const rc = ring.getContext('2d')
  rc.drawImage(mask, 0, 0)
  rc.globalCompositeOperation = 'destination-out'
  rc.drawImage(core, 0, 0)
  ctx.save()
  ctx.globalCompositeOperation = 'source-atop'
  ctx.globalAlpha = alpha
  if (typeof ctx.filter === 'string') ctx.filter = `blur(${blur}px)`
  ctx.drawImage(ring, 0, 0)
  ctx.restore()
  if (typeof ctx.filter === 'string') ctx.filter = 'none'
}

/**
 * Scene-keyed rim: crescent of the silhouette facing `dir` (unit vector from
 * the object toward the light, canvas coords, y down). `shape` optionally
 * fades the crescent across the canvas so the rim covers 40–60 % of the
 * facing edge, never a full halo.
 */
function rimLight(canvas, ctx, color, dir, r, alpha, blur, shape) {
  const mask = solidMask(canvas, color)
  const cr = mkCanvas(canvas.width, canvas.height)
  const cc = cr.getContext('2d')
  cc.drawImage(mask, 0, 0)
  cc.globalCompositeOperation = 'destination-out'
  cc.drawImage(mask, -dir[0] * r, -dir[1] * r)
  if (shape) {
    cc.globalCompositeOperation = 'destination-in'
    cc.fillStyle = shape(cc)
    cc.fillRect(0, 0, cr.width, cr.height)
  }
  ctx.save()
  ctx.globalCompositeOperation = 'source-atop'
  ctx.globalAlpha = alpha
  if (typeof ctx.filter === 'string') ctx.filter = `blur(${blur}px)`
  ctx.drawImage(cr, 0, 0)
  ctx.restore()
  if (typeof ctx.filter === 'string') ctx.filter = 'none'
}

/** Alpha-scan the painted canvas for the silhouette bbox (deterministic). */
function scanBBox(canvas) {
  const ctx = canvas.getContext('2d')
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  let x0 = canvas.width, y0 = canvas.height, x1 = 0, y1 = 0
  for (let y = 0; y < canvas.height; y += 2) {
    for (let x = 0; x < canvas.width; x += 2) {
      if (d[(y * canvas.width + x) * 4 + 3] > 10) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  return { x0, y0, x1, y1 }
}

// ---------------------------------------------------------------------------
// Texture wrap — painterly law: Linear + mips + sRGB. Never NearestFilter.
// ---------------------------------------------------------------------------

function makeTexture(canvas) {
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  return tex
}

function finishArt(canvas, { name, px, py, anchor, worldHeight, floatOffset, palette }) {
  const sil = scanBBox(canvas)
  const silH = Math.max(1, sil.y1 - sil.y0)
  const pxPerMeter = silH / worldHeight
  return {
    texture: makeTexture(canvas),
    px, py, anchor, worldHeight, floatOffset,
    meta: {
      name,
      palette,
      canvas: { w: canvas.width, h: canvas.height },
      anchorPx: { x: px, y: py },            // same as px/py, unambiguous name
      silhouette: sil,                       // px bbox of painted alpha
      pxPerMeter,                            // silhouette height / worldHeight
      // full-canvas quad size in metres if the whole texture is one plane:
      worldSize: { w: canvas.width / pxPerMeter, h: canvas.height / pxPerMeter },
      // anchor as UV (v measured from the BOTTOM, three.js convention):
      anchor01: { u: px / canvas.width, v: (canvas.height - py) / canvas.height },
    },
  }
}

// ===========================================================================
// THE DRAGON — frame04 hall enemy. Round-2 repaint: anatomy + value.
//
// Composition (canvas 1024×896, anchor/feet y = 838, visible ground line
// ≈ y 792 after the 0.35 m sink, ≈ 139 px/m once the silhouette maps to 6 m):
//   · a QUADRUPED with a 3.4 m shoulder hump (y ≈ 322); from it an S-curve
//     NECK dives 1.6 m down-forward to a low WEDGE head held at the 1.4 m
//     hero eye-line — no beak: the maw gapes red (#a42f28→#f0836f) with two
//     LAYERED fang rows, a plum muzzle mask, gold slit eye, amber crown
//     horns and a green mane streaming back along the neck ridge
//   · sail wings RAISED: the near sail roots on the hump and spikes to the
//     very top of the silhouette (§1 wing-crest anchor ≈ 6 m, x left of the
//     feet), a near-black echo sail behind it; the far wing drapes down-left
//     as a dark curtain
//   · the olive plated tail coils across the top-left corner (silhouette
//     0.09 fh) and its tip flies out right — bigger than the frame
//   · muscular haunches; short heavy forelegs with pale talons under a low
//     furred belly
//   · torch key upper-right: a HARD core-shadow terminator claims the belly,
//     rump and throat (belly-ramp darks, hue-bearing); AO pools between
//     limbs, at wing roots, jaw and tail base; bristle-band strokes + fur do
//     the modelling — airbrush pools only for glow and occlusion.
// ===========================================================================

const DRG = {
  hide: ramp(['#55402f', '#6f5743', '#8a6f5a', '#a5876f', '#b89a82', '#c6a792', '#d8bda5', '#e6d0b9', '#e7dbc5', '#f2e6cf']),
  wing: ramp(['#180b26', '#28153e', '#392052', '#492a66', '#57316e', '#6d4180', '#88558f', '#9b6597', '#b07fa6']),
  mane: ramp(['#14291b', '#224234', '#3d6d54', '#598e6e', '#88b394', '#8dd0a5', '#b0e0ba']),
  amber: ramp(['#3c1e0c', '#6f3517', '#9c4a20', '#ca5f2b', '#b76d39', '#d48c47', '#e6a95c', '#f6cd82']),
  gold: ramp(['#77621d', '#c1a631', '#e0c754', '#f4e896']),
  maw: ramp(['#40090c', '#6d1518', '#a42f28', '#c94f43', '#f0836f']),
  tongue: ramp(['#6f1a20', '#a42f30', '#d05348', '#f0836f', '#ffb39c']),
  belly: ramp(['#2c1714', '#3f2320', '#5a382e', '#744c40', '#8f6250']),
  dark: ramp(['#100a12', '#1b1220', '#2a1c2a', '#3e2c3c', '#584252']),
  plum: ramp(['#150d16', '#241522', '#3a2438', '#553a52', '#6e4a62', '#8a5f74', '#a87b90']),
  tooth: ramp(['#8f8168', '#c9bda0', '#efe8d2', '#fdf9ea']),
  olive: ramp(['#211f0e', '#343218', '#4b4a23', '#62602f', '#7a733c', '#93894d', '#ab9d61', '#c1b277']),
}

export function makeDragonArt() {
  const W = 1024, H = 896, GY = 838
  const rnd = mulberry32(0xd7a604)
  const canvas = mkCanvas(W, H)
  const ctx = canvas.getContext('2d')
  ctx.lineJoin = ctx.lineCap = 'round'

  // Torch key from the upper right (party side); cool blue-black pools left.
  const LD = [0.76, -0.65]
  const lit = (nx, ny, base = 0.5, gain = 0.42) => {
    const d = nx * LD[0] + ny * LD[1]
    return Math.max(0, Math.min(1, base + gain * d))
  }

  // ---- far wing: a draped curtain falling down-left behind the rump -------
  drapedWing(ctx, rnd, {
    root: [560, 430],
    carpal: [242, 332],
    spike: [186, 272],
    tips: [[84, 330], [44, 434], [74, 564], [162, 664], [278, 726]],
    sag: 0.36, jag: 14,
    rampF: DRG.wing, brightT: 0.46, darkT: 0.04,
    clawRamp: DRG.dark,
  })
  // the curtain drowns toward the hall dark at its low tips
  wash(ctx, () => {
    puff(ctx, 120, 660, 240, '#171126', 0.5, 190)
    puff(ctx, 62, 470, 150, '#171126', 0.42)
  })

  // ---- the tail -----------------------------------------------------------
  // column off the rump → plated coil crowning the top-left → tip flying right
  const TAIL = [
    [452, 648], [502, 560], [532, 468], [544, 370], [534, 280],
    [494, 224], [418, 198], [318, 192], [212, 176], [134, 138],
    [94, 90], [140, 52], [242, 34], [350, 44], [434, 78],
    [488, 120], [500, 164],
    [566, 132], [640, 116], [706, 128],
  ]
  const N_TAIL = TAIL.length - 1
  const tailW = (t) => (t < 0.2 ? 74 - 90 * t : t < 0.78 ? 56 - 14 * ((t - 0.2) / 0.58) : 40 - 24 * ((t - 0.78) / 0.22))
  const slice = (i0, i1) => {
    const s = TAIL.slice(i0, i1 + 1)
    const t0 = i0 / N_TAIL, t1 = i1 / N_TAIL
    return { spine: s, t0, t1, shape: ribbon(s, (u) => tailW(t0 + (t1 - t0) * u) / 2) }
  }

  /** chunky overlapping plates + irregular thorns along a tail slice. */
  const paintPlatedTube = (sl, outwardFrom, spikes = true) => {
    const { spine, shape, t0, t1 } = sl
    ctx.fillStyle = DRG.olive(0.3)
    ctx.fill(shape)
    shadeIn(ctx, shape, () => {
      walk(spine, 24, (p, tg, n) => {
        const b = lit(n[0], n[1])
        puff(ctx, p[0] + n[0] * 9, p[1] + n[1] * 9, 34, DRG.olive(0.2 + 0.45 * b), 0.3, 24)
        puff(ctx, p[0] - n[0] * 11, p[1] - n[1] * 11, 32, DRG.olive(0.08), 0.34, 22)
      })
    })
    const stops = []
    walk(spine, 25, (p, tg, n, tt) => stops.push([p, tg, n, tt]))
    for (let i = stops.length - 1; i >= 0; i--) {
      const [p, tg, n, tt] = stops[i]
      const w = tailW(t0 + (t1 - t0) * tt) * 0.5
      const jw = w * (1.05 + (rnd() - 0.5) * 0.1)
      // plate brightness: torch key + extra dark toward the lower-left hall
      const b = lit(n[0], n[1], 0.44, 0.38) + (rnd() - 0.5) * 0.12 -
        Math.max(0, (p[1] - 100) / 560 + (400 - p[0]) / 1000) * 0.26
      const plate = spline([
        [p[0] + n[0] * jw - tg[0] * 9, p[1] + n[1] * jw - tg[1] * 9],
        [p[0] + tg[0] * 14, p[1] + tg[1] * 14],
        [p[0] - n[0] * jw - tg[0] * 9, p[1] - n[1] * jw - tg[1] * 9],
        [p[0] - n[0] * jw * 0.82 - tg[0] * 18, p[1] - n[1] * jw * 0.82 - tg[1] * 18],
        [p[0] - tg[0] * 16, p[1] - tg[1] * 16],
        [p[0] + n[0] * jw * 0.82 - tg[0] * 18, p[1] + n[1] * jw * 0.82 - tg[1] * 18],
      ], true)
      ctx.fillStyle = DRG.olive(Math.max(0.06, 0.18 + 0.48 * b))
      ctx.fill(plate)
      shadeIn(ctx, plate, () => {
        strand(ctx, [
          [p[0] + n[0] * jw * 0.9 + tg[0] * 9, p[1] + n[1] * jw * 0.9 + tg[1] * 9],
          [p[0] + tg[0] * 13, p[1] + tg[1] * 13],
          [p[0] - n[0] * jw * 0.9 + tg[0] * 9, p[1] - n[1] * jw * 0.9 + tg[1] * 9],
        ], 4.5, 3, DRG.olive(Math.max(0.1, 0.3 + 0.5 * b), 0.85))
        strand(ctx, [
          [p[0] + n[0] * jw * 0.9 - tg[0] * 15, p[1] + n[1] * jw * 0.9 - tg[1] * 15],
          [p[0] - tg[0] * 18, p[1] - tg[1] * 18],
          [p[0] - n[0] * jw * 0.9 - tg[0] * 15, p[1] - n[1] * jw * 0.9 - tg[1] * 15],
        ], 5, 3, DRG.olive(0.04, 0.6))
        // keel scratch down the plate centre
        if (rnd() < 0.6) strand(ctx, [[p[0] - tg[0] * 12, p[1] - tg[1] * 12], [p[0] + tg[0] * 8, p[1] + tg[1] * 8]], 2, 1, DRG.olive(0.55 * b + 0.1, 0.4))
      })
    }
    ctx.save()
    ctx.globalAlpha = 0.5
    ctx.lineWidth = 4
    ctx.strokeStyle = DRG.olive(0.04)
    ctx.stroke(shape)
    ctx.restore()
    if (!spikes) return
    // amber hooks: chunky, curling back against the flow
    walk(spine, 34, (p, tg, n, tt) => {
      if (rnd() < 0.18) return
      let ox = n[0], oy = n[1]
      if (outwardFrom) {
        ox = p[0] - outwardFrom[0]; oy = p[1] - outwardFrom[1]
        const l = Math.hypot(ox, oy) || 1
        ox /= l; oy /= l
      }
      const w = tailW(t0 + (t1 - t0) * tt) * 0.5
      const ang = Math.atan2(oy, ox) + (rnd() - 0.5) * 0.3
      // curl sign: hook bends back against travel direction
      const back = (ox * tg[1] - oy * tg[0]) > 0 ? 1 : -1
      const len = Math.min(44, (26 + rnd() * 30) * (0.75 + w / 30))
      horn(ctx, p[0] + ox * w * 0.7, p[1] + oy * w * 0.7, ang, len, 14 + rnd() * 7, back * (0.45 + rnd() * 0.25), DRG.amber,
        rnd() < 0.45 ? { tipCss: DRG.gold(0.7) } : {})
      if (rnd() < 0.4) {
        horn(ctx, p[0] + ox * w * 0.55 + tg[0] * 12, p[1] + oy * w * 0.55 + tg[1] * 12, ang + 0.3, len * 0.5, 8, back * 0.4, DRG.amber, {})
      }
    })
  }

  // tip first (deepest), with the flying fins + dangling streamers
  {
    const tip = TAIL[19]
    for (const [ang, len, w] of [[-1.35, 62, 24], [-0.7, 82, 32], [-0.1, 94, 38], [0.55, 74, 30]]) {
      const p1 = [tip[0] + Math.cos(ang) * len, tip[1] + Math.sin(ang) * len]
      const mid = [tip[0] + Math.cos(ang + 0.45) * len * 0.6, tip[1] + Math.sin(ang + 0.45) * len * 0.6]
      const fin = spline([[tip[0], tip[1] + 3], [p1[0], p1[1]], [mid[0], mid[1]]], true)
      ctx.fillStyle = lin(ctx, tip[0], tip[1], p1[0], p1[1], [[0, DRG.wing(0.3)], [1, DRG.wing(0.06)]])
      ctx.fill(fin)
      shadeIn(ctx, fin, () => {
        strand(ctx, [[tip[0], tip[1]], [(tip[0] + p1[0]) / 2, (tip[1] + p1[1]) / 2], p1], 5, 1, DRG.wing(0.04, 0.85))
        puff(ctx, mid[0], mid[1], w, DRG.wing(0.5), 0.3)
      })
    }
    for (const [sx, sy, ex, ey] of [[694, 156, 668, 320], [722, 160, 736, 272]]) {
      strand(ctx, [[sx, sy], [(sx + ex) / 2 + 14, (sy + ey) / 2], [ex, ey]], 5, 0.6, DRG.wing(0.12, 0.85))
    }
    paintPlatedTube(slice(16, 19), null, false)
  }
  // dark ragged under-fins hanging off the loop's entry stretch
  for (const [bx, by, ang, len, w] of [[500, 320, 1.7, 58, 26], [452, 284, 1.95, 48, 22]]) {
    const p1 = [bx + Math.cos(ang) * len, by + Math.sin(ang) * len]
    const fin = spline([[bx - w * 0.4, by], [bx + w * 0.5, by + 6], [p1[0] + 6, p1[1] - 8], [p1[0], p1[1]], [p1[0] - 10, p1[1] - 14]], true)
    ctx.fillStyle = lin(ctx, bx, by, p1[0], p1[1], [[0, DRG.wing(0.26)], [1, DRG.wing(0.05)]])
    ctx.fill(fin)
  }
  // the coil — hooks point out from the loop centre
  paintPlatedTube(slice(5, 16), [300, 118])

  // ---- rising tail base over the wing (cream fur → olive plates) ----------
  {
    const C = slice(0, 5)
    ctx.fillStyle = lin(ctx, 470, 655, 548, 268, [
      [0, DRG.hide(0.38)], [0.4, DRG.hide(0.48)], [0.72, DRG.olive(0.4)], [1, DRG.olive(0.3)],
    ])
    ctx.fill(C.shape)
    shadeIn(ctx, C.shape, () => {
      walk(C.spine, 20, (p, tg, n, tt) => {
        const w = tailW(tt * C.t1) * 0.5
        const b = lit(n[0], n[1])
        const col = tt < 0.5 ? DRG.hide : DRG.olive
        puff(ctx, p[0] + n[0] * w * 0.45, p[1] + n[1] * w * 0.45, w * 1.15, col(0.2 + 0.44 * b), 0.32, w * 0.85)
        puff(ctx, p[0] - n[0] * w * 0.5, p[1] - n[1] * w * 0.5, w, col(0.08), 0.4, w * 0.8)
      })
      fur(ctx, rnd, C.shape, [410, 340, 600, 690], {
        count: 300,
        angleAt: (x, y) => Math.atan2(-(x - 480), y - 690) + Math.PI / 2 + 0.3,
        colAt: () => DRG.hide(0.26 + rnd() * 0.4),
        len: [8, 16], width: [1.2, 2.3], alpha: [0.12, 0.24],
      })
    })
    paintPlatedTube(slice(3, 5), null, false)
    // thorn row up the outer (right) edge of the rise
    walk(C.spine, 40, (p, tg, n, tt) => {
      const w = tailW(tt * C.t1) * 0.5
      const ang = Math.atan2(n[1], n[0]) - 0.25
      horn(ctx, p[0] + n[0] * w * 0.7, p[1] + n[1] * w * 0.7, ang, 28 + rnd() * 24, 13 + rnd() * 6, -0.5, DRG.amber, { tipCss: DRG.gold(0.72) })
    })
  }

  // ---- legs first (the body drops over their hips) ------------------------
  // short HEAVY digitigrade limbs: a cream muscle thigh, dark shank kicked
  // back, pale hooked talons — mass, not sticks (the round-1 failure)
  const leg = (o) => {
    const { hip, knee, hock, footX, thighW, shankW, shade } = o
    // thigh: filled haunch mass hip → knee
    const thigh = spline([
      [hip[0] - thighW * 0.52, hip[1] + 8], [hip[0] - thighW * 0.16, hip[1] - thighW * 0.36],
      [hip[0] + thighW * 0.5, hip[1] - thighW * 0.1], [knee[0] + shankW * 0.7, knee[1] - 12],
      [knee[0], knee[1] + shankW * 0.6], [hip[0] - thighW * 0.46, hip[1] + thighW * 0.52],
    ], true)
    ctx.fillStyle = lin(ctx, hip[0] + thighW * 0.4, hip[1] - 16, knee[0] - 6, knee[1] + 6, [
      [0, DRG.hide(0.4 + shade)], [0.55, DRG.hide(0.24 + shade)], [1, DRG.belly(0.3)],
    ])
    ctx.fill(thigh)
    shadeIn(ctx, thigh, () => {
      strokeBand(ctx, rnd, [[hip[0] + thighW * 0.28, hip[1] - thighW * 0.08], [knee[0] + 10, knee[1] - 10]],
        thighW * 0.5, DRG.hide, 0.42 + shade, 0.5, 3, 0.9)
      strand(ctx, [[hip[0] - thighW * 0.3, hip[1] + 12], [knee[0] - shankW * 0.4, knee[1] - 4]],
        thighW * 0.4, shankW, DRG.belly(0.2, 0.65))
      puff(ctx, knee[0], knee[1] - 4, shankW * 1.1, DRG.hide(0.46 + shade), 0.4, shankW * 0.8)
    })
    // shank: dark, kicked back, then down to the toes
    strand(ctx, [[knee[0], knee[1]], [hock[0], hock[1]], [footX - 2, GY - 16]], shankW, shankW * 0.5, DRG.dark(0.18 + shade))
    strand(ctx, [[knee[0] + shankW * 0.28, knee[1] + 4], [hock[0] + shankW * 0.3, hock[1]], [footX + 5, GY - 18]],
      shankW * 0.32, 2.4, DRG.dark(0.48 + shade, 0.78))
    puff(ctx, hock[0], hock[1], shankW * 0.8, DRG.dark(0.55 + shade), 0.5, shankW * 0.55)
    // feathered cuff where the cream thigh meets the dark shank
    for (let i = 0; i < 6; i++) {
      const a = 1.85 + i * 0.2 + (rnd() - 0.5) * 0.15
      strand(ctx, [[knee[0] + 2, knee[1] - 6], [knee[0] + Math.cos(a) * 18, knee[1] - 4 + Math.sin(a) * 18],
        [knee[0] + Math.cos(a + 0.3) * 34, knee[1] - 2 + Math.sin(a + 0.3) * 34]],
        9, 0.8, DRG.hide(0.26 + shade + rnd() * 0.22, 0.9))
    }
    // foot pad
    strand(ctx, [[footX - 14, GY - 11], [footX + 4, GY - 7], [footX + 22, GY - 7]], shankW * 0.66, shankW * 0.5, DRG.dark(0.22 + shade))
    // pale talons — the bright accent that reads at distance
    for (const [dx, l, aa] of [[24, 26, 0.6], [9, 30, 0.82], [-6, 26, 1.05]]) {
      horn(ctx, footX + dx, GY - 10, aa, l, 10, 0.55, DRG.tooth, { rootT: 0.28, midT: 0.58, tipT: 0.95 })
    }
    horn(ctx, footX - 19, GY - 13, 2.5, 16, 7, 0.3, DRG.tooth, { rootT: 0.25, midT: 0.5, tipT: 0.8 })
    // warm torch kiss down the shin front
    strand(ctx, [[knee[0] + shankW * 0.3, knee[1] + 8], [hock[0] + shankW * 0.34, hock[1] + 4], [footX + 10, GY - 14]],
      3.5, 1.2, 'rgba(231,160,106,0.42)')
  }
  leg({ hip: [500, 650], knee: [478, 726], hock: [500, 766], footX: 490, thighW: 64, shankW: 30, shade: -0.06 }) // hind
  leg({ hip: [646, 600], knee: [620, 716], hock: [640, 778], footX: 632, thighW: 54, shankW: 28, shade: -0.02 }) // far fore
  // near foreleg painted after the body

  // ---- near-black echo sail melting behind the shoulder (painted BEFORE
  // the body so the body's right flank stays in front of it) ---------------
  drapedWing(ctx, rnd, {
    root: [716, 360],
    carpal: [796, 240],
    tips: [[874, 282], [900, 388], [864, 486]],
    sag: 0.4, jag: 12,
    rampF: DRG.wing, brightT: 0.26, darkT: 0.03, alpha: 0.92,
    claws: false,
  })
  wash(ctx, () => puff(ctx, 886, 396, 120, '#140d1f', 0.5, 108))

  // ---- the body: rump low left, back climbing to the 3.4 m shoulder hump --
  const bodyPts = [
    [788, 462], [836, 514], [864, 580], [874, 646], [858, 698], [820, 726],  // breast front
    [760, 742], [686, 746], [606, 740], [532, 722], [480, 694],              // belly line
    [440, 650], [422, 602], [426, 550], [452, 500], [492, 452],              // rump
    [540, 408], [594, 366], [650, 336], [706, 322], [748, 330], [774, 368], [782, 420], // ridge → hump → neck dip
  ]
  const body = spline(bodyPts, true)
  const bodyLitT = (x, y) => 0.2 + 0.52 * lit((x - 650) / 220, (y - 560) / 160)
  {
    // underpaint: one broad diagonal — everything painterly rides ON this
    ctx.fillStyle = lin(ctx, 830, 460, 460, 720, [
      [0, DRG.hide(0.55)], [0.45, DRG.hide(0.38)], [0.75, DRG.hide(0.24)], [1, DRG.hide(0.14)],
    ])
    ctx.fill(body)
    shadeIn(ctx, body, () => {
      // planar bristle bands — stepped values following the form, NOT airbrush
      strokeBand(ctx, rnd, [[498, 472], [560, 432], [618, 392], [672, 356], [724, 336]], 30, DRG.hide, 0.64, 0.5, 4, 1) // back ridge plane
      strokeBand(ctx, rnd, [[652, 470], [700, 424], [744, 390]], 58, DRG.hide, 0.54, 0.45, 4, 1)  // shoulder ball
      strokeBand(ctx, rnd, [[640, 522], [700, 476], [754, 432]], 48, DRG.hide, 0.44, 0.4, 3, 1)
      strokeBand(ctx, rnd, [[492, 540], [568, 560], [658, 568], [744, 546], [790, 502]], 54, DRG.hide, 0.42, 0.4, 4, 1) // mid flank
      strokeBand(ctx, rnd, [[470, 630], [558, 674], [658, 698], [758, 690], [828, 660]], 48, DRG.hide, 0.28, 0.4, 4, 1) // lower flank
      strokeBand(ctx, rnd, [[812, 516], [846, 582], [858, 646]], 44, DRG.hide, 0.6, 0.45, 3, 1)   // breast plane
      strand(ctx, [[798, 494], [832, 546], [850, 604], [854, 652]], 20, 9, DRG.hide(0.8, 0.5))     // breast lit crest
      // fur coat over the bands, value keyed to the torch
      fur(ctx, rnd, body, [420, 322, 878, 750], {
        count: 1500,
        angleAt: (x, y) => Math.atan2(y - 520, x - 660) + Math.PI / 2 + 0.55,
        colAt: (x, y) => DRG.hide(Math.max(0.06, bodyLitT(x, y) + (rnd() - 0.5) * 0.26)),
        len: [7, 17], width: [1.3, 2.7], alpha: [0.08, 0.2], curl: 0.8,
      })
      // HARD core shadow — the terminator. Crisp clipped fill, hue-bearing
      // belly darks; a narrow half-tone seam melts its top edge.
      const term = [[438, 596], [496, 652], [570, 692], [664, 712], [758, 702], [826, 674], [874, 644]]
      const shadowPath = spline([...term, [858, 700], [820, 728], [760, 744], [686, 748], [606, 742], [532, 724], [478, 694], [438, 648]], true)
      ctx.save()
      ctx.globalAlpha = 0.78
      ctx.fillStyle = lin(ctx, 650, 596, 610, 760, [
        [0, DRG.belly(0.5)], [0.45, DRG.belly(0.28)], [1, DRG.belly(0.1)],
      ])
      ctx.fill(shadowPath)
      ctx.restore()
      strand(ctx, term, 8, 3, DRG.hide(0.3, 0.5))
      strand(ctx, term.map((p) => [p[0], p[1] + 9]), 6, 2, DRG.belly(0.42, 0.45))
      // belly plates: broad low-contrast arcs inside the shadow
      const arcPts = [[492, 700], [556, 724], [634, 738], [712, 738], [786, 722], [832, 688]]
      for (let i = arcPts.length - 2; i >= 0; i--) {
        const a = arcPts[i], b = arcPts[i + 1]
        const cxm = (a[0] + b[0]) / 2, cym = (a[1] + b[1]) / 2
        const seg = spline([[a[0], a[1] - 13], [cxm, cym - 19], [b[0], b[1] - 13], [cxm, cym + 6]], true)
        ctx.save()
        ctx.globalAlpha = 0.5
        ctx.fillStyle = DRG.belly(0.3 + 0.08 * i)
        ctx.fill(seg)
        ctx.restore()
        shadeIn(ctx, seg, () => {
          strand(ctx, [[a[0], a[1] - 11], [cxm, cym - 16], [b[0], b[1] - 11]], 3, 2, DRG.belly(0.62, 0.35))
          puff(ctx, cxm, cym + 2, 17, DRG.belly(0.05), 0.35, 8)
        })
      }
      // ambient occlusion pools — focused, deep, between the limbs
      puff(ctx, 504, 648, 44, DRG.belly(0.06), 0.6, 32)    // hind-thigh join
      puff(ctx, 644, 592, 38, DRG.belly(0.08), 0.55, 28)   // far-fore join
      puff(ctx, 700, 736, 84, DRG.belly(0.05), 0.5, 26)    // under-chest trench
      puff(ctx, 462, 630, 38, DRG.belly(0.08), 0.5)        // tail-base pocket
      puff(ctx, 452, 522, 60, DRG.hide(0.08), 0.4)         // rump falls to hall dark
      // lit back-ridge crest + warm torch bounce climbing the breast
      strand(ctx, [[500, 466], [566, 424], [634, 384], [696, 348], [740, 334]], 6, 2.5, DRG.hide(0.88, 0.7))
      puff(ctx, 836, 620, 88, 'rgba(231,160,106,1)', 0.2, 120, 0.4)
    })
    // fluffy rim so the silhouette reads furred, not vector-smooth
    fluffEdge(ctx, rnd, [...bodyPts, bodyPts[0]], 17, {
      size: [7, 15],
      leanFn: (p, n) => Math.atan2(n[1], n[0]) + 0.5,
      colFn: (p) => DRG.hide(Math.max(0.08, bodyLitT(p[0], p[1]) + (rnd() - 0.5) * 0.14), 0.95),
    })
  }

  // ---- amber back-blades raking off the ridge, each rooted in the hide ----
  {
    const blades = [
      [692, 330, 96, 24], [652, 340, 70, 18], [608, 358, 98, 25],
      [564, 384, 62, 16], [524, 414, 82, 20], [490, 452, 54, 14],
    ]
    for (const [bx, by, l, w] of blades) {
      rootedHorn(ctx, rnd, bx, by, -2.42 + (rnd() - 0.5) * 0.12, l, w, -0.34, DRG.amber, DRG.hide, 0.5,
        { rootT: 0.14, midT: 0.55, tipT: 0.92, tipCss: rnd() < 0.5 ? DRG.gold(0.75) : null })
      if (rnd() < 0.6) horn(ctx, bx + 12, by + 12, -2.15, l * 0.4, w * 0.55, -0.3, DRG.amber, {})
    }
  }

  // ---- near wing: the RAISED sail — roots on the hump, crest spikes to the
  // top of the silhouette (§1 wing-crest anchor, left of the feet) ----------
  drapedWing(ctx, rnd, {
    root: [668, 352],
    carpal: [700, 150],
    spike: [662, 52],
    tips: [[796, 112], [884, 208], [932, 342], [916, 472]],
    sag: 0.42, jag: 12,
    rampF: DRG.wing, brightT: 0.7, darkT: 0.07,
    clawRamp: DRG.dark,
    sheen: () => {
      puff(ctx, 756, 232, 64, DRG.wing(0.92), 0.4, 44, -1.05)
      puff(ctx, 798, 330, 56, DRG.wing(0.74), 0.28, 40, -0.85)
      // hot torch line up the leading fold toward the crest
      strand(ctx, [[684, 300], [698, 190], [666, 78]], 4.5, 1.5, 'rgba(255,190,140,0.55)')
    },
  })
  // AO trench where the sail leaves the shoulder — the wing sits IN the body
  puff(ctx, 672, 366, 42, DRG.belly(0.07), 0.55, 26)
  puff(ctx, 700, 342, 30, DRG.belly(0.12), 0.4, 20)

  // ---- near foreleg over the body -----------------------------------------
  leg({ hip: [784, 590], knee: [774, 700], hock: [764, 776], footX: 756, thighW: 60, shankW: 31, shade: 0.08 })

  // ---- green rump ruff ----------------------------------------------------
  for (let i = 0; i < 14; i++) {
    const bx = 426 + rnd() * 58, by = 548 + rnd() * 84
    const ang = -2.5 + (rnd() - 0.5) * 0.7
    const l = 26 + rnd() * 30
    strand(ctx, [
      [bx + 14, by + 6], [bx, by],
      [bx + Math.cos(ang) * l * 0.6, by + Math.sin(ang) * l * 0.6],
      [bx + Math.cos(ang - 0.6) * l, by + Math.sin(ang - 0.6) * l],
    ], 9, 0.8, DRG.mane(0.12 + rnd() * 0.5, 0.9))
  }

  // ---- THE NECK — the S-curve dive from the hump to the eye-line ----------
  {
    const NK = [[712, 338], [762, 322], [810, 342], [838, 390], [848, 452], [842, 516], [830, 552]]
    const nW = (t) => 62 - 18 * t
    const neckShape = ribbon(NK, (t) => nW(t) / 2)
    const nn = normals(NK)
    const offPts = (s) => NK.map((p, i) => {
      const w = nW(i / (NK.length - 1)) * 0.5
      return [p[0] + nn[i][0] * w * s, p[1] + nn[i][1] * w * s]
    })
    ctx.fillStyle = lin(ctx, 880, 400, 750, 520, [[0, DRG.hide(0.62)], [0.5, DRG.hide(0.4)], [1, DRG.hide(0.2)]])
    ctx.fill(neckShape)
    shadeIn(ctx, neckShape, () => {
      strokeBand(ctx, rnd, offPts(-0.55), 22, DRG.hide, 0.62, 0.5, 3, 0.9)   // lit ridge plane
      strokeBand(ctx, rnd, offPts(0.05), 26, DRG.hide, 0.42, 0.45, 3, 1)     // mid plane
      strand(ctx, offPts(0.34), 7, 3, DRG.hide(0.3, 0.5))                    // half-tone seam
      strand(ctx, offPts(0.62), 22, 10, DRG.belly(0.22, 0.8))                // crisp throat core shadow
      strand(ctx, offPts(0.85), 13, 5, DRG.belly(0.09, 0.7))
      // overlapping scale rows crossing the mid plane
      walk(NK, 19, (p, tg, n, tt) => {
        const w = nW(tt) * 0.5
        for (const s of [-0.22, 0.16]) {
          const cxp = p[0] + n[0] * w * s, cyp = p[1] + n[1] * w * s
          strand(ctx, [
            [cxp - tg[0] * 9 + n[0] * 4, cyp - tg[1] * 9 + n[1] * 4],
            [cxp + n[0] * 9, cyp + n[1] * 9],
            [cxp + tg[0] * 9 + n[0] * 4, cyp + tg[1] * 9 + n[1] * 4],
          ], 3.5, 1.5, DRG.hide(0.52 - s * 0.9 + (rnd() - 0.5) * 0.12, 0.5))
        }
      })
      strand(ctx, offPts(-0.8), 5, 2, DRG.hide(0.86, 0.7))                   // hot ridge line
    })
    // green mane streaming back-up off the ridge — dark blade + bright blade
    walk(NK, 14, (p, tg, n, tt) => {
      if (tt > 0.86 || rnd() < 0.12) return
      const w = nW(tt) * 0.5
      const bx = p[0] - n[0] * w * 0.92, by = p[1] - n[1] * w * 0.92
      const ang = Math.atan2(-tg[1], -tg[0]) - 0.38 + (rnd() - 0.5) * 0.3
      const l = 24 + rnd() * 20
      strand(ctx, [[bx + 4, by + 4], [bx + Math.cos(ang) * l * 0.55 + 4, by + Math.sin(ang) * l * 0.55 + 3],
        [bx + Math.cos(ang - 0.4) * l + 3, by + Math.sin(ang - 0.4) * l + 2]], 8, 0.8, DRG.mane(0.16 + rnd() * 0.14, 0.95))
      strand(ctx, [[bx, by], [bx + Math.cos(ang) * l * 0.55, by + Math.sin(ang) * l * 0.55],
        [bx + Math.cos(ang - 0.4) * l, by + Math.sin(ang - 0.4) * l]], 5.5, 0.7, DRG.mane(0.5 + rnd() * 0.4, 0.95))
    })
    // amber ridge spikes, rooted, shrinking toward the head
    for (const [tt, l, w] of [[0.16, 46, 15], [0.44, 38, 13], [0.72, 28, 10]]) {
      const a = along(NK, tt)
      const wr = nW(tt) * 0.5
      rootedHorn(ctx, rnd, a.x - a.nx * wr * 0.8, a.y - a.ny * wr * 0.8, -2.5 + tt * 0.5, l, w, -0.35, DRG.amber, DRG.hide, 0.55,
        { tipCss: rnd() < 0.5 ? DRG.gold(0.72) : null })
    }
    // AO where the throat drops onto the chest
    puff(ctx, 800, 474, 36, DRG.belly(0.08), 0.5, 26)
  }

  // ---- THE HEAD — low wedge at the 1.4 m eye-line, maw gaping red ---------
  {
    // green mane roots + amber crown horns BEHIND the skull
    for (let i = 0; i < 9; i++) {
      const t = i / 8
      const bx = 836 - t * 52, by = 556 + t * 12 + (rnd() - 0.5) * 5
      const ang = -2.35 - t * 0.4 + (rnd() - 0.5) * 0.2
      const l = 22 + rnd() * 22
      strand(ctx, [[bx + 4, by + 4], [bx + Math.cos(ang) * l * 0.55 + 4, by + Math.sin(ang) * l * 0.55 + 3],
        [bx + Math.cos(ang - 0.45) * l + 3, by + Math.sin(ang - 0.45) * l + 2]], 8, 0.8, DRG.mane(0.15 + rnd() * 0.14, 0.95))
      strand(ctx, [[bx, by], [bx + Math.cos(ang) * l * 0.55, by + Math.sin(ang) * l * 0.55],
        [bx + Math.cos(ang - 0.45) * l, by + Math.sin(ang - 0.45) * l]], 5.5, 0.7, DRG.mane(0.5 + rnd() * 0.38, 0.95))
    }
    horn(ctx, 802, 566, -2.55, 78, 20, -0.3, DRG.amber, { rootT: 0.14, midT: 0.55, tipT: 0.92, tipCss: DRG.gold(0.75) })
    horn(ctx, 834, 554, -2.4, 92, 22, -0.28, DRG.amber, { rootT: 0.14, midT: 0.55, tipT: 0.92 })
    horn(ctx, 866, 552, -2.28, 44, 13, -0.26, DRG.amber, {})

    // cream skull wedge — brow high over the eye, tapering forward
    const skull = spline([
      [770, 594], [796, 564], [840, 550], [890, 554], [928, 572],
      [950, 594], [956, 616], [944, 632], [906, 640], [860, 642],
      [814, 634], [784, 616],
    ], true)
    ctx.fillStyle = lin(ctx, 900, 560, 790, 640, [[0, DRG.hide(0.78)], [0.55, DRG.hide(0.55)], [1, DRG.hide(0.32)]])
    ctx.fill(skull)
    shadeIn(ctx, skull, () => {
      strokeBand(ctx, rnd, [[800, 578], [846, 562], [898, 564]], 18, DRG.hide, 0.7, 0.5, 3, 0.9)
      strand(ctx, [[800, 570], [848, 556], [900, 560]], 7, 3, DRG.hide(0.92, 0.75))
      // crisp cheek core shadow toward the jaw hinge
      const cheek = spline([[770, 594], [784, 616], [814, 634], [858, 640], [846, 612], [806, 596]], true)
      ctx.save()
      ctx.globalAlpha = 0.6
      ctx.fillStyle = DRG.belly(0.26)
      ctx.fill(cheek)
      ctx.restore()
      fur(ctx, rnd, skull, [768, 548, 958, 644], {
        count: 170, angleAt: () => 0.25, colAt: () => DRG.hide(0.4 + rnd() * 0.4),
        len: [5, 10], width: [1, 2], alpha: [0.1, 0.2],
      })
    })
    // plum muzzle mask over the front third — the frame04 dark snout
    const muzzle = spline([
      [878, 558], [928, 572], [950, 594], [956, 616], [944, 632],
      [906, 640], [868, 640], [856, 608], [862, 576],
    ], true)
    ctx.fillStyle = lin(ctx, 898, 570, 950, 634, [[0, DRG.plum(0.5)], [0.5, DRG.plum(0.3)], [1, DRG.plum(0.12)]])
    ctx.fill(muzzle)
    shadeIn(ctx, muzzle, () => {
      strand(ctx, [[872, 570], [916, 572], [946, 592]], 6, 2.5, DRG.plum(0.85, 0.8))   // glossy bridge
      strand(ctx, [[866, 590], [906, 596], [938, 612]], 4, 2, DRG.plum(0.6, 0.5))
      puff(ctx, 946, 626, 20, DRG.plum(0.06), 0.55, 15)
      // nostril slit
      ctx.fillStyle = DRG.plum(0.04, 0.95)
      ctx.beginPath()
      ctx.ellipse(930, 596, 7.5, 3.4, 0.45, 0, Math.PI * 2)
      ctx.fill()
      puff(ctx, 926, 592, 6, DRG.plum(0.8), 0.5)
      strand(ctx, [[864, 580], [874, 596], [878, 612]], 2.5, 1, DRG.plum(0.16, 0.5))
    })
    puff(ctx, 862, 586, 15, DRG.hide(0.72), 0.28, 11, 0.4)   // soften the mask seam

    // ---- the maw — GAPING red, #a42f28 → #f0836f --------------------------
    const maw = spline([
      [804, 646], [854, 648], [904, 644], [942, 632], [950, 644],
      [932, 670], [894, 690], [850, 698], [814, 688], [796, 666],
    ], true)
    ctx.fillStyle = lin(ctx, 870, 638, 860, 700, [[0, DRG.maw(0.78)], [0.45, DRG.maw(0.6)], [1, DRG.maw(0.38)]])
    ctx.fill(maw)
    shadeIn(ctx, maw, () => {
      puff(ctx, 812, 670, 26, DRG.maw(0.1), 0.75)                             // throat falls dark
      strand(ctx, [[808, 650], [868, 648], [930, 638]], 8, 4, DRG.maw(0.3, 0.7))
      puff(ctx, 900, 668, 16, DRG.maw(0.95), 0.4)                             // wet glisten
    })
    // upper lip band over the maw's top edge
    strand(ctx, [[798, 644], [854, 646], [906, 642], [948, 630]], 9, 5, DRG.plum(0.14, 0.95))
    // LAYERED fang rows: dark back row first, bright front row over it
    for (const [x, y, l] of [[830, 650, 10], [854, 652, 12], [878, 650, 10], [900, 646, 12]]) {
      horn(ctx, x, y, 1.66 + (rnd() - 0.5) * 0.12, l, l * 0.42, 0.1, DRG.tooth, { rootT: 0.15, midT: 0.4, tipT: 0.62 })
    }
    for (const [x, y, l] of [[818, 650, 13], [842, 653, 17], [866, 653, 12], [888, 650, 20], [910, 646, 14], [930, 640, 24], [944, 634, 18]]) {
      puff(ctx, x, y + 1, l * 0.22, DRG.maw(0.2), 0.5)                        // gum socket
      horn(ctx, x, y, 1.6 + (rnd() - 0.5) * 0.14, l, l * 0.44, 0.14, DRG.tooth, { rootT: 0.3, midT: 0.62, tipT: 0.96 })
    }

    // ---- plum lower jaw ---------------------------------------------------
    const jaw = spline([
      [804, 680], [844, 698], [888, 710], [926, 716], [946, 728],
      [940, 746], [910, 750], [866, 742], [828, 722], [804, 698],
    ], true)
    ctx.fillStyle = lin(ctx, 830, 698, 938, 746, [[0, DRG.plum(0.5)], [0.6, DRG.plum(0.28)], [1, DRG.plum(0.1)]])
    ctx.fill(jaw)
    shadeIn(ctx, jaw, () => {
      strand(ctx, [[810, 688], [868, 706], [932, 722]], 6, 2.5, DRG.plum(0.72, 0.6))
      strand(ctx, [[812, 704], [864, 730], [922, 744]], 12, 6, DRG.plum(0.06, 0.6))   // under-jaw core shadow
      puff(ctx, 934, 736, 10, DRG.plum(0.62), 0.4)                                    // chin catch-light
    })
    // lower fang row rising off the lip
    for (const [x, y, l] of [[832, 694, 12], [856, 702, 16], [882, 708, 11], [906, 712, 15], [928, 716, 12]]) {
      horn(ctx, x, y, -1.55 + (rnd() - 0.5) * 0.14, l, l * 0.42, 0.12, DRG.tooth, { rootT: 0.28, midT: 0.58, tipT: 0.94 })
    }
    // tongue lolling out over the lip, then one fang re-crossing it
    const tPts = [[824, 678], [862, 692], [898, 704], [920, 718], [930, 734]]
    strand(ctx, tPts, 14, 5, DRG.tongue(0.4))
    strand(ctx, tPts.map((p) => [p[0] + 2, p[1] + 3]), 7, 3, DRG.tongue(0.14, 0.7))
    strand(ctx, [[828, 676], [864, 688], [900, 700], [920, 714]], 4.5, 2, DRG.tongue(0.8, 0.85))
    puff(ctx, 912, 710, 6, DRG.tongue(0.97), 0.6)
    horn(ctx, 906, 712, -1.5, 15, 6.5, 0.12, DRG.tooth, { rootT: 0.28, midT: 0.58, tipT: 0.94 })
    // barbels under the chin
    for (const [x, y, a] of [[920, 744, 1.8], [896, 740, 2.05], [936, 738, 1.5]]) {
      strand(ctx, [[x, y], [x + Math.cos(a) * 10, y + Math.sin(a) * 10], [x + Math.cos(a + 0.4) * 18, y + Math.sin(a + 0.4) * 18]], 4, 0.5, DRG.plum(0.3, 0.9))
    }
    // AO pocket where the jaw hinge meets the throat
    puff(ctx, 798, 668, 20, DRG.belly(0.08), 0.6, 15)

    // ---- the eye — gold, slit, fierce, under a heavy brow -----------------
    puff(ctx, 854, 602, 22, DRG.plum(0.16), 0.4, 15, -0.1)
    const eye = spline([[832, 598], [850, 588], [870, 592], [876, 604], [858, 612], [838, 608]], true)
    ctx.fillStyle = lin(ctx, 836, 592, 874, 610, [[0, '#c9821c'], [0.45, '#f6de6e'], [1, '#e2b62a']])
    ctx.fill(eye)
    shadeIn(ctx, eye, () => {
      strand(ctx, [[832, 596], [854, 588], [876, 598]], 5, 3, 'rgba(60,30,20,0.45)')
      ctx.fillStyle = '#140d05'
      ctx.beginPath()
      ctx.ellipse(855, 600, 2.5, 6.6, 0.1, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = 'rgba(255,250,235,0.95)'
      ctx.beginPath()
      ctx.arc(850, 595, 1.6, 0, Math.PI * 2)
      ctx.fill()
    })
    ctx.strokeStyle = DRG.plum(0.12, 0.85)
    ctx.lineWidth = 3
    ctx.stroke(eye)
    // heavy cream brow overhanging the eye
    strand(ctx, [[820, 588], [848, 578], [880, 582]], 9, 4, DRG.hide(0.88))
    strand(ctx, [[822, 594], [850, 586], [878, 590]], 4, 2, DRG.plum(0.22, 0.5))

    // green cheek wisps behind the jaw hinge
    for (let i = 0; i < 7; i++) {
      const ang = 1.9 + i * 0.16
      strand(ctx, [[788, 648], [788 + Math.cos(ang) * 26, 648 + Math.sin(ang) * 26], [782 + Math.cos(ang + 0.35) * 48, 648 + Math.sin(ang + 0.35) * 48]],
        7, 0.7, DRG.mane(0.22 + rnd() * 0.42, 0.92))
    }
  }

  // soft occlusion pooling beneath the belly and around the planted feet
  puff(ctx, 620, 782, 165, 'rgba(14,10,18,1)', 0.34, 44)
  puff(ctx, 756, GY - 8, 92, 'rgba(14,10,18,1)', 0.3, 13)
  puff(ctx, 632, GY - 8, 80, 'rgba(14,10,18,1)', 0.28, 11)
  puff(ctx, 490, GY - 8, 76, 'rgba(14,10,18,1)', 0.26, 10)

  // ---- scene-key washes: warm torch air upper-right, hall dark lower-left --
  wash(ctx, () => {
    puff(ctx, 900, 430, 330, 'rgba(255,166,79,1)', 0.14, 300)
    puff(ctx, 230, 700, 380, '#161126', 0.36, 300)
    puff(ctx, 540, 800, 300, '#171126', 0.24, 140)
    ctx.fillStyle = lin(ctx, 0, 0, 360, 0, [[0, 'rgba(19,14,34,0.4)'], [1, 'rgba(19,14,34,0)']])
    ctx.fillRect(0, 0, 360, H)
  })

  // ---- finishing: dark edge glaze + torch-keyed rim (BIBLE §6) ------------
  edgeGlaze(canvas, ctx, '#2c1d20', 4, 0.55, 2)
  edgeGlaze(canvas, ctx, '#1a1016', 2, 0.4, 1)
  rimLight(canvas, ctx, '#e7a06a', [0.92, -0.39], 3, 0.6, 1,
    (c) => lin(c, 240, 0, 900, 0, [[0, 'rgba(0,0,0,0.12)'], [1, 'rgba(0,0,0,1)']]))
  rimLight(canvas, ctx, '#ffd9ae', [0.92, -0.39], 1.5, 0.35, 0.5,
    (c) => lin(c, 400, 0, 980, 0, [[0, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,0.8)']]))
  rimLight(canvas, ctx, '#4a6a8a', [-0.85, 0.2], 2, 0.22, 1,
    (c) => lin(c, 0, 0, 700, 0, [[0, 'rgba(0,0,0,0.9)'], [1, 'rgba(0,0,0,0)']]))

  return finishArt(canvas, {
    name: 'dragon',
    px: 700, py: GY,             // ground contact between the forefeet
    anchor: 'feet',
    worldHeight: 6.0,
    floatOffset: 0,
    palette: {
      hide: DRG.hide.stops, wing: DRG.wing.stops, mane: DRG.mane.stops,
      spike: DRG.amber.stops, goldTip: DRG.gold.stops, maw: DRG.maw.stops,
      belly: DRG.belly.stops, tailPlate: DRG.olive.stops,
      edgeGlaze: '#2c1d20', rim: '#e7a06a',
    },
  })
}

// ===========================================================================
// THE SORCERER — frame05 highland boss. Levitating, backlit by fog.
//
// Composition (canvas 768×1024, mass centre ≈ (384, 500), ≈ 132 px/m):
//   · vertical near-black robe mass ending in ragged shreds that alpha-
//     dissolve into the fog band — NOTHING touches the ground (round-2 fix:
//     the ground-contact tendrils are gone; a global dissolve kills every
//     painted pixel below y 872 so the silhouette floats 0.6 m clear)
//   · the beard is the BRIGHTEST shape — a layered white cascade that bulges
//     right at mid-height then streams down-left in ragged locks
//   · gaunt sage face with a dark brow-band, swept-back white hair
//   · blue-silk sleeves with gold bead trim; wine silk cords down the front;
//     oxblood thorn-antler epaulettes rooted in gold filigree
//   · staff on a hard diagonal, oxblood with a crimson backlit edge
//   · huge ragged near-black wings both sides, cool fog rim from upper-left
// ===========================================================================

const SRC = {
  beard: ramp(['#4e5346', '#666b5c', '#7e8271', '#949784', '#adaf99', '#b3b4a1', '#c8c9b8', '#ccd0c2', '#e4e7d8']),
  robe: ramp(['#04060a', '#090c0c', '#0d110d', '#141a14', '#1d251d', '#2a352a']),
  teal: ramp(['#04121f', '#0e3a4d', '#1e4d5c', '#2d6076', '#3d7286', '#5b98a2', '#8fc0c2', '#c2e0da']),
  wine: ramp(['#12010a', '#2d0216', '#4a0a2c', '#6d1544', '#8f2158', '#a83070', '#c04a86']),
  gold: ramp(['#2e2812', '#4c421e', '#726739', '#84805a', '#a89e6e', '#c9bd82']),
  staff: ramp(['#1c0304', '#390708', '#481a1c', '#6b2226', '#8f2c2c', '#b03a34']),
  wingD: ramp(['#04080a', '#091110', '#0d150f', '#132420', '#1d3833', '#2d5049']),
  skin: ramp(['#2e3028', '#454737', '#5c5f4c', '#757863', '#8f927c', '#a9ac97']),
  glove: ramp(['#0c0f10', '#181d1c', '#262e29', '#3a453c', '#525f51']),
  thorn: ramp(['#180810', '#2c1018', '#47181e', '#5e2325', '#792f2a']),
}

export function makeSorcererArt() {
  const W = 768, H = 1024
  const rnd = mulberry32(0x50c31e)
  const canvas = mkCanvas(W, H)
  const ctx = canvas.getContext('2d')
  ctx.lineJoin = ctx.lineCap = 'round'

  const LD = [-0.55, -0.83]   // backlight from the upper-left fog glow

  // ---- far wing (screen-left) — translucent, melting into fog -------------
  drapedWing(ctx, rnd, {
    root: [318, 272],
    carpal: [186, 206],
    spike: [136, 178],
    tips: [[56, 236], [34, 322], [66, 406], [134, 462], [216, 478]],
    sag: 0.36, jag: 16,
    rampF: SRC.wingD, brightT: 0.5, darkT: 0.05,
    alpha: 0.88,
    claws: false,
    sheen: () => {
      strand(ctx, [[310, 260], [232, 212], [148, 188]], 6, 2, SRC.teal(0.55, 0.4))
    },
  })
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  for (const t of [[56, 236], [34, 322], [66, 406]]) puff(ctx, t[0], t[1], 46, 'rgba(0,0,0,1)', 0.4)
  ctx.restore()

  // ---- near wing (screen-right) — the big ragged dark mass ----------------
  drapedWing(ctx, rnd, {
    root: [446, 268],
    carpal: [600, 148],
    spike: [664, 86],
    tips: [[730, 140], [750, 236], [716, 330], [650, 404], [572, 448]],
    sag: 0.38, jag: 18,
    rampF: SRC.wingD, brightT: 0.52, darkT: 0.05,
    claws: false,
    sheen: () => {
      strand(ctx, [[456, 256], [546, 182], [652, 98]], 7, 2, SRC.teal(0.6, 0.5))
      puff(ctx, 610, 220, 72, SRC.wingD(0.6), 0.25, 48, -0.7)
    },
  })
  // trailing tatter streamers, attached at the trailing edge — varied curls
  for (const [pts, w] of [
    [[[716, 336], [748, 388], [736, 448], [748, 486]], 10],
    [[[688, 380], [706, 432], [736, 474]], 8],
    [[[646, 410], [660, 480], [640, 540], [652, 574]], 9],
    [[[590, 442], [596, 490], [578, 528]], 6],
  ]) {
    strand(ctx, pts, w, 0.5, SRC.wingD(0.14, 0.92))
  }

  // ---- robe mass ----------------------------------------------------------
  const robePts = [
    [352, 250], [298, 282], [264, 344], [244, 430], [232, 530],
    [228, 640], [248, 740], [234, 818], [268, 798], [290, 874],
    [328, 838], [358, 920], [396, 864], [432, 932], [462, 854],
    [498, 888], [508, 782], [514, 664], [508, 540], [492, 420],
    [468, 318], [432, 258],
  ]
  const robe = spline(robePts, true)
  {
    ctx.fillStyle = lin(ctx, 380, 250, 380, 900, [
      [0, SRC.robe(0.55)], [0.35, SRC.robe(0.34)], [0.7, SRC.robe(0.16)], [1, SRC.robe(0.04)],
    ])
    ctx.fill(robe)
    shadeIn(ctx, robe, () => {
      // wine silk cords twisting down the front — glossy ropes, waist-bright
      const cords = [
        { x: 284, w: 15, b: 0.55, sway: 20, ph: 0.8 },
        { x: 314, w: 19, b: 0.9, sway: 26, ph: 2.4 },
        { x: 348, w: 13, b: 0.7, sway: 15, ph: 4.4 },
        { x: 376, w: 16, b: 0.45, sway: 22, ph: 1.6 },
        { x: 402, w: 11, b: 0.3, sway: 17, ph: 3.3 },
      ]
      for (const f of cords) {
        const spineC = []
        for (let k = 0; k <= 6; k++) {
          const t = k / 6
          const y = 330 + t * 490
          spineC.push([f.x + Math.sin(t * 5.2 + f.ph) * f.sway * 0.5 - t * t * 30, y])
        }
        // dark under-rope, wine body, narrow twisted crest dashes
        strand(ctx, spineC.map((p) => [p[0] + 3, p[1] + 2]), f.w * 1.9, f.w * 0.7, SRC.wine(f.b * 0.2, 0.95))
        strand(ctx, spineC, f.w * 1.4, f.w * 0.55, SRC.wine(f.b * 0.45, 0.95))
        for (let k = 0; k < 6; k++) {
          const t0 = 0.08 + k * 0.15 + (rnd() - 0.5) * 0.04
          const a0 = along(spineC, t0), a1 = along(spineC, Math.min(1, t0 + 0.09))
          const waist = Math.sin(Math.min(1, (a0.y - 330) / 490) * Math.PI)
          strand(ctx, [[a0.x - 2, a0.y], [(a0.x + a1.x) / 2 - 4, (a0.y + a1.y) / 2], [a1.x - 1, a1.y]],
            f.w * 0.45, f.w * 0.18, SRC.wine(Math.min(0.78, f.b * (0.4 + 0.55 * waist)), 0.9))
        }
        // near-black valley separating this cord from the next
        strand(ctx, spineC.map((p) => [p[0] + f.w * 1.15, p[1]]), f.w * 0.6, f.w * 0.25, SRC.robe(0.06, 0.7))
      }
      // quench the wine at collar and hem so only the waist band glows
      puff(ctx, 330, 360, 110, SRC.robe(0.06), 0.6, 60, 0.2)
      puff(ctx, 330, 780, 130, SRC.robe(0.04), 0.62, 70, -0.1)
      // teal silk sheen: collar V + right flank under the wing
      strand(ctx, [[392, 292], [420, 380], [440, 480]], 24, 9, SRC.teal(0.3, 0.4))
      strand(ctx, [[420, 300], [452, 420], [472, 560]], 12, 4, SRC.teal(0.5, 0.35))
      strand(ctx, [[476, 420], [492, 560], [488, 700]], 14, 5, SRC.teal(0.28, 0.3))
      strand(ctx, [[286, 292], [268, 360], [252, 450]], 12, 4, SRC.teal(0.42, 0.32))
      // gold hem threads on two crests
      strand(ctx, [[258, 420], [242, 560], [246, 690]], 3, 1, SRC.gold(0.6, 0.5))
      strand(ctx, [[500, 470], [508, 600], [500, 720]], 3, 1, SRC.gold(0.5, 0.4))
      puff(ctx, 470, 730, 90, SRC.robe(0.01), 0.5, 110)
      // the beard will land here — pre-shadow its right flank onto the robe
      strand(ctx, [[452, 420], [492, 560], [540, 660]], 40, 20, SRC.robe(0.02, 0.5))
    })
    // gold bead trim swinging across the low torso
    const bead = [[296, 690], [334, 720], [378, 736], [424, 730], [464, 708]]
    walk(bead, 17, (p) => {
      ctx.fillStyle = SRC.gold(0.32)
      ctx.beginPath()
      ctx.arc(p[0], p[1], 4.6, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = SRC.gold(0.88, 0.95)
      ctx.beginPath()
      ctx.arc(p[0] - 1.5, p[1] - 1.7, 1.9, 0, Math.PI * 2)
      ctx.fill()
    })
    // hem dissolve — the robe ends in ragged SHREDS that the fog band eats
    // well above the stage. No tendrils, no ground contact: the levitating
    // boss floats 0.6 m clear and units adds the fog-pool disc beneath it.
    ctx.save()
    ctx.globalCompositeOperation = 'destination-out'
    for (let i = 0; i < 70; i++) {
      const x = 200 + rnd() * 340
      const y = 736 + rnd() * 140
      puff(ctx, x, y, 20 + rnd() * 40, 'rgba(0,0,0,1)', 0.16 + ((y - 736) / 140) * 0.6)
    }
    for (let i = 0; i < 16; i++) {
      const x = 230 + rnd() * 280
      strand(ctx, [[x, 740 + rnd() * 40], [x + (rnd() - 0.5) * 26, 790 + rnd() * 40], [x + (rnd() - 0.5) * 44, 838 + rnd() * 30]],
        11 + rnd() * 15, 2, 'rgba(0,0,0,0.6)')
    }
    ctx.fillStyle = lin(ctx, 0, 744, 0, 866, [[0, 'rgba(0,0,0,0)'], [0.6, 'rgba(0,0,0,0.55)'], [1, 'rgba(0,0,0,1)']])
    ctx.fillRect(140, 744, 480, 130)
    ctx.restore()
    // short dark shred ribbons flicking INTO the dissolve band (they fade
    // with it — nothing reaches for the ground)
    for (const [pts, w] of [
      [[[266, 762], [234, 806], [218, 846]], 13],
      [[[318, 790], [302, 830], [308, 866]], 11],
      [[[432, 796], [450, 840], [446, 876]], 11],
      [[[482, 764], [508, 812], [524, 848]], 10],
      [[[372, 806], [378, 846], [370, 882]], 9],
    ]) {
      ctx.save()
      ctx.globalAlpha = 0.7
      strand(ctx, pts, w, 0.5, SRC.robe(0.28))
      ctx.restore()
    }
  }

  // ---- thorn-antler epaulettes rooted in gold filigree --------------------
  const thornBurst = (bx, by, a0, a1, n, maxL) => {
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1)
      const ang = a0 + (a1 - a0) * t + (rnd() - 0.5) * 0.18
      const len = maxL * (0.4 + 0.6 * Math.sin(t * Math.PI)) * (0.75 + rnd() * 0.5)
      const x = bx + (rnd() - 0.5) * 20, y = by + (rnd() - 0.5) * 12
      horn(ctx, x, y, ang, len, 8 + rnd() * 3.5, (rnd() - 0.5) * 1.2, SRC.thorn, { tipT: 0.75 })
      if (rnd() < 0.7) horn(ctx, x + Math.cos(ang) * len * 0.45, y + Math.sin(ang) * len * 0.45, ang - 0.8 + rnd() * 1.6, len * 0.32, 5.5, (rnd() - 0.5) * 0.8, SRC.thorn, {})
    }
    // gold filigree root cluster
    for (let i = 0; i < 4; i++) {
      const a = a0 + (a1 - a0) * (i / 3) + 0.35
      strand(ctx, [[bx, by + 6], [bx + Math.cos(a) * 14, by + 6 + Math.sin(a) * 12], [bx + Math.cos(a + 0.6) * 24, by + 8 + Math.sin(a + 0.6) * 20]],
        4.5, 1, SRC.gold(0.55 + rnd() * 0.25, 0.95))
    }
    for (let i = 0; i < 3; i++) {
      const x = bx - 10 + i * 10, y = by + 10 + (rnd() - 0.5) * 4
      ctx.fillStyle = SRC.gold(0.4)
      ctx.beginPath(); ctx.arc(x, y, 3.4, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = SRC.gold(0.9, 0.9)
      ctx.beginPath(); ctx.arc(x - 1.1, y - 1.2, 1.4, 0, Math.PI * 2); ctx.fill()
    }
  }
  thornBurst(320, 226, -3.0, -1.8, 8, 84)
  thornBurst(446, 232, -1.3, -0.1, 8, 80)

  // ---- reaching arm (screen-left): draped blue-silk sleeve + dark claw ----
  {
    // sleeve silhouette: shoulder → forearm, flaring into a bell cuff
    const sleeve = spline([
      [326, 292], [262, 302], [200, 322], [154, 348], [128, 378],
      [134, 404], [168, 414], [216, 404], [262, 386], [306, 360], [336, 330],
    ], true)
    ctx.fillStyle = lin(ctx, 320, 310, 150, 400, [[0, SRC.teal(0.26)], [0.55, SRC.teal(0.14)], [1, SRC.teal(0.05)]])
    ctx.fill(sleeve)
    shadeIn(ctx, sleeve, () => {
      // one broad lit silk band along the top, deep shadow beneath — grouped
      // values, not stripes
      strand(ctx, [[322, 302], [248, 318], [178, 352], [140, 384]], 20, 9, SRC.teal(0.52, 0.9))
      strand(ctx, [[320, 298], [252, 314], [186, 346]], 7, 2.5, SRC.teal(0.88, 0.75))
      strand(ctx, [[312, 330], [256, 352], [196, 384], [160, 404]], 22, 10, SRC.robe(0.1, 0.75))
      strand(ctx, [[316, 318], [260, 338], [198, 370]], 8, 3, SRC.teal(0.24, 0.7))
      // two short crossing wrinkles where the elbow bends
      strand(ctx, [[252, 322], [240, 344], [236, 366]], 5, 1.5, SRC.teal(0.66, 0.5))
      strand(ctx, [[212, 340], [204, 362], [206, 382]], 4.5, 1.5, SRC.robe(0.06, 0.6))
      // sheen kiss on the upper forearm + deep shadow in the cuff mouth
      puff(ctx, 214, 348, 42, SRC.teal(0.72), 0.24, 26, -0.35)
      puff(ctx, 146, 392, 30, SRC.robe(0.02), 0.7, 22)
      puff(ctx, 300, 330, 44, SRC.robe(0.06), 0.4)
    })
    // gold thread along the cuff lip + bead line down the sleeve's lower edge
    strand(ctx, [[132, 372], [126, 392], [140, 408]], 4, 1.5, SRC.gold(0.66, 0.9))
    walk([[176, 410], [226, 402], [278, 380], [318, 352]], 17, (p) => {
      ctx.fillStyle = SRC.gold(0.35)
      ctx.beginPath(); ctx.arc(p[0], p[1], 3.1, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = SRC.gold(0.85, 0.9)
      ctx.beginPath(); ctx.arc(p[0] - 1, p[1] - 1.1, 1.3, 0, Math.PI * 2); ctx.fill()
    })
    // dark gauntlet claw emerging from the cuff — heavy knuckles, hooked talons
    const palm = spline([[132, 384], [104, 392], [88, 414], [102, 442], [138, 442], [156, 414]], true)
    ctx.fillStyle = lin(ctx, 140, 390, 96, 440, [[0, SRC.glove(0.55)], [1, SRC.glove(0.12)]])
    ctx.fill(palm)
    shadeIn(ctx, palm, () => {
      puff(ctx, 116, 402, 16, SRC.glove(0.8), 0.5, 11, -0.4)
      puff(ctx, 118, 432, 18, SRC.glove(0.02), 0.6)
    })
    for (const [ang, l, w] of [[2.1, 52, 16], [1.78, 64, 17], [1.45, 58, 16], [1.12, 46, 14]]) {
      const bx = 112 + Math.cos(ang - 1.55) * 20, by = 420 + Math.sin(ang - 1.55) * 10
      const tipx = bx + Math.cos(ang + 0.5) * l, tipy = by + Math.sin(ang + 0.5) * l
      strand(ctx, [[bx, by], [bx + Math.cos(ang) * l * 0.55, by + Math.sin(ang) * l * 0.55], [tipx, tipy]], w, 2, SRC.glove(0.3, 0.97))
      strand(ctx, [[bx - 3, by - 3], [bx + Math.cos(ang) * l * 0.5 - 3, by + Math.sin(ang) * l * 0.5 - 2], [tipx - 2, tipy]], 4.5, 0.7, SRC.skin(0.55, 0.5))
      puff(ctx, bx, by, 8, SRC.skin(0.42), 0.5)
      // pale talon hook
      horn(ctx, tipx, tipy, ang + 0.6, 16, 6, 0.35, SRC.skin, { rootT: 0.2, midT: 0.45, tipT: 0.85 })
    }
    horn(ctx, 96, 446, 2.0, 28, 10, 0.35, SRC.glove, {})
    // thin tendrils trailing off the sleeve into the fog
    strand(ctx, [[188, 412], [158, 462], [146, 520]], 5, 0.5, SRC.robe(0.2, 0.8))
    strand(ctx, [[232, 406], [212, 458], [208, 506]], 4, 0.5, SRC.robe(0.24, 0.7))
    // pauldron dome — silk sheen capped, gold-rimmed, occluded beneath
    const pd = spline([[272, 256], [318, 244], [354, 258], [362, 292], [340, 320], [296, 324], [264, 296]], true)
    ctx.fillStyle = lin(ctx, 290, 246, 340, 326, [[0, SRC.teal(0.5)], [0.5, SRC.teal(0.26)], [1, SRC.robe(0.14)]])
    ctx.fill(pd)
    shadeIn(ctx, pd, () => {
      strand(ctx, [[278, 268], [312, 252], [350, 268]], 6, 2.5, SRC.teal(0.82, 0.7))
      strand(ctx, [[272, 292], [310, 278], [352, 292]], 4, 2, SRC.teal(0.6, 0.5))
      puff(ctx, 330, 310, 30, SRC.robe(0.03), 0.6)
    })
    strand(ctx, [[268, 300], [302, 320], [346, 314]], 5.5, 2.5, SRC.gold(0.72, 0.9))
    for (const [x, y, a] of [[284, 252, -2.35], [312, 244, -1.95], [340, 252, -1.55]]) {
      horn(ctx, x, y, a, 24, 7, -0.2, SRC.gold, {})
    }
  }

  // ---- head: tiny, gaunt, swallowed by hair and beard ---------------------
  {
    // high dark collar behind the head, gold edge
    const collar = spline([[336, 216], [350, 176], [384, 160], [420, 172], [438, 208], [430, 248], [352, 250]], true)
    ctx.fillStyle = lin(ctx, 380, 164, 390, 250, [[0, SRC.robe(0.42)], [1, SRC.robe(0.1)]])
    ctx.fill(collar)
    strand(ctx, [[344, 200], [362, 172], [392, 162]], 3, 1, SRC.gold(0.5, 0.6))
    // gaunt sage skull, tilted down toward the party — mostly LIT pale
    const head = spline([[354, 188], [378, 176], [402, 184], [412, 208], [404, 232], [382, 244], [360, 234], [346, 210]], true)
    ctx.fillStyle = lin(ctx, 354, 180, 406, 240, [[0, SRC.skin(0.85)], [0.55, SRC.skin(0.6)], [1, SRC.skin(0.34)]])
    ctx.fill(head)
    shadeIn(ctx, head, () => {
      // crown + cheekbone catch the backlight
      puff(ctx, 366, 188, 16, SRC.skin(0.98), 0.6, 11, -0.5)
      puff(ctx, 372, 224, 12, SRC.skin(0.88), 0.5, 8)
      puff(ctx, 398, 222, 10, SRC.skin(0.8), 0.4, 7)
      // the brow-band: a narrow strip of shadow drowning the eyes
      strand(ctx, [[352, 205], [378, 200], [406, 206]], 8, 5.5, 'rgba(22,26,20,0.8)')
      // cold glint in the near socket
      ctx.fillStyle = 'rgba(222,242,228,0.9)'
      ctx.beginPath()
      ctx.arc(393, 205, 1.7, 0, Math.PI * 2)
      ctx.fill()
      // hooked nose ridge catching light + nostril shade
      strand(ctx, [[394, 206], [403, 218], [401, 228]], 4, 2, SRC.skin(0.95, 0.85))
      puff(ctx, 398, 231, 5, SRC.skin(0.1), 0.6)
      // sunken cheek crease
      strand(ctx, [[380, 216], [376, 226], [378, 234]], 3, 1.5, SRC.skin(0.16, 0.5))
    })
    // thin angry brows sloping in toward the nose
    strand(ctx, [[356, 198], [370, 197], [380, 202]], 3.2, 0.8, SRC.beard(0.78, 0.9))
    strand(ctx, [[388, 201], [398, 196], [407, 199]], 3.2, 0.8, SRC.beard(0.76, 0.9))
    // hair: modest swept-back silver crest, strands flowing to the nape (left)
    const hairBase = spline([[348, 196], [354, 174], [372, 162], [396, 160], [414, 170], [422, 188], [412, 198], [396, 186], [376, 180], [360, 188]], true)
    ctx.fillStyle = lin(ctx, 364, 162, 414, 196, [[0, SRC.beard(0.84)], [0.6, SRC.beard(0.6)], [1, SRC.beard(0.36)]])
    ctx.fill(hairBase)
    shadeIn(ctx, hairBase, () => {
      puff(ctx, 374, 168, 17, SRC.beard(0.96), 0.5, 11, -0.4)
      puff(ctx, 412, 190, 14, SRC.beard(0.2), 0.5)
    })
    for (let i = 0; i < 11; i++) {
      const t = i / 10
      const bx = 396 - t * 40, by = 164 + Math.sin(t * 2.4) * 5
      const ang = 2.75 + t * 0.35 + (rnd() - 0.5) * 0.2   // sweeping back over the crown to the nape
      const l = 20 + rnd() * 16
      strand(ctx, [
        [bx, by],
        [bx + Math.cos(ang) * l * 0.6, by + Math.sin(ang) * l * 0.6],
        [bx + Math.cos(ang + 0.3) * l, by + Math.sin(ang + 0.3) * l],
      ], 5, 0.7, SRC.beard(0.42 + 0.45 * (1 - t) + (rnd() - 0.5) * 0.14, 0.95))
    }
    // flyaway crown wisps against the fog
    for (const [a, l] of [[-2.5, 24], [-2.15, 30], [-2.8, 19]]) {
      strand(ctx, [[370, 164], [370 + Math.cos(a) * l * 0.6, 164 + Math.sin(a) * l * 0.6], [366 + Math.cos(a - 0.4) * l, 162 + Math.sin(a - 0.4) * l]],
        3.5, 0.4, SRC.beard(0.8, 0.85))
    }
  }

  // ---- THE BEARD — the brightest mass on the highland stage ---------------
  {
    // chin → chest → bulge right at mid-height → cascade down-left to points
    const spinePts = [
      [378, 244], [366, 306], [372, 382], [396, 464], [438, 546],
      [492, 618], [540, 682], [556, 748], [536, 820], [492, 878],
    ]
    const wProf = (t) => 30 + 124 * Math.sin(Math.min(1, t * 1.12 + 0.06) * Math.PI) * (1 - t * 0.3)
    const base = ribbon(spinePts, (t) => wProf(t) / 2)
    // under-layer shadow mass offset right-down — a full value step deeper
    ctx.save()
    ctx.translate(15, 10)
    ctx.fillStyle = SRC.beard(0.05, 0.92)
    ctx.fill(base)
    ctx.restore()
    ctx.fillStyle = lin(ctx, 380, 240, 560, 840, [
      [0, SRC.beard(0.74)], [0.38, SRC.beard(0.6)], [0.72, SRC.beard(0.42)], [1, SRC.beard(0.24)],
    ])
    ctx.fill(base)
    // ragged edge lobes so the mass reads as hair, not a tusk — lit lobes
    // hotter, shadow lobes deeper (the dragon-repaint tonal range)
    for (let i = 0; i < 34; i++) {
      const t = 0.06 + rnd() * 0.88
      const a = along(spinePts, t)
      const sgn = rnd() < 0.55 ? -1 : 1
      const w = wProf(t) * 0.5
      const bx = a.x + a.nx * w * sgn * 0.96, by = a.y + a.ny * w * sgn * 0.96
      const ang = Math.atan2(a.ty, a.tx) + sgn * -0.5 + (rnd() - 0.5) * 0.5
      const l = 18 + rnd() * 34
      strand(ctx, [
        [bx - a.tx * l * 0.4, by - a.ty * l * 0.4], [bx, by],
        [bx + Math.cos(ang) * l * 0.7, by + Math.sin(ang) * l * 0.7],
        [bx + Math.cos(ang + sgn * 0.4) * l, by + Math.sin(ang + sgn * 0.4) * l],
      ], l * 0.42, 0.6, SRC.beard(sgn < 0 ? 0.62 + rnd() * 0.33 : 0.12 + rnd() * 0.22, 0.95))
    }
    shadeIn(ctx, base, () => {
      walk(spinePts, 26, (p, tg, n, tt) => {
        const w = wProf(tt) * 0.5
        puff(ctx, p[0] - n[0] * w * 0.55, p[1] - n[1] * w * 0.55, w, SRC.beard(0.95), 0.34, w * 0.75)
        puff(ctx, p[0] + n[0] * w * 0.55, p[1] + n[1] * w * 0.55, w, SRC.beard(0.04), 0.46, w * 0.75)
      })
      puff(ctx, 398, 330, 70, SRC.beard(0.98), 0.32, 46, 0.45)
      puff(ctx, 508, 640, 82, SRC.beard(0.88), 0.26, 60, 0.6)
      // crisp core-shadow seam down the robe-side flank — the beard TURNS
      const coreS = []
      for (let k = 0; k <= 6; k++) {
        const t = 0.06 + (k / 6) * 0.86
        const a = along(spinePts, t)
        const w = wProf(t) * 0.5
        coreS.push([a.x + a.nx * w * 0.66, a.y + a.ny * w * 0.66])
      }
      strand(ctx, coreS, 34, 12, SRC.beard(0.08, 0.6))
      strand(ctx, coreS.map((p) => [p[0] - 9, p[1] - 6]), 13, 5, SRC.beard(0.24, 0.45))
      // rope-locks: FEW wide 3-tone bands that drift across the flow, so the
      // mass reads as heavy crossing locks, not combed fibre
      for (let i = 0; i < 12; i++) {
        const off0 = -1 + (i / 11) * 2 + (rnd() - 0.5) * 0.2
        const off1 = off0 + (rnd() - 0.5) * 0.9
        const s0 = Math.max(0, rnd() * 0.28 - 0.05)
        const s1 = Math.min(1, s0 + 0.5 + rnd() * 0.5)
        const phase = rnd() * 6.28
        const amp = 6 + rnd() * 10
        const pts = []
        for (let k = 0; k <= 6; k++) {
          const u = k / 6
          const t = s0 + (s1 - s0) * u
          const a = along(spinePts, t)
          const w = wProf(t) * 0.5
          const off = off0 + (off1 - off0) * u
          const wob = Math.sin(t * 7.5 + phase) * amp
          pts.push([a.x + a.nx * (off * w * 0.88 + wob), a.y + a.ny * (off * w * 0.88 + wob)])
        }
        const w0 = 17 + rnd() * 21
        const bright = 0.24 + 0.66 * Math.max(0, -(off0 + off1) * 0.42) + (rnd() - 0.5) * 0.24
        strand(ctx, pts.map((p) => [p[0] + 5, p[1] + 4]), w0 * 1.1, w0 * 0.38, SRC.beard(Math.max(0.03, bright - 0.34), 0.94))
        strand(ctx, pts, w0, w0 * 0.32, SRC.beard(Math.max(0.05, Math.min(0.88, bright)), 0.95))
        strand(ctx, pts.map((p) => [p[0] - 4, p[1] - 3]), w0 * 0.36, w0 * 0.12, SRC.beard(Math.min(0.98, bright + 0.34), 0.88))
      }
      // fine flyover strands
      for (let i = 0; i < 90; i++) {
        const off = (rnd() - 0.5) * 1.9
        const s0 = rnd() * 0.55
        const s1 = Math.min(1, s0 + 0.2 + rnd() * 0.4)
        const pts = []
        const phase = rnd() * 6.28
        const amp = 4 + rnd() * 9
        for (let k = 0; k <= 5; k++) {
          const t = s0 + ((s1 - s0) * k) / 5
          const a = along(spinePts, t)
          const w = wProf(t) * 0.5
          const wob = Math.sin(t * 10 + phase) * amp
          pts.push([a.x + a.nx * (off * w * 0.92 + wob), a.y + a.ny * (off * w * 0.92 + wob)])
        }
        const bright = 0.28 + 0.58 * Math.max(0, -off * 0.85) + (rnd() - 0.5) * 0.34
        ctx.globalAlpha = 0.3 + rnd() * 0.35
        strand(ctx, pts, 2 + rnd() * 3.4, 0.4, SRC.beard(Math.max(0.03, Math.min(0.97, bright))))
      }
      ctx.globalAlpha = 1
      // carved dark partings — DEEP valleys between rope-locks
      for (let i = 0; i < 13; i++) {
        const off = (rnd() - 0.5) * 1.5
        const s0 = 0.06 + rnd() * 0.32
        const s1 = Math.min(1, s0 + 0.4 + rnd() * 0.35)
        const pts = []
        for (let k = 0; k <= 4; k++) {
          const t = s0 + ((s1 - s0) * k) / 4
          const a = along(spinePts, t)
          const w = wProf(t) * 0.5
          pts.push([a.x + a.nx * off * w * 0.85 + Math.sin(t * 9 + i) * 5, a.y + a.ny * off * w * 0.85])
        }
        strand(ctx, pts, 9, 0.8, SRC.beard(0.02, 0.72))
        strand(ctx, pts.map((p) => [p[0] - 4, p[1] - 3]), 3, 0.5, SRC.beard(0.85, 0.4))
      }
    })
    // breakaway locks whipping off the right bulge
    for (const [bx, by, ang, l, w] of [
      [560, 560, 0.35, 96, 12], [572, 636, 0.55, 108, 13],
      [566, 700, 0.8, 88, 11], [540, 500, 0.2, 76, 10],
    ]) {
      strand(ctx, [
        [bx - 46, by - 10], [bx, by],
        [bx + Math.cos(ang) * l * 0.55, by + Math.sin(ang) * l * 0.55],
        [bx + Math.cos(ang + 0.5) * l, by + Math.sin(ang + 0.5) * l],
      ], w, 0.8, SRC.beard(0.4 + rnd() * 0.3, 0.94))
      strand(ctx, [
        [bx - 30, by - 8], [bx + 4, by - 3],
        [bx + Math.cos(ang - 0.06) * l * 0.5, by + Math.sin(ang - 0.06) * l * 0.5 - 3],
        [bx + Math.cos(ang + 0.44) * l * 0.9, by + Math.sin(ang + 0.44) * l * 0.9],
      ], w * 0.35, 0.4, SRC.beard(0.74 + rnd() * 0.2, 0.85))
    }
    // tip cascade: tapering locks streaming down-left INTO the fog band —
    // they shred and dissolve there, never reaching for the stage
    for (const [ang, l, w] of [[2.25, 92, 14], [2.5, 74, 12], [2.05, 106, 15], [2.7, 58, 10], [1.9, 84, 12]]) {
      const bx = 512 + (rnd() - 0.5) * 40, by = 796 + (rnd() - 0.5) * 26
      strand(ctx, [
        [bx + 30, by - 40], [bx, by],
        [bx + Math.cos(ang) * l * 0.55, by + Math.sin(ang) * l * 0.55],
        [bx + Math.cos(ang + 0.25) * l, by + Math.sin(ang + 0.25) * l],
      ], w, 0.6, SRC.beard(0.34 + rnd() * 0.34, 0.92))
      strand(ctx, [
        [bx + 24, by - 36], [bx + 2, by - 4],
        [bx + Math.cos(ang - 0.05) * l * 0.5, by + Math.sin(ang - 0.05) * l * 0.5 - 2],
        [bx + Math.cos(ang + 0.2) * l * 0.9, by + Math.sin(ang + 0.2) * l * 0.9],
      ], w * 0.35, 0.4, SRC.beard(0.72 + rnd() * 0.22, 0.8))
    }
    // moustache: face reads 3/4-right — long dominant swoop down-right past
    // the cheek, shorter companion falling left of the chin
    strand(ctx, [[392, 228], [408, 244], [416, 272], [410, 304], [398, 326]], 8.5, 1, SRC.beard(0.88, 0.97))
    strand(ctx, [[390, 232], [402, 250], [406, 278], [400, 302]], 3.5, 0.6, SRC.beard(0.96, 0.85))
    strand(ctx, [[372, 230], [362, 250], [358, 278], [362, 302]], 7, 1, SRC.beard(0.78, 0.95))
    // sideburn strands tying the beard into the hair
    strand(ctx, [[352, 216], [356, 242], [366, 272]], 7, 1, SRC.beard(0.7, 0.9))
    strand(ctx, [[404, 214], [402, 242], [398, 270]], 7, 1, SRC.beard(0.6, 0.9))
    // drooping wisps down the left flank + dark partings off the chin
    for (const [bx, by, ang, l] of [
      [354, 296, 2.05, 38], [348, 348, 2.15, 46], [346, 402, 2.25, 40],
      [352, 454, 2.3, 44], [368, 506, 2.4, 34],
    ]) {
      strand(ctx, [
        [bx + 10, by - 14], [bx, by],
        [bx + Math.cos(ang) * l * 0.6, by + Math.sin(ang) * l * 0.6],
        [bx + Math.cos(ang + 0.3) * l, by + Math.sin(ang + 0.3) * l],
      ], l * 0.22, 0.5, SRC.beard(0.4 + rnd() * 0.25, 0.85))
    }
    strand(ctx, [[368, 262], [362, 310], [366, 360]], 5.5, 1, SRC.beard(0.1, 0.55))
    strand(ctx, [[398, 268], [402, 316], [396, 366]], 5, 1, SRC.beard(0.12, 0.5))
    // flyaway wisps drifting off into the wind
    for (let i = 0; i < 8; i++) {
      const by = 280 + i * 34 + rnd() * 12
      strand(ctx, [[380, by], [346 - i * 3, by + 20], [316 - i * 6, by + 26 + rnd() * 12]], 2.8, 0.3, SRC.beard(0.6, 0.7))
    }
  }

  // ---- emerald brooch at the collar ---------------------------------------
  {
    puff(ctx, 408, 292, 13, 'rgba(47,191,143,1)', 0.5)
    ctx.fillStyle = '#0d3f30'
    ctx.beginPath(); ctx.arc(408, 292, 6.8, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#2fbf8f'
    ctx.beginPath(); ctx.arc(408, 292, 4.8, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#aef2d8'
    ctx.beginPath(); ctx.arc(406, 290, 1.9, 0, Math.PI * 2); ctx.fill()
  }

  // ---- the staff: gnarled oxblood diagonal with a crescent head -----------
  {
    const top = [608, 46], tip = [406, 944]
    const P = (t) => [top[0] + (tip[0] - top[0]) * t, top[1] + (tip[1] - top[1]) * t]
    // raised arm: blue-silk sleeve reaching from the mantle to the grip
    const g = P(0.255)
    strand(ctx, [[468, 248], [508, 246], [g[0] - 6, g[1] - 12]], 30, 15, SRC.robe(0.24, 0.98))
    strand(ctx, [[470, 240], [512, 238], [g[0] - 8, g[1] - 20]], 9, 3.5, SRC.teal(0.55, 0.6))
    strand(ctx, [[476, 236], [516, 234], [g[0] - 6, g[1] - 24]], 4, 1.5, SRC.teal(0.85, 0.45))
    // gold cuff beads at the wrist
    walk([[g[0] - 22, g[1] - 6], [g[0] - 12, g[1] + 4]], 8, (p) => {
      ctx.fillStyle = SRC.gold(0.5)
      ctx.beginPath(); ctx.arc(p[0], p[1], 2.6, 0, Math.PI * 2); ctx.fill()
    })
    // shaft
    const pts = []
    for (let k = 0; k <= 16; k++) {
      const t = k / 16
      const p = P(t)
      pts.push([p[0] + Math.sin(t * 25 + 1.7) * 2.6, p[1]])
    }
    strand(ctx, pts, 13, 9, SRC.staff(0.24))
    strand(ctx, pts.map((p) => [p[0] + 3, p[1]]), 6, 4, SRC.staff(0.08, 0.9))
    strand(ctx, pts.map((p) => [p[0] - 3.6, p[1]]), 2.4, 1.6, SRC.staff(0.78, 0.85))
    for (const t of [0.16, 0.31, 0.47, 0.62, 0.78, 0.9]) {
      const p = P(t)
      puff(ctx, p[0] + Math.sin(t * 40) * 2, p[1], 7, SRC.staff(0.5), 0.6, 5)
      puff(ctx, p[0] - 2.5, p[1] - 2, 2.6, SRC.staff(0.9), 0.55)
    }
    // (no heel ferrule — the staff's lower reach dissolves in the fog band)
    // head: gold collar + one heavy crescent blade, crimson-edged
    const p0 = P(0.05)
    strand(ctx, [[p0[0] - 8, p0[1] + 12], [p0[0], p0[1] + 7], [p0[0] + 8, p0[1] + 3]], 10, 6, SRC.gold(0.55, 0.95))
    const cres = spline([
      [p0[0] - 4, p0[1] + 2], [p0[0] - 28, p0[1] - 16], [p0[0] - 38, p0[1] - 42],
      [p0[0] - 24, p0[1] - 66], [p0[0] + 4, p0[1] - 76], [p0[0] - 2, p0[1] - 58],
      [p0[0] - 11, p0[1] - 40], [p0[0] - 4, p0[1] - 18],
    ], true)
    ctx.fillStyle = lin(ctx, p0[0] - 34, p0[1] - 64, p0[0], p0[1], [[0, SRC.staff(0.72)], [0.55, SRC.staff(0.4)], [1, SRC.staff(0.16)]])
    ctx.fill(cres)
    shadeIn(ctx, cres, () => {
      strand(ctx, [[p0[0] - 32, p0[1] - 18], [p0[0] - 40, p0[1] - 42], [p0[0] - 26, p0[1] - 66]], 3.5, 1.5, SRC.staff(0.95, 0.9))
      puff(ctx, p0[0] - 20, p0[1] - 36, 17, SRC.staff(0.06), 0.6)
    })
    horn(ctx, p0[0] + 2, p0[1] - 2, -0.35, 32, 10, 0.6, SRC.staff, {})       // counter-prong
    horn(ctx, p0[0] + 1, p0[1] - 8, -1.62, 42, 9, 0.15, SRC.staff, { tipT: 0.95 }) // centre spike
    // gripping claw over the shaft
    const gp = spline([[g[0] - 16, g[1] - 12], [g[0] + 12, g[1] - 16], [g[0] + 20, g[1] + 6], [g[0], g[1] + 18], [g[0] - 18, g[1] + 8]], true)
    ctx.fillStyle = lin(ctx, g[0] - 12, g[1] - 12, g[0] + 12, g[1] + 14, [[0, SRC.glove(0.5)], [1, SRC.glove(0.12)]])
    ctx.fill(gp)
    for (let i = 0; i < 4; i++) {
      const fy = g[1] - 11 + i * 8.5
      strand(ctx, [[g[0] - 15, fy], [g[0] + 2, fy + 3.5], [g[0] + 16, fy + 1]], 7.5, 3, SRC.glove(0.32 + (i === 1 ? 0.16 : 0), 0.97))
      strand(ctx, [[g[0] - 14, fy - 2], [g[0] + 1, fy + 1], [g[0] + 13, fy - 1.5]], 2.5, 0.8, SRC.skin(0.55, 0.5))
    }
    // a few bright beard wisps crossing back over the staff
    strand(ctx, [[470, 560], [498, 600], [512, 648]], 4, 0.6, SRC.beard(0.78, 0.8))
    strand(ctx, [[452, 470], [474, 520], [480, 566]], 3.5, 0.5, SRC.beard(0.7, 0.75))
  }

  // ---- the fog band eats EVERYTHING below the hem line --------------------
  // One global ragged alpha-dissolve across beard tips, staff heel and robe
  // shreds together: total by y 872, so the silhouette bottom floats ~0.6 m
  // clear of the stage (§1: hem gone by 0.72 fh; §5.2 fog-pool disc belongs
  // to units). No painted pixel may reach the ground.
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  for (let i = 0; i < 26; i++) {
    const x = 150 + rnd() * 470
    puff(ctx, x, 742 + rnd() * 96, 16 + rnd() * 30, 'rgba(0,0,0,1)', 0.25 + rnd() * 0.3)
  }
  ctx.fillStyle = lin(ctx, 0, 768, 0, 872, [[0, 'rgba(0,0,0,0)'], [0.55, 'rgba(0,0,0,0.5)'], [1, 'rgba(0,0,0,1)']])
  ctx.fillRect(0, 768, W, 104)
  ctx.fillStyle = 'rgba(0,0,0,1)'
  ctx.fillRect(0, 872, W, H - 872)
  ctx.restore()

  // ---- fog compression: milk wash thickening toward the hem ---------------
  wash(ctx, () => {
    puff(ctx, 300, 190, 260, 'rgba(201,210,196,1)', 0.09, 210)
    ctx.fillStyle = 'rgba(142,151,141,0.06)'
    ctx.fillRect(0, 0, W, H)
    ctx.fillStyle = lin(ctx, 0, 560, 0, H, [[0, 'rgba(142,151,141,0)'], [1, 'rgba(142,151,141,0.16)']])
    ctx.fillRect(0, 560, W, H - 560)
  })

  // ---- finishing: cool glaze + fog-keyed rim (BIBLE §6) -------------------
  edgeGlaze(canvas, ctx, '#0a0f0d', 4, 0.55, 2)
  edgeGlaze(canvas, ctx, '#060a09', 2, 0.4, 1)
  rimLight(canvas, ctx, '#c8cfc4', LD, 3, 0.7, 1,
    (c) => lin(c, 0, 60, 0, 900, [[0, 'rgba(0,0,0,1)'], [0.55, 'rgba(0,0,0,0.55)'], [1, 'rgba(0,0,0,0.08)']]))
  rimLight(canvas, ctx, '#e6ece2', LD, 1.5, 0.35, 0.5,
    (c) => lin(c, 0, 60, 0, 520, [[0, 'rgba(0,0,0,0.9)'], [1, 'rgba(0,0,0,0)']]))

  return finishArt(canvas, {
    name: 'sorcerer',
    px: 384, py: 500,            // visual mass centre (chest/robe centroid)
    anchor: 'center',
    worldHeight: 6.5,
    floatOffset: 0.6,
    palette: {
      beard: SRC.beard.stops, robe: SRC.robe.stops, teal: SRC.teal.stops,
      wine: SRC.wine.stops, gold: SRC.gold.stops, staff: SRC.staff.stops,
      wing: SRC.wingD.stops, edgeGlaze: '#0a0f0d', rim: '#c8cfc4',
    },
  })
}
