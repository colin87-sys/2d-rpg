// Headless probe: boots the page and evaluates an expression against window.__POC.
// Usage: node tools/probe.mjs "<js expression>" [--port 4180] [--wait 60000]
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const launchOpts = existsSync(CHROME) ? { executablePath: CHROME } : {}
const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1] }
const expr = args.find((a) => !a.startsWith('--')) || '1'
const PORT = Number(flag('port', 4180))
const waitMs = Number(flag('wait', 90000))

const server = spawn(process.execPath, [resolve('tools/_serve.mjs'), resolve('.'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] })
const kill = () => { try { server.kill('SIGKILL') } catch {} }
process.on('exit', kill)

const waitForServer = async () => {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/index.html`)).ok) return } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('static server never came up')
}

const run = async () => {
  await waitForServer()
  const browser = await chromium.launch({ ...launchOpts, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage({ viewport: { width: 800, height: 450 }, deviceScaleFactor: 1 })
  const logs = []
  page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`))
  page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message}\n${(e.stack || '').split('\n').slice(0, 8).join('\n')}`))
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load', timeout: 60000 })
  try { await page.waitForFunction(() => window.__POC && window.__POC.ready, { timeout: waitMs }) }
  catch { logs.push('warn: ready never true') }
  let out
  try { out = await page.evaluate(`(() => { try { return JSON.stringify(${expr}, null, 1) } catch (e) { return 'EVAL ERR ' + e.message } })()`) }
  catch (e) { out = 'EVAL THROW ' + e.message }
  console.log(out)
  console.log(`\n=== console (${logs.length}) ===`)
  console.log(logs.slice(0, 40).join('\n') || '(clean)')
  await browser.close()
}
run().then(kill).catch((e) => { console.error(e); kill(); process.exit(1) })
