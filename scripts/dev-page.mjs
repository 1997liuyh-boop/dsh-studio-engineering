/** 本地预览工作室页面：用最小的模拟宿主加载已构建的插件，托管静态页面与页面接口。先运行 npm run build。 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
// 预览默认使用仓库内的临时数据目录，不读写用户真实的 DSH 数据。
process.env.DSH_HOME ??= join(root, '.scratch/home')
const port = Number(process.env.PORT ?? 4179)
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }

let page
const plugin = await import(pathToFileURL(join(root, 'lib/index.js')).href)
await plugin.apply({
  get: () => undefined, plugin: () => undefined, effect: callback => { callback() },
  tools: { register: () => () => {} }, systemPrompt: { section: () => () => {} },
  studioProjects: { register(value) { page = value; return () => {} } },
})

createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname
  const prefix = '/studio-projects/' + page.id
  if (!path.startsWith(prefix)) { res.writeHead(302, { location: prefix + '/' }); res.end(); return }
  const rest = path.slice(prefix.length).replace(/^\//, '')
  if (await page.handle(req, res, rest)) return
  const file = normalize(join(page.root, rest || 'index.html'))
  if (!file.startsWith(normalize(page.root))) { res.writeHead(403); res.end(); return }
  try { const body = await readFile(file); res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }); res.end(body) }
  catch { res.writeHead(404); res.end('not found') }
}).listen(port, '127.0.0.1', () => console.log('研发工作室页面预览：http://localhost:' + port + '/studio-projects/' + page.id + '/'))
