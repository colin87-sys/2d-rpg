// Camera sweep: boots the page once, then screenshots a series of rig configs.
// Usage: node tools/sweep.mjs "fov,dist,pitch;fov,dist,pitch;..." [--w 1280] [--h 720] [--tag a]
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const launchOpts = existsSync(CHROME) ? { executablePath: CHROME } : {}
const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1] }
const specs = (args.find((a) => !a.startsWith('--')) || '26,53,28').split(';').map((s) => s.split(',').map(Number))
const W = Number(flag('w', 1280))
const H = Number(flag('h', 720))
const TAG = flag('tag', 'sw')
const PORT = Number(flag('port', 4182))
mkdirSync('shots/sweep', { recursive: true })

const server = spawn(process.execPath, [resolve('tools/_serve.mjs'), resolve('.'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] })
const kill = () => { try { server.kill('SIGKILL') } catch {} }
process.on('exit', kill)
const waitForServer = async () => {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/index.html`)).ok) return } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('no server')
}

const run = async () => {
  await waitForServer()
  const browser = await chromium.launch({ ...launchOpts, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  const logs = []
  page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`))
  page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message}`))
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load', timeout: 60000 })
  await page.waitForFunction(() => window.__POC && window.__POC.ready, { timeout: 120000 })
  for (const [fov, dist, pitch] of specs) {
    await page.evaluate(([f, d, p]) => {
      const q = window.__POC.rig.params
      q.fovDeg = f; q.distMin = d; q.distMax = d; q.distance = d
      q.pitchDeg = p; q.pitchMinDeg = Math.min(p, q.pitchMinDeg); q.pitchMaxDeg = Math.max(p, q.pitchMaxDeg)
    }, [fov, dist, pitch])
    await page.waitForTimeout(5000)
    const name = `shots/sweep/${TAG}_f${fov}_d${dist}_p${pitch}.png`
    await page.screenshot({ path: name, timeout: 180000 })
    console.log('wrote', name)
  }
  await browser.close()
  console.log(`=== console (${logs.length}) ===\n${logs.slice(0, 30).join('\n') || '(clean)'}`)
}
run().then(kill).catch((e) => { console.error(e); kill(); process.exit(1) })
