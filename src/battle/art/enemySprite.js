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
//   line). For the sorcerer it is the visual mass centre. Everything else an
//   integrator could want (canvas size, silhouette bbox, px-per-metre, quad
//   size in metres, anchor as a UV) is in `meta`.
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
 * A draped bat/demon wing. Leading edge root→carpal→spike, then finger tips
 * fanning off the carpal; the trailing edge sags between tips (ragged, with
 * jittered scallops). Fingers get bone spars; the membrane gets pleat bands.
 */
function drapedWing(ctx, rnd, o) {
  const { root, carpal, spike, tips, sag = 0.42, rampF, sheen, alpha = 1, jag = 10 } = o
  const outline = [root, [(root[0] + carpal[0]) / 2, (root[1] + carpal[1]) / 2 - 14], carpal]
  if (spike) outline.push(spike)
  let prev = spike || carpal
  for (const t of tips) {
    const mx = (prev[0] + t[0]) / 2, my = (prev[1] + t[1]) / 2
    outline.push([mx + (carpal[0] - mx) * sag + (rnd() - 0.5) * jag, my + (carpal[1] - my) * sag + (rnd() - 0.5) * jag])
    outline.push([t[0] + (rnd() - 0.5) * 3, t[1] + (rnd() - 0.5) * 3])
    prev = t
  }
  outline.push([(prev[0] + root[0]) / 2 + (carpal[0] - prev[0]) * 0.15, (prev[1] + root[1]) / 2 + (rnd() - 0.5) * jag])
  const shape = spline(outline, true)
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.fillStyle = lin(ctx, carpal[0], carpal[1], (tips[Math.floor(tips.length / 2)][0] + carpal[0]) / 2, tips[Math.floor(tips.length / 2)][1], [
    [0, rampF(0.5)], [0.55, rampF(0.28)], [1, rampF(0.1)],
  ])
  ctx.fill(shape)
  shadeIn(ctx, shape, () => {
    for (const t of tips) {
      const mx = carpal[0] + (t[0] - carpal[0]) * 0.55, my = carpal[1] + (t[1] - carpal[1]) * 0.55
      strand(ctx, [carpal, [mx + 6, my + 6], t], 22, 8, rampF(0.08, 0.55))
      strand(ctx, [[carpal[0] + 6, carpal[1] + 4], [mx + 12, my + 2], [t[0] + 4, t[1] - 2]], 7, 2, rampF(0.68, 0.45))
    }
    puff(ctx, carpal[0] + 20, carpal[1] + 30, 55, rampF(0.75), 0.32, 38, -0.5)
    puff(ctx, (carpal[0] + root[0]) / 2, (carpal[1] + root[1]) / 2 + 30, 60, rampF(0.05), 0.4)
    for (const t of tips) {
      const mx = carpal[0] + (t[0] - carpal[0]) * 0.5, my = carpal[1] + (t[1] - carpal[1]) * 0.5
      strand(ctx, [carpal, [mx, my - 4], t], 7.5, 1.6, rampF(0.04, 0.9))
      strand(ctx, [[carpal[0] + 2, carpal[1] - 2], [mx + 2, my - 7], [t[0], t[1] - 3]], 2.6, 0.8, rampF(0.88, 0.5))
    }
    strand(ctx, outline.slice(0, spike ? 4 : 3), 16, 7, rampF(0.16, 0.95))
    strand(ctx, outline.slice(0, spike ? 4 : 3).map((p) => [p[0] + 2, p[1] - 4]), 6, 2, rampF(0.8, 0.6))
    if (sheen) sheen(shape)
    ctx.globalAlpha = 0.55
    ctx.lineWidth = 5
    ctx.strokeStyle = rampF(0.03)
    ctx.stroke(shape)
  })
  // torn notches bitten out of the trailing edge
  ctx.globalCompositeOperation = 'destination-out'
  for (let i = 1; i < tips.length; i++) {
    const a = tips[i - 1], b = tips[i]
    for (let k = 0; k < 2; k++) {
      const u = 0.3 + rnd() * 0.4
      const mx = a[0] + (b[0] - a[0]) * u, my = a[1] + (b[1] - a[1]) * u
      puff(ctx, mx, my, 6 + rnd() * 9, 'rgba(0,0,0,1)', 0.85, 4 + rnd() * 5, rnd() * 3)
    }
  }
  ctx.globalCompositeOperation = 'source-over'
  ctx.restore()
  if (spike) horn(ctx, spike[0], spike[1], Math.atan2(spike[1] - carpal[1], spike[0] - carpal[0]), 26, 9, 0.25, rampF, {})
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
// Composition (canvas 1024×896, ground line y = 838, ≈ 128 px/m):
//   · one front-loaded cream mass: deep furred chest with the wedge head
//     merged straight into it, maw hinged far back and gaping at hero
//     eye-line; the rump falls away into shadow on the left
//   · dark raptor legs angled back beneath, pale hooked talons
//   · violet sail wings: draped curtain far-left, pleated sail behind the
//     shoulder; green feather ruffs at crest, cheek and rump
//   · the tail: thick thorned rise off the rump rolling into the big
//     olive-plated coil framing the top-left, tip flying out with dark fins.
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
  plum: ramp(['#150d16', '#241522', '#3a2438', '#553a52', '#6e4a62', '#8a5f74']),
  tooth: ramp(['#8f8168', '#c9bda0', '#efe8d2', '#fdf9ea']),
  olive: ramp(['#26260f', '#3c3d1a', '#575a26', '#707434', '#8b8c44', '#a49e58', '#bcb26e', '#d2c684']),
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
    root: [428, 600],
    carpal: [248, 498],
    spike: [178, 456],
    tips: [[74, 592], [94, 690], [176, 752], [268, 768], [352, 736]],
    sag: 0.34, jag: 14,
    rampF: DRG.wing,
  })

  // ---- the tail -----------------------------------------------------------
  const TAIL = [
    [448, 628], [508, 545], [552, 456], [580, 362], [584, 286],
    [552, 224], [486, 172], [388, 134], [272, 126], [178, 154],
    [122, 214], [136, 278], [216, 320], [330, 322], [438, 288],
    [524, 240], [592, 192], [652, 146], [692, 106],
  ]
  const tailW = (t) => (t < 0.16 ? 72 - 80 * t : t < 0.75 ? 58 - 24 * ((t - 0.16) / 0.59) : 34 - 26 * ((t - 0.75) / 0.25))
  const slice = (i0, i1) => {
    const s = TAIL.slice(i0, i1 + 1)
    const t0 = i0 / (TAIL.length - 1), t1 = i1 / (TAIL.length - 1)
    return { spine: s, t0, t1, shape: ribbon(s, (u) => tailW(t0 + (t1 - t0) * u) / 2) }
  }

  /** chunky overlapping plates + irregular thorns along a tail slice. */
  const paintPlatedTube = (sl, outwardFrom, spikes = true) => {
    const { spine, shape, t0, t1 } = sl
    ctx.fillStyle = DRG.olive(0.32)
    ctx.fill(shape)
    shadeIn(ctx, shape, () => {
      walk(spine, 24, (p, tg, n) => {
        const b = lit(n[0], n[1])
        puff(ctx, p[0] + n[0] * 9, p[1] + n[1] * 9, 34, DRG.olive(0.25 + 0.55 * b), 0.3, 24)
        puff(ctx, p[0] - n[0] * 11, p[1] - n[1] * 11, 32, DRG.olive(0.1), 0.32, 22)
      })
    })
    const stops = []
    walk(spine, 21, (p, tg, n, tt) => stops.push([p, tg, n, tt]))
    for (let i = stops.length - 1; i >= 0; i--) {
      const [p, tg, n, tt] = stops[i]
      const w = tailW(t0 + (t1 - t0) * tt) * 0.5
      const jw = w * (1.04 + (rnd() - 0.5) * 0.1)
      const b = lit(n[0], n[1], 0.48, 0.4) + (rnd() - 0.5) * 0.12
      const plate = spline([
        [p[0] + n[0] * jw - tg[0] * 9, p[1] + n[1] * jw - tg[1] * 9],
        [p[0] + tg[0] * 13, p[1] + tg[1] * 13],
        [p[0] - n[0] * jw - tg[0] * 9, p[1] - n[1] * jw - tg[1] * 9],
        [p[0] - n[0] * jw * 0.82 - tg[0] * 17, p[1] - n[1] * jw * 0.82 - tg[1] * 17],
        [p[0] - tg[0] * 15, p[1] - tg[1] * 15],
        [p[0] + n[0] * jw * 0.82 - tg[0] * 17, p[1] + n[1] * jw * 0.82 - tg[1] * 17],
      ], true)
      ctx.fillStyle = DRG.olive(0.2 + 0.5 * b)
      ctx.fill(plate)
      shadeIn(ctx, plate, () => {
        strand(ctx, [
          [p[0] + n[0] * jw * 0.9 + tg[0] * 8, p[1] + n[1] * jw * 0.9 + tg[1] * 8],
          [p[0] + tg[0] * 12, p[1] + tg[1] * 12],
          [p[0] - n[0] * jw * 0.9 + tg[0] * 8, p[1] - n[1] * jw * 0.9 + tg[1] * 8],
        ], 4.5, 3, DRG.olive(0.32 + 0.55 * b, 0.85))
        strand(ctx, [
          [p[0] + n[0] * jw * 0.9 - tg[0] * 14, p[1] + n[1] * jw * 0.9 - tg[1] * 14],
          [p[0] - tg[0] * 17, p[1] - tg[1] * 17],
          [p[0] - n[0] * jw * 0.9 - tg[0] * 14, p[1] - n[1] * jw * 0.9 - tg[1] * 14],
        ], 5, 3, DRG.olive(0.05, 0.6))
      })
    }
    ctx.save()
    ctx.globalAlpha = 0.5
    ctx.lineWidth = 4
    ctx.strokeStyle = DRG.olive(0.05)
    ctx.stroke(shape)
    ctx.restore()
    if (!spikes) return
    walk(spine, 30, (p, tg, n, tt) => {
      let ox = n[0], oy = n[1]
      if (outwardFrom) {
        ox = p[0] - outwardFrom[0]; oy = p[1] - outwardFrom[1]
        const l = Math.hypot(ox, oy) || 1
        ox /= l; oy /= l
      }
      if (rnd() < 0.18) return
      const w = tailW(t0 + (t1 - t0) * tt) * 0.5
      const ang = Math.atan2(oy, ox) + (rnd() - 0.5) * 0.5
      const len = (14 + rnd() * 30) * (0.7 + w / 34)
      horn(ctx, p[0] + ox * w * 0.72, p[1] + oy * w * 0.72, ang, len, 9 + rnd() * 6, (rnd() - 0.5) * 0.7, DRG.amber,
        rnd() < 0.4 ? { tipCss: DRG.gold(0.7) } : {})
      if (rnd() < 0.3) {
        horn(ctx, p[0] + ox * w * 0.6 + tg[0] * 8, p[1] + oy * w * 0.6 + tg[1] * 8, ang + 0.35, len * 0.55, 7, (rnd() - 0.5) * 0.6, DRG.amber, {})
      }
    })
  }

  // tip slice first (deepest), with the flying fins
  {
    const tip = TAIL[18]
    for (const [ang, len, w] of [[-2.1, 78, 34], [-1.35, 96, 42], [-0.55, 82, 34]]) {
      const p1 = [tip[0] + Math.cos(ang) * len, tip[1] + Math.sin(ang) * len]
      const mid = [tip[0] + Math.cos(ang + 0.5) * len * 0.6, tip[1] + Math.sin(ang + 0.5) * len * 0.6]
      const fin = spline([[tip[0], tip[1] + 4], [p1[0], p1[1]], [mid[0], mid[1]]], true)
      ctx.fillStyle = lin(ctx, tip[0], tip[1], p1[0], p1[1], [[0, DRG.wing(0.34)], [1, DRG.wing(0.08)]])
      ctx.fill(fin)
      shadeIn(ctx, fin, () => {
        strand(ctx, [[tip[0], tip[1]], [(tip[0] + p1[0]) / 2, (tip[1] + p1[1]) / 2], p1], 5, 1, DRG.wing(0.04, 0.85))
        puff(ctx, mid[0], mid[1], w, DRG.wing(0.6), 0.3)
      })
    }
    paintPlatedTube(slice(14, 18), null)
  }
  // the coil — thorns point out from the loop centre
  paintPlatedTube(slice(4, 15), [318, 224])

  // ---- near wing: pleated sail rising behind the shoulder -----------------
  drapedWing(ctx, rnd, {
    root: [660, 585],
    carpal: [775, 360],
    spike: [838, 266],
    tips: [[874, 384], [882, 472], [840, 550], [756, 592]],
    sag: 0.4, jag: 12,
    rampF: DRG.wing,
    sheen: () => {
      puff(ctx, 800, 420, 62, DRG.wing(0.88), 0.35, 42, -0.9)
      puff(ctx, 756, 505, 48, DRG.wing(0.72), 0.25, 32, -0.6)
    },
  })

  // ---- rising tail base over the wing (cream fur → olive plates) ----------
  {
    const C = slice(0, 6)
    ctx.fillStyle = lin(ctx, 466, 630, 560, 200, [
      [0, DRG.hide(0.46)], [0.4, DRG.hide(0.56)], [0.72, DRG.olive(0.42)], [1, DRG.olive(0.32)],
    ])
    ctx.fill(C.shape)
    shadeIn(ctx, C.shape, () => {
      walk(C.spine, 20, (p, tg, n, tt) => {
        const w = tailW(tt * C.t1) * 0.5
        const b = lit(n[0], n[1])
        const col = tt < 0.5 ? DRG.hide : DRG.olive
        puff(ctx, p[0] + n[0] * w * 0.45, p[1] + n[1] * w * 0.45, w * 1.15, col(0.24 + 0.5 * b), 0.32, w * 0.85)
        puff(ctx, p[0] - n[0] * w * 0.5, p[1] - n[1] * w * 0.5, w, col(0.12), 0.35, w * 0.8)
      })
      fur(ctx, rnd, C.shape, [400, 400, 640, 670], {
        count: 260,
        angleAt: (x, y) => Math.atan2(-(x - 460), y - 670) + Math.PI / 2 + 0.3,
        colAt: () => DRG.hide(0.35 + rnd() * 0.4),
        len: [8, 16], width: [1.2, 2.3], alpha: [0.12, 0.24],
      })
    })
    paintPlatedTube(slice(3, 6), null, false)
    walk(C.spine, 34, (p, tg, n, tt) => {
      const w = tailW(tt * C.t1) * 0.5
      const ang = Math.atan2(n[1], n[0]) - 0.3
      horn(ctx, p[0] + n[0] * w * 0.7, p[1] + n[1] * w * 0.7, ang, 30 + rnd() * 28, 13 + rnd() * 6, -0.55, DRG.amber, { tipCss: DRG.gold(0.72) })
    })
  }

  // ---- legs first (the body drops over their hips) ------------------------
  // dark raptor limbs, angled back, pale hooked talons (the frame04 read)
  const leg = (hipX, hipY, kneeX, kneeY, footX, wTh, shade) => {
    strand(ctx, [[hipX, hipY], [kneeX, kneeY], [kneeX + 8, (kneeY + GY) / 2 + 8], [footX, GY - 8]], wTh, wTh * 0.42, DRG.dark(0.14 + shade))
    strand(ctx, [[hipX + 7, hipY + 4], [kneeX + 7, kneeY], [footX + 6, GY - 14]], wTh * 0.28, 2, DRG.dark(0.45 + shade, 0.75))
    puff(ctx, kneeX, kneeY, wTh * 0.62, DRG.dark(0.55 + shade), 0.5, wTh * 0.45)
    // foot pad
    strand(ctx, [[footX - 10, GY - 10], [footX + 6, GY - 6], [footX + 22, GY - 6]], wTh * 0.6, wTh * 0.4, DRG.dark(0.2 + shade))
    // pale talons — the bright accent that reads at distance
    for (const [dx, l, aa] of [[24, 24, 0.65], [10, 27, 0.8], [-4, 23, 1.0]]) {
      horn(ctx, footX + dx, GY - 9, aa, l, 9, 0.55, DRG.tooth, { rootT: 0.3, midT: 0.6, tipT: 0.95 })
    }
    horn(ctx, footX - 16, GY - 12, 2.5, 15, 7, 0.3, DRG.tooth, { rootT: 0.25, midT: 0.5, tipT: 0.8 })
    // warm torch kiss down the shin front
    strand(ctx, [[kneeX + 10, kneeY + 6], [kneeX + 12, (kneeY + GY) / 2], [footX + 12, GY - 12]], 3.5, 1.2, 'rgba(231,160,106,0.4)')
  }
  leg(520, 700, 498, 768, 486, 24, -0.04)          // hind leg, deep shadow
  leg(676, 704, 648, 772, 634, 27, 0)              // far foreleg
  // near foreleg painted after the body

  // ---- the body: one front-loaded cream mass ------------------------------
  const bodyPts = [
    [770, 552], [820, 585], [848, 630], [852, 678], [830, 722],   // breast front
    [782, 748], [716, 758], [640, 756], [560, 742], [492, 716],   // belly line
    [444, 678], [420, 634], [424, 592], [458, 560], [520, 538],   // rump → back
    [600, 524], [684, 524], [736, 534],
  ]
  const body = spline(bodyPts, true)
  {
    ctx.fillStyle = lin(ctx, 810, 560, 440, 740, [
      [0, DRG.hide(0.82)], [0.4, DRG.hide(0.6)], [0.75, DRG.hide(0.38)], [1, DRG.hide(0.24)],
    ])
    ctx.fill(body)
    shadeIn(ctx, body, () => {
      // volumes: bright breast, mid back, dark rump + under-shadow
      puff(ctx, 790, 630, 130, DRG.hide(0.95), 0.45, 110, -0.35)
      puff(ctx, 690, 570, 95, DRG.hide(0.8), 0.3, 60, 0.1)
      puff(ctx, 470, 660, 120, DRG.hide(0.12), 0.5, 95)
      puff(ctx, 620, 730, 170, DRG.hide(0.08), 0.5, 60)
      puff(ctx, 540, 580, 70, DRG.hide(0.42), 0.3)
      puff(ctx, 690, 600, 60, DRG.hide(0.2), 0.28, 44, 0.5)   // wing-root shade
      // dense fur coat, brighter strokes clustering up-right
      fur(ctx, rnd, body, [420, 524, 856, 760], {
        count: 1500,
        angleAt: (x, y) => Math.atan2(y - 645, x - 640) + Math.PI / 2 + 0.55,
        colAt: (x, y) => {
          const nx = (x - 640) / 210, ny = (y - 645) / 118
          return DRG.hide(0.28 + 0.55 * lit(nx, ny) + (rnd() - 0.5) * 0.26)
        },
        len: [8, 19], width: [1.4, 2.9], alpha: [0.11, 0.24], curl: 0.8,
      })
      // belly plates: broad low-contrast arcs along the underside
      const arcPts = [[500, 712], [566, 736], [644, 748], [722, 748], [792, 730], [834, 700]]
      for (let i = arcPts.length - 2; i >= 0; i--) {
        const a = arcPts[i], b = arcPts[i + 1]
        const cxm = (a[0] + b[0]) / 2, cym = (a[1] + b[1]) / 2
        const seg = spline([[a[0], a[1] - 20], [cxm, cym - 28], [b[0], b[1] - 20], [cxm, cym + 8]], true)
        ctx.save()
        ctx.globalAlpha = 0.75
        ctx.fillStyle = DRG.belly(0.3 + 0.12 * i)
        ctx.fill(seg)
        ctx.restore()
        shadeIn(ctx, seg, () => {
          strand(ctx, [[a[0], a[1] - 17], [cxm, cym - 24], [b[0], b[1] - 17]], 3.5, 2.5, DRG.belly(0.7, 0.4))
          puff(ctx, cxm, cym + 2, 20, DRG.belly(0.04), 0.45, 10)
        })
      }
      // warm torch bounce climbing the breast
      puff(ctx, 830, 640, 95, 'rgba(231,160,106,1)', 0.2, 125, 0.4)
    })
    // fluffy rim so the silhouette reads furred, not vector-smooth
    fluffEdge(ctx, rnd, [...bodyPts, bodyPts[0]], 17, {
      size: [7, 16],
      leanFn: (p, n) => Math.atan2(n[1], n[0]) + 0.5,
      colFn: (p) => DRG.hide(0.2 + 0.6 * lit((p[0] - 640) / 210, (p[1] - 645) / 118) + (rnd() - 0.5) * 0.15, 0.95),
    })
  }

  // ---- near foreleg over the body -----------------------------------------
  leg(756, 690, 738, 768, 726, 30, 0.12)

  // ---- green rump ruff + amber spine crest --------------------------------
  for (let i = 0; i < 14; i++) {
    const bx = 428 + rnd() * 60, by = 590 + rnd() * 70
    const ang = -2.5 + (rnd() - 0.5) * 0.7
    const l = 26 + rnd() * 30
    strand(ctx, [
      [bx + 14, by + 6], [bx, by],
      [bx + Math.cos(ang) * l * 0.6, by + Math.sin(ang) * l * 0.6],
      [bx + Math.cos(ang - 0.6) * l, by + Math.sin(ang - 0.6) * l],
    ], 9, 0.8, DRG.mane(0.12 + rnd() * 0.5, 0.9))
  }
  {
    const ridge = [[505, 545], [572, 528], [648, 522], [712, 530], [758, 545]]
    walk(ridge, 38, (p, tg, n) => {
      const ang = Math.atan2(n[1], n[0]) - 0.3
      horn(ctx, p[0], p[1] + 8, ang, 26 + rnd() * 20, 13 + rnd() * 5, -0.45, DRG.amber, { tipCss: DRG.gold(0.7) })
      if (rnd() < 0.5) horn(ctx, p[0] + 13, p[1] + 10, ang + 0.3, 15 + rnd() * 9, 8, -0.3, DRG.amber, {})
    })
  }

  // ---- the head: wedge merged into the breast -----------------------------
  {
    // amber horn arc raking back over the shoulder from behind the skull
    horn(ctx, 792, 566, -2.6, 100, 23, -0.38, DRG.amber, { tipCss: DRG.gold(0.78) })
    horn(ctx, 768, 558, -2.8, 78, 18, -0.32, DRG.amber, { tipCss: DRG.gold(0.7) })
    horn(ctx, 812, 578, -2.35, 64, 15, -0.45, DRG.amber, {})
    horn(ctx, 744, 556, -2.95, 54, 13, -0.3, DRG.amber, {})
    horn(ctx, 826, 596, -2.15, 44, 12, -0.5, DRG.amber, {})
    // green crest fan behind the skull top
    for (let i = 0; i < 16; i++) {
      const t = i / 15
      const bx = 792 - t * 52 + (rnd() - 0.5) * 8, by = 566 - t * 4 + (rnd() - 0.5) * 10
      const ang = -2.15 - t * 0.55 + (rnd() - 0.5) * 0.22
      const l = 30 + 34 * Math.sin(Math.min(1, t * 1.25) * Math.PI) + rnd() * 10
      strand(ctx, [
        [bx, by],
        [bx + Math.cos(ang) * l * 0.55, by + Math.sin(ang) * l * 0.55],
        [bx + Math.cos(ang - 0.5) * l, by + Math.sin(ang - 0.5) * l],
      ], 8.5, 0.8, DRG.mane(0.22 + 0.55 * (1 - t) + (rnd() - 0.5) * 0.18, 0.94))
    }

    // cream face plate — sits directly on the breast, no neck gap
    const face = spline([
      [738, 560], [800, 540], [856, 550], [896, 572], [908, 600],
      [894, 626], [862, 644], [822, 658], [780, 662], [744, 645], [722, 606],
    ], true)
    ctx.fillStyle = lin(ctx, 790, 545, 880, 655, [[0, DRG.hide(0.92)], [0.55, DRG.hide(0.76)], [1, DRG.hide(0.52)]])
    ctx.fill(face)
    shadeIn(ctx, face, () => {
      puff(ctx, 856, 578, 44, DRG.hide(0.99), 0.5, 30, -0.3)
      puff(ctx, 756, 640, 44, DRG.hide(0.32), 0.42)
      fur(ctx, rnd, face, [720, 538, 910, 665], {
        count: 200, angleAt: () => 0.32, colAt: () => DRG.hide(0.5 + rnd() * 0.42),
        len: [5, 11], width: [1, 2], alpha: [0.12, 0.22],
      })
    })
    fluffEdge(ctx, rnd, [[738, 560], [722, 606], [744, 645], [780, 662]], 13, {
      size: [6, 11],
      leanFn: () => 2.6,
      colFn: () => DRG.hide(0.45 + rnd() * 0.3, 0.9),
    })

    // ---- the maw: hinged far back under the eye, gaping wide --------------
    // interior first
    const maw = spline([[812, 652], [880, 652], [940, 660], [930, 700], [892, 738], [846, 750], [812, 712], [800, 676]], true)
    ctx.fillStyle = lin(ctx, 880, 650, 860, 750, [[0, DRG.maw(0.12)], [0.55, DRG.maw(0.3)], [1, DRG.maw(0.14)]])
    ctx.fill(maw)
    shadeIn(ctx, maw, () => {
      puff(ctx, 860, 715, 55, DRG.maw(0.04), 0.6)
      puff(ctx, 905, 672, 28, DRG.maw(0.5), 0.4)
    })
    // plum snout hump hooking over the front of the gape
    const snout = spline([
      [858, 560], [908, 576], [946, 600], [966, 630], [968, 658],
      [950, 672], [920, 662], [886, 644], [862, 618], [850, 588],
    ], true)
    ctx.fillStyle = lin(ctx, 880, 566, 960, 668, [[0, DRG.plum(0.62)], [0.5, DRG.plum(0.44)], [1, DRG.plum(0.2)]])
    ctx.fill(snout)
    shadeIn(ctx, snout, () => {
      strand(ctx, [[864, 570], [928, 592], [962, 636]], 9, 3, DRG.plum(0.88, 0.75))
      puff(ctx, 950, 662, 26, DRG.plum(0.06), 0.55, 16)
      ctx.fillStyle = DRG.plum(0.05, 0.9)
      ctx.beginPath()
      ctx.ellipse(944, 610, 8, 4, 0.55, 0, Math.PI * 2)
      ctx.fill()
      puff(ctx, 962, 648, 12, DRG.plum(0.85), 0.5)
    })
    // upper tooth band under the snout — small white hooks in a plum gum line
    strand(ctx, [[828, 654], [886, 650], [944, 662]], 8, 5, DRG.plum(0.24, 0.95))
    for (let i = 0; i < 9; i++) {
      const t = i / 8
      const x = 832 + t * 108, y = 656 + t * 8 - Math.sin(t * Math.PI) * 3
      horn(ctx, x, y, 1.62 - t * 0.25, 9 + 6 * Math.abs(Math.sin(t * 7.1)) + (i === 8 ? 7 : 0), 6, 0.12, DRG.tooth, {})
    }
    // lower jaw — dark plum slab swinging down-forward
    const jaw = spline([
      [800, 666], [846, 690], [890, 726], [916, 762], [920, 788],
      [896, 794], [858, 772], [822, 734], [796, 694], [790, 672],
    ], true)
    ctx.fillStyle = lin(ctx, 820, 680, 912, 790, [[0, DRG.plum(0.5)], [0.6, DRG.plum(0.3)], [1, DRG.plum(0.12)]])
    ctx.fill(jaw)
    shadeIn(ctx, jaw, () => {
      strand(ctx, [[804, 672], [860, 706], [914, 766]], 6, 2.5, DRG.plum(0.8, 0.6))
      puff(ctx, 830, 720, 40, DRG.plum(0.06), 0.5)
    })
    // lower tooth row rising off the jaw line
    for (let i = 0; i < 8; i++) {
      const t = i / 7
      horn(ctx, 812 + t * 92, 684 + t * 74, -1.48 + t * 0.18, 8 + 6 * Math.abs(Math.sin(2 + t * 6)), 5.5, 0.1, DRG.tooth, {})
    }
    // tongue: hangs out over the jaw, twisting, tip curling back
    const tPts = [[818, 672], [856, 696], [888, 726], [900, 758], [886, 780], [864, 782]]
    const tShape = ribbon(tPts, (t) => (16 - 9 * t) / 2)
    ctx.fillStyle = DRG.tongue(0.42)
    ctx.fill(tShape)
    shadeIn(ctx, tShape, () => {
      strand(ctx, tPts, 4.5, 1, DRG.tongue(0.1, 0.85))
      puff(ctx, 878, 722, 20, DRG.tongue(0.88), 0.5, 9, 0.8)
      puff(ctx, 872, 776, 9, DRG.tongue(0.95), 0.6)
    })
    // ---- the eye — small, hot, high on the face, brow shelf above ---------
    puff(ctx, 848, 606, 24, DRG.plum(0.12), 0.5, 15, -0.15)
    const eye = spline([[832, 608], [848, 601], [864, 605], [860, 614], [840, 615]], true)
    ctx.fillStyle = lin(ctx, 834, 603, 862, 614, [[0, '#c98f1e'], [0.45, '#f6e27a'], [1, '#e8c22c']])
    ctx.fill(eye)
    shadeIn(ctx, eye, () => {
      ctx.fillStyle = '#1c1408'
      ctx.beginPath()
      ctx.ellipse(850, 608, 2.1, 5.2, 0.1, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = 'rgba(255,250,235,0.95)'
      ctx.beginPath()
      ctx.arc(846, 604, 1.4, 0, Math.PI * 2)
      ctx.fill()
    })
    ctx.strokeStyle = DRG.plum(0.16, 0.9)
    ctx.lineWidth = 4.5
    ctx.beginPath()
    ctx.moveTo(828, 600)
    ctx.quadraticCurveTo(848, 592, 868, 599)
    ctx.stroke()
    // amber chin tuft + green cheek ruff behind the jaw hinge
    for (let i = 0; i < 6; i++) {
      const ang = 2.25 + i * 0.15
      strand(ctx, [[800, 688], [800 + Math.cos(ang) * 22, 688 + Math.sin(ang) * 22], [796 + Math.cos(ang + 0.5) * 40, 688 + Math.sin(ang + 0.5) * 40]],
        6, 0.6, DRG.amber(0.35 + rnd() * 0.4, 0.9))
    }
    for (let i = 0; i < 9; i++) {
      const ang = 1.85 + i * 0.13
      strand(ctx, [[756, 648], [756 + Math.cos(ang) * 30, 648 + Math.sin(ang) * 30], [750 + Math.cos(ang + 0.35) * 54, 648 + Math.sin(ang + 0.35) * 54]],
        7, 0.7, DRG.mane(0.22 + rnd() * 0.45, 0.92))
    }
  }

  // soft core shadow pooling beneath the body between the legs
  puff(ctx, 640, 790, 150, 'rgba(14,10,18,1)', 0.3, 42)
  puff(ctx, 720, GY - 6, 90, 'rgba(14,10,18,1)', 0.3, 12)
  puff(ctx, 500, GY - 6, 80, 'rgba(14,10,18,1)', 0.26, 10)

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
//   · the beard is the BRIGHTEST shape — a white comet sweeping down-right
//   · staff on a hard diagonal, oxblood with a crimson backlit edge
//   · huge ragged wings both sides, thorn-antler epaulettes, clawed reach
// ===========================================================================

const SRC = {
  beard: ramp(['#4e5346', '#666b5c', '#7e8271', '#949784', '#adaf99', '#b3b4a1', '#c8c9b8', '#ccd0c2', '#e4e7d8']),
  robe: ramp(['#04060a', '#090c0c', '#0d110d', '#141a14', '#1d251d', '#2a352a']),
  teal: ramp(['#061621', '#0e3a4d', '#1e4d5c', '#3d606a', '#5b8189', '#83a8a8']),
  wine: ramp(['#12010a', '#2d0216', '#4a0a2c', '#6d1544', '#8f2158', '#a83070']),
  gold: ramp(['#2e2812', '#4c421e', '#726739', '#84805a', '#a89e6e', '#c9bd82']),
  staff: ramp(['#1c0304', '#390708', '#481a1c', '#6b2226', '#8f2c2c', '#b03a34']),
  wingD: ramp(['#04080a', '#091110', '#0d150f', '#132420', '#1d3833', '#2d5049']),
  skin: ramp(['#1c1613', '#2e2620', '#453a30', '#5c4c3e', '#75604e']),
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
    carpal: [196, 212],
    spike: [148, 186],
    tips: [[70, 240], [48, 318], [78, 398], [140, 452], [216, 470]],
    sag: 0.36, jag: 16,
    rampF: SRC.wingD,
    alpha: 0.85,
    sheen: () => {
      strand(ctx, [[310, 262], [240, 218], [160, 194]], 6, 2, SRC.teal(0.55, 0.45))
    },
  })
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  for (const t of [[70, 240], [48, 318], [78, 398]]) puff(ctx, t[0], t[1], 48, 'rgba(0,0,0,1)', 0.45)
  ctx.restore()

  // ---- near wing (screen-right) — the big ragged dark mass ----------------
  drapedWing(ctx, rnd, {
    root: [446, 270],
    carpal: [592, 152],
    spike: [652, 92],
    tips: [[724, 142], [744, 232], [712, 322], [648, 396], [572, 438]],
    sag: 0.38, jag: 16,
    rampF: SRC.wingD,
    sheen: (shape) => {
      strand(ctx, [[456, 258], [540, 186], [640, 104]], 7, 2, SRC.teal(0.6, 0.5))
      puff(ctx, 600, 220, 70, SRC.wingD(0.62), 0.25, 48, -0.7)
    },
  })
  for (const [x, y, a, l] of [[712, 366, 0.9, 30], [740, 300, 0.45, 24], [668, 420, 1.15, 28], [744, 190, 0.1, 20], [610, 456, 1.4, 24]]) {
    strand(ctx, [[x, y], [x + Math.cos(a) * l * 0.6, y + Math.sin(a) * l * 0.6], [x + Math.cos(a + 0.55) * l, y + Math.sin(a + 0.55) * l]],
      7, 0.5, SRC.wingD(0.18, 0.9))
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
      // wine inner-robe panel down the front-left: irregular lit fold crests
      const folds = [
        { x: 282, w: 20, b: 0.5, sway: 16 },
        { x: 312, w: 13, b: 0.85, sway: 22 },
        { x: 342, w: 17, b: 0.65, sway: 12 },
        { x: 370, w: 9, b: 0.4, sway: 26 },
        { x: 394, w: 12, b: 0.25, sway: 18 },
      ]
      for (const f of folds) {
        strand(ctx, [
          [f.x, 330 + (rnd() - 0.5) * 20],
          [f.x - f.sway * 0.5, 480], [f.x + f.sway * 0.5, 640],
          [f.x - f.sway * 0.3, 780 + (rnd() - 0.5) * 30],
        ], f.w * 1.7, f.w * 0.6, SRC.wine(f.b * 0.5, 0.92))
        strand(ctx, [
          [f.x + 3, 350], [f.x + 3 - f.sway * 0.5, 495], [f.x + 3 + f.sway * 0.5, 630], [f.x + 1, 760],
        ], f.w * 0.5, f.w * 0.2, SRC.wine(f.b, 0.9))
      }
      // quench the wine at collar and hem so only the waist band glows
      puff(ctx, 330, 360, 110, SRC.robe(0.06), 0.6, 60, 0.2)
      puff(ctx, 330, 770, 130, SRC.robe(0.04), 0.6, 70, -0.1)
      puff(ctx, 340, 560, 120, SRC.robe(0.02), 0.4, 46, 0.25)
      // teal silk sheen: collar V + right flank under the wing
      strand(ctx, [[392, 292], [420, 380], [440, 480]], 24, 9, SRC.teal(0.34, 0.4))
      strand(ctx, [[420, 300], [452, 420], [472, 560]], 12, 4, SRC.teal(0.55, 0.35))
      strand(ctx, [[476, 420], [492, 560], [488, 700]], 14, 5, SRC.teal(0.3, 0.3))
      strand(ctx, [[286, 292], [268, 360], [252, 450]], 12, 4, SRC.teal(0.45, 0.32))
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

  // ---- thorn-antler epaulettes bursting from both shoulders ---------------
  const thornBurst = (bx, by, a0, a1, n, maxL) => {
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1)
      const ang = a0 + (a1 - a0) * t + (rnd() - 0.5) * 0.18
      const len = maxL * (0.4 + 0.6 * Math.sin(t * Math.PI)) * (0.75 + rnd() * 0.5)
      const x = bx + (rnd() - 0.5) * 20, y = by + (rnd() - 0.5) * 12
      horn(ctx, x, y, ang, len, 8 + rnd() * 3.5, (rnd() - 0.5) * 1.2, SRC.thorn, { tipT: 0.8 })
      if (rnd() < 0.7) horn(ctx, x + Math.cos(ang) * len * 0.45, y + Math.sin(ang) * len * 0.45, ang - 0.8 + rnd() * 1.6, len * 0.32, 5.5, (rnd() - 0.5) * 0.8, SRC.thorn, {})
      ctx.fillStyle = SRC.gold(0.5)
      ctx.beginPath()
      ctx.arc(x, y, 3.8, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = SRC.gold(0.92, 0.9)
      ctx.beginPath()
      ctx.arc(x - 1.3, y - 1.3, 1.5, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  thornBurst(320, 226, -3.0, -1.8, 8, 86)
  thornBurst(446, 232, -1.3, -0.1, 8, 82)

  // ---- reaching arm + pauldron (screen-left) ------------------------------
  {
    const sleeve = spline([[322, 296], [258, 310], [196, 334], [148, 362], [136, 392], [174, 404], [244, 390], [308, 358], [336, 328]], true)
    ctx.fillStyle = lin(ctx, 320, 316, 150, 390, [[0, SRC.robe(0.5)], [0.6, SRC.robe(0.26)], [1, SRC.robe(0.1)]])
    ctx.fill(sleeve)
    shadeIn(ctx, sleeve, () => {
      strand(ctx, [[314, 306], [230, 330], [154, 368]], 7, 3, SRC.teal(0.6, 0.55))
      strand(ctx, [[300, 346], [238, 370], [166, 396]], 6, 2, SRC.robe(0.02, 0.8))
      puff(ctx, 200, 368, 42, SRC.teal(0.32), 0.2, 26, -0.3)
    })
    strand(ctx, [[166, 356], [148, 378], [156, 400]], 5, 2, SRC.gold(0.68, 0.9))
    // claw hand — heavy knuckles, long spread talons with pale rims
    const palm = spline([[148, 376], [118, 380], [98, 400], [110, 426], [144, 424], [160, 400]], true)
    ctx.fillStyle = lin(ctx, 150, 380, 105, 425, [[0, SRC.skin(0.4)], [1, SRC.skin(0.12)]])
    ctx.fill(palm)
    for (const [ang, l, w] of [[2.05, 66, 12], [1.75, 80, 13], [1.45, 72, 12], [1.15, 58, 11]]) {
      const bx = 116 + Math.cos(ang - 1.55) * 18, by = 408 + Math.sin(ang - 1.55) * 10
      const tipx = bx + Math.cos(ang + 0.4) * l, tipy = by + Math.sin(ang + 0.4) * l
      strand(ctx, [[bx, by], [bx + Math.cos(ang) * l * 0.55, by + Math.sin(ang) * l * 0.55], [tipx, tipy]], w, 1.2, SRC.skin(0.26, 0.97))
      strand(ctx, [[bx - 3, by - 3], [bx + Math.cos(ang) * l * 0.5 - 3, by + Math.sin(ang) * l * 0.5 - 2], [tipx - 2, tipy]], 3.5, 0.6, SRC.skin(0.7, 0.6))
      puff(ctx, bx, by, 6.5, SRC.skin(0.72), 0.55)
    }
    horn(ctx, 104, 428, 1.9, 30, 9, 0.35, SRC.skin, {})
    // pauldron dome — silk sheen capped, gold-rimmed, occluded beneath
    const pd = spline([[272, 256], [318, 244], [354, 258], [362, 292], [340, 320], [296, 324], [264, 296]], true)
    ctx.fillStyle = lin(ctx, 290, 246, 340, 326, [[0, SRC.teal(0.52)], [0.5, SRC.teal(0.3)], [1, SRC.robe(0.16)]])
    ctx.fill(pd)
    shadeIn(ctx, pd, () => {
      strand(ctx, [[278, 268], [312, 252], [350, 268]], 6, 2.5, SRC.teal(0.8, 0.7))
      strand(ctx, [[272, 292], [310, 278], [352, 292]], 4, 2, SRC.teal(0.62, 0.5))
      puff(ctx, 330, 310, 30, SRC.robe(0.03), 0.6)
    })
    strand(ctx, [[268, 300], [302, 320], [346, 314]], 5.5, 2.5, SRC.gold(0.72, 0.9))
    for (const [x, y, a] of [[284, 252, -2.35], [312, 244, -1.95], [340, 252, -1.55]]) {
      horn(ctx, x, y, a, 24, 7, -0.2, SRC.gold, {})
    }
  }

  // ---- head: tiny, bowed, swallowed by hair and beard ---------------------
  {
    // high dark collar behind the head
    const collar = spline([[338, 216], [352, 178], [384, 162], [418, 174], [436, 208], [428, 246], [352, 248]], true)
    ctx.fillStyle = lin(ctx, 380, 166, 390, 248, [[0, SRC.robe(0.4)], [1, SRC.robe(0.12)]])
    ctx.fill(collar)
    // gaunt skull, tilted down toward the party
    const head = spline([[356, 186], [380, 176], [402, 186], [410, 210], [400, 232], [378, 242], [358, 232], [348, 208]], true)
    ctx.fillStyle = lin(ctx, 354, 180, 404, 238, [[0, SRC.skin(0.46)], [0.55, SRC.skin(0.24)], [1, SRC.skin(0.07)]])
    ctx.fill(head)
    shadeIn(ctx, head, () => {
      puff(ctx, 366, 192, 16, SRC.skin(0.78), 0.5, 10, -0.5)
      puff(ctx, 392, 224, 22, SRC.skin(0.02), 0.75)
      puff(ctx, 369, 208, 10, SRC.skin(0.01), 0.85, 6)
      puff(ctx, 389, 205, 10, SRC.skin(0.01), 0.85, 6)
      ctx.fillStyle = 'rgba(214,192,146,0.5)'
      ctx.beginPath()
      ctx.arc(370, 209, 1.5, 0, Math.PI * 2)
      ctx.fill()
      strand(ctx, [[379, 202], [382, 216], [378, 226]], 3, 1.5, SRC.skin(0.5, 0.5))
    })
    // white brows
    strand(ctx, [[358, 202], [368, 198], [377, 201]], 4.5, 1, SRC.beard(0.9, 0.95))
    strand(ctx, [[382, 200], [391, 197], [399, 201]], 4.5, 1, SRC.beard(0.86, 0.95))
    // hair: swept-back silver mass hugging the skull, low nape, small crest
    const hairBase = spline([[346, 196], [352, 174], [372, 158], [398, 158], [418, 174], [428, 198], [420, 216], [402, 196], [380, 184], [360, 190]], true)
    ctx.fillStyle = lin(ctx, 360, 160, 420, 210, [[0, SRC.beard(0.82)], [0.6, SRC.beard(0.6)], [1, SRC.beard(0.34)]])
    ctx.fill(hairBase)
    shadeIn(ctx, hairBase, () => {
      puff(ctx, 372, 168, 20, SRC.beard(0.95), 0.5, 12, -0.4)
      puff(ctx, 416, 200, 18, SRC.beard(0.2), 0.5)
    })
    for (let i = 0; i < 12; i++) {
      const t = i / 11
      const bx = 352 + t * 54, by = 172 - Math.sin(t * Math.PI) * 9
      const ang = 0.35 + t * 0.5 + (rnd() - 0.5) * 0.2   // sweeping back-down toward the nape
      const l = 22 + rnd() * 16
      strand(ctx, [
        [bx, by],
        [bx + Math.cos(ang) * l * 0.6, by + Math.sin(ang) * l * 0.6],
        [bx + Math.cos(ang + 0.35) * l, by + Math.sin(ang + 0.35) * l],
      ], 5.5, 0.7, SRC.beard(0.42 + 0.45 * (1 - t) + (rnd() - 0.5) * 0.14, 0.95))
    }
  }

  // ---- THE BEARD — the brightest mass on the highland stage ---------------
  {
    // bows left off the chin, then sweeps right and low like a comet
    const spinePts = [
      [372, 226], [378, 300], [388, 390], [406, 482], [436, 566],
      [480, 634], [538, 682], [602, 706], [660, 700],
    ]
    const wProf = (t) => 26 + 128 * Math.sin(Math.min(1, t * 1.04) * Math.PI) * (1 - t * 0.16) + t * 6
    const base = ribbon(spinePts, (t) => wProf(t) / 2)
    // under-layer shadow mass offset right-down
    ctx.save()
    ctx.translate(12, 9)
    ctx.fillStyle = SRC.beard(0.16, 0.9)
    ctx.fill(base)
    ctx.restore()
    ctx.fillStyle = lin(ctx, 380, 240, 640, 700, [
      [0, SRC.beard(0.68)], [0.4, SRC.beard(0.56)], [0.75, SRC.beard(0.44)], [1, SRC.beard(0.36)],
    ])
    ctx.fill(base)
    // ragged edge lobes so the mass reads as hair, not a tusk
    const nrmS = normals(spinePts)
    for (let i = 0; i < 30; i++) {
      const t = 0.06 + rnd() * 0.88
      const a = along(spinePts, t)
      const sgn = rnd() < 0.55 ? -1 : 1
      const w = wProf(t) * 0.5
      const bx = a.x + a.nx * w * sgn * 0.96, by = a.y + a.ny * w * sgn * 0.96
      const ang = Math.atan2(a.ty, a.tx) + sgn * -0.5 + (rnd() - 0.5) * 0.5
      const l = 14 + rnd() * 26
      strand(ctx, [
        [bx - a.tx * l * 0.4, by - a.ty * l * 0.4], [bx, by],
        [bx + Math.cos(ang) * l * 0.7, by + Math.sin(ang) * l * 0.7],
        [bx + Math.cos(ang + sgn * 0.4) * l, by + Math.sin(ang + sgn * 0.4) * l],
      ], l * 0.42, 0.6, SRC.beard(sgn < 0 ? 0.6 + rnd() * 0.3 : 0.25 + rnd() * 0.25, 0.95))
    }
    shadeIn(ctx, base, () => {
      walk(spinePts, 26, (p, tg, n, tt) => {
        const w = wProf(tt) * 0.5
        puff(ctx, p[0] - n[0] * w * 0.55, p[1] - n[1] * w * 0.55, w, SRC.beard(0.9), 0.32, w * 0.75)
        puff(ctx, p[0] + n[0] * w * 0.55, p[1] + n[1] * w * 0.55, w, SRC.beard(0.12), 0.36, w * 0.75)
      })
      puff(ctx, 400, 330, 72, SRC.beard(0.98), 0.3, 48, 0.45)
      // heavy strand work with wobble — the wave texture
      for (let i = 0; i < 260; i++) {
        const off = (rnd() - 0.5) * 1.9
        const s0 = rnd() * 0.42
        const s1 = Math.min(1, s0 + 0.25 + rnd() * 0.5)
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
        const bright = 0.34 + 0.52 * Math.max(0, -off * 0.85) + (rnd() - 0.5) * 0.3
        ctx.globalAlpha = 0.5 + rnd() * 0.45
        strand(ctx, pts, 2.4 + rnd() * 4.2, 0.4, SRC.beard(Math.max(0.06, Math.min(1, bright))))
      }
      ctx.globalAlpha = 1
      // carved dark partings
      for (let i = 0; i < 10; i++) {
        const off = (rnd() - 0.5) * 1.5
        const s0 = 0.08 + rnd() * 0.3
        const s1 = Math.min(1, s0 + 0.4 + rnd() * 0.3)
        const pts = []
        for (let k = 0; k <= 4; k++) {
          const t = s0 + ((s1 - s0) * k) / 4
          const a = along(spinePts, t)
          const w = wProf(t) * 0.5
          pts.push([a.x + a.nx * off * w * 0.85 + Math.sin(t * 9 + i) * 5, a.y + a.ny * off * w * 0.85])
        }
        strand(ctx, pts, 4, 0.8, SRC.beard(0.08, 0.5))
      }
    })
    // thick splayed locks at the tip, fanning right and curling
    for (const [ang, l, w] of [[-0.6, 96, 13], [-0.28, 118, 15], [0.05, 128, 16], [0.42, 104, 13], [0.85, 78, 11]]) {
      const bx = 606 + rnd() * 26, by = 692 + (rnd() - 0.5) * 26
      strand(ctx, [
        [bx - 56, by - 12], [bx, by],
        [bx + Math.cos(ang) * l * 0.55, by + Math.sin(ang) * l * 0.55],
        [bx + Math.cos(ang - 0.5) * l, by + Math.sin(ang - 0.5) * l],
      ], w, 1, SRC.beard(0.42 + rnd() * 0.34, 0.94))
      strand(ctx, [
        [bx - 40, by - 10], [bx + 4, by - 3],
        [bx + Math.cos(ang - 0.1) * l * 0.5, by + Math.sin(ang - 0.1) * l * 0.5 - 3],
        [bx + Math.cos(ang - 0.55) * l * 0.94, by + Math.sin(ang - 0.55) * l * 0.94],
      ], w * 0.35, 0.5, SRC.beard(0.78 + rnd() * 0.18, 0.8))
    }
    // moustache swoops riding the beard top
    for (const s of [-1, 1]) {
      strand(ctx, [
        [378 + s * 5, 224], [368 + s * 20, 248], [372 + s * 28, 284], [380 + s * 24, 318],
      ], 8, 1, SRC.beard(0.85, 0.97))
    }
    // sideburn strands tying the beard into the hair
    strand(ctx, [[352, 214], [356, 240], [366, 270]], 7, 1, SRC.beard(0.7, 0.9))
    strand(ctx, [[402, 212], [400, 240], [396, 268]], 7, 1, SRC.beard(0.6, 0.9))
    // flyaway wisps drifting off into the wind
    for (let i = 0; i < 8; i++) {
      const by = 280 + i * 30 + rnd() * 12
      strand(ctx, [[382, by], [348 - i * 3, by + 20], [318 - i * 6, by + 26 + rnd() * 12]], 2.8, 0.3, SRC.beard(0.6, 0.7))
    }
  }

  // ---- emerald brooch at the collar ---------------------------------------
  {
    puff(ctx, 406, 290, 13, 'rgba(47,191,143,1)', 0.5)
    ctx.fillStyle = '#0d3f30'
    ctx.beginPath(); ctx.arc(406, 290, 6.8, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#2fbf8f'
    ctx.beginPath(); ctx.arc(406, 290, 4.8, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#aef2d8'
    ctx.beginPath(); ctx.arc(404, 288, 1.9, 0, Math.PI * 2); ctx.fill()
  }

  // ---- the staff: gnarled oxblood diagonal with a crescent head -----------
  {
    const top = [612, 30], tip = [406, 944]
    const P = (t) => [top[0] + (tip[0] - top[0]) * t, top[1] + (tip[1] - top[1]) * t]
    // sleeve mass reaching from the mantle to the grip
    const g = P(0.255)
    strand(ctx, [[468, 246], [506, 248], [g[0] - 6, g[1] - 12]], 30, 15, SRC.robe(0.24, 0.98))
    strand(ctx, [[472, 242], [510, 244], [g[0] - 8, g[1] - 18]], 7, 3, SRC.teal(0.5, 0.4))
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
      [p0[0] - 4, p0[1] + 2], [p0[0] - 26, p0[1] - 16], [p0[0] - 34, p0[1] - 40],
      [p0[0] - 22, p0[1] - 62], [p0[0] + 4, p0[1] - 72], [p0[0] - 2, p0[1] - 56],
      [p0[0] - 10, p0[1] - 38], [p0[0] - 4, p0[1] - 18],
    ], true)
    ctx.fillStyle = lin(ctx, p0[0] - 30, p0[1] - 60, p0[0], p0[1], [[0, SRC.staff(0.72)], [0.55, SRC.staff(0.4)], [1, SRC.staff(0.16)]])
    ctx.fill(cres)
    shadeIn(ctx, cres, () => {
      strand(ctx, [[p0[0] - 30, p0[1] - 18], [p0[0] - 36, p0[1] - 40], [p0[0] - 24, p0[1] - 62]], 3.5, 1.5, SRC.staff(0.95, 0.9))
      puff(ctx, p0[0] - 18, p0[1] - 34, 16, SRC.staff(0.06), 0.6)
    })
    horn(ctx, p0[0] + 2, p0[1] - 2, -0.35, 30, 10, 0.6, SRC.staff, {})       // counter-prong
    horn(ctx, p0[0] + 1, p0[1] - 8, -1.62, 40, 9, 0.15, SRC.staff, { tipT: 0.95 }) // centre spike
    // gripping claw over the shaft
    const gp = spline([[g[0] - 16, g[1] - 12], [g[0] + 12, g[1] - 16], [g[0] + 20, g[1] + 6], [g[0], g[1] + 18], [g[0] - 18, g[1] + 8]], true)
    ctx.fillStyle = lin(ctx, g[0] - 12, g[1] - 12, g[0] + 12, g[1] + 14, [[0, SRC.skin(0.42)], [1, SRC.skin(0.1)]])
    ctx.fill(gp)
    for (let i = 0; i < 4; i++) {
      const fy = g[1] - 11 + i * 8.5
      strand(ctx, [[g[0] - 15, fy], [g[0] + 2, fy + 3.5], [g[0] + 16, fy + 1]], 7.5, 3, SRC.skin(0.3 + (i === 1 ? 0.16 : 0), 0.97))
      strand(ctx, [[g[0] - 14, fy - 2], [g[0] + 1, fy + 1], [g[0] + 13, fy - 1.5]], 2.5, 0.8, SRC.skin(0.68, 0.5))
    }
  }

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
