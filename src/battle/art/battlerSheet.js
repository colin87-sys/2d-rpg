// ---------------------------------------------------------------------------
// battlerSheet.js — the four battle chibi sheets, loaded from the generated
// atlases under assets/battlers/ (geometry per assets/manifest.json, binding).
//
// Contract (docs/BATTLE_CONTRACT.md — frozen):
//   export function makeBattlerSheet(id): Sheet   // 'rain'|'lasswell'|'fina'|'lid'
//   Sheet = { texture, frameW, frameH, cols, rows, anims, fps,
//             meta: { texelsPerMeter, bodyPx, groundRow } }
//   anim keys: idle ready attack cast hit ko victory
//   (west-facing profile; victory faces south — the sheets bake exactly that)
//
// Additive export (integrator-facing, does not change any existing one):
//   export const battlerSheetsReady: Promise<void>
//     resolves once all four PNG atlases have finished loading. The factory
//     stays synchronous — THREE.TextureLoader.load() returns the Texture
//     immediately and populates .image when the file arrives — so main.js
//     builds the whole scene as before, then the integrator awaits this
//     promise before signalling the capture harness; otherwise the first
//     screenshot fires on blank textures.
//
// Atlas geometry (assets/manifest.json — binding):
//   1920×1600 px, 6 cols × 5 rows of 320 px cells, row-major from top-left.
//   29 authored frames, cell 29 (bottom-right) empty. Anchor bottom-centre:
//   soles rest on cell row 309 in every frame (measured across all four
//   sheets); rows 310–319 stay clear so units.js can sink boots into the
//   floor's ambient. Real straight alpha, pixel art → NearestFilter, sRGB,
//   no mipmaps.
//
// Scale (BATTLE_BIBLE §1–§2, binding): the battle chibi body is 1.60 m and
// lands at 0.174 fh front rank / 0.125 fh back rank under the fixed camera —
// rank size difference is pure perspective, so no per-rank scaling here or
// anywhere. The generated sheets draw each character at a different pixel
// height (crown→sole, standing idle, measured): rain 178, lasswell 235,
// fina 218, lid 206 — so texelsPerMeter is per-character (bodyPx / 1.60) and
// every battler's body reads exactly 1.60 m in world.
//
// UV / flipY convention (must match units.js — see its line ~161): frame UVs
// are computed from PIXEL ratios with
//   offset.v = 1 − ((row + 1) · frameH) / texH
// which is the flipY = true convention (three.js image-texture default —
// v = 1 at the image's top row, so row 0 lands upright at the top). The old
// procedural CanvasTexture used the same default; keep flipY = true or every
// frame renders upside down. Note 6·320 = 1920 tiles this sheet exactly, but
// units.js's pixel-ratio math is still the required form — never 1/cols.
//
// NOTE: src/battle/ui/timeline.js re-declares this module's old colour ramps
// byte-for-byte for its painted busts (its own copies, zero imports from
// here) — so the ramp constants could be deleted with the rest of the
// procedural painter. The identity bytes live on in timeline.js.
// ---------------------------------------------------------------------------

import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Sheet geometry (assets/manifest.json — binding)
// ---------------------------------------------------------------------------

const CELL = 320                // px per frame cell
const COLS = 6
const ROWS = 5
const SHEET_W = 1920            // = COLS·CELL (exact tiling)
const SHEET_H = 1600            // = ROWS·CELL
const FPS = 12                  // one clock; per-anim pacing via repeat orders
const BODY_M = 1.6              // BIBLE §2: battle chibi body height, binding

const GROUND_ROW = 309          // soles (measured, all four sheets, all
                                // frames); rows 310–319 clear for foot-sink

// Per-character atlas + measured standing body height (crown→sole, idle).
const CHARS = {
  rain:     { name: 'Rain',     file: 'rain-stormblade.png',          bodyPx: 178 },
  lasswell: { name: 'Lasswell', file: 'lasswell-katana-duellist.png', bodyPx: 235 },
  fina:     { name: 'Fina',     file: 'fina-radiant-support.png',     bodyPx: 218 },
  lid:      { name: 'Lid',      file: 'lid-engineer.png',             bodyPx: 206 },
}

// Cell layout — the manifest's {start, count} ranges, identical on all four.
const LAYOUT = {
  idle: [0, 4], ready: [4, 4], attack: [8, 6], cast: [14, 6],
  hit: [20, 2], ko: [22, 3], victory: [25, 4],
}

// Playback orders over the 12 fps clock (overworld IDLE_ORDER idiom) —
// timings land on BIBLE §9: idle 6 fps, cast ≈0.9 s with the VFX-peak hold,
// hit 250 ms, ko falls then stays slumped (loop:false baked as a tail hold),
// victory celebration loop. The choreography paces itself on these arrays —
// do not retime them.
const ORDERS = {
  idle:    [0, 0, 1, 1, 2, 2, 3, 3],
  ready:   [0, 1, 2, 3, 2, 3, 2, 3],
  attack:  [0, 0, 1, 2, 3, 3, 4, 5],
  cast:    [0, 1, 2, 2, 3, 3, 4, 4, 4, 5, 5],
  hit:     [0, 0, 1],
  ko:      [0, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2],
  victory: [0, 0, 1, 1, 2, 2, 3, 3],
}

// Expand {start,count} ranges through the repeat orders → explicit absolute
// cell indices, the contract's Record<string, number[]>.
function animsFromOrders() {
  const anims = {}
  for (const [k, [start]] of Object.entries(LAYOUT)) {
    anims[k] = ORDERS[k].map((i) => start + i)
  }
  return anims
}

// ---------------------------------------------------------------------------
// Texture loading — synchronous handles, async pixels.
// All four atlases start loading at module import; makeBattlerSheet() hands
// out the (possibly still-populating) Texture immediately.
// ---------------------------------------------------------------------------

const ASSET_BASE = new URL('../../../assets/battlers/', import.meta.url)
const loader = new THREE.TextureLoader()

const TEXTURES = {}   // id → THREE.Texture (handle valid immediately)
const LOADS = []      // per-id promises feeding battlerSheetsReady

for (const [id, ch] of Object.entries(CHARS)) {
  const url = new URL(ch.file, ASSET_BASE).href
  LOADS.push(new Promise((resolve, reject) => {
    TEXTURES[id] = loader.load(
      url,
      (tex) => { tex.needsUpdate = true; resolve(tex) },
      undefined,
      () => reject(new Error(`battlerSheet: failed to load ${url}`)),
    )
    const tex = TEXTURES[id]
    // Pixel-art atlas setup (straight alpha, sRGB, hard texels, no mips).
    tex.colorSpace = THREE.SRGBColorSpace
    tex.flipY = true                    // units.js UV convention — see header
    tex.premultiplyAlpha = false        // manifest: real straight alpha
    tex.magFilter = THREE.NearestFilter
    tex.minFilter = THREE.NearestFilter
    tex.generateMipmaps = false
    tex.wrapS = THREE.ClampToEdgeWrapping
    tex.wrapT = THREE.ClampToEdgeWrapping
  }))
}

// Additive export — resolves when every battler atlas is decoded and ready
// to upload. Rejects loudly if any PNG is missing; the harness must not
// screenshot a party of blank quads.
export const battlerSheetsReady = Promise.all(LOADS).then(() => undefined)

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function makeBattlerSheet(id) {
  const ch = CHARS[id]
  if (!ch) throw new Error(`makeBattlerSheet: unknown id '${id}' (rain|lasswell|fina|lid)`)
  const tpm = ch.bodyPx / BODY_M       // per-character: body reads 1.60 m
  return {
    texture: TEXTURES[id],
    frameW: CELL,
    frameH: CELL,
    cols: COLS,
    rows: ROWS,
    anims: animsFromOrders(),
    fps: FPS,
    meta: {
      // --- contract fields
      texelsPerMeter: tpm,             // 320 px cell → CELL/tpm metres of plane
      bodyPx: ch.bodyPx,               // crown→sole standing, measured
      groundRow: GROUND_ROW,           // soles; rows 310–319 clear to sink
      // --- extras (additive, safe to ignore)
      kind: 'battler',
      id,
      name: ch.name,
      planeMeters: { w: CELL / tpm, h: CELL / tpm },
      sheetPx: { w: SHEET_W, h: SHEET_H },
      frameCount: 29,                  // cell 29 is empty (manifest)
      facing: 'west-except-victory-front',
      // UVs from pixel ratios (units.js's required form; here cols·frameW
      // happens to tile exactly, but the ratios stay the source of truth).
      uv: { u: CELL / SHEET_W, v: CELL / SHEET_H },
      cellUV: (i) => ({
        u: ((i % COLS) * CELL) / SHEET_W,
        v: 1 - ((Math.floor(i / COLS) + 1) * CELL) / SHEET_H,
      }),
    },
  }
}
