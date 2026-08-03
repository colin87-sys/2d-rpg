// ---------------------------------------------------------------------------
// characterSprite.js — hero + golden-bird mount sheets, loaded from the
// GENERATED overworld atlases (assets/manifest.json, binding):
//
//   assets/overworld/rain-stormblade-walk.png    1536×1152, 4×3 grid, 384 cells
//   assets/overworld/golden-bird-mount-walk.png  1536×1152, 4×3 grid, 384 cells
//
// Rows (row-major, cell 0 top-left): walk_south 0–3, walk_west 4–7,
// walk_north 8–11. There is NO east row — east is west mirrored.
//
// Contract (docs/CONTRACT.md — frozen):
//   export function makeHeroSheet(): Sheet
//   export function makeMountSheet(): Sheet
//   Sheet = { texture, frameW, frameH, cols, rows, anims, fps }
//   anim keys: idle_s idle_n idle_e idle_w walk_s walk_n walk_e walk_w
//              run_s run_n run_e run_w        (frame index = row * cols + col)
// Additive export (same idiom as battlerSheet.js's battlerSheetsReady):
//   export const characterSheetsReady: Promise<void> — resolves once both
//   PNGs are decoded AND repacked into their atlas canvases. The integrator
//   must await it before signalling the capture harness.
//
// WHY A REPACK PASS EXISTS (measured by tools/import-assets.mjs):
//   Both sheets ship a defective walk_west row (cells 4–7). Its content sits
//   at the TOP of the cell — hero feet at y 264/268/268/268, mount feet at
//   y 343/340/343/342, vs y 384 (the cell floor) for the south/north rows —
//   and each west cell also carries a small DETACHED debris fragment near the
//   bottom edge (stray crest/hair pixels: hero y 373–383, 169–212 opaque px;
//   mount y 366–383, 236–282 opaque px). A naive bottom-centre anchor from
//   the raw alpha bbox latches onto that debris and plants every west frame
//   ~120 px (hero) / ~42 px (mount) too high, so the unit would jump when
//   turning. player.js also has exactly ONE meta.groundRow per sheet, so the
//   fix must live in the pixels, not in a per-frame offset.
//
//   The fix mirrors the verifier's band segmentation (import-assets.mjs):
//   per cell, split the scanlines into contiguous non-empty bands, keep only
//   the band with the most opaque pixels (the figure), and compute the bbox
//   and bottom-centre foot anchor from that band alone. Each cell is then
//   redrawn into a 1536×1536 (4×4, power-of-two) canvas with its figure band
//   planted on a shared baseline (soles on row GROUND_ROW = 380) and its foot
//   centre on the cell's vertical centreline; the debris band is simply never
//   drawn. Row 3 of the repacked atlas is the east row: the cleaned west
//   band drawn through ctx.scale(-1, 1).
//
//   (A pure UV mirror — swapping u0/u1 per frame — is impossible here:
//   player.js's applyCell() derives UVs from the cell index alone via
//   texture.offset/repeat with a fixed positive repeat, and that file is
//   frozen. The one-time canvas mirror at load is the only seam-free way to
//   provide east without touching player.js.)
//
// Scale (docs/ART_BIBLE.md §5, binding): the hero BODY reads 1.60 m, not the
// cell. Measured standing body height (south cell 0, dominant band) is 278 px
// → meta.bodyPx = 278, so player.js sizes the plane at 1.6·384/278 ≈ 2.21 m.
// Mount texelsPerMeter = 166 makes the composited mounted unit top out at
// ≈ 2.40 m (bird crest 346 px ⇒ 2.40 m world with player.js's ×1.15 tune).
// ---------------------------------------------------------------------------

import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Atlas geometry (assets/manifest.json) + repack constants
// ---------------------------------------------------------------------------

const CELL = 384                  // px per frame cell, both sheets
const COLS = 4
const SRC_ROWS = 3                // south / west / north in the PNGs
const DST_ROWS = 4                // + mirrored east row in the repacked atlas
const ATLAS = CELL * COLS         // 1536 — repacked canvas is 1536×1536 (PO2)

const GROUND_ROW = 380            // soles rest here after repack; rows 381–383
                                  // stay clear so bases can sink (bible §6)
const ALPHA_ON = 16               // opacity threshold — same as the verifier
const FPS = 8                     // 4-frame stride ≈ 2 steps/s; player.js
                                  // speed-scales the rate around this

const ASSET_BASE = new URL('../../assets/overworld/', import.meta.url)

// Measured constants (tools/import-assets.mjs band data — see header).
// These feed meta synchronously, because createPlayer() runs before the PNGs
// finish decoding and reads meta at construction time.
const BODY_M = 1.6                // bible §5 — the hero IS the scale unit

const HERO = {
  file: 'rain-stormblade-walk.png',
  bodyPx: 278,                    // standing body height, south cell 0 band
  hipRow: 287,                    // belt/buckle line after repack (row from
                                  // cell top) — rider seat for compositing
}

const MOUNT = {
  file: 'golden-bird-mount-walk.png',
  bodyPx: 346,                    // standing bird height (crest→claws), south
  texelsPerMeter: 166,            // 384/166 × player's 1.15 ⇒ 2.66 m plane;
                                  // bird crest 346 px reads 2.40 m (bible §5
                                  // mounted-unit height)
  // Rider hip target per facing, repacked-cell px from top-left. Measured off
  // the saddle pad; east mirrors west (x → CELL−1−x).
  saddle: {
    s: { x: 192, y: 200 },
    n: { x: 192, y: 192 },
    w: { x: 216, y: 210 },
    e: { x: 167, y: 210 },
  },
}

// ---------------------------------------------------------------------------
// Band segmentation — the verifier's algorithm, verbatim in approach:
// contiguous non-empty scanline bands per cell, dominant band by opaque-pixel
// count, bbox + bottom-centre foot anchor from the dominant band only.
// ---------------------------------------------------------------------------

/**
 * @param {Uint8ClampedArray} data  RGBA of the WHOLE source image
 * @param {number} imgW             source image width in px
 * @param {number} ox @param {number} oy   cell origin in the source image
 * @returns {null | {a:number,b:number,minX:number,maxX:number,maxY:number}}
 *   dominant-band rows [a, b] and its bbox extremes (cell-local px)
 */
function dominantBand(data, imgW, ox, oy) {
  const rowCount = new Array(CELL).fill(0)
  for (let y = 0; y < CELL; y++) {
    const off = ((oy + y) * imgW + ox) * 4
    let n = 0
    for (let x = 0; x < CELL; x++) if (data[off + x * 4 + 3] > ALPHA_ON) n++
    rowCount[y] = n
  }
  // contiguous non-empty bands — detached debris shows up as its own band
  const bands = []
  for (let y = 0, s = -1; y <= CELL; y++) {
    const on = y < CELL && rowCount[y] > 0
    if (on && s < 0) s = y
    else if (!on && s >= 0) { bands.push({ a: s, b: y - 1, px: 0 }); s = -1 }
  }
  for (const bd of bands) for (let y = bd.a; y <= bd.b; y++) bd.px += rowCount[y]
  const dom = bands.reduce((best, bd) => (!best || bd.px > best.px ? bd : best), null)
  if (!dom) return null
  // bbox within the dominant band only
  let minX = CELL, maxX = -1, maxY = -1
  for (let y = dom.a; y <= dom.b; y++) {
    const off = ((oy + y) * imgW + ox) * 4
    for (let x = 0; x < CELL; x++) {
      if (data[off + x * 4 + 3] > ALPHA_ON) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  return { a: dom.a, b: dom.b, minX, maxX, maxY }
}

// ---------------------------------------------------------------------------
// Repack — 4×3 source PNG → 4×4 atlas canvas, every figure re-anchored to the
// shared baseline, debris dropped, east row appended as mirrored west.
// ---------------------------------------------------------------------------

function repack(dstCanvas, img) {
  // read the source alpha once
  const scan = document.createElement('canvas')
  scan.width = img.width
  scan.height = img.height
  const sctx = scan.getContext('2d', { willReadFrequently: true })
  sctx.drawImage(img, 0, 0)
  const data = sctx.getImageData(0, 0, img.width, img.height).data

  const ctx = dstCanvas.getContext('2d')
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, ATLAS, ATLAS)

  const centre = (CELL - 1) / 2 // 191.5
  const westBands = []          // reused for the mirrored east row

  for (let row = 0; row < SRC_ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const band = dominantBand(data, img.width, col * CELL, row * CELL)
      if (!band) continue
      if (row === 1) westBands[col] = band
      // plant soles on GROUND_ROW, foot centre on the cell centreline;
      // drawing only rows a..b of the source cell drops the debris band
      const dy = GROUND_ROW - band.maxY
      const dx = Math.round(centre - (band.minX + band.maxX) / 2)
      ctx.drawImage(
        img,
        col * CELL, row * CELL + band.a, CELL, band.b - band.a + 1,
        col * CELL + dx, row * CELL + band.a + dy, CELL, band.b - band.a + 1,
      )
    }
  }

  // east row (atlas row 3): the CLEANED west band, mirrored about the cell's
  // vertical centreline — frame order preserved (east i = mirror of west i)
  for (let col = 0; col < COLS; col++) {
    const band = westBands[col]
    if (!band) continue
    const dy = GROUND_ROW - band.maxY
    const dxm = -Math.round(centre - (band.minX + band.maxX) / 2)
    ctx.save()
    ctx.translate(col * CELL + CELL + dxm, 3 * CELL)
    ctx.scale(-1, 1)
    ctx.drawImage(
      img,
      col * CELL, 1 * CELL + band.a, CELL, band.b - band.a + 1,
      0, band.a + dy, CELL, band.b - band.a + 1,
    )
    ctx.restore()
  }
}

// ---------------------------------------------------------------------------
// Textures — synchronous handles, async pixels (battlerSheet.js idiom).
// Both PNGs start loading at module import; the factories hand out the
// (possibly still-blank) CanvasTexture immediately and the repack pass fills
// it in, flipping needsUpdate.
// ---------------------------------------------------------------------------

function makeAtlasTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = ATLAS
  canvas.height = ATLAS
  const tex = new THREE.CanvasTexture(canvas)
  // Pixel-art setup (manifest: sRGB, real straight alpha; bible: hard texels)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.flipY = true                    // player.js applyCell() convention:
                                      // offset.y = 1 − (row+1)/rows addresses
                                      // row-major-top-left cells ONLY under
                                      // three's default flipY = true
  tex.premultiplyAlpha = false
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  return tex
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous' // TextureLoader's default; keeps the repack
                                  // canvas readable if assets come off a CDN
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`characterSprite: failed to load ${url}`))
    img.src = url
  })
}

const heroTexture = makeAtlasTexture()
const mountTexture = makeAtlasTexture()

function loadAndRepack(file, texture) {
  return loadImage(new URL(file, ASSET_BASE).href).then((img) => {
    repack(texture.image, img)
    texture.needsUpdate = true
  })
}

// Additive export — resolves when both atlases are decoded, cleaned and
// repacked. Rejects loudly if a PNG is missing: the harness must never
// screenshot a blank hero.
export const characterSheetsReady = Promise.all([
  loadAndRepack(HERO.file, heroTexture),
  loadAndRepack(MOUNT.file, mountTexture),
]).then(() => undefined)

// ---------------------------------------------------------------------------
// Anims — honest mapping of a walk-only, three-row source (+ mirrored east):
//   walk_s/w/n ← atlas rows 0/1/2; walk_e ← row 3 (west mirrored at repack)
//   idle_*     ← the first frame of the walk row (the standing/contact pose)
//   run_*      ← the walk cycle; the single sheet-wide fps carries the pace
//                (player.js additionally speed-scales its animation rate)
// ---------------------------------------------------------------------------

const FACE_ROW = { s: 0, w: 1, n: 2, e: 3 }

function buildAnims() {
  const anims = {}
  for (const [face, row] of Object.entries(FACE_ROW)) {
    const cells = [0, 1, 2, 3].map((i) => row * COLS + i)
    anims['walk_' + face] = cells
    anims['run_' + face] = cells.slice()
    anims['idle_' + face] = [cells[0]]
  }
  return anims
}

// ---------------------------------------------------------------------------
// Public API (contract signatures — frozen)
// ---------------------------------------------------------------------------

export function makeHeroSheet() {
  const tpm = HERO.bodyPx / BODY_M // 278 px body reads 1.60 m → 173.75 tx/m
  return {
    texture: heroTexture,
    frameW: CELL,
    frameH: CELL,
    cols: COLS,
    rows: DST_ROWS,
    anims: buildAnims(),
    fps: FPS,
    // Extra (non-contract, safe to ignore): compositing + scale guidance.
    meta: {
      kind: 'hero',
      texelsPerMeter: tpm,
      bodyPx: HERO.bodyPx,        // player.js: plane = 1.6·384/278 ≈ 2.21 m
      groundRow: GROUND_ROW,
      hipRow: HERO.hipRow,        // belt line — lands on the mount's saddle
      planeMeters: { w: CELL / tpm, h: CELL / tpm },
    },
  }
}

export function makeMountSheet() {
  // No ride_* variants exist in the generated sheet (it was produced
  // riderless in ordinary walk posture) — player.js's resolveAnim() falls
  // back from ride_<state>_<face> to <state>_<face> automatically.
  return {
    texture: mountTexture,
    frameW: CELL,
    frameH: CELL,
    cols: COLS,
    rows: DST_ROWS,
    anims: buildAnims(),
    fps: FPS,
    meta: {
      kind: 'mount',
      texelsPerMeter: MOUNT.texelsPerMeter,
      bodyPx: MOUNT.bodyPx,
      groundRow: GROUND_ROW,
      planeMeters: { w: CELL / MOUNT.texelsPerMeter, h: CELL / MOUNT.texelsPerMeter },
      // Hero hips land here (repacked-cell px from top) when composited.
      saddle: MOUNT.saddle,
      // bobByCell omitted deliberately: per-frame body bob cannot be
      // recovered reliably from the generated frames; player.js treats a
      // missing table as zero bob and keeps the rider glued to the saddle.
    },
  }
}
