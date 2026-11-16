import type { Confidence, EdgeKind, FileFacts, Graph, GraphEdge, GraphNode, UseFact } from '../types.ts'
import { componentName, pascal } from './facts.ts'
import { externalPackage, resolveImport, type Layout } from './layout.ts'

const edgeKinds: Record<UseFact['kind'], EdgeKind> = { call: 'calls', ref: 'references', render: 'renders', extends: 'extends', implements: 'implements' }
/** 自动导入约定扫描的目录名。 */
const autoImportDirs = new Set(['composables', 'utils', 'stores', 'store', 'hooks'])

export const symbolId = (file: string, name: string) => file + '#' + name
/** 组件名的宽松形式：忽略大小写、连字符与下划线。 */
const loose = (name: string) => name.replace(/[-_]/g, '').toLowerCase()

/**
 * 用全部文件的事实解析出跨文件关系，生成图谱。纯计算，不读磁盘；增量更新时只需重抽改动的文件再整体解析一次。
 * @param input 项目根目录、提交、文件事实、布局与被跳过的文件数。
 */
export function buildGraph(input: { root: string; commit: string; facts: FileFacts[]; layout: Layout; skipped: number }): Graph {
  const { facts, layout } = input
  const nodes: GraphNode[] = []
  const nodeIds = new Set<string>()
  /** 每个文件的导出表：导出名 → 节点 ID */
  const exportsOf = new Map<string, Map<string, string>>()
  const factsOf = new Map(facts.map(file => [file.path, file]))

  for (const file of facts) {
    const isComponent = file.language === 'vue'
    nodes.push({ id: file.path, kind: isComponent ? 'component' : 'file', name: isComponent ? componentName(file.path) : file.path.slice(file.path.lastIndexOf('/') + 1), file: file.path, line: 1, endLine: file.lines, exported: true, ...(file.component ? { component: file.component } : {}) })
    nodeIds.add(file.path)
    const exported = new Map<string, string>()
    for (const symbol of file.symbols) {
      const id = symbolId(file.path, symbol.name)
      // 重载或重复声明只保留第一条。
      if (nodeIds.has(id)) continue
      nodeIds.add(id)
      nodes.push({ id, kind: symbol.kind, name: symbol.name, file: file.path, line: symbol.line, endLine: symbol.endLine, exported: symbol.exported, ...(symbol.signature ? { signature: symbol.signature } : {}), ...(symbol.doc ? { doc: symbol.doc } : {}), parent: symbol.parent ? symbolId(file.path, symbol.parent) : file.path })
      if (symbol.exported && !symbol.parent) { exported.set(symbol.name, id); if (symbol.isDefault) exported.set('default', id) }
    }
    for (const [name, local] of Object.entries(file.aliases)) if (nodeIds.has(symbolId(file.path, local))) exported.set(name, symbolId(file.path, local))
    // Vue 组件的默认导出就是组件本身。
    if (isComponent && !exported.has('default')) exported.set('default', file.path)
    exportsOf.set(file.path, exported)
  }

  /** 在文件的导出表里找名字，找不到时沿转导出继续找。 */
  const lookupExport = (file: string, name: string, seen = new Set<string>()): string | undefined => {
    if (seen.has(file) || seen.size > 12) return undefined
    seen.add(file)
    const direct = exportsOf.get(file)?.get(name)
    if (direct) return direct
    for (const reexport of factsOf.get(file)?.reexports ?? []) {
      const target = resolveImport(layout, file, reexport.source)
      if (!target) continue
      if (reexport.names) {
        const entry = reexport.names.find(item => item.exported === name)
        if (entry) { const hit = lookupExport(target, entry.imported, seen); if (hit) return hit }
      } else if (name !== 'default') { const hit = lookupExport(target, name, seen); if (hit) return hit }
    }
    return undefined
  }

  // 自动导入索引：约定目录下全项目唯一的导出名；组件按文件名与 Nuxt 的目录前缀名登记。
  const autoSymbols = new Map<string, string | null>()
  const components = new Map<string, string | null>()
  const register = (index: Map<string, string | null>, name: string, id: string) => index.set(name, index.has(name) && index.get(name) !== id ? null : id)
  for (const file of facts) {
    const segments = file.path.split('/')
    if (file.language === 'vue') {
      register(components, componentName(file.path), file.path)
      const anchor = segments.lastIndexOf('components')
      if (anchor >= 0) {
        // Nuxt 命名：目录名逐级作前缀，文件名已带上级目录名时不重复。
        const parts = segments.slice(anchor + 1).map(part => pascal(part.replace(/\.vue$/, ''))).filter(part => part !== 'Index')
        const name = parts.reduce((prefix, part) => part.startsWith(prefix) ? part : prefix + part, '')
        if (name) register(components, name, file.path)
      }
    } else if (layout.autoImport && segments.some(segment => autoImportDirs.has(segment))) {
      for (const symbol of file.symbols) if (symbol.exported && !symbol.parent && symbol.kind !== 'interface' && symbol.kind !== 'type') register(autoSymbols, symbol.name, symbolId(file.path, symbol.name))
    }
  }

  const edges = new Map<string, GraphEdge>()
  const addEdge = (from: string, to: string, kind: EdgeKind, confidence: Confidence, line?: number) => {
    if (from === to || !nodeIds.has(from) || !nodeIds.has(to)) return
    const key = from + '\0' + to + '\0' + kind
    const existing = edges.get(key)
    // 同一条边既有确定来源又有推断来源时，记为确定。
    if (!existing) edges.set(key, { from, to, kind, confidence, ...(line ? { line } : {}) })
    else if (existing.confidence === 'inferred' && confidence === 'resolved') existing.confidence = 'resolved'
  }
  const externals: Record<string, number> = {}

  for (const file of facts) {
    const locals = new Set(file.symbols.map(symbol => symbol.name))
    /** 只能经 this 调用的方法：同名的裸标识符应该按导入或自动导入解析。 */
    const viaThis = new Set(file.symbols.filter(symbol => symbol.viaThis).map(symbol => symbol.name))
    const imported = new Map<string, { source: string; imported: string }>()
    /** 导入名去掉大小写与分隔符后的索引，只用于匹配模板里的组件标签。 */
    const importedLoose = new Map<string, { source: string; imported: string }>()
    const seenExternal = new Set<string>()
    for (const item of [...file.imports, ...file.reexports.map(reexport => ({ source: reexport.source, line: 0, names: [] as { imported: string; local: string }[] }))]) {
      const target = resolveImport(layout, file.path, item.source)
      if (target) addEdge(file.path, target, 'imports', 'resolved', item.line || undefined)
      else { const name = externalPackage(item.source); if (name && !seenExternal.has(name)) { seenExternal.add(name); externals[name] = (externals[name] ?? 0) + 1 } }
      for (const name of item.names) { imported.set(name.local, { source: item.source, imported: name.imported }); importedLoose.set(loose(name.local), { source: item.source, imported: name.imported }) }
    }
    for (const use of file.uses) {
      const from = use.from && locals.has(use.from) ? symbolId(file.path, use.from) : file.path
      const kind = edgeKinds[use.kind]
      // this.成员：extract 已把成员写成「类名.成员名」。
      if (use.name === 'this') {
        if (use.member && locals.has(use.member)) addEdge(from, symbolId(file.path, use.member), kind, 'resolved', use.line)
        else if (use.member) {
          // 本组件没有这个方法：按 mixins 声明的顺序到混入里找，混入的方法同样只能经 this 调用。
          for (const mixin of file.mixins ?? []) {
            const binding = imported.get(mixin)
            const target = binding && resolveImport(layout, file.path, binding.source)
            if (target && nodeIds.has(symbolId(target, use.member))) { addEdge(from, symbolId(target, use.member), kind, 'resolved', use.line); break }
          }
        }
        continue
      }
      if (locals.has(use.name) && !viaThis.has(use.name)) {
        const member = use.member && locals.has(use.name + '.' + use.member) ? use.name + '.' + use.member : use.name
        addEdge(from, symbolId(file.path, member), kind, 'resolved', use.line)
        continue
      }
      // 模板标签与注册名不区分大小写和连字符：<tab-nav> 对应 import tabNav。
      const binding = imported.get(use.name) ?? (use.kind === 'render' ? importedLoose.get(loose(use.name)) : undefined)
      if (binding) {
        const target = resolveImport(layout, file.path, binding.source)
        if (!target) continue
        if (binding.imported === '*') {
          // 命名空间导入或 require 的成员：先找具名导出，再找默认导出对象上的同名成员。
          const hit = use.member ? lookupExport(target, use.member) ?? (nodeIds.has(symbolId(target, 'default.' + use.member)) ? symbolId(target, 'default.' + use.member) : undefined) : undefined
          addEdge(from, hit ?? target, kind, hit || !use.member ? 'resolved' : 'inferred', use.line)
        } else {
          const hit = lookupExport(target, binding.imported)
          const member = hit && use.member && nodeIds.has(hit + '.' + use.member) ? hit + '.' + use.member : hit
          // 导入的文件找到了但导出名没对上（动态导出等）：连到文件，标为推断。
          addEdge(from, member ?? target, kind, member ? 'resolved' : 'inferred', use.line)
        }
        continue
      }
      // 既不是本地符号也没有导入：按自动导入约定找全项目唯一的同名导出。
      const auto = use.kind === 'render' ? components.get(use.name) : use.kind === 'call' && !use.member ? autoSymbols.get(use.name) : undefined
      if (auto) addEdge(from, auto, kind, 'inferred', use.line)
    }
  }

  const list = [...edges.values()]
  const languages: Record<string, number> = {}
  for (const file of facts) languages[file.language] = (languages[file.language] ?? 0) + 1
  return {
    schemaVersion: 1, engine: 'builtin', root: input.root, commit: input.commit, builtAt: new Date().toISOString(), nodes, edges: list, externals,
    stats: { files: facts.length, symbols: nodes.length - facts.length, edges: list.length, inferredEdges: list.filter(edge => edge.confidence === 'inferred').length, languages, errors: facts.filter(file => file.error).length, skipped: input.skipped },
  }
}
