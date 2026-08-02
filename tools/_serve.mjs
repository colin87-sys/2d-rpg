import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
const ROOT = process.argv[2] || '.'
const PORT = Number(process.argv[3] || 4173)
const MIME = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.map':'application/json' }
createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0])
    if (p.endsWith('/')) p += 'index.html'
    const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''))
    const buf = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' })
    res.end(buf)
  } catch { res.writeHead(404); res.end('404') }
}).listen(PORT, '127.0.0.1', () => console.log('serving', ROOT, 'on', PORT))
