// Headless screenshot harness.
// Usage: node tools/shot.mjs [outfile] [--wait ms] [--w 1920] [--h 1080]
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const args = process.argv.slice(2)
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? def : args[i + 1]
}
const out = resolve(args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) || 'shots/poc.png')
const waitMs = Number(flag('wait', 9000))
const W = Number(flag('w', 1920))
const H = Number(flag('h', 1080))
const PORT = Number(flag('port', 4173))

mkdirSync(dirname(out), { recursive: true })

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
})
server.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`))
server.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`))

const kill = () => { try { server.kill('SIGKILL') } catch {} }
process.on('exit', kill)

const waitForServer = async () => {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/`)
      if (r.ok) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('preview server never came up')
}

const run = async () => {
  await waitForServer()
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  const logs = []
  page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`))
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}\n${e.stack || ''}`))
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 })
  await page.waitForTimeout(waitMs)
  await page.screenshot({ path: out })
  await browser.close()
  console.log(`\n=== console (${logs.length}) ===`)
  console.log(logs.slice(0, 80).join('\n') || '(clean)')
  console.log(`\nwrote ${out}`)
}

run().then(() => { kill(); process.exit(0) }).catch((e) => { console.error(e); kill(); process.exit(1) })
