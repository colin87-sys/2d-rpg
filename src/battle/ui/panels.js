// ---------------------------------------------------------------------------
// src/battle/ui/panels.js — party HP/MP panels + enemy HP/break gauges
//
//   export function createPanels({ units }): PanelsUI
//   PanelsUI = { dom: HTMLElement, update(dt): void }
//
// Owns the bottom band (y > 0.83 fh): the four 204×138 glass panels of
// BATTLE_BIBLE §7.2 at 0.1319 fw pitch, and the enemy HP + break gauges of
// §7.3 anchored under the enemy via units.enemy.screen(). Nothing else.
//
// Every geometry/colour constant below is typed in from BATTLE_BIBLE §7.2/§7.3
// (pixel-sampled off docs/reference/frame04.png). Three places the reference
// IMAGE overrules / refines the bible prose ("the images win"):
//
//   1. LIMIT ROW SEGMENTATION — frame04 shows the bottom gauge as TWO beveled
//      pills (x+14 w81 | 11 px gap | x+106 w80), not one 167 px strip; the
//      left pill is the limit gauge proper, the right a secondary (esper)
//      strip that is near-empty in every frame04 panel. frame05 shows the
//      bible's single x+18 w167 strip. Default here is the frame04 two-pill
//      look (frame04 is the primary target); a unit may opt into the frame05
//      form with `unit.limitSegments = 1`, and a secondary fill is read from
//      `unit.limit2 ?? unit.esper ?? 0`.
//   2. IGNITE SHAPE — Lasswell's full limit ignites a magenta wash across the
//      panel's full bottom strip (~y+102 → past the bottom edge, spilling a
//      few px beyond the glass), brightest over the full pill, while pill
//      TRACKS stay black and a small hot chip glows at the secondary pill's
//      left end. Sampled: fill core #f9cefb, edges #eb87f7, wash #f188fe →
//      #a951c1. Built exactly so, on top of the bible's #eb7cfe / #e371fd /
//      #a13daf shimmer law.
//   3. ENEMY GAUGE DRESSING — the enemy HP pill wears a visible 1 px pale
//      steel frame (sampled #4c4151-class) inside the dark outline, and the
//      break gauge's warm glow hugs the whole gold bevel (empty track
//      included), not just the fill. Both reproduced.
//
// Enemy block anchoring: bible says "block left ≈ enemy screen x − 0.065 fw,
// clamp [0.10, 0.30]" with measured lefts 0.152 (f04) / 0.194 (f05). Under the
// solved camera units.enemy.screen() yields x = 0.3293 fw (dragon forefeet) /
// 0.3595 fw (sorcerer mass), so the constant that actually reproduces BOTH
// measured positions through screen() is −0.171 fw (→ 0.158 / 0.189 after
// clamp, within 0.007 fw of both plates). y never moves: centres are FIXED at
// 0.747 fh (HP) and 0.769 fh (break).
//
// No webfonts, no assets: DOM + Canvas2D inside #ui, everything drawn here.
// Anti-aliased canvas is house-legal for UI (§7 "everything anti-aliased
// DOM/canvas"). Panels redraw only when dirty (stat delta or live animation:
// ghosts, count-downs, hairline flash, low-HP pulse, limit shimmer); the
// enemy strip redraws every frame (tiny) because its glow breathes and its x
// tracks the enemy.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// §7.2 party panel constants — design px at 1630 fw; scaled by s = fw / 1630
// ---------------------------------------------------------------------------

const REF_W = 1630                     // both reference plates are 1630×921

const PANEL_W = 204
const PANEL_H = 138
const PANEL_RADIUS = 4
const PANEL_TOP_FH = 0.836             // panel tops (fraction of frame height)
const PANEL_LEFT_FW = [0.4730, 0.6049, 0.7368, 0.8687]  // slot lefts, pitch 0.1319

const GLASS_TOP = '#474753'            // vertical glass gradient, α 0.86
const GLASS_BOT = '#243e4f'
const GLASS_ALPHA = 0.86
const HAIR_TOP = '#736e75'             // 1 px hairlines, per-edge colours
const HAIR_SIDE = '#676f7a'
const HAIR_BOT = '#5b6879'

const NAME_COLOR = '#e7e8ea'           // cap height 13 → fs 18.5
const NAME_X = 11
const NAME_BASE = 26
const NAME_FS = 18.5

const LABEL_X = 14                     // "HP"/"MP", cap 11 → fs 15.5
const LABEL_FS = 15.5
const HP_LABEL_G0 = '#084536'          // label vertical gradients (top → bottom)
const HP_LABEL_G1 = '#37a484'
const MP_LABEL_G0 = '#0d4661'
const MP_LABEL_G1 = '#5aa6bd'

const NUM_COLOR = '#f3f6fb'
const NUM_RIGHT = 185                  // numerals right-aligned to x+185
const HP_NUM_FS = 23.5                 // digit height 17 px
const MP_NUM_FS = 22.0                 // digit height 16 px
const HP_ROW_BASE = 56                 // shared label/numeral baselines
const MP_ROW_BASE = 89

const BAR_X = 18
const BAR_W = 167
const HP_BAR_Y = 60                    // y+60..68, 9 px beveled pill
const MP_BAR_Y = 93                    // y+93..101
const BAR_H = 9
const PILL_TRACK = '#05070a'

const HP_BEVEL_T = '#577573'           // 1 px pale pill edges
const HP_BEVEL_B = '#5d7074'
const HP_FILL = ['#14785c', '#51c9a6', '#286a5c']   // vertical: top→core→bottom
const HP_TIP = '#65cdac'
const HP_TIP_HOT = '#79e8c2'

const MP_BEVEL_T = '#587587'
const MP_BEVEL_B = '#527088'
const MP_FILL_L = '#287496'            // horizontal fill, core #3d89ad
const MP_FILL_CORE = '#3d89ad'
const MP_FILL_R = '#4595b8'
const MP_TIP = '#63b9d8'

// low-HP fill swaps (≤30% amber, ≤15% crimson + 1.2 Hz hairline pulse)
const HP_FILL_AMBER = ['#7c5619', '#d9a53f', '#8a6a24']
const HP_TIP_AMBER = '#ecc36a'
const HP_BEVEL_AMBER_T = '#7d7358'
const HP_BEVEL_AMBER_B = '#6f6749'
const HP_FILL_CRIT = ['#8a2436', '#c23a4e', '#7c2331']
const HP_TIP_CRIT = '#e0607a'
const HP_BEVEL_CRIT_T = '#7c5560'
const HP_BEVEL_CRIT_B = '#6f4a54'
const LOW_HP_AMBER = 0.30
const LOW_HP_CRIT = 0.15
const CRIT_PULSE_HZ = 1.2

// limit gauge — frame04 two-pill layout + frame05 single-strip option
const LIM_Y = 116                      // y+116..124, 8 px
const LIM_H = 8
const LIM_SEG1_X = 14                  // measured off frame04 (see header)
const LIM_SEG1_W = 81
const LIM_SEG2_X = 106
const LIM_SEG2_W = 80
const LIM_SINGLE_X = 18                // frame05 / bible single strip
const LIM_SINGLE_W = 167
const LIM_HAIR_T = '#5c6674'
const LIM_HAIR_B = '#616e7c'
const LIM_TRACK = '#171823'
const LIM_FILL = ['#7a3d82', '#b453d4', '#e97af5']  // horizontal, toward tip
const LIM_TIP = '#f2b0ea'
// full-state shimmer + ignite wash
const LIM_FULL_BASE = '#eb7cfe'
const LIM_FULL_END = '#e371fd'
const LIM_FULL_WAVE = '#a13daf'
const LIM_FULL_CORE = '#f9cefb'        // sampled hot centre of the full pill
const IGNITE_A = '#f188fe'             // wash bright (over the full pill)
const IGNITE_B = '#a951c1'             // wash mid
const IGNITE_C = '#6e2f86'             // wash tail
const IGNITE_GLOW = '#e97af5'          // ±10 px bloom colour

// damage / heal reads
const GHOST_DMG = '#e8637a'
const GHOST_HEAL = '#7dffa8'
const GHOST_MS = 0.400
const COUNT_MS = 0.350
const FLASH_COLOR = '#ff8896'
const FLASH_MS = 0.300

const PAD = 16                         // canvas gutter for shadow/glow spill

// ---------------------------------------------------------------------------
// §7.3 enemy gauge constants
// ---------------------------------------------------------------------------

const EG_W = 220                       // 0.135 fw
const EG_HP_H = 7
const EG_HP_CY_FH = 0.747              // FIXED centre-y fractions
const EG_BK_CY_FH = 0.769
const EG_BK_H = 9                      // + 2 px bevel each side
const EG_BK_BEVEL = 2
const EG_X_OFFSET_FW = -0.171          // enemy screen x + this → block left
const EG_CLAMP_LO = 0.10               //   (reproduces 0.152 f04 / 0.194 f05)
const EG_CLAMP_HI = 0.30
const EG_PAD = 18

const EG_HP_FILL = ['#4f2038', '#632740', '#822046', '#9d224e'] // trail→tip
const EG_HP_TIP_EDGE = '#8f2f52'
const EG_HP_TRACK = '#050508'
const EG_HP_FRAME = '#565662'          // sampled pale steel 1 px frame
const EG_HP_OUTLINE = '#050714'

const EG_BK_FILL = ['#7c653b', '#ac9c62', '#cfb286', '#e0c98f']
const EG_BK_SPEC = 'rgba(255,242,205,0.40)'   // hot specular top row
const EG_BK_TRACK_T = '#241c05'
const EG_BK_TRACK_B = '#070400'
const EG_BK_BEVEL_T = '#6a6142'
const EG_BK_BEVEL_B = '#584e2a'
const EG_BK_BEVEL_S = '#655c3a'
const EG_BK_GLOW = 'rgba(222,178,88,'  // completed with alpha at draw time
const EG_FADE_MS = 0.300               // §9 enemy death: gauges slow-fade 300 ms

// house UI face — bold humanist sans, system stack only (no webfonts).
// Liberation Sans sits before the generics so the headless-CI render matches
// the grotesque of the reference; desktops hit Segoe/system first.
const FONT_STACK =
  "-apple-system, 'Segoe UI', 'Liberation Sans', Roboto, 'Helvetica Neue', Arial, sans-serif"

const NUM_CONDENSE = 0.93              // slight x-condense on numerals (ref look)

// ---------------------------------------------------------------------------

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const easeOutCubic = (u) => 1 - Math.pow(1 - clamp01(u), 3)

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w * 0.5, h * 0.5)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.arcTo(x + w, y, x + w, y + rr, rr)
  ctx.lineTo(x + w, y + h - rr)
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr)
  ctx.lineTo(x + rr, y + h)
  ctx.arcTo(x, y + h, x, y + h - rr, rr)
  ctx.lineTo(x, y + rr)
  ctx.arcTo(x, y, x + rr, y, rr)
  ctx.closePath()
}

export function createPanels({ units }) {
  // ---- DOM scaffold --------------------------------------------------------
  const dom = document.createElement('div')
  dom.id = 'battle-panels'
  dom.style.cssText =
    'position:absolute;inset:0;pointer-events:none;z-index:30;overflow:hidden;'

  const roster = (units && units.roster) || []
  const enemy = units && units.enemy

  // ---- viewport state ------------------------------------------------------
  let vw = 0
  let vh = 0
  let s = 1                      // design→css scale, fw / 1630
  let dpr = 1
  let tNow = 0

  function viewportBox() {
    // #ui is fixed inset:0 → its box is the frame. Fall back to window before
    // the element is laid out (first construction frame).
    const host = dom.parentElement
    const w = host && host.clientWidth ? host.clientWidth : window.innerWidth
    const h = host && host.clientHeight ? host.clientHeight : window.innerHeight
    return { w, h }
  }

  // ---- per-unit panel state ------------------------------------------------
  // Everything a redraw needs, plus the animation clocks that make damage
  // legible: numeral count-downs, HP ghost trails, hairline flashes.
  const panels = roster.slice(0, 4).map((unit, slot) => ({
    unit,
    slot,
    canvas: document.createElement('canvas'),
    ctx: null,
    // last-seen stats (delta detection)
    prevHp: unit.hp,
    prevMp: unit.mp,
    prevLimit: unit.limit,
    prevKo: unit.hp <= 0,
    // numeral count animation (350 ms): displayed value chases the target
    hpCount: { from: unit.hp, to: unit.hp, t: COUNT_MS },
    mpCount: { from: unit.mp, to: unit.mp, t: COUNT_MS },
    // HP ghost segment: fractions of the bar [lo..hi], heal flag, life timer
    ghost: null,               // { lo, hi, heal, t }
    flash: 0,                  // damage hairline flash countdown (s)
    ignite: unit.limit >= 0.999 ? 1 : 0,   // full-limit wash ramp 0..1
    dirty: true,
  }))

  for (const p of panels) {
    p.canvas.style.cssText = 'position:absolute;left:0;top:0;'
    p.ctx = p.canvas.getContext('2d')
    dom.appendChild(p.canvas)
  }

  // ---- enemy gauge state ---------------------------------------------------
  const eg = {
    canvas: document.createElement('canvas'),
    ctx: null,
    x: 0,                      // smoothed block-left, css px
    xInit: false,
    fade: 1,                   // §9 death fade
    prevHp: enemy ? enemy.hp : 0,
  }
  eg.canvas.style.cssText = 'position:absolute;left:0;top:0;will-change:transform;'
  eg.ctx = eg.canvas.getContext('2d')
  if (enemy) dom.appendChild(eg.canvas)

  // ---- layout --------------------------------------------------------------
  function layout() {
    const box = viewportBox()
    vw = box.w
    vh = box.h
    s = vw / REF_W
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    const k = s * dpr

    // party panels: tops at 0.836 fh, lefts at the bible fractions; keep the
    // glass fully on-frame if the viewport is squatter than 1630:921.
    const cssPanelW = (PANEL_W + PAD * 2) * s
    const cssPanelH = (PANEL_H + PAD * 2) * s
    const topCss = Math.min(PANEL_TOP_FH * vh, vh - PANEL_H * s - 4)
    for (const p of panels) {
      const leftCss = PANEL_LEFT_FW[p.slot] * vw
      p.canvas.style.left = (leftCss - PAD * s).toFixed(2) + 'px'
      p.canvas.style.top = (topCss - PAD * s).toFixed(2) + 'px'
      p.canvas.style.width = cssPanelW.toFixed(2) + 'px'
      p.canvas.style.height = cssPanelH.toFixed(2) + 'px'
      p.canvas.width = Math.max(2, Math.round((PANEL_W + PAD * 2) * k))
      p.canvas.height = Math.max(2, Math.round((PANEL_H + PAD * 2) * k))
      p.dirty = true
    }

    // enemy gauge canvas: content = HP bar top → break bevel bottom.
    const contentH = egContentH()
    eg.canvas.width = Math.max(2, Math.round((EG_W + EG_PAD * 2) * k))
    eg.canvas.height = Math.max(2, Math.round((contentH + EG_PAD * 2) * k))
    eg.canvas.style.width = ((EG_W + EG_PAD * 2) * s).toFixed(2) + 'px'
    eg.canvas.style.height = ((contentH + EG_PAD * 2) * s).toFixed(2) + 'px'
  }

  // local-y layout of the enemy strip (design px, origin = HP bar top)
  function egContentH() {
    const gap = (EG_BK_CY_FH - EG_HP_CY_FH) * 921 // centre spacing at ref height
    return EG_HP_H / 2 + gap + EG_BK_H / 2 + EG_BK_BEVEL
  }

  // =========================================================================
  //  PARTY PANEL DRAWING
  // =========================================================================

  function panelFont(weight, fs) {
    return weight + ' ' + fs + 'px ' + FONT_STACK
  }

  // Tabular numerals: each digit hand-placed on a fixed advance so count-down
  // frames never jitter, with a slight x-condense to match the reference set.
  function drawNumerals(ctx, text, rightX, baseline, fs, fillStyle) {
    ctx.font = panelFont('700', fs)
    const adv = ctx.measureText('8').width * NUM_CONDENSE + 0.4
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
    let cx = rightX - adv / 2
    for (let i = text.length - 1; i >= 0; i--) {
      ctx.save()
      ctx.translate(cx, baseline)
      ctx.scale(NUM_CONDENSE, 1)
      ctx.fillStyle = 'rgba(5,11,16,0.6)'   // 1 px dark seat under the digit
      ctx.fillText(text[i], 0, 1)
      ctx.fillStyle = fillStyle
      ctx.fillText(text[i], 0, 0)
      ctx.restore()
      cx -= adv
    }
    ctx.textAlign = 'left'
  }

  function drawGradientLabel(ctx, text, x, baseline, fs, c0, c1) {
    ctx.font = panelFont('700', fs)
    const capH = fs * 0.72
    const g = ctx.createLinearGradient(0, baseline - capH, 0, baseline)
    g.addColorStop(0, c0)
    g.addColorStop(1, c1)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    // 1 px dark seat under the glyphs lifts them off the glass (sampled)
    ctx.fillStyle = 'rgba(4,14,18,0.55)'
    ctx.fillText(text, x, baseline + 1)
    ctx.fillStyle = g
    ctx.fillText(text, x, baseline)
  }

  // Beveled pill: 1 px pale rounded frame, near-black track, gradient fill.
  // kind: 'hp' (vertical fill ramp + horizontal lift toward tip)
  //       'mp' (horizontal ramp)  'limit' (horizontal ramp)
  function drawPill(ctx, x, y, w, h, frac, kind, opts) {
    const o = opts || {}
    const r = 2.5
    // track
    roundRectPath(ctx, x, y, w, h, r)
    ctx.fillStyle = o.track || PILL_TRACK
    ctx.fill()
    // inner top shade line on the track (slight recession)
    ctx.fillStyle = 'rgba(0,0,0,0.5)'
    ctx.fillRect(x + 1, y + 1, w - 2, 1)

    // fill
    const fw = Math.round((w - 2) * clamp01(frac))
    if (fw > 0) {
      const fx = x + 1
      const fy = y + 1
      const fh = h - 2
      ctx.save()
      roundRectPath(ctx, fx, fy, fw, fh, 1.5)
      ctx.clip()
      let g
      if (kind === 'hp') {
        const ramp = o.fill
        g = ctx.createLinearGradient(0, fy, 0, fy + fh)
        g.addColorStop(0, ramp[0])
        g.addColorStop(0.45, ramp[1])
        g.addColorStop(1, ramp[2])
        ctx.fillStyle = g
        ctx.fillRect(fx, fy, fw, fh)
        // gentle horizontal lift toward the leading edge (sampled f04)
        const lift = ctx.createLinearGradient(fx, 0, fx + fw, 0)
        lift.addColorStop(0, 'rgba(130,255,215,0)')
        lift.addColorStop(1, 'rgba(130,255,215,0.14)')
        ctx.fillStyle = lift
        ctx.fillRect(fx, fy, fw, fh)
      } else {
        const ramp = o.fill
        g = ctx.createLinearGradient(fx, 0, fx + Math.max(fw, 8), 0)
        g.addColorStop(0, ramp[0])
        g.addColorStop(0.6, ramp[1])
        g.addColorStop(1, ramp[2])
        ctx.fillStyle = g
        ctx.fillRect(fx, fy, fw, fh)
        // thin top-row lighten so the pill reads rounded
        ctx.fillStyle = 'rgba(255,255,255,0.10)'
        ctx.fillRect(fx, fy, fw, 1)
      }
      // leading-tip highlight
      if (o.tip && fw > 6) {
        const tg = ctx.createLinearGradient(fx + fw - 10, 0, fx + fw, 0)
        tg.addColorStop(0, 'rgba(255,255,255,0)')
        tg.addColorStop(1, o.tip)
        ctx.fillStyle = tg
        ctx.fillRect(fx + fw - 10, fy, 10, fh)
        if (o.tipHot) {
          ctx.fillStyle = o.tipHot
          ctx.fillRect(fx + fw - 2, fy, 2, fh)
        }
      }
      ctx.restore()
    }

    // ghost segment (damage red trailing beyond the fill / heal green atop it)
    if (o.ghost && o.ghost.t > 0) {
      const gh = o.ghost
      const a = clamp01(gh.t / GHOST_MS)
      const gx0 = x + 1 + Math.round((w - 2) * clamp01(gh.lo))
      const gx1 = x + 1 + Math.round((w - 2) * clamp01(gh.hi))
      if (gx1 > gx0) {
        ctx.globalAlpha = (gh.heal ? 0.75 : 0.9) * a
        ctx.fillStyle = gh.heal ? GHOST_HEAL : GHOST_DMG
        ctx.fillRect(gx0, y + 1, gx1 - gx0, h - 2)
        ctx.globalAlpha = 1
      }
    }

    // beveled frame: vertical gradient stroke so top/bottom edge colours match
    // the sampled pair while the end-caps blend between them
    const bg = ctx.createLinearGradient(0, y, 0, y + h)
    bg.addColorStop(0, o.bevelT)
    bg.addColorStop(1, o.bevelB)
    ctx.strokeStyle = bg
    ctx.lineWidth = 1
    roundRectPath(ctx, x + 0.5, y + 0.5, w - 1, h - 1, r)
    ctx.stroke()
  }

  // Full-limit shimmer fill (bible law): base #eb7cfe, bright ends #e371fd,
  // a dark #a13daf wave travelling the strip, hot #f9cefb core (sampled).
  function drawFullLimitFill(ctx, fx, fy, fw, fh, phase) {
    const wp = phase % 1
    const g = ctx.createLinearGradient(fx, 0, fx + fw, 0)
    const stops = [
      [0.0, LIM_FULL_END],
      [0.35, LIM_FULL_CORE],
      [0.7, LIM_FULL_CORE],
      [1.0, LIM_FULL_END],
    ]
    for (const [p, c] of stops) g.addColorStop(p, c)
    ctx.fillStyle = g
    ctx.fillRect(fx, fy, fw, fh)
    // base tint pass keeps the whole strip in the #eb7cfe family
    ctx.fillStyle = 'rgba(235,124,254,0.22)'
    ctx.fillRect(fx, fy, fw, fh)
    // travelling dark wave — a soft sheen passing through, not a hard band
    const w0 = clamp01(wp - 0.24)
    const w1 = clamp01(wp + 0.24)
    if (w1 > w0) {
      const wg = ctx.createLinearGradient(fx, 0, fx + fw, 0)
      wg.addColorStop(0, 'rgba(161,61,175,0)')
      if (w0 > 0) wg.addColorStop(w0, 'rgba(161,61,175,0)')
      wg.addColorStop(wp, 'rgba(161,61,175,0.45)')
      if (w1 < 1) wg.addColorStop(w1, 'rgba(161,61,175,0)')
      wg.addColorStop(1, 'rgba(161,61,175,0)')
      ctx.fillStyle = wg
      ctx.fillRect(fx, fy, fw, fh)
    }
    // white-hot 1 px specular
    ctx.fillStyle = 'rgba(255,235,255,0.5)'
    ctx.fillRect(fx, fy, fw, 1)
  }

  // The ignite wash: a magenta band across the panel's full bottom strip,
  // brightest over the full pill, spilling a few px past the glass (frame04).
  // Composed on a scratch canvas (colour run × radial hotspot × vertical
  // alpha envelope via destination-in) then added over the glass with
  // 'lighter' — never touches pixels outside its own sprite.
  let washScratch = null
  function drawIgniteWash(ctx, ign, phase, seg1Cx) {
    const breath = 1 + 0.12 * Math.sin(phase * Math.PI * 2 * 0.8)
    const a = clamp01(0.62 * ign * breath)
    if (a <= 0.003) return
    const X0 = -8                      // design-space band, spills past the glass
    const W = PANEL_W + 16
    const y0 = LIM_Y - 11              // just under the MP pill, per frame04
    const H = PANEL_H + 5 - y0
    const k = s * dpr
    const bw = Math.max(2, Math.ceil(W * k))
    const bh = Math.max(2, Math.ceil(H * k))
    if (!washScratch) washScratch = document.createElement('canvas')
    if (washScratch.width !== bw || washScratch.height !== bh) {
      washScratch.width = bw
      washScratch.height = bh
    }
    const w2 = washScratch.getContext('2d')
    w2.setTransform(k, 0, 0, k, 0, 0)
    w2.globalCompositeOperation = 'source-over'
    w2.clearRect(0, 0, W, H)
    // horizontal colour run, peaked at the full pill
    const px = clamp01((seg1Cx - X0) / W)
    const hg = w2.createLinearGradient(0, 0, W, 0)
    hg.addColorStop(Math.max(0, px - 0.35), IGNITE_B)
    hg.addColorStop(px, IGNITE_A)
    hg.addColorStop(Math.min(1, px + 0.45), IGNITE_B)
    hg.addColorStop(1, IGNITE_C)
    w2.fillStyle = hg
    w2.fillRect(0, 0, W, H)
    // hot core blooming off the full pill — kept pink, never white-hot, so the
    // additive pass over the teal glass stays in the magenta family
    const rg = w2.createRadialGradient(seg1Cx - X0, H * 0.55, 1, seg1Cx - X0, H * 0.55, W * 0.40)
    rg.addColorStop(0, 'rgba(252,182,250,0.42)')
    rg.addColorStop(0.35, 'rgba(241,136,254,0.22)')
    rg.addColorStop(1, 'rgba(241,136,254,0)')
    w2.globalCompositeOperation = 'lighter'
    w2.fillStyle = rg
    w2.fillRect(0, 0, W, H)
    // vertical alpha envelope: fade in below the MP row, out past the glass
    w2.globalCompositeOperation = 'destination-in'
    const vg = w2.createLinearGradient(0, 0, 0, H)
    vg.addColorStop(0, 'rgba(0,0,0,0)')
    vg.addColorStop(0.48, 'rgba(0,0,0,1)')
    vg.addColorStop(0.84, 'rgba(0,0,0,0.85)')
    vg.addColorStop(1, 'rgba(0,0,0,0)')
    w2.fillStyle = vg
    w2.fillRect(0, 0, W, H)
    // add over the glass
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = a
    ctx.drawImage(washScratch, 0, 0, bw, bh, X0, y0, W, H)
    ctx.restore()
  }

  function limitLayout(unit) {
    const segs = unit && unit.limitSegments === 1 ? 1 : 2
    if (segs === 1) return { segs, s1x: LIM_SINGLE_X, s1w: LIM_SINGLE_W }
    return { segs, s1x: LIM_SEG1_X, s1w: LIM_SEG1_W, s2x: LIM_SEG2_X, s2w: LIM_SEG2_W }
  }

  function drawPanel(p) {
    const u = p.unit
    const ctx = p.ctx
    const k = s * dpr
    ctx.setTransform(k, 0, 0, k, PAD * k, PAD * k)
    ctx.clearRect(-PAD, -PAD, PANEL_W + PAD * 2, PANEL_H + PAD * 2)

    const hpMax = u.hpMax > 0 ? u.hpMax : 1
    const mpMax = u.mpMax > 0 ? u.mpMax : 1
    const hpFrac = clamp01(u.hp / hpMax)
    const mpFrac = clamp01(u.mp / mpMax)
    const limit = clamp01(u.limit || 0)
    const ko = u.hp <= 0
    const crit = !ko && hpFrac <= LOW_HP_CRIT
    const amber = !ko && !crit && hpFrac <= LOW_HP_AMBER

    // ---- glass + drop shadow ----------------------------------------------
    ctx.save()
    ctx.shadowColor = 'rgba(3,7,13,0.55)'
    ctx.shadowBlur = 9
    ctx.shadowOffsetY = 4
    roundRectPath(ctx, 0, 0, PANEL_W, PANEL_H, PANEL_RADIUS)
    const glass = ctx.createLinearGradient(0, 0, 0, PANEL_H)
    glass.addColorStop(0, GLASS_TOP)
    glass.addColorStop(1, GLASS_BOT)
    ctx.globalAlpha = GLASS_ALPHA
    ctx.fillStyle = glass
    ctx.fill()
    ctx.restore()
    // faint inner sheen across the top third (sampled violet-grey lift)
    ctx.save()
    roundRectPath(ctx, 0, 0, PANEL_W, PANEL_H, PANEL_RADIUS)
    ctx.clip()
    const sheen = ctx.createLinearGradient(0, 0, 0, 44)
    sheen.addColorStop(0, 'rgba(126,120,138,0.20)')
    sheen.addColorStop(1, 'rgba(126,120,138,0)')
    ctx.fillStyle = sheen
    ctx.fillRect(0, 0, PANEL_W, 44)
    ctx.restore()

    // ---- ignite wash sits over the glass, under text and pills ------------
    const ll = limitLayout(u)
    if (p.ignite > 0.01) {
      drawIgniteWash(ctx, p.ignite, tNow * 0.8 + p.slot * 0.13, ll.s1x + ll.s1w * 0.5)
    }

    // ---- hairline frame, per-edge colours ---------------------------------
    // crit pulse / damage flash recolour the frame
    let hairT = HAIR_TOP
    let hairS = HAIR_SIDE
    let hairB = HAIR_BOT
    ctx.lineWidth = 1
    ctx.strokeStyle = hairT
    ctx.beginPath()
    ctx.moveTo(PANEL_RADIUS, 0.5)
    ctx.lineTo(PANEL_W - PANEL_RADIUS, 0.5)
    ctx.stroke()
    ctx.strokeStyle = hairB
    ctx.beginPath()
    ctx.moveTo(PANEL_RADIUS, PANEL_H - 0.5)
    ctx.lineTo(PANEL_W - PANEL_RADIUS, PANEL_H - 0.5)
    ctx.stroke()
    ctx.strokeStyle = hairS
    ctx.beginPath()
    ctx.moveTo(0.5, PANEL_RADIUS)
    ctx.lineTo(0.5, PANEL_H - PANEL_RADIUS)
    ctx.moveTo(PANEL_W - 0.5, PANEL_RADIUS)
    ctx.lineTo(PANEL_W - 0.5, PANEL_H - PANEL_RADIUS)
    ctx.stroke()
    // corner ticks so the radius reads closed
    ctx.strokeStyle = hairS
    for (const [cx, cy, a0] of [
      [PANEL_RADIUS + 0.5, PANEL_RADIUS + 0.5, Math.PI],
      [PANEL_W - PANEL_RADIUS - 0.5, PANEL_RADIUS + 0.5, -Math.PI / 2],
      [PANEL_W - PANEL_RADIUS - 0.5, PANEL_H - PANEL_RADIUS - 0.5, 0],
      [PANEL_RADIUS + 0.5, PANEL_H - PANEL_RADIUS - 0.5, Math.PI / 2],
    ]) {
      ctx.beginPath()
      ctx.arc(cx, cy, PANEL_RADIUS, a0, a0 + Math.PI / 2)
      ctx.stroke()
    }

    // ---- name --------------------------------------------------------------
    ctx.globalAlpha = ko ? 0.4 : 1                 // §9 KO: name dims to 40 %
    ctx.font = panelFont('600', NAME_FS)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = 'rgba(6,12,18,0.6)'
    ctx.fillText(u.name || u.id || '', NAME_X, NAME_BASE + 1)
    ctx.fillStyle = NAME_COLOR
    ctx.fillText(u.name || u.id || '', NAME_X, NAME_BASE)
    ctx.globalAlpha = 1

    // ---- HP row ------------------------------------------------------------
    drawGradientLabel(ctx, 'HP', LABEL_X, HP_ROW_BASE, LABEL_FS, HP_LABEL_G0, HP_LABEL_G1)
    const hpShown = Math.max(0, Math.round(
      p.hpCount.from + (p.hpCount.to - p.hpCount.from) * easeOutCubic(p.hpCount.t / COUNT_MS)))
    ctx.globalAlpha = ko ? 0.55 : 1
    drawNumerals(ctx, String(hpShown), NUM_RIGHT, HP_ROW_BASE, HP_NUM_FS, NUM_COLOR)
    ctx.globalAlpha = 1

    const hpOpts = {
      fill: crit ? HP_FILL_CRIT : amber ? HP_FILL_AMBER : HP_FILL,
      tip: crit ? HP_TIP_CRIT : amber ? HP_TIP_AMBER : HP_TIP,
      tipHot: crit ? null : amber ? null : HP_TIP_HOT,
      bevelT: crit ? HP_BEVEL_CRIT_T : amber ? HP_BEVEL_AMBER_T : HP_BEVEL_T,
      bevelB: crit ? HP_BEVEL_CRIT_B : amber ? HP_BEVEL_AMBER_B : HP_BEVEL_B,
      ghost: p.ghost,
    }
    drawPill(ctx, BAR_X, HP_BAR_Y, BAR_W, BAR_H, hpFrac, 'hp', hpOpts)

    // ---- MP row ------------------------------------------------------------
    drawGradientLabel(ctx, 'MP', LABEL_X, MP_ROW_BASE, LABEL_FS, MP_LABEL_G0, MP_LABEL_G1)
    const mpShown = Math.max(0, Math.round(
      p.mpCount.from + (p.mpCount.to - p.mpCount.from) * easeOutCubic(p.mpCount.t / COUNT_MS)))
    ctx.globalAlpha = ko ? 0.55 : 1
    drawNumerals(ctx, String(mpShown), NUM_RIGHT, MP_ROW_BASE, MP_NUM_FS, NUM_COLOR)
    ctx.globalAlpha = 1
    drawPill(ctx, BAR_X, MP_BAR_Y, BAR_W, BAR_H, mpFrac, 'mp', {
      fill: [MP_FILL_L, MP_FILL_CORE, MP_FILL_R],
      tip: MP_TIP,
      bevelT: MP_BEVEL_T,
      bevelB: MP_BEVEL_B,
    })

    // ---- limit row ---------------------------------------------------------
    const full = limit >= 0.999
    const limOpts = {
      fill: LIM_FILL,
      tip: LIM_TIP,
      bevelT: LIM_HAIR_T,
      bevelB: LIM_HAIR_B,
      track: LIM_TRACK,
    }
    if (full && p.ignite > 0.01) {
      // full pill: track + shimmer fill + ±10 px bloom (bible full-state law)
      ctx.save()
      ctx.shadowColor = IGNITE_GLOW
      ctx.shadowBlur = 10 * (0.8 + 0.4 * p.ignite)
      roundRectPath(ctx, ll.s1x, LIM_Y, ll.s1w, LIM_H, 2.5)
      ctx.fillStyle = LIM_FULL_BASE
      ctx.fill()
      ctx.restore()
      ctx.save()
      roundRectPath(ctx, ll.s1x + 1, LIM_Y + 1, ll.s1w - 2, LIM_H - 2, 1.5)
      ctx.clip()
      drawFullLimitFill(ctx, ll.s1x + 1, LIM_Y + 1, ll.s1w - 2, LIM_H - 2,
        tNow * 0.66 + p.slot * 0.29)
      ctx.restore()
      // pale keyline the reference shows around the blazing pill
      ctx.strokeStyle = 'rgba(250,214,252,0.9)'
      ctx.lineWidth = 1
      roundRectPath(ctx, ll.s1x + 0.5, LIM_Y + 0.5, ll.s1w - 1, LIM_H - 1, 2.5)
      ctx.stroke()
    } else {
      drawPill(ctx, ll.s1x, LIM_Y, ll.s1w, LIM_H, limit, 'limit', limOpts)
    }
    if (ll.segs === 2) {
      // secondary (esper) strip — near-empty in frame04; optional live value
      const l2 = clamp01(u.limit2 != null ? u.limit2 : u.esper != null ? u.esper : 0)
      drawPill(ctx, ll.s2x, LIM_Y, ll.s2w, LIM_H, l2, 'limit', limOpts)
      if (full && p.ignite > 0.01 && l2 <= 0.02) {
        // sampled frame04 detail: a small hot chip glows at the secondary
        // pill's left end while the gauge is ignited
        ctx.save()
        ctx.shadowColor = IGNITE_GLOW
        ctx.shadowBlur = 6
        ctx.fillStyle = 'rgba(245,179,255,0.95)'
        ctx.fillRect(ll.s2x + 1, LIM_Y + 1.5, 6, LIM_H - 3)
        ctx.restore()
      }
    }

    // ---- low-HP hairline pulse / damage hairline flash ---------------------
    if (crit) {
      const pulse = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(tNow * Math.PI * 2 * CRIT_PULSE_HZ))
      ctx.globalAlpha = pulse
      ctx.strokeStyle = '#c23a4e'
      ctx.lineWidth = 1
      roundRectPath(ctx, 0.5, 0.5, PANEL_W - 1, PANEL_H - 1, PANEL_RADIUS)
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    if (p.flash > 0) {
      ctx.globalAlpha = clamp01(p.flash / FLASH_MS)
      ctx.strokeStyle = FLASH_COLOR
      ctx.lineWidth = 1.5
      roundRectPath(ctx, 0.5, 0.5, PANEL_W - 1, PANEL_H - 1, PANEL_RADIUS)
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    // ---- KO veil -----------------------------------------------------------
    if (ko) {
      ctx.save()
      roundRectPath(ctx, 0, 0, PANEL_W, PANEL_H, PANEL_RADIUS)
      ctx.fillStyle = 'rgba(8,10,15,0.30)'
      ctx.fill()
      ctx.restore()
    }
  }

  // =========================================================================
  //  ENEMY GAUGES
  // =========================================================================

  function drawEnemyGauges() {
    if (!enemy) return
    const ctx = eg.ctx
    const k = s * dpr
    const contentH = egContentH()
    ctx.setTransform(k, 0, 0, k, EG_PAD * k, EG_PAD * k)
    ctx.clearRect(-EG_PAD, -EG_PAD, EG_W + EG_PAD * 2, contentH + EG_PAD * 2)
    if (eg.fade <= 0.001) return
    ctx.globalAlpha = eg.fade

    const hpMax = enemy.hpMax > 0 ? enemy.hpMax : 1
    const hpFrac = clamp01(enemy.hp / hpMax)
    // break charge: prefer an explicit break field, fall back to the enemy's
    // limit slot (units boots it to the frame04 read), then a static default.
    const bk = clamp01(
      enemy.break != null ? enemy.break :
      enemy.breakGauge != null ? enemy.breakGauge :
      enemy.limit != null ? enemy.limit : 0.4)

    // ---- HP bar: dark outline, pale steel frame, near-black track ----------
    const hy = 0
    ctx.fillStyle = EG_HP_OUTLINE
    ctx.fillRect(-2, hy - 2, EG_W + 4, EG_HP_H + 4)
    ctx.strokeStyle = EG_HP_FRAME
    ctx.lineWidth = 1
    ctx.strokeRect(-1.5, hy - 1.5, EG_W + 3, EG_HP_H + 3)
    ctx.fillStyle = EG_HP_TRACK
    ctx.fillRect(0, hy, EG_W, EG_HP_H)
    const hw = Math.round(EG_W * hpFrac)
    if (hw > 0) {
      const g = ctx.createLinearGradient(0, 0, Math.max(hw, 8), 0)
      g.addColorStop(0, EG_HP_FILL[0])
      g.addColorStop(0.08, EG_HP_FILL[1])
      g.addColorStop(0.55, EG_HP_FILL[2])
      g.addColorStop(0.97, EG_HP_FILL[3])
      g.addColorStop(1, EG_HP_TIP_EDGE)
      ctx.fillStyle = g
      ctx.fillRect(0, hy, hw, EG_HP_H)
      // soft top highlight + bottom shade rows inside the fill
      ctx.fillStyle = 'rgba(255,190,205,0.16)'
      ctx.fillRect(0, hy, hw, 1)
      ctx.fillStyle = 'rgba(20,0,10,0.30)'
      ctx.fillRect(0, hy + EG_HP_H - 1, hw, 1)
    }

    // ---- break gauge: gold bevel pill that glows along its whole length ----
    const gap = (EG_BK_CY_FH - EG_HP_CY_FH) * 921
    const by = EG_HP_H / 2 + gap - EG_BK_H / 2   // fill-top local y
    const breath = 0.85 + 0.15 * Math.sin(tNow * Math.PI * 2 * 0.45)
    // outer warm glow hugging the bevel (empty track included — sampled f04)
    ctx.save()
    ctx.shadowColor = EG_BK_GLOW + (0.38 * breath * eg.fade).toFixed(3) + ')'
    ctx.shadowBlur = 7
    ctx.fillStyle = 'rgba(120,96,44,0.9)'
    roundRectPath(ctx, -EG_BK_BEVEL, by - EG_BK_BEVEL,
      EG_W + EG_BK_BEVEL * 2, EG_BK_H + EG_BK_BEVEL * 2, 2.5)
    ctx.fill()
    ctx.restore()
    // bevel frame (2 px): lit top, shaded bottom, mid sides
    const bevG = ctx.createLinearGradient(0, by - EG_BK_BEVEL, 0, by + EG_BK_H + EG_BK_BEVEL)
    bevG.addColorStop(0, EG_BK_BEVEL_T)
    bevG.addColorStop(0.5, EG_BK_BEVEL_S)
    bevG.addColorStop(1, EG_BK_BEVEL_B)
    ctx.fillStyle = bevG
    roundRectPath(ctx, -EG_BK_BEVEL, by - EG_BK_BEVEL,
      EG_W + EG_BK_BEVEL * 2, EG_BK_H + EG_BK_BEVEL * 2, 3)
    ctx.fill()
    // track
    const tg = ctx.createLinearGradient(0, by, 0, by + EG_BK_H)
    tg.addColorStop(0, EG_BK_TRACK_T)
    tg.addColorStop(1, EG_BK_TRACK_B)
    ctx.fillStyle = tg
    ctx.fillRect(0, by, EG_W, EG_BK_H)
    const bw = Math.round(EG_W * bk)
    if (bw > 0) {
      const g = ctx.createLinearGradient(0, 0, Math.max(bw, 8), 0)
      g.addColorStop(0, EG_BK_FILL[0])
      g.addColorStop(0.55, EG_BK_FILL[1])
      g.addColorStop(0.85, EG_BK_FILL[2])
      g.addColorStop(1, EG_BK_FILL[3])
      ctx.fillStyle = g
      ctx.fillRect(0, by, bw, EG_BK_H)
      // hot specular top row + brighter bloom over the filled span
      ctx.fillStyle = EG_BK_SPEC
      ctx.fillRect(0, by, bw, 1)
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      ctx.shadowColor = EG_BK_GLOW + (0.35 * breath * eg.fade).toFixed(3) + ')'
      ctx.shadowBlur = 6
      ctx.globalAlpha = 0.15 * eg.fade
      ctx.fillStyle = '#e8d19b'
      ctx.fillRect(0, by, bw, EG_BK_H)
      ctx.restore()
      ctx.globalAlpha = eg.fade
      // pale leading tip
      ctx.fillStyle = 'rgba(255,244,214,0.85)'
      ctx.fillRect(Math.max(0, bw - 2), by, 2, EG_BK_H)
    }
    ctx.globalAlpha = 1
  }

  function egTargetLeft() {
    // anchored under the enemy through screen(); x only — y is FIXED
    let fx = 0.3293 // dragon boot anchor, in case screen() is not primed yet
    if (enemy && typeof enemy.screen === 'function') {
      const scr = enemy.screen()
      if (scr && scr.x > 0 && vw > 0) fx = scr.x / vw
    }
    return clamp(fx + EG_X_OFFSET_FW, EG_CLAMP_LO, EG_CLAMP_HI) * vw
  }

  function placeEnemyBlock() {
    // FIXED y band: HP centre 0.747 fh; canvas origin backs off by pad + h/2
    const top = EG_HP_CY_FH * vh - (EG_HP_H / 2) * s - EG_PAD * s
    eg.canvas.style.transform =
      'translate(' + (eg.x - EG_PAD * s).toFixed(2) + 'px,' + top.toFixed(2) + 'px)'
  }

  // =========================================================================
  //  DELTA DETECTION + UPDATE LOOP
  // =========================================================================

  function pokeStats(p, dt) {
    const u = p.unit
    let dirty = false

    // hp change → count-down + ghost + hairline flash (damage only)
    if (u.hp !== p.prevHp) {
      const hpMax = u.hpMax > 0 ? u.hpMax : 1
      const oldF = clamp01(p.prevHp / hpMax)
      const newF = clamp01(u.hp / hpMax)
      const shown = Math.round(
        p.hpCount.from + (p.hpCount.to - p.hpCount.from) * easeOutCubic(p.hpCount.t / COUNT_MS))
      p.hpCount = { from: shown, to: u.hp, t: 0 }
      if (u.hp < p.prevHp) {
        // damage: bar drops instantly, red ghost trails [new..old], frame flashes
        const hi = p.ghost && !p.ghost.heal ? Math.max(p.ghost.hi, oldF) : oldF
        p.ghost = { lo: newF, hi, heal: false, t: GHOST_MS }
        p.flash = FLASH_MS
      } else {
        // heal: green ghost rides the regained span
        p.ghost = { lo: oldF, hi: newF, heal: true, t: GHOST_MS }
      }
      p.prevHp = u.hp
      dirty = true
    }
    if (u.mp !== p.prevMp) {
      const shown = Math.round(
        p.mpCount.from + (p.mpCount.to - p.mpCount.from) * easeOutCubic(p.mpCount.t / COUNT_MS))
      p.mpCount = { from: shown, to: u.mp, t: 0 }   // no ghost on MP (bible)
      p.prevMp = u.mp
      dirty = true
    }
    if (u.limit !== p.prevLimit) {
      p.prevLimit = u.limit
      dirty = true
    }
    const ko = u.hp <= 0
    if (ko !== p.prevKo) {
      p.prevKo = ko
      dirty = true
    }

    // clocks
    if (p.hpCount.t < COUNT_MS) { p.hpCount.t = Math.min(COUNT_MS, p.hpCount.t + dt); dirty = true }
    if (p.mpCount.t < COUNT_MS) { p.mpCount.t = Math.min(COUNT_MS, p.mpCount.t + dt); dirty = true }
    if (p.ghost) {
      p.ghost.t -= dt
      if (p.ghost.t <= 0) p.ghost = null
      dirty = true
    }
    if (p.flash > 0) { p.flash = Math.max(0, p.flash - dt); dirty = true }

    // ignite ramp toward (limit full ? 1 : 0)
    const want = clamp01(u.limit || 0) >= 0.999 ? 1 : 0
    if (p.ignite !== want) {
      p.ignite = want > p.ignite
        ? Math.min(want, p.ignite + dt * 4)     // ~250 ms in
        : Math.max(want, p.ignite - dt * 3.3)   // ~300 ms out
      dirty = true
    }
    // live states that animate every frame
    if (p.ignite > 0.01) dirty = true                                   // shimmer
    const hpMax = u.hpMax > 0 ? u.hpMax : 1
    if (u.hp > 0 && u.hp / hpMax <= LOW_HP_CRIT) dirty = true           // pulse

    if (dirty) p.dirty = true
  }

  function update(dt) {
    if (!(dt >= 0)) dt = 1 / 60
    if (dt > 0.1) dt = 0.1
    tNow += dt

    // resize poll (cheap: two int compares per frame)
    const box = viewportBox()
    if (box.w !== vw || box.h !== vh) layout()

    for (const p of panels) {
      pokeStats(p, dt)
      if (p.dirty) {
        drawPanel(p)
        p.dirty = false
      }
    }

    if (enemy) {
      // §9: enemy death → 300 ms slow-fade of its gauges
      const dead = enemy.hp <= 0
      eg.fade = clamp01(eg.fade + (dead ? -dt / EG_FADE_MS : dt / EG_FADE_MS))
      // x tracks the enemy (recoil etc.) with a soft follow; y never moves
      const target = egTargetLeft()
      if (!eg.xInit) { eg.x = target; eg.xInit = true }
      else eg.x += (target - eg.x) * (1 - Math.exp(-10 * dt))
      placeEnemyBlock()
      drawEnemyGauges()   // tiny canvas; glow breath animates every frame
    }
  }

  // ---- boot ----------------------------------------------------------------
  // Paint the very first frame fully populated (units primes its stats and
  // screen() before UI construction), so a freeze capture is correct even if
  // no stat ever changes.
  layout()
  for (const p of panels) { drawPanel(p); p.dirty = false }
  if (enemy) {
    eg.x = egTargetLeft()
    eg.xInit = true
    placeEnemyBlock()
    drawEnemyGauges()
  }

  return {
    dom,
    update,
    // non-contract extras (harmless additions; integrator may ignore):
    relayout: layout,
    dispose() { dom.remove() },
  }
}
