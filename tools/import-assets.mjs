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

// Scale tolerance.
//
// Naive whole-sheet comparison does not work: a `ko` frame is a character
// LYING DOWN and is legitimately ~half height, and `victory` raises a weapon
// overhead and is legitimately taller. Comparing those to a sheet-wide median
// flags correct art as broken (it did, on all four battlers).
//
// So compare in two passes instead:
//   WITHIN an animation — every frame of `idle` depicts the same standing
//     character, so a real scale change shows up here.
//   ACROSS animations — only between animations that share a posture. Prone
//     and airborne anims are exempt from cross-comparison, because their
//     height difference is the pose, not the scale.
const WITHIN_WARN = 0.18
const WITHIN_FAIL = 0.35
const ACROSS_WARN = 0.22
const ACROSS_FAIL = 0.40
// Animations whose silhouette height is not comparable to a standing pose.
const POSTURE_EXEMPT = /^(ko|death|die|down|hit|hurt|knock)/i

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
  const res = await page.evaluate(async ({ d, a }) => {
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

        // Pass 1 — opaque pixel count per scanline, so detached debris shows up
        // as its own band. Generated sheets carry orphan fragments (stray hair
        // or crest tips left behind by the generator), and because they can sit
        // BELOW the character they would hijack a naive bottom-centre anchor and
        // plant every frame too high. Keep only the dominant band.
        const rowCount = new Array(cellHeight).fill(0)
        for (let y = 0; y < cellHeight; y++) {
          const rowOff = ((oy + y) * img.width + ox) * 4
          let n = 0
          for (let x = 0; x < cellWidth; x++) if (all[rowOff + x * 4 + 3] > 16) n++
          rowCount[y] = n
        }
        const bands = []
        for (let y = 0, s = -1; y <= cellHeight; y++) {
          const on = y < cellHeight && rowCount[y] > 0
          if (on && s < 0) s = y
          else if (!on && s >= 0) { bands.push({ a: s, b: y - 1, px: 0 }); s = -1 }
        }
        for (const bd of bands) for (let y = bd.a; y <= bd.b; y++) bd.px += rowCount[y]
        const dominant = bands.reduce((best, bd) => (!best || bd.px > best.px ? bd : best), null)
        const discarded = bands.filter((bd) => bd !== dominant && bd.px > 0)
        const yLo = dominant ? dominant.a : 0
        const yHi = dominant ? dominant.b : -1

        // Pass 2 — bbox within the dominant band only.
        let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, opaque = 0
        for (let y = yLo; y <= yHi; y++) {
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
              debris: discarded.map((bd) => ({ y0: bd.a, y1: bd.b, px: bd.px })),
            })
      }
    }
    return out
  }, { d: `data:image/png;base64,${b64}`, a })

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

    // 4. bleed and orphan debris
    const bleeding = occupied.filter((c) => c.touchesEdge)
    if (bleeding.length) {
      row.problems.push({ level: 'WARN', msg: `${bleeding.length} cell(s) touch their cell edge (${bleeding.slice(0, 6).map((c) => c.idx).join(', ')}${bleeding.length > 6 ? '…' : ''}) — content may be clipped` })
    }
    const withDebris = occupied.filter((c) => c.debris && c.debris.length)
    if (withDebris.length) {
      const worst = withDebris.flatMap((c) => c.debris).reduce((m, d) => Math.max(m, d.px), 0)
      row.notes.push(`${withDebris.length} cell(s) carry detached fragments away from the figure ` +
        `(cells ${withDebris.slice(0, 6).map((c) => c.idx).join(', ')}${withDebris.length > 6 ? '…' : ''}; largest ${worst}px). ` +
        `Discarded before anchoring — had they been kept, bottom-centre would have planted on the debris.`)
    }

    // 5. scale consistency — the un-repairable one
    const med = (xs) => { const s = [...xs].sort((p, q) => p - q); return s[Math.floor(s.length / 2)] }
    const byIdx = new Map(occupied.map((c) => [c.idx, c]))
    const allH = occupied.map((c) => c.h)
    row.contentHeight = { median: med(allH), min: Math.min(...allH), max: Math.max(...allH) }

    // Fall back to treating the whole sheet as one animation if none declared.
    const anims = a.animations
      ? Object.entries(a.animations).map(([name, r]) => ({
          name,
          cells: Array.from({ length: r.count }, (_, i) => byIdx.get(r.start + i)).filter(Boolean),
        }))
      : [{ name: '(sheet)', cells: occupied }]

    const animMedians = []
    for (const an of anims) {
      if (!an.cells.length) continue
      const m = med(an.cells.map((c) => c.h))
      const exempt = POSTURE_EXEMPT.test(an.name)
      animMedians.push({ name: an.name, median: m, exempt })
      // A ko/death animation is a posture TRANSITION — it starts upright and
      // ends prone, so its own frames are not height-comparable to each other
      // either. Height carries no scale signal here at all; report the numbers
      // for eyeballing rather than inventing a failure.
      if (exempt) {
        row.notes.push(`${an.name}: heights ${an.cells.map((c) => c.h).join(' → ')}px (posture transition, scale not checkable by height)`)
        continue
      }
      // --- within-animation drift ---
      for (const c of an.cells) {
        const dev = (c.h - m) / m
        if (Math.abs(dev) <= WITHIN_WARN) continue
        const lvl = Math.abs(dev) > WITHIN_FAIL ? 'FAIL' : 'WARN'
        if (lvl === 'FAIL') hardFails++
        row.problems.push({
          level: lvl,
          msg: `cell ${c.idx} (${an.name}) is ${(dev * 100).toFixed(0)}% off that animation's own median ${m}px` +
               (lvl === 'FAIL' ? ' — scale drift within one animation cannot be auto-repaired' : ''),
        })
      }
    }

    // --- across comparable (upright) animations ---
    const upright = animMedians.filter((x) => !x.exempt)
    if (upright.length > 1) {
      const base = med(upright.map((x) => x.median))
      row.animMedians = Object.fromEntries(animMedians.map((x) => [x.name, x.median + (x.exempt ? ' (posture-exempt)' : '')]))
      for (const u of upright) {
        const dev = (u.median - base) / base
        if (Math.abs(dev) <= ACROSS_WARN) continue
        const lvl = Math.abs(dev) > ACROSS_FAIL ? 'FAIL' : 'WARN'
        if (lvl === 'FAIL') hardFails++
        row.problems.push({
          level: lvl,
          msg: `animation "${u.name}" sits ${(dev * 100).toFixed(0)}% off the upright baseline ${base}px` +
               (lvl === 'WARN' ? ' — check it is a raised weapon, not a scale change' : ''),
        })
      }
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
