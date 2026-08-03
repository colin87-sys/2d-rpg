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
// THE DRAGON — frame04 hall enemy.
//
// Composition (canvas 1024×896, ground line y = 838, ≈ 130 px/m):
//   · front-loaded cream furred mass; the skull dome rides the breast with a
//     huge yellow eye, a green mohawk crest, and big amber flame-blades
//     raking back along the ridge
//   · dark aubergine hook-beak snout, maw gaping BELOW it at hero eye-line:
//     red interior, white fang rows, plum lower-jaw slab, tongue lolling out
//   · violet sail wings: a draped curtain far-left, a raised pleated sail
//     over the shoulder with a near-black echo wing melting right
//   · the tail: thorned cream rise off the rump rolling into a flattened
//     olive-plated coil framing the top-left, tip flying out with dark fins
//   · torch key upper-right: warm kiss on breast/skull/blades, plum-blue
//     pools swallowing the rump, far wing and loop's lower arc.
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
    root: [432, 606],
    carpal: [252, 468],
    spike: [180, 418],
    tips: [[66, 498], [44, 590], [72, 682], [152, 748], [262, 778]],
    sag: 0.36, jag: 14,
    rampF: DRG.wing, brightT: 0.5, darkT: 0.05,
    clawRamp: DRG.dark,
  })
  // the curtain drowns toward the hall dark at its low tips
  wash(ctx, () => {
    puff(ctx, 120, 700, 240, '#171126', 0.5, 190)
    puff(ctx, 60, 560, 150, '#171126', 0.4)
  })

  // ---- near-black echo wing melting away to the right ---------------------
  drapedWing(ctx, rnd, {
    root: [690, 520],
    carpal: [828, 382],
    tips: [[950, 336], [972, 428], [942, 516]],
    sag: 0.4, jag: 12,
    rampF: DRG.wing, brightT: 0.3, darkT: 0.03, alpha: 0.95,
    claws: false,
  })
  wash(ctx, () => puff(ctx, 950, 430, 170, '#140d1f', 0.55, 150))

  // ---- the tail -----------------------------------------------------------
  // column off the rump → flattened plated coil top-left → tip flying right
  const TAIL = [
    [442, 648], [498, 560], [534, 468], [548, 376], [538, 296],
    [496, 254], [420, 234], [318, 236], [220, 222], [148, 188],
    [104, 138], [150, 90], [246, 68], [352, 76], [436, 108],
    [492, 146], [504, 188],
    [566, 164], [636, 154], [696, 174],
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
    for (const [ang, len, w] of [[-1.5, 66, 26], [-0.85, 84, 34], [-0.2, 96, 40], [0.5, 78, 32]]) {
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
    for (const [sx, sy, ex, ey] of [[684, 202, 656, 372], [712, 206, 728, 326]]) {
      strand(ctx, [[sx, sy], [(sx + ex) / 2 + 14, (sy + ey) / 2], [ex, ey]], 5, 0.6, DRG.wing(0.12, 0.85))
    }
    paintPlatedTube(slice(16, 19), null, false)
  }
  // dark ragged under-fins hanging off the loop's entry stretch
  for (const [bx, by, ang, len, w] of [[468, 248, 1.65, 70, 30], [414, 244, 1.9, 56, 24]]) {
    const p1 = [bx + Math.cos(ang) * len, by + Math.sin(ang) * len]
    const fin = spline([[bx - w * 0.4, by], [bx + w * 0.5, by + 6], [p1[0] + 6, p1[1] - 8], [p1[0], p1[1]], [p1[0] - 10, p1[1] - 14]], true)
    ctx.fillStyle = lin(ctx, bx, by, p1[0], p1[1], [[0, DRG.wing(0.26)], [1, DRG.wing(0.05)]])
    ctx.fill(fin)
  }
  // the coil — hooks point out from the loop centre
  paintPlatedTube(slice(5, 16), [300, 154])

  // ---- rising tail base over the wing (cream fur → olive plates) ----------
  {
    const C = slice(0, 5)
    ctx.fillStyle = lin(ctx, 466, 650, 552, 260, [
      [0, DRG.hide(0.42)], [0.4, DRG.hide(0.52)], [0.72, DRG.olive(0.4)], [1, DRG.olive(0.3)],
    ])
    ctx.fill(C.shape)
    shadeIn(ctx, C.shape, () => {
      walk(C.spine, 20, (p, tg, n, tt) => {
        const w = tailW(tt * C.t1) * 0.5
        const b = lit(n[0], n[1])
        const col = tt < 0.5 ? DRG.hide : DRG.olive
        puff(ctx, p[0] + n[0] * w * 0.45, p[1] + n[1] * w * 0.45, w * 1.15, col(0.22 + 0.46 * b), 0.32, w * 0.85)
        puff(ctx, p[0] - n[0] * w * 0.5, p[1] - n[1] * w * 0.5, w, col(0.1), 0.36, w * 0.8)
      })
      fur(ctx, rnd, C.shape, [408, 380, 600, 690], {
        count: 300,
        angleAt: (x, y) => Math.atan2(-(x - 470), y - 690) + Math.PI / 2 + 0.3,
        colAt: () => DRG.hide(0.3 + rnd() * 0.42),
        len: [8, 16], width: [1.2, 2.3], alpha: [0.12, 0.24],
      })
    })
    paintPlatedTube(slice(3, 5), null, false)
    // thorn row up the outer (right) edge of the rise
    walk(C.spine, 40, (p, tg, n, tt) => {
      const w = tailW(tt * C.t1) * 0.5
      const ang = Math.atan2(n[1], n[0]) - 0.25
      horn(ctx, p[0] + n[0] * w * 0.7, p[1] + n[1] * w * 0.7, ang, 30 + rnd() * 26, 13 + rnd() * 6, -0.5, DRG.amber, { tipCss: DRG.gold(0.72) })
    })
  }

  // ---- legs first (the body drops over their hips) ------------------------
  // dark raptor limbs, angled back, pale hooked talons (the frame04 read)
  const leg = (hipX, hipY, kneeX, kneeY, footX, wTh, shade) => {
    strand(ctx, [[hipX, hipY], [kneeX, kneeY], [kneeX + 8, (kneeY + GY) / 2 + 8], [footX, GY - 8]], wTh, wTh * 0.44, DRG.dark(0.14 + shade))
    strand(ctx, [[hipX + 8, hipY + 4], [kneeX + 8, kneeY], [footX + 7, GY - 14]], wTh * 0.3, 2.4, DRG.dark(0.45 + shade, 0.75))
    puff(ctx, kneeX, kneeY, wTh * 0.66, DRG.dark(0.55 + shade), 0.5, wTh * 0.48)
    // feathered cuff where the cream thigh meets the dark shank
    for (let i = 0; i < 5; i++) {
      const a = 1.9 + i * 0.22 + (rnd() - 0.5) * 0.15
      strand(ctx, [[hipX + 6, hipY + 8], [hipX + 6 + Math.cos(a) * 20, hipY + 8 + Math.sin(a) * 20], [hipX + 4 + Math.cos(a + 0.3) * 36, hipY + 10 + Math.sin(a + 0.3) * 36]],
        9, 0.8, DRG.hide(0.3 + shade * 1.2 + rnd() * 0.25, 0.9))
    }
    // foot pad
    strand(ctx, [[footX - 12, GY - 10], [footX + 6, GY - 6], [footX + 24, GY - 6]], wTh * 0.62, wTh * 0.42, DRG.dark(0.2 + shade))
    // pale talons — the bright accent that reads at distance
    for (const [dx, l, aa] of [[26, 25, 0.62], [11, 28, 0.8], [-4, 24, 1.0]]) {
      horn(ctx, footX + dx, GY - 9, aa, l, 9.5, 0.55, DRG.tooth, { rootT: 0.3, midT: 0.6, tipT: 0.95 })
    }
    horn(ctx, footX - 17, GY - 12, 2.5, 16, 7, 0.3, DRG.tooth, { rootT: 0.25, midT: 0.5, tipT: 0.8 })
    // warm torch kiss down the shin front
    strand(ctx, [[kneeX + 10, kneeY + 6], [kneeX + 12, (kneeY + GY) / 2], [footX + 12, GY - 12]], 3.5, 1.2, 'rgba(231,160,106,0.4)')
  }
  leg(520, 700, 496, 766, 484, 27, -0.04)          // hind leg, deep shadow
  leg(676, 704, 646, 770, 632, 30, 0)              // far foreleg
  // near foreleg painted after the body

  // ---- the body: one front-loaded cream mass ------------------------------
  const bodyPts = [
    [770, 552], [822, 585], [850, 630], [854, 678], [832, 722],   // breast front
    [782, 748], [716, 758], [640, 756], [560, 742], [492, 716],   // belly line
    [444, 678], [420, 634], [424, 592], [458, 560], [520, 538],   // rump → back
    [600, 524], [684, 524], [736, 534],
  ]
  const body = spline(bodyPts, true)
  {
    ctx.fillStyle = lin(ctx, 810, 560, 440, 740, [
      [0, DRG.hide(0.74)], [0.4, DRG.hide(0.54)], [0.75, DRG.hide(0.34)], [1, DRG.hide(0.2)],
    ])
    ctx.fill(body)
    shadeIn(ctx, body, () => {
      // volumes: bright breast, mid back, dark rump + under-shadow
      puff(ctx, 792, 626, 128, DRG.hide(0.92), 0.42, 108, -0.35)
      puff(ctx, 690, 566, 95, DRG.hide(0.76), 0.3, 60, 0.1)
      puff(ctx, 466, 660, 124, DRG.hide(0.1), 0.55, 98)
      puff(ctx, 620, 732, 170, DRG.hide(0.07), 0.55, 60)
      puff(ctx, 540, 580, 70, DRG.hide(0.4), 0.3)
      puff(ctx, 688, 598, 62, DRG.hide(0.16), 0.32, 46, 0.5)   // wing-root shade
      // dense fur coat, brighter strokes clustering up-right
      fur(ctx, rnd, body, [420, 524, 856, 760], {
        count: 1700,
        angleAt: (x, y) => Math.atan2(y - 645, x - 640) + Math.PI / 2 + 0.55,
        colAt: (x, y) => {
          const nx = (x - 640) / 210, ny = (y - 645) / 118
          return DRG.hide(0.24 + 0.56 * lit(nx, ny) + (rnd() - 0.5) * 0.3)
        },
        len: [8, 19], width: [1.4, 2.9], alpha: [0.1, 0.26], curl: 0.8,
      })
      // belly plates: broad low-contrast arcs hugging the underside
      const arcPts = [[500, 718], [566, 742], [644, 752], [722, 752], [794, 734], [836, 704]]
      for (let i = arcPts.length - 2; i >= 0; i--) {
        const a = arcPts[i], b = arcPts[i + 1]
        const cxm = (a[0] + b[0]) / 2, cym = (a[1] + b[1]) / 2
        const seg = spline([[a[0], a[1] - 14], [cxm, cym - 20], [b[0], b[1] - 14], [cxm, cym + 6]], true)
        ctx.save()
        ctx.globalAlpha = 0.45
        ctx.fillStyle = DRG.belly(0.32 + 0.1 * i)
        ctx.fill(seg)
        ctx.restore()
        shadeIn(ctx, seg, () => {
          strand(ctx, [[a[0], a[1] - 12], [cxm, cym - 17], [b[0], b[1] - 12]], 3, 2, DRG.belly(0.68, 0.3))
          puff(ctx, cxm, cym + 2, 18, DRG.belly(0.04), 0.35, 9)
        })
      }
      // warm torch bounce climbing the breast
      puff(ctx, 832, 636, 95, 'rgba(231,160,106,1)', 0.22, 125, 0.4)
    })
    // fluffy rim so the silhouette reads furred, not vector-smooth
    fluffEdge(ctx, rnd, [...bodyPts, bodyPts[0]], 17, {
      size: [7, 16],
      leanFn: (p, n) => Math.atan2(n[1], n[0]) + 0.5,
      colFn: (p) => DRG.hide(0.18 + 0.58 * lit((p[0] - 640) / 210, (p[1] - 645) / 118) + (rnd() - 0.5) * 0.15, 0.95),
    })
  }

  // ---- near wing: pleated sail raised over the shoulder -------------------
  drapedWing(ctx, rnd, {
    root: [648, 552],
    carpal: [762, 322],
    spike: [800, 238],
    tips: [[866, 296], [908, 372], [922, 462], [886, 548]],
    sag: 0.42, jag: 12,
    rampF: DRG.wing, brightT: 0.68, darkT: 0.08,
    clawRamp: DRG.dark,
    sheen: () => {
      puff(ctx, 806, 388, 64, DRG.wing(0.9), 0.4, 44, -0.85)
      puff(ctx, 768, 472, 50, DRG.wing(0.74), 0.28, 34, -0.6)
      // hot torch line down the leading fold
      strand(ctx, [[770, 330], [800, 258], [806, 246]], 4, 1.5, 'rgba(255,190,140,0.5)')
    },
  })

  // ---- near foreleg over the body -----------------------------------------
  leg(756, 690, 736, 766, 722, 33, 0.12)

  // ---- green rump ruff ----------------------------------------------------
  for (let i = 0; i < 14; i++) {
    const bx = 424 + rnd() * 62, by = 586 + rnd() * 72
    const ang = -2.5 + (rnd() - 0.5) * 0.7
    const l = 26 + rnd() * 30
    strand(ctx, [
      [bx + 14, by + 6], [bx, by],
      [bx + Math.cos(ang) * l * 0.6, by + Math.sin(ang) * l * 0.6],
      [bx + Math.cos(ang - 0.6) * l, by + Math.sin(ang - 0.6) * l],
    ], 9, 0.8, DRG.mane(0.12 + rnd() * 0.5, 0.9))
  }

  // ---- THE HEAD -----------------------------------------------------------
  {
    // big amber flame-blades raking back along the ridge (behind the skull)
    const blades = [
      [700, 560, 88, 22], [664, 556, 64, 16], [624, 552, 96, 24],
      [584, 552, 58, 15], [548, 556, 78, 20],
    ]
    for (const [bx, by, l, w] of blades) {
      horn(ctx, bx, by, -2.42 + (rnd() - 0.5) * 0.12, l, w, -0.34, DRG.amber, { rootT: 0.14, midT: 0.55, tipT: 0.92, tipCss: rnd() < 0.5 ? DRG.gold(0.75) : null })
      if (rnd() < 0.6) horn(ctx, bx + 14, by + 10, -2.15, l * 0.42, w * 0.55, -0.3, DRG.amber, {})
    }
    // small amber under-tufts at the shoulder
    for (let i = 0; i < 4; i++) {
      horn(ctx, 596 + i * 26 + (rnd() - 0.5) * 8, 584 + (rnd() - 0.5) * 8, -2.7 + rnd() * 0.3, 22 + rnd() * 14, 9, -0.3, DRG.amber, {})
    }

    // green mohawk crest over the crown
    for (let i = 0; i < 10; i++) {
      const t = i / 9
      const bx = 812 - t * 100 + (rnd() - 0.5) * 6, by = 552 - Math.sin(t * Math.PI) * 8 + (rnd() - 0.5) * 5
      const ang = -1.95 - t * 0.5 + (rnd() - 0.5) * 0.18
      const l = 24 + 26 * Math.sin(Math.min(1, t * 1.3) * Math.PI) + rnd() * 8
      // dark teal back blade + bright green front blade
      strand(ctx, [
        [bx + 4, by + 4], [bx + Math.cos(ang) * l * 0.55 + 4, by + Math.sin(ang) * l * 0.55 + 3],
        [bx + Math.cos(ang - 0.45) * l + 3, by + Math.sin(ang - 0.45) * l + 2],
      ], 9, 0.8, DRG.mane(0.16 + rnd() * 0.14, 0.95))
      strand(ctx, [
        [bx, by], [bx + Math.cos(ang) * l * 0.55, by + Math.sin(ang) * l * 0.55],
        [bx + Math.cos(ang - 0.45) * l, by + Math.sin(ang - 0.45) * l],
      ], 6.5, 0.7, DRG.mane(0.55 + rnd() * 0.35, 0.95))
    }

    // cream skull dome riding the breast
    const face = spline([
      [712, 568], [762, 546], [812, 546], [846, 560], [862, 584],
      [858, 612], [840, 634], [812, 650], [776, 656], [740, 644], [716, 612],
    ], true)
    ctx.fillStyle = lin(ctx, 786, 548, 858, 648, [[0, DRG.hide(0.9)], [0.55, DRG.hide(0.72)], [1, DRG.hide(0.5)]])
    ctx.fill(face)
    shadeIn(ctx, face, () => {
      puff(ctx, 826, 572, 40, DRG.hide(0.98), 0.5, 28, -0.3)
      puff(ctx, 740, 636, 44, DRG.hide(0.3), 0.44)
      puff(ctx, 816, 638, 28, DRG.hide(0.4), 0.3)
      fur(ctx, rnd, face, [710, 544, 864, 658], {
        count: 220, angleAt: () => 0.3, colAt: () => DRG.hide(0.48 + rnd() * 0.42),
        len: [5, 11], width: [1, 2], alpha: [0.12, 0.22],
      })
    })
    fluffEdge(ctx, rnd, [[712, 568], [716, 612], [740, 644], [776, 656]], 13, {
      size: [6, 11],
      leanFn: () => 2.6,
      colFn: () => DRG.hide(0.42 + rnd() * 0.3, 0.9),
    })

    // ---- aubergine hook-beak — shallow wedge FORWARD of the eye -----------
    const snout = spline([
      [830, 574], [884, 564], [930, 574], [960, 594], [972, 618],
      [966, 644], [948, 668], [934, 670], [928, 654], [900, 642],
      [864, 634], [838, 622], [824, 598],
    ], true)
    ctx.fillStyle = lin(ctx, 876, 572, 956, 664, [[0, DRG.plum(0.56)], [0.5, DRG.plum(0.38)], [1, DRG.plum(0.15)]])
    ctx.fill(snout)
    shadeIn(ctx, snout, () => {
      // glossy lavender spine along the top curve
      strand(ctx, [[842, 580], [898, 572], [944, 590], [964, 616]], 7, 2.5, DRG.plum(0.92, 0.8))
      strand(ctx, [[852, 588], [904, 582], [942, 598]], 3, 1, 'rgba(236,214,232,0.5)')
      // hook shadow + tip depth
      puff(ctx, 950, 654, 26, DRG.plum(0.05), 0.6, 20)
      puff(ctx, 906, 636, 36, DRG.plum(0.1), 0.4)
      // nostril slit
      ctx.fillStyle = DRG.plum(0.04, 0.95)
      ctx.beginPath()
      ctx.ellipse(938, 610, 8, 3.6, 0.5, 0, Math.PI * 2)
      ctx.fill()
      puff(ctx, 934, 606, 7, DRG.plum(0.85), 0.5)
      // wrinkles where beak meets brow
      strand(ctx, [[838, 590], [850, 602], [856, 616]], 2.5, 1, DRG.plum(0.14, 0.5))
      strand(ctx, [[852, 586], [864, 598], [870, 612]], 2.5, 1, DRG.plum(0.14, 0.4))
    })
    // soften the beak→brow seam into the cream
    puff(ctx, 830, 596, 20, DRG.hide(0.78), 0.3, 15, 0.4)

    // ---- maw gaping below the beak, corner far back under the eye ---------
    const maw = spline([
      [806, 646], [862, 656], [912, 668], [938, 682], [912, 706],
      [868, 720], [828, 712], [800, 678],
    ], true)
    ctx.fillStyle = lin(ctx, 862, 656, 856, 722, [[0, DRG.maw(0.1)], [0.5, DRG.maw(0.3)], [1, DRG.maw(0.12)]])
    ctx.fill(maw)
    shadeIn(ctx, maw, () => {
      puff(ctx, 818, 680, 30, DRG.maw(0.03), 0.7)
      puff(ctx, 898, 690, 22, DRG.maw(0.45), 0.4)
    })

    // ---- slim plum lower-jaw jutting forward-down -------------------------
    const jaw = spline([
      [800, 668], [842, 686], [888, 704], [922, 722], [938, 738],
      [930, 752], [904, 750], [862, 734], [824, 708], [796, 682],
    ], true)
    ctx.fillStyle = lin(ctx, 826, 690, 932, 748, [[0, DRG.plum(0.46)], [0.6, DRG.plum(0.26)], [1, DRG.plum(0.1)]])
    ctx.fill(jaw)
    shadeIn(ctx, jaw, () => {
      strand(ctx, [[806, 678], [868, 704], [930, 740]], 5.5, 2.5, DRG.plum(0.76, 0.6))
      puff(ctx, 834, 708, 32, DRG.plum(0.05), 0.5)
      // chin corner highlight
      puff(ctx, 924, 740, 11, DRG.plum(0.68), 0.4)
    })
    // lower fangs rising off the jaw's front lip
    for (const [x, y, ang, l] of [[912, 714, -1.9, 15], [892, 702, -1.8, 12], [872, 692, -1.75, 10], [926, 728, -2.0, 12]]) {
      horn(ctx, x, y, ang, l, 6.5, 0.12, DRG.tooth, {})
    }
    // barbels under the chin
    for (const [x, y, a] of [[916, 746, 1.85], [894, 742, 2.1], [930, 742, 1.55]]) {
      strand(ctx, [[x, y], [x + Math.cos(a) * 10, y + Math.sin(a) * 10], [x + Math.cos(a + 0.4) * 18, y + Math.sin(a + 0.4) * 18]], 4, 0.5, DRG.plum(0.3, 0.9))
    }

    // ---- upper lip band + hanging fang row --------------------------------
    strand(ctx, [[804, 642], [864, 654], [914, 668], [940, 680]], 8, 5, DRG.plum(0.12, 0.95))
    for (let i = 0; i < 7; i++) {
      const t = i / 6
      const x = 816 + t * 104 + (rnd() - 0.5) * 3
      const y = 648 + t * 30
      const big = t > 0.72
      horn(ctx, x, y, 1.45 + t * 0.15, big ? 18 + t * 9 : 10 + 6 * Math.abs(Math.sin(t * 7.1)), big ? 8.5 : 6, 0.15, DRG.tooth, {})
    }
    // the two front hook-fangs under the beak tip
    horn(ctx, 940, 678, 1.6, 23, 9, 0.25, DRG.tooth, { rootT: 0.25, midT: 0.6, tipT: 0.96 })
    horn(ctx, 922, 672, 1.5, 18, 8, 0.2, DRG.tooth, { rootT: 0.25, midT: 0.6, tipT: 0.92 })

    // ---- tongue arcing out just past the chin -----------------------------
    const tPts = [[818, 672], [856, 690], [890, 708], [908, 728], [900, 748], [884, 752]]
    ctx.save()
    strand(ctx, tPts, 15, 6, DRG.tongue(0.4))
    strand(ctx, tPts.map((p) => [p[0] + 2, p[1] + 3]), 7, 3, DRG.tongue(0.12, 0.7))
    strand(ctx, [[822, 670], [858, 686], [890, 704], [904, 722]], 4.5, 2, DRG.tongue(0.8, 0.85))
    puff(ctx, 892, 716, 7, DRG.tongue(0.97), 0.6)
    puff(ctx, 896, 744, 5, DRG.tongue(0.9), 0.5)
    ctx.restore()

    // ---- the eye — big, hot, fierce, set in the cream ---------------------
    puff(ctx, 806, 602, 24, DRG.plum(0.18), 0.35, 16, -0.12)
    const eye = spline([[780, 598], [800, 588], [822, 592], [828, 604], [808, 612], [786, 608]], true)
    ctx.fillStyle = lin(ctx, 784, 592, 826, 610, [[0, '#c9821c'], [0.45, '#f6de6e'], [1, '#e2b62a']])
    ctx.fill(eye)
    shadeIn(ctx, eye, () => {
      // upper lid shadow across the gold
      strand(ctx, [[780, 596], [804, 588], [828, 598]], 5, 3, 'rgba(60,30,20,0.45)')
      ctx.fillStyle = '#140d05'
      ctx.beginPath()
      ctx.ellipse(806, 600, 2.6, 6.8, 0.12, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = 'rgba(255,250,235,0.95)'
      ctx.beginPath()
      ctx.arc(801, 595, 1.7, 0, Math.PI * 2)
      ctx.fill()
    })
    ctx.strokeStyle = DRG.plum(0.12, 0.85)
    ctx.lineWidth = 3
    ctx.stroke(eye)
    // cream brow ridge overhanging the eye
    strand(ctx, [[772, 586], [800, 576], [830, 584]], 9, 4, DRG.hide(0.9))
    strand(ctx, [[774, 592], [802, 584], [828, 590]], 4, 2, DRG.plum(0.22, 0.5))

    // amber chin tuft behind the jaw hinge + green cheek wisps
    for (let i = 0; i < 4; i++) {
      const ang = 2.3 + i * 0.18
      horn(ctx, 786 + (rnd() - 0.5) * 6, 692 + i * 6, ang, 22 + rnd() * 14, 9, 0.25, DRG.amber, {})
    }
    for (let i = 0; i < 8; i++) {
      const ang = 1.85 + i * 0.14
      strand(ctx, [[756, 650], [756 + Math.cos(ang) * 28, 650 + Math.sin(ang) * 28], [750 + Math.cos(ang + 0.35) * 52, 650 + Math.sin(ang + 0.35) * 52]],
        7, 0.7, DRG.mane(0.22 + rnd() * 0.45, 0.92))
    }
  }

  // soft core shadow pooling beneath the body between the legs
  puff(ctx, 640, 792, 150, 'rgba(14,10,18,1)', 0.32, 42)
  puff(ctx, 710, GY - 6, 90, 'rgba(14,10,18,1)', 0.3, 12)
  puff(ctx, 500, GY - 6, 80, 'rgba(14,10,18,1)', 0.26, 10)

  // ---- scene-key washes: warm torch air upper-right, hall dark lower-left --
  wash(ctx, () => {
    puff(ctx, 880, 470, 330, 'rgba(255,166,79,1)', 0.13, 300)
    puff(ctx, 240, 720, 380, '#161126', 0.34, 300)
    puff(ctx, 560, 790, 300, '#171126', 0.22, 150)
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
// Composition (canvas 768×1024, mass centre ≈ (384, 500), ≈ 150 px/m):
//   · vertical near-black robe mass, hem dissolving into fog
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
    // hem dissolve — the robe is eaten by fog below ~0.72 of the figure
    ctx.save()
    ctx.globalCompositeOperation = 'destination-out'
    for (let i = 0; i < 60; i++) {
      const x = 220 + rnd() * 300
      const y = 810 + rnd() * 190
      puff(ctx, x, y, 22 + rnd() * 42, 'rgba(0,0,0,1)', 0.14 + ((y - 810) / 190) * 0.55)
    }
    for (let i = 0; i < 14; i++) {
      const x = 240 + rnd() * 260
      strand(ctx, [[x, 820 + rnd() * 40], [x + (rnd() - 0.5) * 24, 890 + rnd() * 40], [x + (rnd() - 0.5) * 40, 960 + rnd() * 40]],
        10 + rnd() * 14, 2, 'rgba(0,0,0,0.55)')
    }
    ctx.fillStyle = lin(ctx, 0, 840, 0, 1010, [[0, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,0.97)']])
    ctx.fillRect(160, 840, 440, 200)
    ctx.restore()
    // dark streamer ribbons flicking off the hem
    for (const [pts, w] of [
      [[[266, 776], [222, 846], [198, 916]], 14],
      [[[318, 816], [298, 886], [310, 948]], 12],
      [[[432, 826], [456, 898], [446, 958]], 12],
      [[[482, 786], [516, 852], [544, 898]], 10],
      [[[372, 852], [380, 912], [368, 964]], 10],
    ]) {
      ctx.save()
      ctx.globalAlpha = 0.75
      strand(ctx, pts, w, 0.5, SRC.robe(0.28))
      ctx.restore()
    }
    // curling tendril with gold dot trim (bottom-left)
    const ten = [[260, 756], [212, 810], [174, 862], [156, 902], [166, 932], [192, 938]]
    strand(ctx, ten, 17, 2, SRC.robe(0.32, 0.95))
    walk(ten.slice(0, 5), 27, (p, tg, n) => {
      ctx.fillStyle = SRC.gold(0.62, 0.9)
      ctx.beginPath()
      ctx.arc(p[0] + n[0] * 7, p[1] + n[1] * 7, 2.7, 0, Math.PI * 2)
      ctx.fill()
    })
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
    // under-layer shadow mass offset right-down
    ctx.save()
    ctx.translate(13, 9)
    ctx.fillStyle = SRC.beard(0.14, 0.9)
    ctx.fill(base)
    ctx.restore()
    ctx.fillStyle = lin(ctx, 380, 240, 560, 840, [
      [0, SRC.beard(0.66)], [0.4, SRC.beard(0.56)], [0.75, SRC.beard(0.44)], [1, SRC.beard(0.34)],
    ])
    ctx.fill(base)
    // ragged edge lobes so the mass reads as hair, not a tusk
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
      ], l * 0.42, 0.6, SRC.beard(sgn < 0 ? 0.58 + rnd() * 0.3 : 0.22 + rnd() * 0.25, 0.95))
    }
    shadeIn(ctx, base, () => {
      walk(spinePts, 26, (p, tg, n, tt) => {
        const w = wProf(tt) * 0.5
        puff(ctx, p[0] - n[0] * w * 0.55, p[1] - n[1] * w * 0.55, w, SRC.beard(0.9), 0.32, w * 0.75)
        puff(ctx, p[0] + n[0] * w * 0.55, p[1] + n[1] * w * 0.55, w, SRC.beard(0.1), 0.38, w * 0.75)
      })
      puff(ctx, 398, 330, 70, SRC.beard(0.98), 0.3, 46, 0.45)
      puff(ctx, 508, 640, 82, SRC.beard(0.85), 0.24, 60, 0.6)
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
        const bright = 0.32 + 0.5 * Math.max(0, -(off0 + off1) * 0.4) + (rnd() - 0.5) * 0.2
        strand(ctx, pts.map((p) => [p[0] + 5, p[1] + 4]), w0 * 1.1, w0 * 0.38, SRC.beard(Math.max(0.05, bright - 0.28), 0.92))
        strand(ctx, pts, w0, w0 * 0.32, SRC.beard(Math.min(0.86, bright), 0.95))
        strand(ctx, pts.map((p) => [p[0] - 4, p[1] - 3]), w0 * 0.36, w0 * 0.12, SRC.beard(Math.min(0.96, bright + 0.26), 0.85))
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
        const bright = 0.34 + 0.48 * Math.max(0, -off * 0.85) + (rnd() - 0.5) * 0.3
        ctx.globalAlpha = 0.3 + rnd() * 0.35
        strand(ctx, pts, 2 + rnd() * 3.4, 0.4, SRC.beard(Math.max(0.05, Math.min(0.95, bright))))
      }
      ctx.globalAlpha = 1
      // carved dark partings — deep valleys between rope-locks
      for (let i = 0; i < 10; i++) {
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
        strand(ctx, pts, 7.5, 0.8, SRC.beard(0.07, 0.6))
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
    // tip cascade: long tapering locks streaming down-left, feathered ends
    for (const [ang, l, w] of [[2.25, 120, 14], [2.5, 96, 12], [2.05, 140, 15], [2.7, 74, 10], [1.9, 108, 12]]) {
      const bx = 512 + (rnd() - 0.5) * 40, by = 842 + (rnd() - 0.5) * 30
      strand(ctx, [
        [bx + 30, by - 40], [bx, by],
        [bx + Math.cos(ang) * l * 0.55, by + Math.sin(ang) * l * 0.55],
        [bx + Math.cos(ang + 0.25) * l, by + Math.sin(ang + 0.25) * l],
      ], w, 0.6, SRC.beard(0.38 + rnd() * 0.3, 0.92))
      strand(ctx, [
        [bx + 24, by - 36], [bx + 2, by - 4],
        [bx + Math.cos(ang - 0.05) * l * 0.5, by + Math.sin(ang - 0.05) * l * 0.5 - 2],
        [bx + Math.cos(ang + 0.2) * l * 0.9, by + Math.sin(ang + 0.2) * l * 0.9],
      ], w * 0.35, 0.4, SRC.beard(0.7 + rnd() * 0.2, 0.8))
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
    strand(ctx, [[tip[0] + 4, tip[1] - 26], [tip[0] + 1, tip[1] - 8], [tip[0], tip[1]]], 9, 2, SRC.gold(0.42, 0.95))
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
