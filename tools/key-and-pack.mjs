// Chroma-key a green-screen sprite sheet and re-pack it onto a clean grid.
//
//   node tools/key-and-pack.mjs <in.png> <out.png> --cols 4 --rows 4 --cell 320
//
// Generated sheets sometimes arrive on a green field instead of with real
// alpha. Keying is not just "delete the green pixels": a painterly sprite has
// a soft, dark edge glaze, and that glaze picks up green spill from the
// backdrop. A hard threshold leaves a lime rind around every silhouette that
// is glaringly obvious once the sprite is composited over a dark hall.
//
// So three passes:
//   1. ALPHA from greenness, with a soft ramp — hard cut inside, feathered at
//      the boundary, so the painterly edge survives.
//   2. DESPILL — pull the green channel back down toward the red/blue
//      envelope wherever it exceeds it. This is what removes the rind.
//   3. RE-PACK — trim each frame to its own content and re-place it
//      bottom-centre in a uniform cell, at NATIVE scale (no resampling, so no
//      quality loss). Fixes anchor drift for free.
//
// Relative frame sizes are preserved exactly — frames are never normalised to
// each other, because their size differences are the animation.
import { chromium } from 'playwright'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1] }
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')))
const IN = resolve(positional[0])
const OUT = resolve(positional[1])
const COLS = Number(flag('cols', 4))
const ROWS = Number(flag('rows', 4))
const CELL = Number(flag('cell', 320))

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const page = await browser.newPage()

const b64 = readFileSync(IN).toString('base64')
const result = await page.evaluate(async ({ d, COLS, ROWS, CELL }) => {
  const img = new Image()
  img.src = d
  await img.decode()
  const src = new OffscreenCanvas(img.width, img.height)
  const sx = src.getContext('2d', { willReadFrequently: true })
  sx.drawImage(img, 0, 0)
  const im = sx.getImageData(0, 0, img.width, img.height)
  const px = im.data

  // --- 1 + 2: key and despill ------------------------------------------
  // greenness = how far green runs ahead of the red/blue envelope. Neutral and
  // warm pixels (this dragon is slate, gold and amber) score at or below zero,
  // so nothing in the subject is at risk.
  const T_KEEP = 24   // at or below → fully opaque
  const T_CUT = 78    // at or above → fully transparent

  // Decide whether this sheet needs keying AT ALL before touching a pixel.
  // A sheet that already carries real alpha and has no green field must be
  // re-packed only: despilling it would clamp the green channel on genuinely
  // green-leaning art (slate scales here read slightly green in shadow) and
  // quietly shift the palette for no reason.
  let preAlpha = 0, preGreen = 0
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) preAlpha++
    if (px[i + 1] > 90 && px[i + 1] - Math.max(px[i], px[i + 2]) > 55) preGreen++
  }
  const total0 = px.length / 4
  const needsKey = (preGreen / total0) > 0.02
  const hadAlpha = (preAlpha / total0) > 0.02

  let keyed = 0, despilled = 0
  if (!needsKey) {
    keyed = preAlpha
  } else for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2]
    const env = Math.max(r, b)
    const greenness = g - env
    let a = 255
    if (greenness >= T_CUT) a = 0
    else if (greenness > T_KEEP) a = Math.round(255 * (1 - (greenness - T_KEEP) / (T_CUT - T_KEEP)))
    // Never ADD opacity. A sheet that already carries real alpha must survive
    // this pass untouched — transparent pixels there are (0,0,0,0), which score
    // zero greenness and would otherwise be promoted to fully opaque black.
    a = Math.min(a, px[i + 3])
    if (a === 0) { px[i + 3] = 0; keyed++; continue }
    if (greenness > 0) {
      // Clamp green to the envelope. Keeps hue for anything genuinely green
      // (nothing here) while stripping spill from the dark edge glaze.
      px[i + 1] = env + Math.round(Math.min(greenness, 6) * 0.5)
      despilled++
    }
    px[i + 3] = a
  }
  sx.putImageData(im, 0, 0)

  // --- 3: find each frame's content bbox inside its grid cell -----------
  const pitchX = img.width / COLS, pitchY = img.height / ROWS
  const frames = []
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const ox = Math.floor(c * pitchX), oy = Math.floor(r * pitchY)
      const w = Math.floor((c + 1) * pitchX) - ox, h = Math.floor((r + 1) * pitchY) - oy
      let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, n = 0
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (px[((oy + y) * img.width + ox + x) * 4 + 3] > 24) {
            n++
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
          }
        }
      }
      frames.push(n < 64
        ? { idx: r * COLS + c, empty: true }
        : { idx: r * COLS + c, empty: false, sx: ox + minX, sy: oy + minY, w: maxX - minX + 1, h: maxY - minY + 1, px: n })
    }
  }

  // --- re-pack, native scale, bottom-centre ----------------------------
  const out = new OffscreenCanvas(COLS * CELL, ROWS * CELL)
  const ox2 = out.getContext('2d')
  ox2.imageSmoothingEnabled = false
  const oversize = []
  for (const f of frames) {
    if (f.empty) continue
    if (f.w > CELL || f.h > CELL) { oversize.push({ idx: f.idx, w: f.w, h: f.h }); continue }
    const cx = (f.idx % COLS) * CELL + Math.round((CELL - f.w) / 2)
    const cy = (Math.floor(f.idx / COLS) + 1) * CELL - f.h   // feet on the cell floor
    ox2.drawImage(src, f.sx, f.sy, f.w, f.h, cx, cy, f.w, f.h)
  }
  const blob = await out.convertToBlob({ type: 'image/png' })
  const buf = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i])
  return {
    srcSize: `${img.width}x${img.height}`,
    outSize: `${COLS * CELL}x${ROWS * CELL}`,
    needsKey, hadAlpha,
    keyedPct: +(100 * keyed / (px.length / 4)).toFixed(1),
    despilledPct: +(100 * despilled / (px.length / 4)).toFixed(2),
    frames: frames.filter((f) => !f.empty).map((f) => ({ idx: f.idx, w: f.w, h: f.h })),
    emptyCells: frames.filter((f) => f.empty).map((f) => f.idx),
    oversize,
    b64: btoa(bin),
  }
}, { d: `data:image/png;base64,${b64}`, COLS, ROWS, CELL })

await browser.close()
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, Buffer.from(result.b64, 'base64'))

console.log(`source        ${result.srcSize}`)
console.log(`output        ${result.outSize}  → ${OUT}`)
console.log(result.needsKey
  ? `chroma key     applied — ${result.keyedPct}% keyed out, ${result.despilledPct}% despilled`
  : `chroma key     SKIPPED — source already has real alpha (${result.keyedPct}% transparent), no green field; repack only`)
console.log(`frames        ${result.frames.length}  (empty cells: ${result.emptyCells.join(', ') || 'none'})`)
const hs = result.frames.map((f) => f.h)
console.log(`content h     ${Math.min(...hs)}–${Math.max(...hs)}px`)
for (const f of result.frames) console.log(`  cell ${String(f.idx).padStart(2)}  ${f.w}x${f.h}`)
if (result.oversize.length) {
  console.log(`\nOVERSIZE — these do not fit a ${CELL}px cell and were DROPPED:`)
  for (const o of result.oversize) console.log(`  cell ${o.idx}  ${o.w}x${o.h}`)
  process.exitCode = 1
}
