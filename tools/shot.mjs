// Headless screenshot harness — no bundler in the loop.
// The page is plain ESM + an import map, served by a tiny static server.
//
// Usage: node tools/shot.mjs [outfile] [--wait 12000] [--w 1920] [--h 1080] [--port 4173]
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const launchOpts = existsSync(CHROME) ? { executablePath: CHROME } : {}

const args = process.argv.slice(2)
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? def : args[i + 1]
}
const out = resolve(args.find((a) => !a.startsWith('--')) || 'shots/poc.png')
const waitMs = Number(flag('wait', 12000))
const W = Number(flag('w', 1920))
const H = Number(flag('h', 1080))
const PORT = Number(flag('port', 4173))

mkdirSync(dirname(out), { recursive: true })

const server = spawn(process.execPath, [resolve('tools/_serve.mjs'), resolve('.'), String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stderr.on('data', (d) => process.stderr.write(`[serve] ${d}`))
const kill = () => { try { server.kill('SIGKILL') } catch {} }
process.on('exit', kill)

const waitForServer = async () => {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/index.html`)).ok) return } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('static server never came up')
}

const run = async () => {
  await waitForServer()
  const browser = await chromium.launch({
    ...launchOpts,
    args: [
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--no-sandbox', '--disable-dev-shm-usage',
    ],
  })
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  const logs = []
  page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`))
  page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message}\n${(e.stack || '').split('\n').slice(0, 6).join('\n')}`))

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load', timeout: 60000 })
  // Wait for the app to signal it has drawn real content, then let animation settle.
  try {
    await page.waitForFunction(() => window.__POC && window.__POC.ready, { timeout: waitMs })
  } catch {
    logs.push(`warn: window.__POC.ready never became true within ${waitMs}ms`)
  }
  await page.waitForTimeout(Number(flag('settle', 3000)))
  await page.screenshot({ path: out })
  await browser.close()

  console.log(`\n=== console (${logs.length}) ===`)
  console.log(logs.slice(0, 60).join('\n') || '(clean)')
  console.log(`\nwrote ${out}`)
  if (logs.some((l) => l.startsWith('PAGEERROR'))) process.exitCode = 2
}

run().then(kill).catch((e) => { console.error(e); kill(); process.exit(1) })
