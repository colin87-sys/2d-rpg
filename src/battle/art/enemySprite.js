// ---------------------------------------------------------------------------
// enemySprite.js — the painterly enemy wall (BATTLE_BIBLE §6, BATTLE_CONTRACT).
//
//   export function makeDragonArt(): EnemyArt     — hall enemy   (frame04)
//   export function makeSorcererArt(): EnemyArt   — highland boss (frame05)
//   export const enemyArtReady: Promise<void>     — resolves once both sheets
//                                                   have loaded AND every
//                                                   created texture holds a
//                                                   real frame (await before
//                                                   signalling capture-ready)
//
//   EnemyArt = { texture, px, py, anchor: 'feet'|'center', worldHeight,
//                floatOffset, meta: { name, palette, ... } }
//
//   Round 3: the 1,100-line Canvas2D generators are gone. The enemies are now
//   the GENERATED sheets of assets/manifest.json:
//
//     assets/enemies/hall-dragon.png         2048×2048, 4×4 grid of 512 cells,
//     assets/enemies/highland-sovereign.png  13 frames row-major top-left,
//                                            cells 13–15 empty, facing east,
//                                            straight (non-premultiplied) alpha
//
//   THE ASYNC SEAM — the factories stay synchronous. Each returns immediately
//   with a 512×512 CanvasTexture plus geometry baked from the manifest (and
//   from offline alpha-bbox measurement of the sheets — the numbers below are
//   measured, not guessed). When the sheet image arrives, the current frame is
//   blitted into the canvas and `needsUpdate` flips. `enemyArtReady` resolves
//   strictly AFTER pending blits run, so an awaited integrator never
//   screenshots a blank enemy.
//
//   WHY A PER-FRAME CANVAS AND NOT THE RAW ATLAS: units.js renders the enemy
//   as ONE full-canvas quad — its shader samples `uCellOff + uv * uCellRep`
//   with the enemy's window fixed at (0,0)/(1,1), and units.js must keep
//   working untouched. Handing it the 4×4 atlas would paint all 13 frames
//   onto the quad at once. So this module owns frame selection: atlas cells
//   are cut in CANVAS pixel space (row-major, y down — exactly the manifest's
//   convention, offsets from PIXEL sizes, never 1/cols) and the GPU only ever
//   sees a single-frame texture.
//
//   FLIP-Y CONVENTION: units.js builds the enemy quad with uv (0,0) at the
//   BOTTOM-left and samples the texture directly, which is three.js'
//   flipY = true convention (v = 0 → bottom row of the image). The previous
//   procedural CanvasTextures relied on that same default. So the frame
//   texture keeps `flipY = true`; the manifest's top-left row-major order is
//   consumed entirely on the CPU side where canvas y-down applies verbatim.
//   (flipY = false here would render the enemy upside down.)
//
//   Painterly law unchanged: LinearFilter + mipmaps + sRGB, straight alpha,
//   NO NearestFilter, no pixel outlines. This module owns enemy textures
//   only; it places nothing and lights nothing.
// ---------------------------------------------------------------------------

import * as THREE from 'three'

const asset = (rel) => new URL(rel, import.meta.url).href

// ---------------------------------------------------------------------------
// Sheet definitions — geometry from assets/manifest.json; `sil` (frame-0
// alpha bbox, alpha > 10, x1/y1 exclusive), anchor pixels and palettes were
// measured offline from the shipped PNGs.
// ---------------------------------------------------------------------------

const DRAGON_SHEET = {
  name: 'dragon',
  url: asset('../../../assets/enemies/hall-dragon.png'),
  sheetW: 2048, sheetH: 2048,
  cols: 4, rows: 4, cellW: 512, cellH: 512,
  frameCount: 13,
  emptyCells: [13, 14, 15],
  facing: 'east',                     // toward the party (+X) — no mirroring
  animDefs: {
    idle:   { start: 0,  count: 4 },
    attack: { start: 4,  count: 4 },
    hit:    { start: 8,  count: 2 },
    death:  { start: 10, count: 3, loop: false },
  },
  // Frame 0 silhouette: x 30–483, y 193–512 — feet planted on the cell
  // bottom, wing crest at the top. Ground-contact columns run x 262–341 in
  // every idle frame; px sits on their right shoulder (the forefeet claws,
  // ≈ 2/3 across the bbox exactly like frame04's own dragon) so units.js'
  // staging composes as designed: feet blob under the claws, mass pool
  // 1.25 m frame-left under the body, snout stopping short of the 0.50 fw
  // duel line. py is the packed ground line (cell bottom).
  sil: { x0: 30, y0: 193, x1: 483, y1: 512 },
  px: 340,
  py: 512,
  anchor: 'feet',
  worldHeight: 6.0,                   // §2: wing crest 6 m ≈ 3.75× the hero
  floatOffset: 0,
  // shadow → lit scale greys, then the amber/gold belly-glow accents
  palette: ['#0c0c0c', '#242424', '#3c3c3c', '#545454', '#5a6e82', '#6e8282',
            '#825a32', '#968246', '#aa8246'],
  image: null,
  pending: [],
  _load: null,
}

const SORCERER_SHEET = {
  name: 'sorcerer',
  url: asset('../../../assets/enemies/highland-sovereign.png'),
  sheetW: 2048, sheetH: 2048,
  cols: 4, rows: 4, cellW: 512, cellH: 512,
  frameCount: 13,
  emptyCells: [13, 14, 15],
  facing: 'east',
  animDefs: {
    idle:  { start: 0,  count: 4 },
    cast:  { start: 4,  count: 4 },
    hit:   { start: 8,  count: 2 },
    death: { start: 10, count: 3, loop: false },
  },
  // Frame 0 silhouette: x 81–423, y 31–473 (staff crest → robe hem), 442 px
  // = 6.5 m. units.js plants the anchor pixel at the §1 mass height of
  // 3.4 m; py is chosen so the hem then floats exactly the §6 0.6 m off the
  // ground (473 − 2.8 m · 68 px/m ≈ 283) with the crest at 7.1 m. px is the
  // silhouette's horizontal centre.
  sil: { x0: 81, y0: 31, x1: 423, y1: 473 },
  px: 252,
  py: 283,
  anchor: 'center',
  worldHeight: 6.5,                   // §2: 6.5 m including wings
  floatOffset: 0.6,                   // §6: levitates 0.6 m off the ground
  // robe teal-blacks, wound magentas, gold trim, beard silvers, spell teal
  palette: ['#0c0c0c', '#0a3246', '#460a32', '#6e0a46', '#6e5a32', '#82826e',
            '#aaaa96', '#d2d2be', '#49e0d6'],
  image: null,
  pending: [],
  _load: null,
}

// ---------------------------------------------------------------------------
// Loading — one shared image per sheet, kicked off at module import so the
// PNGs stream while the rest of the scene builds. Textures created before
// the image lands register a blit job; the onload handler runs every pending
// job BEFORE resolving, so `enemyArtReady` settles only with populated
// textures.
// ---------------------------------------------------------------------------

function loadSheet(def) {
  if (def._load) return def._load
  def._load = new Promise((resolve, reject) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => {
      def.image = img
      const jobs = def.pending.slice()
      def.pending.length = 0
      for (const job of jobs) job()
      resolve(img)
    }
    img.onerror = () => reject(new Error(`enemySprite: failed to load ${def.url}`))
    img.src = def.url
  })
  return def._load
}

export const enemyArtReady =
  Promise.all([loadSheet(DRAGON_SHEET), loadSheet(SORCERER_SHEET)]).then(() => undefined)

// ---------------------------------------------------------------------------
// Frame blit — atlas cell → single-frame canvas, all in pixel space.
// Offsets come from the manifest's pixel sizes scaled by the decoded image's
// real dimensions (pixel ratios, never 1/cols), so a resized re-export of
// the sheet still cuts on cell boundaries.
// ---------------------------------------------------------------------------

function frameRectPx(def, index, imgW, imgH) {
  const col = index % def.cols
  const row = (index / def.cols) | 0
  return {
    sx: Math.round(imgW * ((col * def.cellW) / def.sheetW)),
    sy: Math.round(imgH * ((row * def.cellH) / def.sheetH)),
    sw: Math.round(imgW * (def.cellW / def.sheetW)),
    sh: Math.round(imgH * (def.cellH / def.sheetH)),
  }
}

function makeEnemyArt(def) {
  const canvas = document.createElement('canvas')
  canvas.width = def.cellW
  canvas.height = def.cellH
  const ctx = canvas.getContext('2d')

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.flipY = true                // units.js samples v=0 at the quad
                                      // bottom on a full-frame texture — see
                                      // the convention note in the header
  texture.premultiplyAlpha = false    // manifest: real straight alpha
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true      // 512² is power-of-two
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping

  let current = def.animDefs.idle.start

  function blit() {
    const img = def.image
    if (!img) return
    const { sx, sy, sw, sh } = frameRectPx(def, current,
      img.naturalWidth || def.sheetW, img.naturalHeight || def.sheetH)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
    texture.needsUpdate = true
  }

  /** Present atlas frame `index` on the texture (empty cells are refused). */
  function setFrame(index) {
    if (!Number.isInteger(index) || index < 0 || index >= def.frameCount) return false
    current = index
    if (def.image) blit()
    return true                       // pre-load: the pending job blits it
  }

  if (def.image) blit()
  else def.pending.push(blit)

  // px per metre: the frame-0 silhouette spans exactly `worldHeight` metres
  // (same convention as the procedural art this replaces — staging sink /
  // mass height are applied by units.js on top).
  const silH = def.sil.y1 - def.sil.y0
  const pxPerMeter = silH / def.worldHeight

  // expanded frame lists, battlerSheet-style: anims.idle = [0,1,2,3], …
  const anims = {}
  for (const key of Object.keys(def.animDefs)) {
    const a = def.animDefs[key]
    anims[key] = Array.from({ length: a.count }, (_, i) => a.start + i)
  }

  return {
    texture,
    px: def.px,
    py: def.py,
    anchor: def.anchor,
    worldHeight: def.worldHeight,
    floatOffset: def.floatOffset,
    setFrame,                          // additive extra — nothing depends on it
    ready: loadSheet(def).then(() => undefined),
    meta: {
      name: def.name,
      palette: def.palette,
      canvas: { w: canvas.width, h: canvas.height },
      anchorPx: { x: def.px, y: def.py },        // same as px/py, unambiguous
      silhouette: { ...def.sil },                // frame-0 alpha bbox (px)
      pxPerMeter,
      // full-canvas quad size in metres if the whole texture is one plane:
      worldSize: { w: canvas.width / pxPerMeter, h: canvas.height / pxPerMeter },
      // anchor as UV (v measured from the BOTTOM, three.js convention):
      anchor01: { u: def.px / canvas.width, v: (canvas.height - def.py) / canvas.height },
      // the generated source sheet, for anyone wiring real frame animation:
      sheet: {
        url: def.url,
        width: def.sheetW, height: def.sheetH,
        cols: def.cols, rows: def.rows,
        cellW: def.cellW, cellH: def.cellH,
        frameCount: def.frameCount,
        emptyCells: def.emptyCells.slice(),
        facing: def.facing,
        order: 'row-major-top-left',
        animDefs: def.animDefs,                  // manifest form {start,count,loop}
        anims,                                   // expanded frame index lists
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Factories — synchronous, per BATTLE_CONTRACT.
// ---------------------------------------------------------------------------

/** Hall enemy (frame04): the obsidian-and-gold wyrm, grounded, facing east. */
export function makeDragonArt() {
  return makeEnemyArt(DRAGON_SHEET)
}

/** Highland boss (frame05): the levitating sovereign, anchored at centre. */
export function makeSorcererArt() {
  return makeEnemyArt(SORCERER_SHEET)
}
