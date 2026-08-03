// ---------------------------------------------------------------------------
// src/battle/ui/callouts.js — the floating battle chrome (BATTLE_BIBLE
// §7.4 skill-name banner, §7.5 status icons / damage numerals / reticle).
//
// Contract (docs/BATTLE_CONTRACT.md — frozen):
//   export function createCallouts({ units, camera }): CalloutsUI
//   CalloutsUI = { dom, update(dt): void, announce(text): void,
//                  number(unitId, value, kind): void,
//                  reticle(unitId | null): void, status(unitId): void }
//
// Everything world-anchored goes through units.get(id).screen() — this module
// never projects on its own (the camera argument is accepted per contract and
// deliberately unused). It owns the floating chrome only and never touches
// panel or timeline DOM.
//
// §7.4 banner (pixel-identical across frames 04/05 — measured):
//   410×42 px (0.2515 fw × 0.0456 fh), centred x 0.494 fw, top y 0.203 fh.
//   Steel-teal glass rgba(9,49,69,.82) with the outer 50 px each side fading
//   to 0; 1 px #7e98a6 hairlines top and bottom at 55 % (bottom brighter —
//   frame05 samples #8aacb6 there); text #dff5ff ~19 px, +0.04 em tracking,
//   faint glow. In: fade + 12 px slide-down over 120 ms; hold ≥ 900 ms;
//   out: fade + 8 px slide-up over 180 ms. Under ?freeze= the hold pins open
//   so the deterministic capture always shows the banner (frame04 is shot at
//   burst peak with "Firaga" up).
//
// §7.5 status icons: 40×34 px crimson diamonds planted at the unit's feet
//   projection (+8 px), fill #982f3d, top rim #d694a0, bottom shade #6d2530,
//   white glyph #ffeae9, gentle 1 Hz bob, horizontal 4 px stacking, and the
//   little white duration tick at the lower right that both frame05 icons
//   carry. Statuses are synced from unit.statuses every frame (status(id)
//   just pops the newest icon), so icons can never silently fail to appear.
//
// §7.5 damage numerals: spawned at unit chest +24 px with ±14 px x-jitter,
//   34 px white #f4f7ff with a 2 px #1d1410 outline; crit gold #ffe9a6 at
//   1.4×; heal #7dffa8; MP #5aa6bd. Pop to 1.4× in 90 ms → settle 1.0× →
//   rise 28 px fading over 650 ms.
//
// §7.5 target reticle: four cyan corner brackets forming a 64 px diamond
//   around the target centre, #3fc9f2 2 px hairlines, rotating 4°/s, scale
//   pulsing ±6 % at 1.1 Hz.
//
// No webfonts: the bible's battle face is the bold humanist system-ui stack.
// Banner is DOM (crisp text + wall-clock CSS transitions so the 120/180 ms
// moves stay smooth even under software GL); numerals, icons and the reticle
// are one full-viewport canvas repainted per frame.
// ---------------------------------------------------------------------------

'use strict'

// ---------------------------------------------------------------------------
// §7.4 / §7.5 binding numbers (px quoted at 1630×921, scaled live)
// ---------------------------------------------------------------------------

const BANNER_W = 0.2515          // fw
const BANNER_H = 0.0456          // fh
const BANNER_CX = 0.494          // fw
const BANNER_TOP = 0.203         // fh
const BANNER_FONT = 19           // px @921 (cap height 13)
const BANNER_IN_S = 0.120
const BANNER_HOLD_S = 0.900
const BANNER_OUT_S = 0.180

const NUM_FONT = 34              // px @921
const NUM_POP_S = 0.090
const NUM_SETTLE_S = 0.180
const NUM_RISE_S = 0.650
const NUM_RISE_PX = 28
const NUM_JITTER = 14
const NUM_CHEST = 24             // px above the chest anchor

const ICON_W = 40                // px @921 (wider than tall — bible)
const ICON_H = 34
const ICON_GAP = 4
const ICON_FEET_DY = 8
const ICON_BOB_HZ = 1.0
const ICON_BOB_PX = 2

const RET_SIZE = 64              // point-to-point diamond
const RET_ROT_DPS = 4            // degrees per second
const RET_PULSE_HZ = 1.1
const RET_PULSE = 0.06
const RET_FADE_S = 0.120

const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

const KIND_STYLE = {
  damage: { fill: '#f4f7ff', scale: 1.0 },
  dmg:    { fill: '#f4f7ff', scale: 1.0 },
  crit:   { fill: '#ffe9a6', scale: 1.4 },
  heal:   { fill: '#7dffa8', scale: 1.0 },
  mp:     { fill: '#5aa6bd', scale: 0.9 },
  miss:   { fill: '#cfd6dd', scale: 0.85 },
}
const OUTLINE = '#1d1410'

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
const easeOutCubic = (t) => 1 - (1 - t) * (1 - t) * (1 - t)

// ---------------------------------------------------------------------------
// CSS — banner chrome. Geometry that depends on fw/fh is set inline by
// relayout(); classes only carry state transitions.
// ---------------------------------------------------------------------------

const CSS_ID = 'bt-callouts-css'
const CSS = `
#bt-callouts{position:absolute;inset:0;pointer-events:none;overflow:hidden;}
#bt-callouts canvas{position:absolute;left:0;top:0;display:block;}
.bc-banner{position:absolute;display:flex;align-items:center;justify-content:center;
  background:linear-gradient(90deg,rgba(9,49,69,0) 0%,rgba(9,49,69,.82) 12.2%,rgba(9,49,69,.82) 87.8%,rgba(9,49,69,0) 100%);
  opacity:0;transform:translate(-50%,-12px);will-change:opacity,transform;
  transition:opacity .18s ease-in,transform .18s ease-in;}
.bc-banner.bc-show{opacity:1;transform:translate(-50%,0);
  transition:opacity .12s cubic-bezier(.2,.7,.3,1),transform .12s cubic-bezier(.2,.7,.3,1);}
.bc-banner.bc-out{opacity:0;transform:translate(-50%,-8px);
  transition:opacity .18s ease-in,transform .18s ease-in;}
.bc-banner .bc-hl{position:absolute;left:0;right:0;height:1px;pointer-events:none;}
.bc-banner .bc-hl-t{top:0;
  background:linear-gradient(90deg,rgba(126,152,166,0) 0%,rgba(126,152,166,.55) 12.2%,rgba(126,152,166,.55) 87.8%,rgba(126,152,166,0) 100%);}
.bc-banner .bc-hl-b{bottom:0;
  background:linear-gradient(90deg,rgba(138,172,182,0) 0%,rgba(138,172,182,.78) 12.2%,rgba(138,172,182,.78) 87.8%,rgba(138,172,182,0) 100%);}
.bc-banner .bc-txt{color:#dff5ff;letter-spacing:.04em;white-space:nowrap;
  font-family:${FONT_STACK};font-weight:600;
  text-shadow:0 0 1px rgba(223,245,255,.9),0 1px 2px rgba(0,12,22,.65),0 0 9px rgba(140,215,255,.28);}
`

// ---------------------------------------------------------------------------
// Status icon glyph painters (white #ffeae9 strokes on the crimson diamond).
// 'stone' is the shipped status (frame05's petrified pair); a few generics
// keep unknown statuses legible instead of invisible.
// ---------------------------------------------------------------------------

function glyphFor(name) {
  const n = String(name || '').toLowerCase()
  if (n.indexOf('stone') >= 0 || n.indexOf('petrif') >= 0 || n.indexOf('paral') >= 0 || n.indexOf('disable') >= 0) return 'nought'
  if (n.indexOf('poison') >= 0 || n.indexOf('venom') >= 0) return 'drop'
  if (n.indexOf('slow') >= 0 || n.indexOf('stop') >= 0) return 'clock'
  if (n.indexOf('blind') >= 0 || n.indexOf('dark') >= 0) return 'eye'
  if (n.indexOf('silence') >= 0 || n.indexOf('mute') >= 0) return 'dots'
  return 'bang'
}

function paintGlyph(ctx, kind, r) {
  // centred at (0,0); r ≈ glyph radius. White with a soft dark seat.
  ctx.save()
  ctx.strokeStyle = '#ffeae9'
  ctx.fillStyle = '#ffeae9'
  ctx.lineWidth = Math.max(1.4, r * 0.30)
  ctx.lineCap = 'round'
  ctx.shadowColor = 'rgba(60,8,14,0.8)'
  ctx.shadowBlur = 1.5
  ctx.shadowOffsetY = 1
  if (kind === 'nought') {                     // Ø — circle + slash
    ctx.beginPath()
    ctx.arc(0, 0, r * 0.72, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(r * 0.78, -r * 0.78)
    ctx.lineTo(-r * 0.78, r * 0.78)
    ctx.stroke()
  } else if (kind === 'drop') {                // poison droplet
    ctx.beginPath()
    ctx.moveTo(0, -r * 0.85)
    ctx.quadraticCurveTo(r * 0.75, 0.1 * r, 0, r * 0.8)
    ctx.quadraticCurveTo(-r * 0.75, 0.1 * r, 0, -r * 0.85)
    ctx.fill()
  } else if (kind === 'clock') {               // slow/stop
    ctx.beginPath()
    ctx.arc(0, 0, r * 0.72, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(0, -r * 0.45)
    ctx.moveTo(0, 0)
    ctx.lineTo(r * 0.35, r * 0.12)
    ctx.stroke()
  } else if (kind === 'eye') {                 // blind — eye + slash
    ctx.beginPath()
    ctx.ellipse(0, 0, r * 0.8, r * 0.45, 0, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(0, 0, r * 0.16, 0, Math.PI * 2)
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(r * 0.7, -r * 0.7)
    ctx.lineTo(-r * 0.7, r * 0.7)
    ctx.stroke()
  } else if (kind === 'dots') {                // silence — ellipsis
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath()
      ctx.arc(i * r * 0.55, 0, r * 0.16, 0, Math.PI * 2)
      ctx.fill()
    }
  } else {                                     // '!' fallback
    ctx.beginPath()
    ctx.moveTo(0, -r * 0.75)
    ctx.lineTo(0, r * 0.2)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(0, r * 0.68, r * 0.14, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

/** Bake one status-icon tile at layout scale. */
function bakeStatusIcon(glyph, sy, dpr) {
  const w = Math.max(12, ICON_W * sy)
  const h = Math.max(10, ICON_H * sy)
  const pad = Math.ceil(w * 0.22)
  const cw = Math.ceil(w + pad * 2)
  const chh = Math.ceil(h + pad * 2)
  const c = document.createElement('canvas')
  c.width = Math.max(2, Math.round(cw * dpr))
  c.height = Math.max(2, Math.round(chh * dpr))
  const ctx = c.getContext('2d')
  ctx.scale(dpr, dpr)
  const ax = cw / 2
  const ay = chh / 2
  const hw = w / 2
  const hh = h / 2

  // drop shadow + crimson body
  ctx.save()
  ctx.shadowColor = 'rgba(4,10,16,0.5)'
  ctx.shadowBlur = w * 0.10
  ctx.shadowOffsetY = 1.5
  ctx.beginPath()
  ctx.moveTo(ax, ay - hh)
  ctx.lineTo(ax + hw, ay)
  ctx.lineTo(ax, ay + hh)
  ctx.lineTo(ax - hw, ay)
  ctx.closePath()
  const g = ctx.createLinearGradient(0, ay - hh, 0, ay + hh)
  g.addColorStop(0, '#bb3d4e')
  g.addColorStop(0.5, '#982f3d')
  g.addColorStop(1, '#7c2531')
  ctx.fillStyle = g
  ctx.fill()
  ctx.restore()
  // bottom shade edges then top rim
  ctx.beginPath()
  ctx.moveTo(ax - hw + 1, ay + 1)
  ctx.lineTo(ax, ay + hh)
  ctx.lineTo(ax + hw - 1, ay + 1)
  ctx.lineWidth = Math.max(1, w * 0.05)
  ctx.strokeStyle = '#6d2530'
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(ax - hw + 1, ay - 1)
  ctx.lineTo(ax, ay - hh + 1)
  ctx.lineTo(ax + hw - 1, ay - 1)
  ctx.lineWidth = Math.max(1, w * 0.045)
  ctx.strokeStyle = '#d694a0'
  ctx.stroke()

  // glyph — 18 px @921 → r ≈ 10·sy (reads at capture scale)
  ctx.save()
  ctx.translate(ax, ay)
  paintGlyph(ctx, glyph, 10 * sy)
  ctx.restore()

  // the little white duration tick at the lower right (both frame05 icons)
  ctx.save()
  ctx.font = `700 ${Math.max(6, 9 * sy)}px ${FONT_STACK}`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.lineWidth = Math.max(1.5, 2 * sy)
  ctx.strokeStyle = OUTLINE
  ctx.fillStyle = '#f6f8fa'
  const tx = ax + hw * 0.62
  const ty = ay + hh * 0.86
  ctx.strokeText('1', tx, ty)
  ctx.fillText('1', tx, ty)
  ctx.restore()

  return { canvas: c, ax, ay }
}

// ---------------------------------------------------------------------------
// createCallouts
// ---------------------------------------------------------------------------

export function createCallouts({ units, camera }) {
  void camera // accepted per contract; all anchoring goes through screen()

  if (!document.getElementById(CSS_ID)) {
    const style = document.createElement('style')
    style.id = CSS_ID
    style.textContent = CSS
    document.head.appendChild(style)
  }
  const mount = document.getElementById('ui') || document.body
  const root = document.createElement('div')
  root.id = 'bt-callouts'

  const canvas = document.createElement('canvas')
  root.appendChild(canvas)
  const ctx = canvas.getContext('2d')

  // banner DOM
  const banner = document.createElement('div')
  banner.className = 'bc-banner'
  const hlT = document.createElement('i')
  hlT.className = 'bc-hl bc-hl-t'
  const hlB = document.createElement('i')
  hlB.className = 'bc-hl bc-hl-b'
  const txt = document.createElement('span')
  txt.className = 'bc-txt'
  banner.appendChild(hlT)
  banner.appendChild(txt)
  banner.appendChild(hlB)
  root.appendChild(banner)
  mount.appendChild(root)

  // ?freeze= capture: pin the banner open so the deterministic shot always
  // carries the skill name, exactly like frame04 at burst peak.
  let freezeSticky = false
  try {
    freezeSticky = /[?&]freeze=/.test(String(window.location.search || ''))
  } catch (_) { /* no window/location — run with normal timing */ }

  // ---- layout -------------------------------------------------------------
  const layout = { vw: 0, vh: 0, dpr: 1, sy: 1 }
  const iconTiles = new Map()      // glyph → tile

  function relayout() {
    const vw = window.innerWidth || 1600
    const vh = window.innerHeight || 900
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2.5)
    if (vw === layout.vw && vh === layout.vh && dpr === layout.dpr) return
    layout.vw = vw
    layout.vh = vh
    layout.dpr = dpr
    layout.sy = vh / 921
    canvas.width = Math.round(vw * dpr)
    canvas.height = Math.round(vh * dpr)
    canvas.style.width = vw + 'px'
    canvas.style.height = vh + 'px'
    // banner geometry — §7.4 fractions
    banner.style.left = (BANNER_CX * 100) + '%'
    banner.style.top = Math.round(BANNER_TOP * vh) + 'px'
    banner.style.width = Math.round(BANNER_W * vw) + 'px'
    banner.style.height = Math.round(BANNER_H * vh) + 'px'
    txt.style.fontSize = Math.max(11, Math.round(BANNER_FONT * layout.sy)) + 'px'
    iconTiles.clear()              // rebake lazily at the new scale
  }

  function iconTile(glyph) {
    let t = iconTiles.get(glyph)
    if (!t) {
      t = bakeStatusIcon(glyph, layout.sy, layout.dpr)
      iconTiles.set(glyph, t)
    }
    return t
  }

  // ---- banner state machine ----------------------------------------------
  const ban = { phase: 'idle', t: 0 }   // idle | in | hold | out

  function announce(text) {
    txt.textContent = String(text == null ? '' : text)
    banner.classList.remove('bc-out')
    banner.classList.add('bc-show')
    ban.phase = 'in'
    ban.t = 0
  }

  function stepBanner(dt) {
    ban.t += dt
    switch (ban.phase) {
      case 'in':
        if (ban.t >= BANNER_IN_S) { ban.phase = 'hold'; ban.t = 0 }
        break
      case 'hold':
        // §7.4: hold ≥ 900 ms; under ?freeze= the hold pins open
        if (!freezeSticky && ban.t >= BANNER_HOLD_S) {
          banner.classList.remove('bc-show')
          banner.classList.add('bc-out')
          ban.phase = 'out'
          ban.t = 0
        }
        break
      case 'out':
        if (ban.t >= BANNER_OUT_S) {
          banner.classList.remove('bc-out')
          ban.phase = 'idle'
          ban.t = 0
        }
        break
    }
  }

  // ---- damage numerals ----------------------------------------------------
  // spawned at chest +24 px, ±14 px jitter; position captured at spawn so
  // numbers hang in the air while the sprite recoils under them
  const numerals = []
  let jitterSeq = 0

  function number(unitId, value, kind) {
    const u = units && units.get ? units.get(unitId) : null
    if (!u || !u.screen) return
    const scr = u.screen()
    const chestFrac = u.isEnemy ? 0.34 : 0.62
    const style = KIND_STYLE[String(kind || 'damage').toLowerCase()] || KIND_STYLE.damage
    const isNum = typeof value === 'number' && isFinite(value)
    const text = isNum ? String(Math.round(Math.abs(value))) : String(value == null ? 'MISS' : value)
    jitterSeq++
    const jx = ((jitterSeq * 0.6180339887) % 1 - 0.5) * 2 * NUM_JITTER * layout.sy
    // simultaneous hits on one unit stack upward instead of overprinting
    let live = 0
    for (const n of numerals) if (n.unitId === unitId && n.t < 0.4) live++
    numerals.push({
      unitId,
      text,
      fill: style.fill,
      k: style.scale,
      x: scr.x + jx,
      y: scr.y - scr.h * chestFrac - (NUM_CHEST + live * 30) * layout.sy,
      t: 0,
    })
    if (numerals.length > 24) numerals.splice(0, numerals.length - 24)
  }

  function drawNumerals(dt) {
    if (!numerals.length) return
    const sy = layout.sy
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineJoin = 'round'
    for (let i = numerals.length - 1; i >= 0; i--) {
      const n = numerals[i]
      n.t += dt
      const life = NUM_SETTLE_S + NUM_RISE_S
      if (n.t >= life) { numerals.splice(i, 1); continue }
      // pop 1.4× in 90 ms → settle 1.0× by 180 ms
      let sc
      if (n.t < NUM_POP_S) sc = 0.55 + (1.4 - 0.55) * easeOutCubic(n.t / NUM_POP_S)
      else if (n.t < NUM_SETTLE_S) sc = 1.4 - 0.4 * ((n.t - NUM_POP_S) / (NUM_SETTLE_S - NUM_POP_S))
      else sc = 1.0
      // rise 28 px fading over 650 ms
      const rq = clamp((n.t - NUM_SETTLE_S) / NUM_RISE_S, 0, 1)
      const y = n.y - NUM_RISE_PX * sy * easeOutCubic(rq)
      const alpha = rq < 0.35 ? 1 : 1 - (rq - 0.35) / 0.65
      const px = NUM_FONT * sy * sc * n.k
      ctx.font = `700 ${px.toFixed(1)}px ${FONT_STACK}`
      ctx.globalAlpha = clamp(alpha, 0, 1)
      ctx.lineWidth = Math.max(2, 2 * sy * sc)
      ctx.strokeStyle = OUTLINE
      ctx.strokeText(n.text, n.x, y)
      ctx.fillStyle = n.fill
      ctx.fillText(n.text, n.x, y)
      ctx.globalAlpha = 1
    }
  }

  // ---- status icons -------------------------------------------------------
  // authoritative sync from unit.statuses each frame; status(id) marks the
  // unit so its newest icon pops. shown: Map unitId → [{name, glyph, t}]
  const shown = new Map()
  const popRequests = new Set()

  function status(unitId) {
    if (unitId != null) popRequests.add(unitId)
  }

  function collectUnits() {
    const list = []
    const roster = (units && units.roster) || []
    for (const u of roster) list.push(u)
    if (units && units.enemy) list.push(units.enemy)
    return list
  }

  function stepStatuses(dt) {
    const all = collectUnits()
    for (const u of all) {
      const want = Array.isArray(u.statuses) ? u.statuses : []
      let row = shown.get(u.id)
      if (!row && want.length === 0) continue
      if (!row) { row = []; shown.set(u.id, row) }
      // removals fade out
      for (const ic of row) {
        if (want.indexOf(ic.name) < 0) ic.dying = true
      }
      // additions pop in
      for (const name of want) {
        let found = null
        for (const ic of row) if (ic.name === name && !ic.dying) { found = ic; break }
        if (!found) {
          row.push({ name, glyph: glyphFor(name), t: 0, dying: false, a: 0 })
          popRequests.delete(u.id)
        } else if (popRequests.has(u.id)) {
          found.t = 0                    // re-pop on an explicit poke
          popRequests.delete(u.id)
        }
      }
      for (let i = row.length - 1; i >= 0; i--) {
        const ic = row[i]
        ic.t += dt
        ic.a = ic.dying ? ic.a - dt / 0.18 : Math.min(1, ic.a + dt / 0.15)
        if (ic.dying && ic.a <= 0) row.splice(i, 1)
      }
      if (!row.length) shown.delete(u.id)
    }
  }

  function drawStatuses(tNow) {
    if (!shown.size) return
    const sy = layout.sy
    const stepX = (ICON_W + ICON_GAP) * sy
    for (const [unitId, row] of shown) {
      if (!row.length) continue
      const u = units && units.get ? units.get(unitId) : null
      if (!u || !u.screen || !(u.hp > 0 || u.alive !== false)) continue
      const scr = u.screen()
      // feet projection +8 px, clamped to kiss the panel band like frame05
      const cy0 = Math.min(scr.y + ICON_FEET_DY * sy, 0.824 * layout.vh)
      const total = (row.length - 1) * stepX
      for (let i = 0; i < row.length; i++) {
        const ic = row[i]
        const tile = iconTile(ic.glyph)
        // gentle 1 Hz bob, phase-offset per slot; pop-in scale
        const bob = Math.sin((tNow + i * 0.35) * Math.PI * 2 * ICON_BOB_HZ) * ICON_BOB_PX * sy
        const pop = ic.t < 0.15 ? 1.3 - 0.3 * easeOutCubic(ic.t / 0.15) : 1
        const cx = scr.x - total / 2 + i * stepX
        const cy = cy0 + bob
        const dpr = layout.dpr
        const w = (tile.canvas.width / dpr) * pop
        const h = (tile.canvas.height / dpr) * pop
        ctx.globalAlpha = clamp(ic.a, 0, 1)
        ctx.drawImage(tile.canvas, cx - tile.ax * pop, cy - tile.ay * pop, w, h)
        ctx.globalAlpha = 1
      }
    }
  }

  // ---- target reticle -----------------------------------------------------
  const ret = { id: null, alpha: 0, angle: 0 }

  function reticle(unitId) {
    ret.id = unitId == null ? null : unitId
  }

  function drawReticle(dt, tNow) {
    const want = ret.id != null
    ret.alpha = clamp(ret.alpha + (want ? dt : -dt) / RET_FADE_S, 0, 1)
    if (ret.alpha <= 0.004) return
    const u = ret.id != null && units && units.get ? units.get(ret.id) : null
    if (!u || !u.screen) return
    const scr = u.screen()
    const cx = scr.x
    const cy = scr.y - scr.h * (u.isEnemy ? 0.42 : 0.5)
    ret.angle += RET_ROT_DPS * (Math.PI / 180) * dt
    const pulse = 1 + RET_PULSE * Math.sin(tNow * Math.PI * 2 * RET_PULSE_HZ)
    const r = (RET_SIZE / 2) * layout.sy * pulse

    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(ret.angle)
    ctx.globalAlpha = ret.alpha
    ctx.strokeStyle = '#3fc9f2'
    ctx.lineWidth = Math.max(1.6, 2.2 * layout.sy)
    ctx.lineCap = 'round'
    ctx.shadowColor = 'rgba(63,201,242,0.85)'
    ctx.shadowBlur = 6 * layout.sy
    const seg = r * 0.42               // bracket arm length along each edge
    // four corner brackets at the diamond vertices: N E S W
    for (let v = 0; v < 4; v++) {
      const a = (v * Math.PI) / 2 - Math.PI / 2       // vertex angle
      const vx = Math.cos(a) * r
      const vy = Math.sin(a) * r
      // edge directions from this vertex toward its two neighbours
      for (const dv of [1, -1]) {
        const na = ((v + dv + 4) % 4) * Math.PI / 2 - Math.PI / 2
        const nx = Math.cos(na) * r
        const ny = Math.sin(na) * r
        const dx = nx - vx
        const dy = ny - vy
        const len = Math.hypot(dx, dy) || 1
        ctx.beginPath()
        ctx.moveTo(vx, vy)
        ctx.lineTo(vx + (dx / len) * seg, vy + (dy / len) * seg)
        ctx.stroke()
      }
    }
    ctx.restore()
  }

  // ---- per-frame ----------------------------------------------------------
  let tNow = 0

  function update(dt) {
    const step = typeof dt === 'number' && isFinite(dt) ? clamp(dt, 0, 0.5) : 0.016
    tNow += step
    relayout()

    const dpr = layout.dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, layout.vw, layout.vh)

    stepBanner(step)
    stepStatuses(step)
    drawReticle(step, tNow)
    drawStatuses(tNow)
    drawNumerals(step)
  }

  relayout()
  update(0)

  return { dom: root, update, announce, number, reticle, status }
}
