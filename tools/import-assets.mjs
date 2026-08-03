// Asset import verifier — run before wiring any generated sheet into the game.
//
//   node tools/import-assets.mjs [--dir assets] [--json]
//
// Reads assets/manifest.json, then for every atlas checks the things that
// actually break rendering, in the order they break it:
//
//   1. the file exists, decodes, and matches the manifest's declared size
//   2. it carries real (straight, non-premultiplied) alpha
//   3. cells declared empty ARE empty, and cells declared occupied are NOT
//   4. every occupied cell's content fits inside its cell with no bleed
//   5. content SCALE is consistent across frames  <-- the one defect that
//      cannot be auto-repaired; position drift can, scale drift cannot
//   6. the bottom-centre foot anchor is where the manifest claims
//
// No image libraries are installed, so decoding goes through the pre-installed
// Chromium's canvas — same approach the shot harness uses.
import { chromium } from 'playwright'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1] }
const DIR = resolve(flag('dir', 'assets'))
const asJson = args.includes('--json')

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8'))

// Scale tolerance. Generated frames legitimately differ in silhouette height
// (a crouched `ko` pose IS shorter than `idle`), so height alone is a bad
// signal. We compare against the per-sheet MEDIAN and only flag outliers well
// outside what posing explains.
const SCALE_WARN = 0.25   // >25% off the median content height → worth a look
const SCALE_FAIL = 0.45   // >45% → almost certainly a scale error, not a pose

const browser = await chromium.launch({ executablePath: existsSync(CHROME) ? CHROME : undefined, args: ['--no-sandbox'] })
const page = await browser.newPage()

const report = []
let hardFails = 0

for (const a of manifest.assets) {
  const file = join(DIR, a.path)
  const row = { id: a.id, path: a.path, type: a.type, problems: [], notes: [] }

  if (!existsSync(file)) {
    row.problems.push({ level: 'MISSING', msg: `file not found at ${a.path}` })
    hardFails++
    report.push(row)
    continue
  }

  const b64 = readFileSync(file).toString('base64')
  const res = await page.evaluate(async ({ d, a, SCALE_WARN, SCALE_FAIL }) => {
    const img = new Image()
    img.src = d
    await img.decode()
    const c = new OffscreenCanvas(img.width, img.height)
    const cx = c.getContext('2d', { willReadFrequently: true })
    cx.drawImage(img, 0, 0)
    const all = cx.getImageData(0, 0, img.width, img.height).data

    // --- global alpha profile -------------------------------------------
    let transparent = 0, partial = 0, premultSuspect = 0
    for (let i = 0; i < all.length; i += 4) {
      const al = all[i + 3]
      if (al === 0) transparent++
      else if (al < 250) {
        partial++
        // straight alpha allows colour > alpha; premultiplied never does
        if (all[i] > al + 8 || all[i + 1] > al + 8 || all[i + 2] > al + 8) premultSuspect++
      }
    }
    const total = all.length / 4
    const out = {
      w: img.width, h: img.height,
      transparentPct: +(100 * transparent / total).toFixed(2),
      partialPct: +(100 * partial / total).toFixed(3),
      straightAlpha: premultSuspect > partial * 0.02,
      cells: [],
    }
    if (!a.grid) return out

    // --- per-cell alpha bounding boxes ----------------------------------
    const { columns, rows, cellWidth, cellHeight } = a.grid
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < columns; col++) {
        const idx = r * columns + col
        const ox = col * cellWidth, oy = r * cellHeight
        let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, opaque = 0
        for (let y = 0; y < cellHeight; y++) {
          const rowOff = ((oy + y) * img.width + ox) * 4
          for (let x = 0; x < cellWidth; x++) {
            if (all[rowOff + x * 4 + 3] > 16) {
              opaque++
              if (x < minX) minX = x
              if (x > maxX) maxX = x
              if (y < minY) minY = y
              if (y > maxY) maxY = y
            }
          }
        }
        out.cells.push(opaque === 0
          ? { idx, empty: true }
          : {
              idx, empty: false, opaque,
              x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1,
              // bottom-centre anchor, in cell-local pixels
              footX: +(((minX + maxX) / 2)).toFixed(1),
              footY: maxY + 1,
              touchesEdge: minX === 0 || minY === 0 || maxX === cellWidth - 1 || maxY === cellHeight - 1,
            })
      }
    }
    return out
  }, { d: `data:image/png;base64,${b64}`, a, SCALE_WARN, SCALE_FAIL })

  row.size = `${res.w}x${res.h}`
  row.transparentPct = res.transparentPct

  // 1. declared dimensions
  if (a.width && (res.w !== a.width || res.h !== a.height)) {
    row.problems.push({ level: 'FAIL', msg: `size ${res.w}x${res.h} != manifest ${a.width}x${a.height}` })
    hardFails++
  }

  // 2. alpha
  if (a.alpha === true && res.transparentPct < 1) {
    row.problems.push({ level: 'FAIL', msg: `manifest declares alpha but only ${res.transparentPct}% is transparent — background may be baked in` })
    hardFails++
  }
  if (a.alpha === true && manifest.premultipliedAlpha === false && !res.straightAlpha && res.partialPct > 0.05) {
    row.notes.push(`soft edges look premultiplied; set texture.premultiplyAlpha accordingly`)
  }

  if (res.cells.length) {
    const declaredEmpty = new Set(a.emptyCells || [])
    const occupied = res.cells.filter((c) => !c.empty)

    // 3. empty/occupied agreement
    for (const c of res.cells) {
      if (c.empty && !declaredEmpty.has(c.idx) && c.idx < (a.frameCount ?? res.cells.length)) {
        row.problems.push({ level: 'FAIL', msg: `cell ${c.idx} is blank but not declared empty — a frame is missing` })
        hardFails++
      }
      if (!c.empty && declaredEmpty.has(c.idx)) {
        row.problems.push({ level: 'WARN', msg: `cell ${c.idx} declared empty but has ${c.opaque} opaque px` })
      }
    }

    // 4. bleed
    const bleeding = occupied.filter((c) => c.touchesEdge)
    if (bleeding.length) {
      row.problems.push({ level: 'WARN', msg: `${bleeding.length} cell(s) touch their cell edge (${bleeding.slice(0, 6).map((c) => c.idx).join(', ')}${bleeding.length > 6 ? '…' : ''}) — content may be clipped` })
    }

    // 5. scale consistency — the un-repairable one
    const heights = occupied.map((c) => c.h).sort((x, y) => x - y)
    const median = heights[Math.floor(heights.length / 2)]
    row.contentHeight = { median, min: heights[0], max: heights[heights.length - 1] }
    const outliers = occupied
      .map((c) => ({ idx: c.idx, h: c.h, dev: (c.h - median) / median }))
      .filter((o) => Math.abs(o.dev) > SCALE_WARN)
      .sort((p, q) => Math.abs(q.dev) - Math.abs(p.dev))
    for (const o of outliers) {
      const lvl = Math.abs(o.dev) > SCALE_FAIL ? 'FAIL' : 'WARN'
      if (lvl === 'FAIL') hardFails++
      row.problems.push({
        level: lvl,
        msg: `cell ${o.idx} content height ${o.h}px is ${(o.dev * 100).toFixed(0)}% off the sheet median ${median}px` +
             (lvl === 'WARN' ? ' — check it is a pose, not a scale change' : ' — scale drift cannot be auto-repaired'),
      })
    }

    // 6. foot anchor spread
    const feet = occupied.map((c) => c.footY)
    const footMin = Math.min(...feet), footMax = Math.max(...feet)
    row.footSpreadPx = footMax - footMin
    if (a.anchor === 'bottom-center' && footMax - footMin > a.grid.cellHeight * 0.18) {
      row.notes.push(`feet vary ${footMax - footMin}px across frames — importer will re-anchor to bottom-centre (repairable)`)
    }
    row.frames = occupied.length
  }

  report.push(row)
}

await browser.close()

if (asJson) {
  console.log(JSON.stringify({ hardFails, report }, null, 2))
} else {
  for (const r of report) {
    const bad = r.problems.filter((p) => p.level !== 'WARN').length
    console.log(`\n${bad ? '✗' : r.problems.length ? '!' : '✓'} ${r.id}  (${r.path})`)
    if (r.size) console.log(`    ${r.size}  ${r.frames ?? '—'} frames  ${r.transparentPct}% transparent` +
      (r.contentHeight ? `  content h median ${r.contentHeight.median}px [${r.contentHeight.min}–${r.contentHeight.max}]` : '') +
      (r.footSpreadPx !== undefined ? `  foot spread ${r.footSpreadPx}px` : ''))
    for (const p of r.problems) console.log(`    [${p.level}] ${p.msg}`)
    for (const n of r.notes) console.log(`    · ${n}`)
  }
  console.log(`\n${hardFails === 0 ? 'All sheets pass. Safe to wire up.' : `${hardFails} hard failure(s) — fix before wiring.`}`)
}
process.exitCode = hardFails === 0 ? 0 : 1
