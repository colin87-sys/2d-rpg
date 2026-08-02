/* ===========================================================================
   Aetherbound — src/ui/hud.js
   ---------------------------------------------------------------------------
   Shipped-JRPG corner HUD, matched against docs/reference/frame01.png:

     • Top-right glass minimap plate  — 0.20 fw wide, h = 0.92 w (measured
       331×305 on the 1630×921 plate), outer radius 12, drop shadow, subtle
       vertical sheen, thin warm-grey hairline frame inset ~7.5 % of the
       plate width (the image shows ~25 px on a 331 px plate — the map art
       runs FULL-BLEED underneath it, exactly like the reference where the
       parchment continent crosses the hairline).
     • The map itself is baked ONCE at construction from terrain.height /
       terrain.biome on a fixed grid: dark-glass ocean, parchment landmass
       tinted by biome + elevation, NW hillshading, contour engraving on the
       rock, forest lobes + stipple, pale coastline fringe with a soft glow
       bleeding into the water, ochre road polylines, the saturated-cyan
       river (the only saturated cyan in the frame, per the art bible),
       cartographic micro-marks (castle keep, hamlet, shrine, pier, bridge
       decks) and parchment blotch + grain.
     • Per frame (cheap overlay canvas only): soft camera view-cone, pulsing
       quest pins (cyan shield-teardrop = story, stacked gold diamond =
       quest — both with white anchor dots, straight off frame01), the
       white-core / cyan-glow player chevron with smoothed heading, and a
       slow sonar ping.
     • Region nameplate (top-left, art bible §9): serif small-caps, gold
       kicker + hairline rule that draws itself, fade-in → hold → fade-out
       on region change (region = nearest owning POI, else biome).
     • Low-opacity keycap controls hint, bottom-right.

   Contract (frozen):  createHUD({ terrain, player }) -> { update(dt), dom }
   No THREE import needed — pure DOM + Canvas2D. No fonts, no images, no
   network. Mounted into #ui (pointer-events: none).
   ======================================================================== */

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
const lerp = (a, b, t) => a + (b - a) * t
const TAU = Math.PI * 2

/** deterministic 0..1 hash of an integer lattice point (no tables) */
function hash2(ix, iy) {
  const s = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453123
  return s - Math.floor(s)
}

/** 2-octave value noise, smooth, deterministic — parchment blotching */
function vnoise(x, y) {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  let fx = x - ix
  let fy = y - iy
  fx = fx * fx * (3 - 2 * fx)
  fy = fy * fy * (3 - 2 * fy)
  const a = hash2(ix, iy)
  const b = hash2(ix + 1, iy)
  const c = hash2(ix, iy + 1)
  const d = hash2(ix + 1, iy + 1)
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fy)
}

/** rounded-rect path (hand-rolled — no reliance on ctx.roundRect) */
function rr(ctx, x, y, w, h, r) {
  const q = Math.min(r, w * 0.5, h * 0.5)
  ctx.beginPath()
  ctx.moveTo(x + q, y)
  ctx.lineTo(x + w - q, y)
  ctx.arcTo(x + w, y, x + w, y + q, q)
  ctx.lineTo(x + w, y + h - q)
  ctx.arcTo(x + w, y + h, x + w - q, y + h, q)
  ctx.lineTo(x + q, y + h)
  ctx.arcTo(x, y + h, x, y + h - q, q)
  ctx.lineTo(x, y + q)
  ctx.arcTo(x, y, x + q, y, q)
  ctx.closePath()
}

function shortestArc(from, to) {
  let d = (to - from) % TAU
  if (d > Math.PI) d -= TAU
  if (d < -Math.PI) d += TAU
  return d
}

// ---------------------------------------------------------------------------
// palette — art bible §9 + pixels sampled off frame01's panel
// ---------------------------------------------------------------------------

const P = {
  hairline: 'rgba(216,220,210,0.55)', // #d8dcd2 @55%
  hairlineEtch: 'rgba(0,0,0,0.28)',
  gold: '#d9b542',
  goldDim: 'rgba(217,181,66,0.72)',
  pinBlue: '#3fc9f2',
  pinBlueHi: '#8ce2fa',
  pinBlueLo: '#1f93c4',
  pinGold: '#eac93f',
  pinGoldHi: '#f7e27a',
  pinGoldLo: '#c79a26',
  pinGoldGlyph: '#3a2f10',
  town: 'rgba(245,239,221,0.8)', // #f5efdd @80%
  plateText: '#f2ead8',
}

// land tints (r,g,b) — parchment family, biome-keyed
const LAND = {
  grassLo: [128, 129, 80], // sage-olive parchment (low pasture — green cast)
  grassHi: [178, 143, 96], // warm tan (high shelves) — the west-continent read
  field: [198, 166, 90], // wheat gold
  forest: [103, 111, 62],
  forestDark: [76, 86, 47], // #55603a-class stipple
  beach: [203, 179, 132],
  road: [178, 149, 96],
  rockLo: [150, 139, 111],
  rockHi: [180, 167, 138],
  snow: [232, 229, 221],
  crevice: [108, 88, 62], // #6f5a40 relief shade
  coast: [224, 207, 166], // pale coastline fringe
}
const WATER_SHALLOW = [24, 37, 35]
const WATER_DEEP = [10, 18, 20]

const BIOME_ID = { grass: 0, ocean: 1, beach: 2, forest: 3, road: 4, rock: 5, snow: 6, field: 7 }

// ---------------------------------------------------------------------------
// fixed map window (world metres) — framed on the POI spread so the pin
// composition matches frame01: ocean field on the west third, parchment land
// east of it, the camp's gold pin kissing the bottom hairline.
// ---------------------------------------------------------------------------

// Measured off frame01: the plate is SQUARE — hairline frame 280×281 px with
// a uniform ~26 px inset on a 331×334 plate (the "shorter" reads come from
// the gold pin's shadow and the castle sitting behind the glass).
const PANEL_H_RATIO = 1.0
const MAP_ASPECT = 1 / PANEL_H_RATIO
const WIN = (() => {
  const cx = -50
  const cz = -37
  const spanZ = 320
  const spanX = spanZ * MAP_ASPECT
  return { xW: cx - spanX / 2, zN: cz - spanZ / 2, spanX, spanZ }
})()

const BAKE_W = 560
const BAKE_H = Math.round(BAKE_W / MAP_ASPECT) // 560

// world → normalised map coords (0..1, north-up)
const mapU = (wx) => (wx - WIN.xW) / WIN.spanX
const mapV = (wz) => (wz - WIN.zN) / WIN.spanZ

// ---------------------------------------------------------------------------
// region table — nameplate ownership. The farm POI deliberately owns no
// region (the paddocks ARE Grandpine Fields, and the bible's boot nameplate
// is "GRANDPINE FIELDS — Ferren Coast" with the hero 4.5 m from that POI).
// ---------------------------------------------------------------------------

const POI_REGIONS = {
  castle: { r: 16, title: 'Grandpine Castle', kicker: 'ROYAL DEMESNE' },
  village: { r: 30, title: 'Ferren Hamlet', kicker: 'FERREN COAST' },
  shrine: { r: 24, title: 'Windward Shrine', kicker: 'HIGHLAND STEPS' },
  camp: { r: 18, title: 'Roadside Camp', kicker: 'SOUTH DOWNS' },
}
const BRIDGE_REGIONS = [
  { match: 'Trestle', r: 20, title: 'Trestle Crossing', kicker: 'FERREN COAST' },
  { match: 'North', r: 20, title: 'North Gorge', kicker: 'HIGHLAND STEPS' },
]
const BIOME_REGIONS = {
  ocean: { title: 'Ferren Coast', kicker: 'WESTERN SHORE' },
  beach: { title: 'Ferren Coast', kicker: 'WESTERN SHORE' },
  rock: { title: 'Highland Steps', kicker: 'FERREN COAST' },
  snow: { title: 'The North Reach', kicker: 'HIGHLAND STEPS' },
}
const DEFAULT_REGION = { title: 'Grandpine Fields', kicker: 'FERREN COAST' }

// pin classing: 2 blue story + 1 gold quest + town dots == frame01's census
const PIN_CLASS = { castle: 'story', shrine: 'story', camp: 'quest', village: 'town', farm: 'town', bridge: 'town' }

// ---------------------------------------------------------------------------
// CSS (injected once)
// ---------------------------------------------------------------------------

const CSS_ID = 'abh-css'
const CSS = `
#abh-root{position:absolute;inset:0;pointer-events:none;overflow:hidden;
  --abh-serif:Georgia,'Times New Roman','Palatino Linotype',Palatino,serif;}
#abh-root *{box-sizing:border-box;margin:0;padding:0;}

/* ---- minimap plate ---- */
.abh-panel{position:absolute;border-radius:12px;overflow:hidden;
  background:linear-gradient(180deg,rgba(27,33,27,.55) 0%,rgba(13,18,14,.60) 34%,rgba(9,13,10,.64) 100%);
  box-shadow:0 6px 18px rgba(0,0,0,.45),0 2px 6px rgba(0,0,0,.35),inset 0 0 0 1px rgba(0,0,0,.34),inset 0 1px 0 rgba(255,255,255,.055);
  backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);
  opacity:0;animation:abhIn .55s ease-out .12s forwards;}
.abh-panel canvas{position:absolute;left:0;top:0;width:100%;height:100%;display:block;}
@keyframes abhIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}

/* ---- nameplate ---- */
.abh-np{position:absolute;display:inline-block;padding:9px 20px 11px 18px;border-radius:9px;
  background:linear-gradient(180deg,rgba(14,19,14,.42),rgba(8,12,9,.48));
  box-shadow:0 4px 14px rgba(0,0,0,.35),inset 0 0 0 1px rgba(226,222,204,.10),inset 0 1px 0 rgba(255,255,255,.05);
  backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);
  opacity:0;transform:translateY(-7px);
  transition:opacity .9s ease,transform .9s ease;}
.abh-np.abh-show{opacity:1;transform:none;
  transition:opacity .6s cubic-bezier(.25,.6,.25,1),transform .6s cubic-bezier(.25,.6,.25,1);}
.abh-np-k{font-family:var(--abh-serif);font-size:10px;letter-spacing:.36em;color:${P.gold};
  opacity:.92;text-shadow:0 1px 2px rgba(0,0,0,.65);padding-left:2px;white-space:nowrap;}
.abh-np-t{font-family:var(--abh-serif);font-variant-caps:small-caps;
  font-size:clamp(17px,1.45vw,21px);letter-spacing:.22em;color:${P.plateText};
  line-height:1.28;margin-top:2px;white-space:nowrap;
  text-shadow:0 1px 3px rgba(0,0,0,.7),0 0 14px rgba(0,0,0,.35);
  transition:letter-spacing .8s cubic-bezier(.2,.6,.2,1);}
.abh-np.abh-show .abh-np-t{letter-spacing:.13em;}
.abh-np-r{position:relative;height:5px;margin-top:6px;}
.abh-np-r i{position:absolute;left:0;right:0;top:2px;height:1px;display:block;
  background:linear-gradient(90deg,rgba(201,168,76,0) 0%,rgba(201,168,76,.9) 18%,rgba(201,168,76,.9) 82%,rgba(201,168,76,0) 100%);
  transform:scaleX(0);transform-origin:50% 50%;transition:transform .85s cubic-bezier(.2,.7,.2,1) .1s;}
.abh-np.abh-show .abh-np-r i{transform:scaleX(1);}
.abh-np-r b{position:absolute;left:50%;top:0;width:5px;height:5px;margin-left:-2.5px;
  background:${P.gold};transform:rotate(45deg) scale(0);border-radius:1px;
  box-shadow:0 0 6px rgba(217,181,66,.55);transition:transform .5s ease .35s;}
.abh-np.abh-show .abh-np-r b{transform:rotate(45deg) scale(1);}

/* ---- controls hint ---- */
.abh-hint{position:absolute;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
  font-size:10px;letter-spacing:.04em;color:rgba(233,238,224,.66);text-align:right;
  text-shadow:0 1px 2px rgba(0,0,0,.8);opacity:0;animation:abhHintIn 1s ease .9s forwards;
  white-space:nowrap;}
@keyframes abhHintIn{to{opacity:.78}}
.abh-hint .k{display:inline-block;min-width:15px;padding:1px 4px 2px;margin:0 1px;
  border-radius:3.5px;text-align:center;font-size:9px;letter-spacing:.02em;
  color:rgba(240,244,232,.8);
  background:linear-gradient(180deg,rgba(34,40,32,.55),rgba(12,16,12,.6));
  border:1px solid rgba(216,222,206,.26);border-bottom-width:2px;
  box-shadow:0 1px 2px rgba(0,0,0,.4);}
.abh-hint .s{opacity:.45;margin:0 7px;}
.abh-hint .w{opacity:.85;margin-left:5px;font-variant-caps:small-caps;
  font-family:var(--abh-serif);font-size:10.5px;letter-spacing:.08em;}
@media (max-width:640px){.abh-hint{display:none}}
`

// ===========================================================================
// createHUD
// ===========================================================================

export function createHUD({ terrain, player }) {
  const meta = (terrain && terrain.meta) || {}
  const seaLevel = meta.seaLevel || 0
  const pois = Array.isArray(meta.poi) ? meta.poi : []

  // ---------------------------------------------------------------- DOM ----
  if (!document.getElementById(CSS_ID)) {
    const style = document.createElement('style')
    style.id = CSS_ID
    style.textContent = CSS
    document.head.appendChild(style)
  }

  const mount = document.getElementById('ui') || document.body
  const root = document.createElement('div')
  root.id = 'abh-root'

  const panel = document.createElement('div')
  panel.className = 'abh-panel'
  const staticCanvas = document.createElement('canvas') // map + chrome (resize only)
  const dynCanvas = document.createElement('canvas') // cone + pins + arrow (per frame)
  panel.appendChild(staticCanvas)
  panel.appendChild(dynCanvas)

  const nameplate = document.createElement('div')
  nameplate.className = 'abh-np'
  const npKicker = document.createElement('div')
  npKicker.className = 'abh-np-k'
  const npTitle = document.createElement('div')
  npTitle.className = 'abh-np-t'
  const npRule = document.createElement('div')
  npRule.className = 'abh-np-r'
  npRule.appendChild(document.createElement('i'))
  npRule.appendChild(document.createElement('b'))
  nameplate.appendChild(npKicker)
  nameplate.appendChild(npTitle)
  nameplate.appendChild(npRule)

  const hint = document.createElement('div')
  hint.className = 'abh-hint'
  const key = (k) => `<span class="k">${k}</span>`
  hint.innerHTML =
    key('W') + key('A') + key('S') + key('D') + `<span class="w">Move</span><span class="s">·</span>` +
    key('Shift') + `<span class="w">Run</span><span class="s">·</span>` +
    key('Q') + key('E') + `<span class="w">Rotate</span><span class="s">·</span>` +
    key('+') + key('−') + `<span class="w">Zoom</span>`

  root.appendChild(panel)
  root.appendChild(nameplate)
  root.appendChild(hint)
  mount.appendChild(root)

  const sCtx = staticCanvas.getContext('2d')
  const dCtx = dynCanvas.getContext('2d')

  // ------------------------------------------------------------- pins ------
  // classify once; positions are normalised map coords so they survive resize
  const pins = [] // { u, v, cls, phase, poi }
  const towns = []
  for (let i = 0; i < pois.length; i++) {
    const poi = pois[i]
    const cls = PIN_CLASS[poi.kind] || 'town'
    const rec = { u: mapU(poi.x), v: mapV(poi.z), cls, phase: i * 0.93, poi }
    if (cls === 'town') towns.push(rec)
    else pins.push(rec)
  }
  // draw order: north pins first so southern pins overlap them (map reads)
  pins.sort((a, b) => a.v - b.v)

  // ===================================================================
  // MAP BAKE — one synchronous pass at construction, never re-run.
  // ===================================================================

  const bake = document.createElement('canvas')
  bake.width = BAKE_W
  bake.height = BAKE_H
  const bCtx = bake.getContext('2d')

  ;(function bakeMap() {
    const W = BAKE_W
    const H = BAKE_H
    const sx = WIN.spanX / W // metres per bake texel (~0.62)
    const sz = WIN.spanZ / H

    // -- pass 1: sample the terrain once ---------------------------------
    const hg = new Float32Array(W * H)
    const bg = new Uint8Array(W * H)
    for (let gy = 0; gy < H; gy++) {
      const wz = WIN.zN + (gy + 0.5) * sz
      for (let gx = 0; gx < W; gx++) {
        const wx = WIN.xW + (gx + 0.5) * sx
        const i = gy * W + gx
        hg[i] = terrain.height(wx, wz)
        bg[i] = BIOME_ID[terrain.biome(wx, wz)] | 0
      }
    }

    // -- pass 2: shade every texel ---------------------------------------
    const img = bCtx.createImageData(W, H)
    const px = img.data
    const OC = BIOME_ID.ocean

    for (let gy = 0; gy < H; gy++) {
      for (let gx = 0; gx < W; gx++) {
        const i = gy * W + gx
        const b = bg[i]
        const h = hg[i]
        const o = i * 4

        if (b === OC) {
          // dark-glass water — deeper = darker, slight green keeps it alive
          const depth = clamp((seaLevel - h) / 12, 0, 1)
          px[o] = lerp(WATER_SHALLOW[0], WATER_DEEP[0], depth)
          px[o + 1] = lerp(WATER_SHALLOW[1], WATER_DEEP[1], depth)
          px[o + 2] = lerp(WATER_SHALLOW[2], WATER_DEEP[2], depth)
          px[o + 3] = 146 + 32 * depth // translucent: the scene ghosts through
          continue
        }

        // central-difference gradient (metres of rise per metre run)
        const xm = gx > 0 ? hg[i - 1] : h
        const xp = gx < W - 1 ? hg[i + 1] : h
        const zm = gy > 0 ? hg[i - W] : h
        const zp = gy < H - 1 ? hg[i + W] : h
        const gdx = (xp - xm) / (2 * sx)
        const gdz = (zp - zm) / (2 * sz)
        const grad = Math.hypot(gdx, gdz)

        // biome base tint — elevation warms the parchment (green shelf low,
        // tan mesa high: the reference's two-tone landmass read)
        const hT = clamp((h - 4) / 22, 0, 1)
        let r, g, bl
        if (b === BIOME_ID.field) {
          r = LAND.field[0]; g = LAND.field[1]; bl = LAND.field[2]
        } else if (b === BIOME_ID.forest) {
          // broad crown-lobes via low-freq noise, so woods read as masses
          const lobe = vnoise(gx * 0.16, gy * 0.16)
          const t = clamp((lobe - 0.42) * 2.2, 0, 1)
          r = lerp(LAND.forest[0], LAND.forestDark[0], t)
          g = lerp(LAND.forest[1], LAND.forestDark[1], t)
          bl = lerp(LAND.forest[2], LAND.forestDark[2], t)
        } else if (b === BIOME_ID.beach) {
          r = LAND.beach[0]; g = LAND.beach[1]; bl = LAND.beach[2]
        } else if (b === BIOME_ID.rock) {
          r = lerp(LAND.rockLo[0], LAND.rockHi[0], hT)
          g = lerp(LAND.rockLo[1], LAND.rockHi[1], hT)
          bl = lerp(LAND.rockLo[2], LAND.rockHi[2], hT)
        } else if (b === BIOME_ID.snow) {
          r = LAND.snow[0]; g = LAND.snow[1]; bl = LAND.snow[2]
        } else if (b === BIOME_ID.road) {
          r = LAND.road[0]; g = LAND.road[1]; bl = LAND.road[2]
        } else {
          // grass — sage-olive low, warming to tan on the high shelves
          r = lerp(LAND.grassLo[0], LAND.grassHi[0], hT)
          g = lerp(LAND.grassLo[1], LAND.grassHi[1], hT)
          bl = lerp(LAND.grassLo[2], LAND.grassHi[2], hT)
        }

        // NW hillshade — the cartographic relief that makes it a real map
        const sh = clamp(-gdx * 0.85 - gdz * 0.62, -0.7, 0.7)
        let f = 1 + sh * 0.72

        // steep faces sink toward the relief-shade brown (canyon engraving)
        if (grad > 0.85) {
          const t = clamp((grad - 0.85) / 1.7, 0, 1) * 0.55
          r = lerp(r, LAND.crevice[0], t)
          g = lerp(g, LAND.crevice[1], t)
          bl = lerp(bl, LAND.crevice[2], t)
        }

        // engraved contour lines every 6 m (skip flats to avoid banding)
        const m = ((h % 6) + 6) % 6
        if (m < 0.5 && grad > 0.06) {
          f *= 1 - 0.14 * clamp(grad * 6, 0, 1) * (b === BIOME_ID.rock ? 1.6 : 1)
        }

        // parchment blotching (two octaves) + fibre grain
        const bl1 = vnoise(gx * 0.045, gy * 0.045)
        const bl2 = vnoise(gx * 0.11 + 37, gy * 0.11 + 11)
        f *= 0.945 + (bl1 * 0.6 + bl2 * 0.4) * 0.1
        const grain = (hash2(gx, gy) - 0.5) * 7

        // sparse dark stipple in the woods
        if (b === BIOME_ID.forest && hash2(gx * 3 + 7, gy * 3 + 5) < 0.16) f *= 0.86

        px[o] = clamp(r * f + grain, 0, 255)
        px[o + 1] = clamp(g * f + grain, 0, 255)
        px[o + 2] = clamp(bl * f + grain, 0, 255)
        px[o + 3] = 255
      }
    }

    // -- pass 3: coastline fringe + water-side glow ----------------------
    // land texels touching water get the pale parchment edge; water texels
    // within 2 texels of land get a soft lift (the reference's cool halo).
    const edgeLand = new Uint8Array(W * H)
    const glow1 = new Uint8Array(W * H)
    for (let gy = 1; gy < H - 1; gy++) {
      for (let gx = 1; gx < W - 1; gx++) {
        const i = gy * W + gx
        const isW = bg[i] === OC
        let touch = false
        for (let dy = -1; dy <= 1 && !touch; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (bg[i + dy * W + dx] === OC !== isW) { touch = true; break }
          }
        }
        if (!touch) continue
        if (isW) glow1[i] = 1
        else edgeLand[i] = 1
      }
    }
    const glow2 = new Uint8Array(W * H)
    for (let gy = 1; gy < H - 1; gy++) {
      for (let gx = 1; gx < W - 1; gx++) {
        const i = gy * W + gx
        if (bg[i] !== OC || glow1[i]) continue
        if (glow1[i - 1] || glow1[i + 1] || glow1[i - W] || glow1[i + W] ||
            glow1[i - W - 1] || glow1[i - W + 1] || glow1[i + W - 1] || glow1[i + W + 1]) glow2[i] = 1
      }
    }
    for (let i = 0; i < W * H; i++) {
      const o = i * 4
      if (edgeLand[i]) {
        const t = 0.62
        px[o] = lerp(px[o], LAND.coast[0], t)
        px[o + 1] = lerp(px[o + 1], LAND.coast[1], t)
        px[o + 2] = lerp(px[o + 2], LAND.coast[2], t)
      } else if (glow1[i]) {
        px[o] = clamp(px[o] + 34, 0, 255)
        px[o + 1] = clamp(px[o + 1] + 40, 0, 255)
        px[o + 2] = clamp(px[o + 2] + 38, 0, 255)
        px[o + 3] = clamp(px[o + 3] + 26, 0, 255)
      } else if (glow2[i]) {
        px[o] = clamp(px[o] + 14, 0, 255)
        px[o + 1] = clamp(px[o + 1] + 17, 0, 255)
        px[o + 2] = clamp(px[o + 2] + 16, 0, 255)
        px[o + 3] = clamp(px[o + 3] + 12, 0, 255)
      }
    }

    bCtx.putImageData(img, 0, 0)

    // -- pass 4: vector overlays in bake space ---------------------------
    const bx = (wx) => mapU(wx) * W
    const by = (wz) => mapV(wz) * H

    // roads — dark ochre underlay, then the pale #c9ac74 line
    const roads = (meta.roads || [])
    bCtx.lineJoin = 'round'
    bCtx.lineCap = 'round'
    for (let pass = 0; pass < 2; pass++) {
      bCtx.strokeStyle = pass === 0 ? 'rgba(92,70,42,0.6)' : 'rgba(206,177,120,1)'
      bCtx.lineWidth = pass === 0 ? 3.0 : 1.6
      for (const road of roads) {
        const pts = road.points || []
        if (pts.length < 2) continue
        bCtx.beginPath()
        bCtx.moveTo(bx(pts[0].x), by(pts[0].z))
        for (let i = 1; i < pts.length; i++) bCtx.lineTo(bx(pts[i].x), by(pts[i].z))
        bCtx.stroke()
      }
    }

    // river — the ONLY saturated cyan on the panel (art bible §3/§10)
    const riverPts = (meta.river && meta.river.points) || []
    if (riverPts.length > 1) {
      const passes = [
        { c: 'rgba(23,74,88,0.9)', w: 3.6 },
        { c: 'rgba(63,160,185,0.95)', w: 2.2 },
        { c: 'rgba(140,222,238,0.9)', w: 0.9 },
      ]
      for (const p of passes) {
        bCtx.strokeStyle = p.c
        bCtx.lineWidth = p.w
        bCtx.beginPath()
        bCtx.moveTo(bx(riverPts[0].x), by(riverPts[0].z))
        for (let i = 1; i < riverPts.length; i++) bCtx.lineTo(bx(riverPts[i].x), by(riverPts[i].z))
        bCtx.stroke()
      }
      // headwater pool + waterfall fleck
      bCtx.fillStyle = 'rgba(96,190,210,0.85)'
      bCtx.beginPath()
      bCtx.ellipse(bx(riverPts[0].x), by(riverPts[0].z), 3.2, 2.4, 0, 0, TAU)
      bCtx.fill()
      const wf = meta.waterfall
      if (wf) {
        bCtx.fillStyle = 'rgba(238,248,250,0.95)'
        bCtx.fillRect(bx(wf.x) - 0.8, by(wf.z) - 1.8, 1.6, 3.6)
      }
    }

    // cartographic micro-marks at the POIs
    for (const poi of pois) {
      const x = bx(poi.x)
      const y = by(poi.z)
      if (poi.kind === 'castle') {
        // tiny white keep with a cobalt roof-dot and gold fleck
        bCtx.fillStyle = 'rgba(50,45,32,0.6)'
        bCtx.fillRect(x - 2.6, y - 2.1, 5.2, 4.6) // grounding shadow
        bCtx.fillStyle = '#e9e4d6'
        bCtx.fillRect(x - 2.1, y - 2.6, 4.2, 4.2)
        bCtx.fillStyle = '#35549c'
        bCtx.fillRect(x - 1.2, y - 3.6, 2.4, 1.6)
        bCtx.fillStyle = P.gold
        bCtx.fillRect(x - 0.4, y - 4.4, 0.9, 0.9)
      } else if (poi.kind === 'village') {
        bCtx.fillStyle = '#6b4a2e'
        bCtx.fillRect(x - 2.8, y - 0.4, 2.1, 2.1)
        bCtx.fillRect(x + 0.7, y - 1.1, 2.1, 2.1)
        bCtx.fillStyle = '#9aa0a8'
        bCtx.fillRect(x - 1.1, y - 2.4, 2.2, 2.2)
      } else if (poi.kind === 'shrine') {
        bCtx.fillStyle = '#b0453c'
        bCtx.fillRect(x - 2.2, y - 2.4, 4.4, 1.1)
        bCtx.fillRect(x - 1.6, y - 1.3, 1.0, 3.0)
        bCtx.fillRect(x + 0.6, y - 1.3, 1.0, 3.0)
      } else if (poi.kind === 'bridge') {
        // short planked deck across the gap, laid N–S like the roads
        bCtx.fillStyle = '#7a5a34'
        bCtx.fillRect(x - 1.6, y - 3.2, 3.2, 6.4)
        bCtx.fillStyle = 'rgba(176,138,84,0.9)'
        bCtx.fillRect(x - 1.6, y - 3.2, 3.2, 1.1)
        bCtx.fillRect(x - 1.6, y + 2.1, 3.2, 1.1)
      }
    }

    // the little pier tick west of the farm shelf
    const pier = meta.extras && meta.extras.pier
    if (pier) {
      const dx = Math.cos(pier.angle)
      const dz = Math.sin(pier.angle)
      bCtx.strokeStyle = 'rgba(138,106,68,0.95)'
      bCtx.lineWidth = 1.6
      bCtx.beginPath()
      bCtx.moveTo(bx(pier.x), by(pier.z))
      bCtx.lineTo(bx(pier.x + dx * (pier.length || 5)), by(pier.z + dz * (pier.length || 5)))
      bCtx.stroke()
    }
  })()

  // ===================================================================
  // LAYOUT + STATIC COMPOSE (glass chrome, hairline, corner notches)
  // ===================================================================

  const layout = { w: 0, h: 0, dpr: 1, vw: 0, vh: 0, s: 1, inset: 0 }

  function relayout() {
    const vw = window.innerWidth || 1280
    const vh = window.innerHeight || 720
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2.5)
    // 0.20 fw, but never taller than 0.42 fh (ultrawide guard) nor tiny
    const w = Math.round(Math.max(Math.min(vw * 0.2, vh * 0.42, 400), Math.min(210, vw * 0.42)))
    const h = Math.round(w * PANEL_H_RATIO)
    if (w === layout.w && h === layout.h && dpr === layout.dpr && vw === layout.vw && vh === layout.vh) return
    layout.w = w
    layout.h = h
    layout.dpr = dpr
    layout.vw = vw
    layout.vh = vh
    layout.s = w / 320 // design scale: bible geometry is quoted at 1600×900
    layout.inset = Math.round(w * 0.078) // hairline inset ≈26/331, off frame01

    const right = Math.round(Math.max(10, vw * 0.01))
    const top = Math.round(Math.max(10, vh * 0.022))
    panel.style.width = w + 'px'
    panel.style.height = h + 'px'
    panel.style.right = right + 'px'
    panel.style.top = top + 'px'
    panel.style.borderRadius = Math.round(12 * clamp(layout.s, 0.8, 1.35)) + 'px'

    for (const c of [staticCanvas, dynCanvas]) {
      c.width = Math.round(w * dpr)
      c.height = Math.round(h * dpr)
    }
    sCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
    dCtx.setTransform(dpr, 0, 0, dpr, 0, 0)

    nameplate.style.left = Math.round(Math.max(14, vw * 0.012)) + 'px'
    nameplate.style.top = Math.round(Math.max(12, vh * 0.022)) + 'px'
    hint.style.right = right + 'px'
    hint.style.bottom = Math.round(Math.max(12, vh * 0.02)) + 'px'

    drawStatic()
  }

  function drawStatic() {
    const w = layout.w
    const h = layout.h
    const inset = layout.inset
    const ctx = sCtx
    ctx.clearRect(0, 0, w, h)

    // -- the baked map, full bleed under the frame (as in the reference)
    ctx.save()
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bake, 0, 0, w, h)

    // feather the map into the plate edges so it never slams the corners
    const F = Math.max(5, w * 0.02)
    ctx.globalCompositeOperation = 'destination-out'
    const edges = [
      [0, 0, F, 0], // left
      [w, 0, w - F, 0], // right
      [0, 0, 0, F], // top
      [0, h, 0, h - F], // bottom
    ]
    for (const [x0, y0, x1, y1] of edges) {
      const gr = ctx.createLinearGradient(x0, y0, x1, y1)
      gr.addColorStop(0, 'rgba(0,0,0,0.85)')
      gr.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = gr
      ctx.fillRect(0, 0, w, h)
    }
    ctx.restore()

    // -- inner shadow ring: seats the map into the glass
    ctx.save()
    const ringW = Math.max(8, w * 0.035)
    for (const [x0, y0, x1, y1] of [
      [0, 0, ringW, 0], [w, 0, w - ringW, 0], [0, 0, 0, ringW], [0, h, 0, h - ringW],
    ]) {
      const gr = ctx.createLinearGradient(x0, y0, x1, y1)
      gr.addColorStop(0, 'rgba(0,0,0,0.26)')
      gr.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = gr
      ctx.fillRect(0, 0, w, h)
    }
    ctx.restore()

    // -- town dots (static — pins pulse on the dyn canvas)
    for (const d of towns) {
      const x = d.u * w
      const y = d.v * h
      ctx.beginPath()
      ctx.arc(x, y + 1, 3.2 * layout.s, 0, TAU)
      ctx.fillStyle = 'rgba(0,0,0,0.35)'
      ctx.fill()
      ctx.beginPath()
      ctx.arc(x, y, 2.5 * layout.s, 0, TAU)
      ctx.fillStyle = P.town
      ctx.fill()
      ctx.lineWidth = 1
      ctx.strokeStyle = 'rgba(24,30,22,0.65)'
      ctx.stroke()
    }

    // -- hairline frame (etched: dark offset line + light line)
    const r = Math.round(10 * clamp(layout.s, 0.8, 1.35))
    ctx.lineWidth = 1.5
    rr(ctx, inset + 0.75, inset + 1.75, w - inset * 2, h - inset * 2, r)
    ctx.strokeStyle = P.hairlineEtch
    ctx.stroke()
    rr(ctx, inset + 0.75, inset + 0.75, w - inset * 2 - 1.5, h - inset * 2 - 1.5, r)
    ctx.strokeStyle = P.hairline
    ctx.stroke()

    // -- notched corner detail: gold 45° ticks + jewel dots, TL and BR
    const notch = (cx, cy, dir) => {
      ctx.save()
      ctx.translate(cx, cy)
      ctx.scale(dir, dir)
      ctx.strokeStyle = P.goldDim
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.moveTo(2.5, 10.5)
      ctx.lineTo(10.5, 2.5)
      ctx.stroke()
      ctx.globalAlpha = 0.55
      ctx.beginPath()
      ctx.moveTo(5.5, 13.5)
      ctx.lineTo(13.5, 5.5)
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.fillStyle = P.gold
      ctx.save()
      ctx.translate(5.9, 5.9)
      ctx.rotate(Math.PI / 4)
      ctx.fillRect(-1.6, -1.6, 3.2, 3.2)
      ctx.restore()
      ctx.restore()
    }
    const nOff = inset - 1
    notch(nOff, nOff, 1)
    notch(w - nOff, h - nOff, -1)

    // -- top sheen on the glass
    const sheen = ctx.createLinearGradient(0, 0, 0, h * 0.24)
    sheen.addColorStop(0, 'rgba(255,255,255,0.06)')
    sheen.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = sheen
    ctx.fillRect(0, 0, w, h * 0.24)
  }

  // ===================================================================
  // DYNAMIC LAYER — view cone, pins, player arrow, sonar ping
  // ===================================================================

  function cameraYawAndSpan() {
    const poc = typeof window !== 'undefined' ? window.__POC : null
    const cam = poc && poc.engine && poc.engine.camera
    if (cam && cam.matrixWorld && cam.matrixWorld.elements) {
      const e = cam.matrixWorld.elements
      const fx = -e[8]
      const fz = -e[10]
      if (fx * fx + fz * fz > 1e-6) {
        const yaw = Math.atan2(fx, -fz) // 0 = north(-Z), cw positive
        let span = Math.PI / 4
        if (cam.fov && cam.aspect) {
          span = 2 * Math.atan(Math.tan((cam.fov * Math.PI) / 360) * cam.aspect)
        }
        return { yaw, span: clamp(span, Math.PI / 6, (Math.PI * 7) / 18) }
      }
    }
    return { yaw: facingAngle(player && player.facing), span: Math.PI / 4 }
  }

  function facingAngle(f) {
    if (f === 'e') return Math.PI / 2
    if (f === 's') return Math.PI
    if (f === 'w') return (Math.PI * 3) / 2
    return 0
  }

  let heading = facingAngle(player && player.facing)

  function drawStoryPin(ctx, s, t, phase) {
    // cyan shield-teardrop, 18×22 at design scale, tip at local (0,0)
    const pulse = 0.5 + 0.5 * Math.sin(t * 3.6 + phase)
    ctx.save()
    ctx.scale(s, s)

    // soft glow (gentle pulse)
    const glow = ctx.createRadialGradient(0, -11, 1, 0, -11, 15)
    glow.addColorStop(0, `rgba(63,201,242,${0.30 + 0.14 * pulse})`)
    glow.addColorStop(1, 'rgba(63,201,242,0)')
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(0, -11, 15, 0, TAU)
    ctx.fill()

    ctx.save()
    ctx.translate(0, -0.4 * pulse) // 0.4px bob — barely-there life
    const body = () => {
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.bezierCurveTo(-2.2, -4.5, -8.6, -7.5, -8.8, -13.4)
      ctx.bezierCurveTo(-9.0, -18.8, -4.9, -21.8, 0, -21.8)
      ctx.bezierCurveTo(4.9, -21.8, 9.0, -18.8, 8.8, -13.4)
      ctx.bezierCurveTo(8.6, -7.5, 2.2, -4.5, 0, 0)
      ctx.closePath()
    }
    // drop shadow
    ctx.save()
    ctx.translate(0.6, 1.8)
    body()
    ctx.fillStyle = 'rgba(0,0,0,0.42)'
    ctx.fill()
    ctx.restore()
    // fill
    body()
    const fill = ctx.createLinearGradient(0, -22, 0, 0)
    fill.addColorStop(0, P.pinBlueHi)
    fill.addColorStop(0.45, P.pinBlue)
    fill.addColorStop(1, P.pinBlueLo)
    ctx.fillStyle = fill
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = 'rgba(255,255,255,0.92)'
    ctx.stroke()
    // top-left inner sparkle
    ctx.beginPath()
    ctx.ellipse(-3.4, -16.6, 2.3, 1.5, -0.7, 0, TAU)
    ctx.fillStyle = 'rgba(235,251,255,0.55)'
    ctx.fill()
    // glyph
    ctx.fillStyle = '#ffffff'
    ctx.font = '700 11px Georgia, serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.shadowColor = 'rgba(10,58,80,0.8)'
    ctx.shadowBlur = 1.5
    ctx.shadowOffsetY = 1
    ctx.fillText('!', 0, -13.1)
    ctx.restore()
    ctx.restore()
  }

  function drawQuestPin(ctx, s, t, phase) {
    // stacked gold diamonds (frame01 shows the pair), centre ~(0,-13)
    const pulse = 0.5 + 0.5 * Math.sin(t * 3.1 + phase)
    ctx.save()
    ctx.scale(s, s)

    const glow = ctx.createRadialGradient(0, -13, 1, 0, -13, 16)
    glow.addColorStop(0, `rgba(234,201,63,${0.28 + 0.15 * pulse})`)
    glow.addColorStop(1, 'rgba(234,201,63,0)')
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(0, -13, 16, 0, TAU)
    ctx.fill()

    const diamond = (cx, cy, rad) => {
      const c = 2.2 // corner rounding
      ctx.beginPath()
      ctx.moveTo(cx, cy - rad)
      ctx.quadraticCurveTo(cx + c, cy - c, cx + rad, cy)
      ctx.quadraticCurveTo(cx + c, cy + c, cx, cy + rad)
      ctx.quadraticCurveTo(cx - c, cy + c, cx - rad, cy)
      ctx.quadraticCurveTo(cx - c, cy - c, cx, cy - rad)
      ctx.closePath()
    }

    ctx.save()
    ctx.translate(0, -0.4 * pulse)
    // back card of the stack — offset up-left, dimmer
    diamond(-4.4, -14.6, 9.2)
    ctx.fillStyle = '#b8942c'
    ctx.fill()
    ctx.lineWidth = 1.2
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'
    ctx.stroke()
    // shadow of the front card
    ctx.save()
    ctx.translate(0.7, 1.8)
    diamond(0, -13, 10)
    ctx.fillStyle = 'rgba(0,0,0,0.42)'
    ctx.fill()
    ctx.restore()
    // front card
    diamond(0, -13, 10)
    const fill = ctx.createLinearGradient(0, -23, 0, -3)
    fill.addColorStop(0, P.pinGoldHi)
    fill.addColorStop(0.5, P.pinGold)
    fill.addColorStop(1, P.pinGoldLo)
    ctx.fillStyle = fill
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.stroke()
    diamond(0, -13, 7.4)
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(138,109,36,0.85)'
    ctx.stroke()
    // glyph
    ctx.fillStyle = P.pinGoldGlyph
    ctx.font = '700 11px Georgia, serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('!', 0, -12.6)
    ctx.restore()
    ctx.restore()
  }

  function drawAnchorDot(ctx, x, y, s) {
    ctx.beginPath()
    ctx.arc(x, y, 2.3 * s, 0, TAU)
    ctx.fillStyle = 'rgba(245,239,221,0.95)'
    ctx.fill()
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(20,26,20,0.6)'
    ctx.stroke()
  }

  let pingT = 0 // sonar ping clock

  function drawDynamic(t, dt) {
    const w = layout.w
    const h = layout.h
    const s = clamp(layout.s, 0.75, 1.4)
    const ctx = dCtx
    ctx.clearRect(0, 0, w, h)

    // player map position
    const pp = player && player.position
    const pu = pp ? mapU(pp.x) : 0.5
    const pv = pp ? mapV(pp.z) : 0.5
    const pxx = clamp(pu, 0.03, 0.97) * w
    const pyy = clamp(pv, 0.03, 0.97) * h

    // smoothed heading (facing is 4-way; ease so the arrow feels alive)
    const { yaw, span } = cameraYawAndSpan()
    const targetHeading = facingAngle(player && player.facing)
    heading += shortestArc(heading, targetHeading) * Math.min(1, dt * 10)

    // ---- camera view-cone (frustum direction), under everything
    const coneR = w * 0.155
    const a0 = yaw - span / 2 - Math.PI / 2
    const a1 = yaw + span / 2 - Math.PI / 2
    const cone = ctx.createRadialGradient(pxx, pyy, 2, pxx, pyy, coneR)
    cone.addColorStop(0, 'rgba(150,228,246,0.26)')
    cone.addColorStop(0.55, 'rgba(150,228,246,0.10)')
    cone.addColorStop(1, 'rgba(150,228,246,0)')
    ctx.beginPath()
    ctx.moveTo(pxx, pyy)
    ctx.arc(pxx, pyy, coneR, a0, a1)
    ctx.closePath()
    ctx.fillStyle = cone
    ctx.fill()

    // ---- sonar ping — one soft ring every 2.8 s
    pingT += dt
    const cycle = pingT % 2.8
    if (cycle < 1.15) {
      const k = cycle / 1.15
      ctx.beginPath()
      ctx.arc(pxx, pyy, (3 + 9 * k) * s, 0, TAU)
      ctx.lineWidth = 1.2
      ctx.strokeStyle = `rgba(140,226,250,${0.24 * (1 - k)})`
      ctx.stroke()
    }

    // ---- pins (anchor dot at the POI, body floats just above)
    for (const pin of pins) {
      const x = pin.u * w
      const y = pin.v * h
      drawAnchorDot(ctx, x, y, s)
      ctx.save()
      ctx.translate(x, y - 4 * s)
      if (pin.cls === 'quest') drawQuestPin(ctx, s, t, pin.phase)
      else drawStoryPin(ctx, s, t, pin.phase)
      ctx.restore()
    }

    // ---- player chevron — white core, cyan glow, dark keel
    ctx.save()
    ctx.translate(pxx, pyy)

    const glow = ctx.createRadialGradient(0, 0, 1, 0, 0, 12 * s)
    glow.addColorStop(0, 'rgba(80,220,255,0.5)')
    glow.addColorStop(1, 'rgba(80,220,255,0)')
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(0, 0, 12 * s, 0, TAU)
    ctx.fill()

    ctx.rotate(heading)
    ctx.scale(s * 1.12, s * 1.12)
    const dart = () => {
      ctx.beginPath()
      ctx.moveTo(0, -8.2)
      ctx.lineTo(5.6, 6)
      ctx.lineTo(0, 3.1)
      ctx.lineTo(-5.6, 6)
      ctx.closePath()
    }
    ctx.save()
    ctx.translate(0.5, 1.5)
    dart()
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.fill()
    ctx.restore()
    dart()
    // white leading edge melting into the reference's saturated cyan
    const df = ctx.createLinearGradient(0, -8.2, 0, 6)
    df.addColorStop(0, '#f4feff')
    df.addColorStop(0.45, '#8ce4fa')
    df.addColorStop(1, '#38b7e4')
    ctx.fillStyle = df
    ctx.fill()
    ctx.lineWidth = 1.25
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#0b3742'
    ctx.stroke()
    ctx.restore()
  }

  // ===================================================================
  // REGION NAMEPLATE — fade in, hold, fade out on region change
  // ===================================================================

  const np = {
    phase: 'idle', // idle | in | hold | out
    timer: 0,
    current: null, // region currently on screen / last announced
    pending: DEFAULT_REGION,
    candidate: DEFAULT_REGION, // hysteresis: must win 2 consecutive polls
    candidateHits: 2,
    pollT: 999, // force an immediate first poll
    bootDelay: 0.4, // let the first frames land clean, like frame01 (was 1.2 —
                    // too long to clear before a capture settles on slow GL)
  }

  function regionAt(x, z) {
    let best = null
    let bestD = Infinity
    for (const poi of pois) {
      let reg = null
      if (poi.kind === 'bridge') {
        for (const b of BRIDGE_REGIONS) {
          if (poi.name && poi.name.indexOf(b.match) >= 0) reg = b
        }
      } else {
        reg = POI_REGIONS[poi.kind] || null
      }
      if (!reg) continue
      const dx = x - poi.x
      const dz = z - poi.z
      const d = Math.hypot(dx, dz)
      if (d < reg.r && d < bestD) {
        bestD = d
        best = reg
      }
    }
    if (best) return best
    let biome = 'grass'
    try {
      biome = terrain.biome(x, z)
    } catch (_) { /* stay on default */ }
    return BIOME_REGIONS[biome] || DEFAULT_REGION
  }

  function setPlateText(region) {
    npKicker.textContent = region.kicker
    npTitle.textContent = region.title
  }

  function updateNameplate(dt) {
    if (np.bootDelay > 0) {
      np.bootDelay -= dt
      if (np.bootDelay > 0) return
    }

    // poll the region ~4×/s; a new region must win two consecutive polls
    // before it becomes pending (no nameplate flicker on a boundary)
    np.pollT += dt
    if (np.pollT > 0.25 && player && player.position) {
      np.pollT = 0
      const seen = regionAt(player.position.x, player.position.z)
      if (seen.title === np.candidate.title) {
        if (++np.candidateHits >= 2) np.pending = np.candidate
      } else {
        np.candidate = seen
        np.candidateHits = 1
      }
    }

    const changed = !np.current || np.pending.title !== np.current.title
    np.timer += dt

    switch (np.phase) {
      case 'idle':
        if (changed || np.current === null) {
          np.current = np.pending
          setPlateText(np.current)
          nameplate.classList.add('abh-show')
          np.phase = 'in'
          np.timer = 0
        }
        break
      case 'in':
        if (np.timer > 0.65) {
          np.phase = 'hold'
          np.timer = 0
        }
        break
      case 'hold':
        // a region change mid-hold restarts the cycle via fade-out
        if (changed || np.timer > 7.0) {
          nameplate.classList.remove('abh-show')
          np.phase = 'out'
          np.timer = 0
        }
        break
      case 'out':
        if (np.timer > 0.95) {
          np.phase = 'idle'
          np.timer = 0
          if (!changed) np.current = np.pending // announced and done
          else np.current = null // trigger re-announce next tick
        }
        break
    }
  }

  // ===================================================================
  // frame update
  // ===================================================================

  let elapsed = 0
  window.addEventListener('resize', relayout)
  relayout()

  function update(dt) {
    // Ceiling was 0.1 s: on a software-GL box (2–3 fps) the HUD's own clock ran
    // at ~25 % of wall time, so the nameplate needed ~20 s of real time to
    // finish its intro and never made it into a screenshot. 0.5 still absorbs a
    // tab-restore spike without stalling the timeline on slow hardware.
    const step = typeof dt === 'number' && isFinite(dt) ? clamp(dt, 0, 0.5) : 0.016
    elapsed += step
    // cheap per-frame guard: catches DPR flips resize events can miss
    if (
      window.innerWidth !== layout.vw ||
      window.innerHeight !== layout.vh ||
      clamp(window.devicePixelRatio || 1, 1, 2.5) !== layout.dpr
    ) {
      relayout()
    }
    drawDynamic(elapsed, step)
    updateNameplate(step)
  }

  return { update, dom: root }
}
