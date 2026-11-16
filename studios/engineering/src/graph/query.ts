import type { FileChange } from '../git.ts'
import type { Confidence, EdgeKind, Graph, GraphEdge, GraphNode } from '../types.ts'
import { isTest, moduleOf } from './paths.ts'
import { viewsOf } from './views.ts'

/** 图谱的内存索引：按节点 ID、名字、文件与出入边组织，查询不再遍历全图。 */
export interface GraphIndex {
  graph: Graph
  nodes: Map<string, GraphNode>
  out: Map<string, GraphEdge[]>
  in: Map<string, GraphEdge[]>
  /** 小写的短名（类成员取成员名）→ 节点 */
  byName: Map<string, GraphNode[]>
  /** 文件 → 其中的符号，按行号排序 */
  byFile: Map<string, GraphNode[]>
  /** 父节点 → 子节点（类 → 成员） */
  children: Map<string, GraphNode[]>
}

const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => { const list = map.get(key); if (list) list.push(value); else map.set(key, [value]) }
const shortName = (node: GraphNode) => node.name.slice(node.name.lastIndexOf('.') + 1)

/**
 * 为图谱建立内存索引。
 * @param graph 已解析的图谱。
 */
export function indexGraph(graph: Graph): GraphIndex {
  const index: GraphIndex = { graph, nodes: new Map(), out: new Map(), in: new Map(), byName: new Map(), byFile: new Map(), children: new Map() }
  for (const node of graph.nodes) {
    index.nodes.set(node.id, node)
    push(index.byName, shortName(node).toLowerCase(), node)
    if (node.kind !== 'file' && node.kind !== 'component') push(index.byFile, node.file, node)
    if (node.parent && node.parent !== node.file) push(index.children, node.parent, node)
  }
  for (const edge of graph.edges) { push(index.out, edge.from, edge); push(index.in, edge.to, edge) }
  for (const list of index.byFile.values()) list.sort((a, b) => a.line - b.line)
  return index
}

/** 给模型看的节点摘要：定位、签名与用途，不带内部字段。 */
export interface NodeBrief {
  id: string
  kind: string
  name: string
  location: string
  exported: boolean
  signature?: string
  doc?: string
  /** 被多少处使用（入边数，不含文件导入） */
  usedBy: number
}

const usedBy = (index: GraphIndex, id: string) => (index.in.get(id) ?? []).filter(edge => edge.kind !== 'imports').length

/** 把节点整理成摘要。 */
export function brief(index: GraphIndex, node: GraphNode): NodeBrief {
  return { id: node.id, kind: node.kind, name: node.name, location: node.file + ':' + node.line, exported: node.exported, ...(node.signature ? { signature: node.signature } : {}), ...(node.doc ? { doc: node.doc } : {}), usedBy: usedBy(index, node.id) }
}

const normalize = (reference: string) => reference.trim().replaceAll('\\', '/').replace(/^\.\//, '')
/** 把标识符拆成小写词：camelCase、PascalCase、kebab-case、snake_case 与路径分隔符。 */
const words = (text: string) => text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9一-鿿]+/).filter(Boolean)

/**
 * 按名字、路径或用途搜索符号与文件。
 * @param index 图谱索引。
 * @param query 关键词；可以是符号名、路径片段或几个词。
 * @param limit 最多返回多少条。
 */
export function search(index: GraphIndex, query: string, limit = 20): { total: number; results: NodeBrief[] } {
  const needle = normalize(query).toLowerCase(), tokens = words(query)
  if (!needle) return { total: 0, results: [] }
  const scored: { node: GraphNode; score: number }[] = []
  for (const node of index.graph.nodes) {
    const name = node.name.toLowerCase(), short = shortName(node).toLowerCase(), file = node.file.toLowerCase()
    let score = 0
    if (short === needle || name === needle || node.id.toLowerCase() === needle) score = 100
    else if (short.startsWith(needle)) score = 70
    else if (name.includes(needle)) score = 50
    else if (file.includes(needle)) score = node.kind === 'file' || node.kind === 'component' ? 40 : 15
    else if (tokens.length) {
      // 多个词：名字与路径里命中的词越多越靠前，注释与签名命中只作补充。
      const own = new Set([...words(node.name), ...words(node.file)]), extra = (node.doc ?? '').toLowerCase() + ' ' + (node.signature ?? '').toLowerCase()
      const hits = tokens.filter(token => own.has(token) || [...own].some(word => word.startsWith(token))).length
      const loose = tokens.filter(token => extra.includes(token)).length
      if (hits === tokens.length) score = 35
      else if (hits + loose === tokens.length) score = 20
      else if (hits >= 2 && hits >= tokens.length - 1) score = 8 * hits
    }
    if (score === 0) continue
    scored.push({ node, score: score + (node.exported ? 3 : 0) + Math.min(10, usedBy(index, node.id)) - (isTest(node.file) ? 5 : 0) })
  }
  scored.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id))
  return { total: scored.length, results: scored.slice(0, limit).map(item => brief(index, item.node)) }
}

/** 引用解析结果：唯一命中、多个候选或未找到（附相近名字）。 */
export type Resolution = { node: GraphNode } | { candidates: NodeBrief[] } | { missing: string; suggestions: string[] }

/**
 * 把「路径#符号」「路径」或单独的符号名解析成节点；符号名不唯一时返回候选，不替调用方猜。
 * @param index 图谱索引。
 * @param reference 引用文本。
 */
export function resolveReference(index: GraphIndex, reference: string): Resolution {
  const text = normalize(reference)
  const exact = index.nodes.get(text)
  if (exact) return { node: exact }
  const hash = text.indexOf('#')
  if (hash > 0) {
    const file = text.slice(0, hash), name = text.slice(hash + 1)
    const inFile = (index.byFile.get(file) ?? []).filter(node => node.name === name || shortName(node) === name)
    if (inFile.length === 1) return { node: inFile[0] }
    if (inFile.length > 1) return { candidates: inFile.map(node => brief(index, node)) }
    const names = (index.byFile.get(file) ?? []).map(node => node.id)
    return { missing: text, suggestions: names.length ? names.slice(0, 12) : search(index, name, 6).results.map(item => item.id) }
  }
  // 路径后缀：允许只写文件名或末尾几级目录。
  if (text.includes('/') || /\.[a-z]+$/i.test(text)) {
    const files = index.graph.nodes.filter(node => (node.kind === 'file' || node.kind === 'component') && (node.id === text || node.id.endsWith('/' + text)))
    if (files.length === 1) return { node: files[0] }
    if (files.length > 1) return { candidates: files.slice(0, 12).map(node => brief(index, node)) }
  }
  const named = index.graph.nodes.filter(node => node.name === text || (shortName(node) === text && node.kind !== 'file'))
  if (named.length === 1) return { node: named[0] }
  if (named.length > 1) return { candidates: named.slice(0, 12).map(node => brief(index, node)) }
  return { missing: text, suggestions: search(index, text.slice(text.lastIndexOf('/') + 1), 6).results.map(item => item.id) }
}

interface Relation { id: string; kind: EdgeKind; location: string; confidence: Confidence; signature?: string }

/**
 * 一个节点的完整上下文：自身、成员、谁在用它、它用了谁。
 * @param index 图谱索引。
 * @param node 目标节点。
 * @param limit 每类关系最多列多少条。
 */
export function context(index: GraphIndex, node: GraphNode, limit = 30) {
  const relation = (edge: GraphEdge, other: string): Relation => {
    const target = index.nodes.get(other)!
    return { id: other, kind: edge.kind, location: target.file + ':' + (edge.line ?? target.line), confidence: edge.confidence, ...(target.signature ? { signature: target.signature } : {}) }
  }
  const incoming = index.in.get(node.id) ?? [], outgoing = index.out.get(node.id) ?? []
  const isFile = node.kind === 'file' || node.kind === 'component'
  return {
    node: { ...brief(index, node), lines: node.line + '-' + node.endLine, ...(node.component ? { component: node.component } : {}) },
    ...(isFile ? { symbols: (index.byFile.get(node.id) ?? []).filter(item => item.parent === node.id).map(item => brief(index, item)) } : {}),
    ...(index.children.get(node.id)?.length ? { members: index.children.get(node.id)!.map(item => brief(index, item)) } : {}),
    usedBy: { total: incoming.length, items: incoming.slice(0, limit).map(edge => relation(edge, edge.from)) },
    uses: { total: outgoing.length, items: outgoing.slice(0, limit).map(edge => relation(edge, edge.to)) },
  }
}

/** 影响面里的一项：受影响的节点、经由哪条关系、路径上是否有推断出来的边。 */
export interface ImpactItem {
  id: string
  kind: string
  location: string
  /** 它依赖的上一级节点 */
  via: string
  relation: EdgeKind
  confidence: Confidence
  test?: true
}

export interface ImpactReport {
  targets: string[]
  risk: 'LOW' | 'MEDIUM' | 'HIGH'
  summary: { direct: number; indirect: number; regression: number; files: number; modules: string[]; tests: string[]; entries: string[]; inferred: number; flows: { id: string; label: string }[]; clusters: string[] }
  /** 直接依赖：改动后必须逐个核对 */
  direct: ImpactItem[]
  /** 间接依赖：很可能受影响 */
  indirect: ImpactItem[]
  /** 更远的传递依赖：建议回归 */
  regression: ImpactItem[]
  notes: string[]
}

/**
 * 计算改动若干节点的影响面：沿「谁在用它」反向遍历，按距离分三级。
 * @param index 图谱索引。
 * @param targets 被改动的节点。文件会连同其中的符号一起算；类会连同成员一起算。
 * @param options depth 为遍历深度（1–6，默认 3）；limit 为每一级最多列出的条数。
 */
export function impact(index: GraphIndex, targets: GraphNode[], options: { depth?: number; limit?: number } = {}): ImpactReport {
  const depth = Math.min(6, Math.max(1, options.depth ?? 3)), limit = options.limit ?? 40
  const seeds = new Set<string>()
  for (const target of targets) {
    seeds.add(target.id)
    if (target.kind === 'file' || target.kind === 'component') for (const symbol of index.byFile.get(target.id) ?? []) seeds.add(symbol.id)
    for (const member of index.children.get(target.id) ?? []) seeds.add(member.id)
  }
  const visited = new Map<string, { depth: number; via: string; relation: EdgeKind; confidence: Confidence }>()
  let frontier = [...seeds].map(id => ({ id, confidence: 'resolved' as Confidence }))
  for (let level = 1; level <= depth && frontier.length; level += 1) {
    const next: typeof frontier = []
    for (const current of frontier) {
      const node = index.nodes.get(current.id)
      // 普通文件节点代表「模块顶层代码用到了它」，影响到此为止；组件节点会被别的组件渲染，继续向上。
      if (level > 1 && node?.kind === 'file') continue
      for (const edge of index.in.get(current.id) ?? []) {
        // 文件导入关系只在目标本身是文件时才算直接影响，否则会把整份文件的导入方都算进来。
        if (edge.kind === 'imports' && !(level === 1 && targets.some(target => target.id === current.id))) continue
        if (seeds.has(edge.from) || visited.has(edge.from)) continue
        const confidence: Confidence = current.confidence === 'inferred' || edge.confidence === 'inferred' ? 'inferred' : 'resolved'
        visited.set(edge.from, { depth: level, via: current.id, relation: edge.kind, confidence })
        next.push({ id: edge.from, confidence })
        // 组件脚本里的符号受影响，组件本身也就受影响：算在同一级，不多占一层深度。
        const owner = index.nodes.get(index.nodes.get(edge.from)!.file)
        if (owner?.kind === 'component' && owner.id !== edge.from && !seeds.has(owner.id) && !visited.has(owner.id)) {
          visited.set(owner.id, { depth: level, via: edge.from, relation: 'references', confidence })
          next.push({ id: owner.id, confidence })
        }
      }
    }
    frontier = next
  }
  const items = [...visited.entries()].map(([id, hit]) => {
    const node = index.nodes.get(id)!
    return { depth: hit.depth, item: { id, kind: node.kind, location: node.file + ':' + node.line, via: hit.via, relation: hit.relation, confidence: hit.confidence, ...(isTest(node.file) ? { test: true as const } : {}) } satisfies ImpactItem, file: node.file }
  }).sort((a, b) => a.depth - b.depth || Number(!!a.item.test) - Number(!!b.item.test) || a.item.id.localeCompare(b.item.id))
  const level = (from: number, to: number) => items.filter(entry => entry.depth >= from && entry.depth <= to)
  const direct = level(1, 1), indirect = level(2, 2), regression = level(3, depth)
  const production = items.filter(entry => !entry.item.test)
  const modules = [...new Set(production.map(entry => moduleOf(entry.file)))].sort()
  // 经过改动目标或其直接使用方的执行流程，以及波及的功能聚类。
  const views = viewsOf(index)
  const isEntry = (file: string) => views.entries.has(file)
  const flowIds = new Set<string>()
  for (const id of [...seeds, ...direct.map(entry => entry.item.id)]) for (const flow of views.flowsOf.get(id) ?? []) flowIds.add(flow)
  const flowLabels = new Map(views.flows.map(flow => [flow.id, flow.label]))
  const clusterLabels = new Map(views.clusters.map(cluster => [cluster.id, cluster.label]))
  const clusters = [...new Set(production.map(entry => views.clusterOf.get(entry.file)).filter((id): id is string => !!id))].map(id => clusterLabels.get(id)!)
  const directCount = direct.filter(entry => !entry.item.test).length
  let risk: ImpactReport['risk'] = directCount >= 10 ? 'HIGH' : directCount >= 4 ? 'MEDIUM' : 'LOW'
  if (modules.length >= 4 && risk !== 'HIGH') risk = risk === 'LOW' ? 'MEDIUM' : 'HIGH'
  const notes: string[] = []
  if (items.length === 0) notes.push('图中没有找到使用方：目标可能是入口、只被动态调用、由项目外部使用，或使用方的语言不在图谱范围内，改动前请再用文本搜索确认。')
  if (items.some(entry => entry.item.confidence === 'inferred')) notes.push('标为 inferred 的条目来自自动导入等约定推断，不是由 import 语句确定的，请打开文件核对。')
  for (const [name, list] of [['直接依赖', direct], ['间接依赖', indirect], ['需回归的依赖', regression]] as const) if (list.length > limit) notes.push(name + '共 ' + list.length + ' 条，这里只列出前 ' + limit + ' 条。')
  if (flowIds.size > 30) notes.push('经过的执行流程共 ' + flowIds.size + ' 条，这里只列出前 30 条。')
  if (targets.some(target => target.exported && isEntry(target.file))) notes.push('目标位于页面、路由或入口文件，可能由框架按约定加载，图里看不到这类使用方。')
  return {
    targets: targets.map(target => target.id), risk,
    summary: { direct: direct.length, indirect: indirect.length, regression: regression.length, files: new Set(items.map(entry => entry.file)).size, modules, tests: [...new Set(items.filter(entry => entry.item.test).map(entry => entry.file))].slice(0, 30), entries: [...new Set(production.filter(entry => isEntry(entry.file)).map(entry => entry.file))].slice(0, 30), inferred: items.filter(entry => entry.item.confidence === 'inferred').length,
      flows: [...flowIds].slice(0, 30).map(id => ({ id, label: flowLabels.get(id)! })), clusters },
    direct: direct.slice(0, limit).map(entry => entry.item), indirect: indirect.slice(0, limit).map(entry => entry.item), regression: regression.slice(0, limit).map(entry => entry.item), notes,
  }
}

/**
 * 项目概览：规模、模块划分与依赖、被使用最多的符号、入口与外部依赖。
 * @param index 图谱索引。
 */
export function overview(index: GraphIndex) {
  const modules = new Map<string, { files: number; symbols: number }>()
  for (const node of index.graph.nodes) {
    const entry = modules.get(moduleOf(node.file)) ?? { files: 0, symbols: 0 }
    if (node.kind === 'file' || node.kind === 'component') entry.files += 1; else entry.symbols += 1
    modules.set(moduleOf(node.file), entry)
  }
  const dependencies = new Map<string, number>()
  for (const edge of index.graph.edges) {
    const from = moduleOf(index.nodes.get(edge.from)!.file), to = moduleOf(index.nodes.get(edge.to)!.file)
    if (from !== to) dependencies.set(from + ' → ' + to, (dependencies.get(from + ' → ' + to) ?? 0) + 1)
  }
  const top = <T>(list: T[], score: (item: T) => number, count: number) => [...list].sort((a, b) => score(b) - score(a)).slice(0, count)
  const views = viewsOf(index)
  const routes = index.graph.routes ?? []
  return {
    root: index.graph.root, commit: index.graph.commit, builtAt: index.graph.builtAt, stats: index.graph.stats,
    modules: top([...modules.entries()], entry => entry[1].files, 25).map(([name, value]) => ({ name, ...value })),
    moduleDependencies: top([...dependencies.entries()], entry => entry[1], 20).map(([link, count]) => ({ link, count })),
    hubs: top(index.graph.nodes.filter(node => node.kind !== 'file' && !isTest(node.file)), node => usedBy(index, node.id), 15).filter(node => usedBy(index, node.id) > 0).map(node => brief(index, node)),
    entries: [...views.entries].sort().slice(0, 25),
    clusters: views.clusters.slice(0, 15).map(cluster => ({ id: cluster.id, label: cluster.label, files: cluster.files, cohesion: cluster.cohesion, keywords: cluster.keywords })),
    globalViews: { clusters: views.clusters.length, scatteredFiles: views.scattered, flows: views.flows.length, routes: { pages: routes.filter(route => route.kind === 'page').length, apis: routes.filter(route => route.kind === 'api').length, tabs: routes.filter(route => route.tab).length }, cycles: views.cycles.length },
    externals: top(Object.entries(index.graph.externals), entry => entry[1], 20).map(([name, files]) => ({ name, files })),
  }
}

/**
 * 把 Git 改动映射到图谱里的符号：改动行落在哪个符号的范围内就算哪个符号被改，取范围最小的那个。
 * @param index 图谱索引。
 * @param changes 文件改动清单。
 */
export function changedSymbols(index: GraphIndex, changes: FileChange[]) {
  const symbols = new Map<string, GraphNode>()
  const deleted: string[] = [], outside: string[] = []
  for (const change of changes) {
    const file = normalize(change.file)
    if (change.status === 'deleted') { deleted.push(file); continue }
    const fileNode = index.nodes.get(file)
    if (!fileNode) { outside.push(file); continue }
    const inFile = index.byFile.get(file) ?? []
    for (const [start, end] of change.ranges) {
      const hits = inFile.filter(node => node.line <= end && node.endLine >= start)
      // 类与其成员同时命中时只留成员；一个符号都没命中说明改的是模块顶层代码。
      const specific = hits.filter(node => !hits.some(other => other.parent === node.id))
      if (specific.length) for (const node of specific) symbols.set(node.id, node)
      else symbols.set(fileNode.id, fileNode)
    }
  }
  return { symbols: [...symbols.values()], deleted, outside }
}
