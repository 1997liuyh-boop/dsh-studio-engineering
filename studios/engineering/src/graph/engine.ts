import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { headCommit } from '../git.ts'
import type { FileFacts, Freshness, Graph, GraphStats } from '../types.ts'
import { extractFile } from './facts.ts'
import { loadLayout } from './layout.ts'
import { indexGraph, type GraphIndex } from './query.ts'
import { buildGraph } from './resolve.ts'
import { detectRoutes } from './routes.ts'
import { scanProject } from './scan.ts'

/** 抽取逻辑变化时加一，旧的事实缓存整体作废。 */
export const ENGINE_VERSION = 4
/** 单个源码文件的体积上限；更大的多为打包产物或生成代码。 */
const MAX_FILE_BYTES = 512_000
/** 距上次核对不足这个时间时直接用内存里的图，避免连续调用工具时反复扫盘。 */
const RECHECK_MS = 2_000

/** 压缩或打包产物的特征：存在超长行，或平均行长远超手写代码。 */
function looksMinified(path: string, source: string): boolean {
  if (!/\.(js|mjs|cjs)$/.test(path) || source.length < 2000) return false
  const lines = source.split('\n')
  return source.length / lines.length > 240 || lines.some(line => line.length > 4000)
}

/** 已建图项目的摘要，供工作室页面列出。 */
export interface GraphMeta {
  root: string
  commit: string
  builtAt: string
  stats: GraphStats
}

/** 文件的体积与修改时间；两者都没变就认为内容没变。 */
interface Stamp { size: number; mtime: number }

/** 内存里只留索引与文件戳；抽取结果体积大，有变化时再从磁盘读回。 */
interface Loaded {
  index: GraphIndex
  stamps: Map<string, Stamp>
  /** 配置文件的体积与时间；变了要重算别名与路由 */
  configKey: string
  checkedAt: number
}

/**
 * 图谱引擎：按项目根目录建图、增量更新并缓存。图谱存放在工作室数据目录，不向用户项目写入任何文件。
 */
export class GraphEngine {
  readonly dir: string
  private loaded = new Map<string, Loaded>()
  /** 同一项目的建图串行执行，避免并发写同一份缓存。 */
  private running = new Map<string, Promise<unknown>>()

  /** @param dir 图谱存放目录，缺省为 DSH_HOME/studio/engineering/graphs。 */
  constructor(dir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'studio/engineering/graphs')) {
    this.dir = dir
  }

  private async folder(root: string): Promise<{ key: string; root: string; path: string }> {
    if (!isAbsolute(root)) throw new Error('项目目录必须是绝对路径')
    const real = await realpath(root)
    // Windows 路径大小写不敏感，统一小写后再算目录名。
    const key = createHash('sha1').update(process.platform === 'win32' ? real.toLowerCase() : real).digest('hex').slice(0, 16)
    return { key, root: real, path: join(this.dir, key) }
  }

  private async readCache(path: string): Promise<Map<string, FileFacts>> {
    try {
      const cache = JSON.parse(await readFile(join(path, 'facts.json'), 'utf8')) as { engineVersion?: number; files?: FileFacts[] }
      if (cache.engineVersion !== ENGINE_VERSION || !Array.isArray(cache.files)) return new Map()
      return new Map(cache.files.map(file => [file.path, file]))
    } catch { return new Map() }
  }

  private async write(path: string, name: string, value: object): Promise<void> {
    await mkdir(path, { recursive: true })
    const temp = join(path, randomUUID() + '.tmp')
    try { await writeFile(temp, JSON.stringify(value)); await rename(temp, join(path, name)) }
    catch (error) { await rm(temp, { force: true }); throw error }
  }

  /**
   * 取项目的最新图谱：首次调用建图，之后比对文件体积、修改时间与内容哈希，只重新解析有变化的文件。
   * @param root 项目根目录（绝对路径）。
   * @param options force 为 true 时丢弃缓存全量重建。
   */
  ensure(root: string, options: { signal?: AbortSignal; force?: boolean } = {}): Promise<{ index: GraphIndex; freshness: Freshness }> {
    const run = async () => {
      const started = Date.now()
      const folder = await this.folder(root)
      const state = this.loaded.get(folder.key)
      const fresh = (elapsedMs: number) => ({ index: state!.index, freshness: { state: 'fresh' as const, changed: 0, removed: 0, elapsedMs } })
      if (state && !options.force && started - state.checkedAt < RECHECK_MS) return fresh(0)
      const scan = await scanProject(folder.root, options.signal)
      // 先只看体积与修改时间：绝大多数调用到这里就能确认没有变化，不必读回抽取结果。
      const stamps = new Map<string, Stamp>()
      let skipped = scan.dropped + scan.generated
      for (const [position, path] of scan.sources.entries()) {
        // 定期让出事件循环：建图在宿主进程内运行，不能长时间卡住界面与其他会话。
        if (position % 200 === 199) { await new Promise<void>(resolve => setImmediate(resolve)); options.signal?.throwIfAborted() }
        let info: { size: number; mtimeMs: number }
        try { info = await stat(join(folder.root, path)) } catch { continue }
        if (info.size > MAX_FILE_BYTES) { skipped += 1; continue }
        stamps.set(path, { size: info.size, mtime: info.mtimeMs })
      }
      // package.json、tsconfig、pages.json 等配置不进事实缓存，但它们决定别名与路由：单独记一份文件戳。
      const configStamps: string[] = []
      for (const path of [...scan.configs].sort()) { try { const info = await stat(join(folder.root, path)); configStamps.push(path + ':' + info.size + ':' + info.mtimeMs) } catch { /* 刚被删除的配置忽略 */ } }
      const configKey = createHash('sha1').update(configStamps.join('\n')).digest('hex').slice(0, 16)
      const same = (known: Map<string, Stamp>) => known.size === stamps.size && [...stamps].every(([path, stamp]) => { const other = known.get(path); return !!other && other.size === stamp.size && other.mtime === stamp.mtime })
      if (state && !options.force && same(state.stamps) && state.configKey === configKey) { state.checkedAt = Date.now(); return fresh(Date.now() - started) }

      const previous = options.force ? new Map<string, FileFacts>() : await this.readCache(folder.path)
      const facts = new Map<string, FileFacts>()
      let changed = 0, parsed = 0
      for (const [path, stamp] of stamps) {
        const cached = previous.get(path)
        if (cached && cached.size === stamp.size && cached.mtime === stamp.mtime) { facts.set(path, cached); continue }
        if (parsed++ % 25 === 24) { await new Promise<void>(resolve => setImmediate(resolve)); options.signal?.throwIfAborted() }
        let source: string
        try { source = await readFile(join(folder.root, path), 'utf8') } catch { continue }
        // 压缩或打包过的脚本没有可读的符号，只留一条占位记录（下次按体积与时间命中缓存，不再读文件）。
        const next: FileFacts = looksMinified(path, source)
          ? { path, hash: '', size: stamp.size, mtime: stamp.mtime, language: 'js', lines: 0, symbols: [], imports: [], reexports: [], aliases: {}, uses: [], generated: true }
          : await extractFile(path, source, stamp)
        // 只是时间戳变了、内容没变：沿用旧事实，不算改动。
        if (cached && cached.hash && cached.hash === next.hash) { facts.set(path, { ...cached, ...stamp }); continue }
        facts.set(path, next)
        changed += 1
      }
      const removed = [...previous.keys()].filter(path => !facts.has(path)).length
      const commit = await headCommit(folder.root, options.signal)
      const touched = changed > 0 || removed > 0 || !same(new Map([...previous].map(([path, file]) => [path, { size: file.size, mtime: file.mtime }])))
      let graph: Graph | undefined
      if (changed === 0 && removed === 0 && previous.size > 0) {
        // 内容没变（进程重启后首次访问，或只是时间戳变了）：沿用内存或磁盘上的图。
        if (state && state.configKey === configKey) graph = state.index.graph
        else if (!state) try { const saved = JSON.parse(await readFile(join(folder.path, 'graph.json'), 'utf8')) as Graph; if (saved.schemaVersion === 1 && saved.engineVersion === ENGINE_VERSION && saved.configKey === configKey) graph = saved } catch { /* 图文件缺失时重新解析 */ }
      }
      const reused = !!graph
      if (!graph) {
        const readable = [...facts.values()].filter(file => !file.generated)
        const layout = await loadLayout(folder.root, readable.map(file => file.path), scan.configs)
        graph = buildGraph({ root: folder.root, commit, facts: readable, layout, skipped: skipped + facts.size - readable.length })
        graph.routes = await detectRoutes(folder.root, layout, scan.configs)
        graph.engineVersion = ENGINE_VERSION
        graph.configKey = configKey
        await this.write(folder.path, 'graph.json', graph)
        await this.write(folder.path, 'meta.json', { root: folder.root, commit, builtAt: graph.builtAt, stats: graph.stats } satisfies GraphMeta)
      }
      // 时间戳有变化也要落盘，否则下次还会把这些文件重读一遍。
      if (touched) await this.write(folder.path, 'facts.json', { engineVersion: ENGINE_VERSION, files: [...facts.values()] })
      const next: Loaded = { index: reused && state ? state.index : indexGraph(graph), stamps, configKey, checkedAt: Date.now() }
      this.loaded.set(folder.key, next)
      return { index: next.index, freshness: { state: reused ? 'fresh' as const : previous.size === 0 ? 'built' as const : 'updated' as const, changed, removed, elapsedMs: Date.now() - started } }
    }
    // 以调用方传入的路径排队；同一项目的不同写法最多导致一次多余的串行等待。
    const queued = (this.running.get(root) ?? Promise.resolve()).then(run, run)
    this.running.set(root, queued.catch(() => {}))
    return queued
  }

  /** 列出已建过图的项目，按建图时间倒序。 */
  async list(): Promise<GraphMeta[]> {
    let names: string[]
    try { names = await readdir(this.dir) } catch { return [] }
    const metas: GraphMeta[] = []
    for (const name of names) {
      try { metas.push(JSON.parse(await readFile(join(this.dir, name, 'meta.json'), 'utf8')) as GraphMeta) } catch { /* 目录不完整时跳过 */ }
    }
    return metas.sort((a, b) => b.builtAt.localeCompare(a.builtAt))
  }

  /** 删除某个项目的图谱缓存。 */
  async remove(root: string): Promise<void> {
    const folder = await this.folder(root)
    this.loaded.delete(folder.key)
    await rm(folder.path, { recursive: true, force: true })
  }
}
