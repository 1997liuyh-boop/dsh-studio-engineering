import type { EdgeKind, GraphNode } from '../types.ts'
import { isBootPath, isEntryPath, isTest } from './paths.ts'
import type { GraphIndex } from './query.ts'

/**
 * 全局视图：功能聚类、执行流程、路径追踪与循环依赖。都由图谱推算，不读磁盘；
 * 结果按索引缓存，同一份图只算一次。
 */

/** 一个功能聚类：按调用与依赖关系紧密程度划分的一组文件，不一定与目录一致。 */
export interface Cluster {
  id: string
  /** 名称：主要目录，跨目录时用「目录 + 目录」 */
  label: string
  files: number
  symbols: number
  /** 内聚度：内部关系占全部关系的比例，越接近 1 越独立 */
  cohesion: number
  /** 主要目录及其中的文件数 */
  directories: { path: string; files: number }[]
  /** 文件名与导出名里出现最多的词 */
  keywords: string[]
  /** 被聚类之外使用最多的符号或组件 */
  members: { id: string; kind: string; usedBy: number }[]
  /** 这个聚类用到的其他聚类及关系数 */
  dependsOn: { cluster: string; weight: number }[]
  /** 入口文件数（页面、路由、接口） */
  entries: number
}

/** 执行流程中的一步。 */
export interface FlowStep {
  id: string
  depth: number
  /** 从哪一步走到这里 */
  via?: string
  relation?: EdgeKind
  /** 走到这一步的关系里有推断出来的 */
  inferred?: true
}

/** 一条执行流程：从入口出发，沿调用与渲染关系能走到的步骤。 */
export interface Flow {
  id: string
  label: string
  entry: string
  /** 入口对应的路由 */
  route?: string
  title?: string
  steps: FlowStep[]
  /** 经过的功能聚类，按首次出现排序 */
  clusters: string[]
  /** 没有再往下调用的步骤：通常是请求、存储、工具函数等底层能力，按全项目被使用次数排序 */
  terminals: string[]
  /** 步数达到上限被截断 */
  truncated?: true
}

export interface Views {
  clusters: Cluster[]
  /** 文件 → 聚类 ID；散落的小文件不在其中 */
  clusterOf: Map<string, string>
  /** 散落文件数：与其他文件几乎没有关系，或所在聚类太小 */
  scattered: number
  /** 聚类之间的关系，用于画架构图 */
  links: { from: string; to: string; weight: number }[]
  flows: Flow[]
  /** 节点 → 经过它的流程 ID */
  flowsOf: Map<string, string[]>
  /** 入口文件：路由表里的页面与接口，加上按目录约定判断的入口 */
  entries: Set<string>
  cycles: Cycle[]
}

export interface Cycle {
  /** 互相依赖的文件（强连通分量），最多列 30 个 */
  files: string[]
  size: number
  /** 其中一条具体的循环导入路径，首尾相同 */
  path: string[]
}

const FLOW_DEPTH = 5
const FLOW_STEPS = 60
const MIN_CLUSTER = 3
/** 起名时忽略的通用词。 */
const stopwords = new Set(['index', 'vue', 'nvue', 'js', 'ts', 'tsx', 'jsx', 'mjs', 'src', 'app', 'lib', 'utils', 'util', 'components', 'component', 'pages', 'page', 'common', 'default', 'get', 'set', 'the', 'and', 'use', 'new', 'list', 'data', 'item', 'type', 'types', 'main', 'test', 'tests', 'spec'])
const isFileNode = (node: GraphNode | undefined) => !!node && (node.kind === 'file' || node.kind === 'component')
const words = (text: string) => text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length >= 3 && !stopwords.has(word) && !/^\d+$/.test(word))
const usedBy = (index: GraphIndex, id: string) => (index.in.get(id) ?? []).filter(edge => edge.kind !== 'imports').length

/**
 * Louvain 社区划分（模块度优化 + 逐层聚合），按节点顺序处理，结果确定。
 * @param size 节点数。
 * @param adjacency 每个节点的邻居与权重（无向，双向都要写）。
 * @returns 每个节点的社区编号。
 */
export function louvain(size: number, adjacency: Map<number, number>[]): number[] {
  let membership = Array.from({ length: size }, (_, node) => node)
  let graph = adjacency
  for (let level = 0; level < 12; level += 1) {
    const count = graph.length
    const degree = graph.map(neighbors => { let sum = 0; for (const weight of neighbors.values()) sum += weight; return sum })
    const total = degree.reduce((sum, value) => sum + value, 0)
    if (total === 0) break
    const community = Array.from({ length: count }, (_, node) => node)
    const tot = degree.slice()
    let moved = false
    for (let pass = 0; pass < 20; pass += 1) {
      let changed = 0
      for (let node = 0; node < count; node += 1) {
        const own = community[node], k = degree[node]
        if (k === 0) continue
        // 节点到各相邻社区的权重。
        const links = new Map<number, number>()
        for (const [neighbor, weight] of graph[node]) if (neighbor !== node) links.set(community[neighbor], (links.get(community[neighbor]) ?? 0) + weight)
        tot[own] -= k
        let best = own, bestGain = (links.get(own) ?? 0) - tot[own] * k / total
        for (const [candidate, weight] of links) {
          const gain = weight - tot[candidate] * k / total
          if (gain > bestGain + 1e-12) { best = candidate; bestGain = gain }
        }
        tot[best] += k
        if (best !== own) { community[node] = best; changed += 1 }
      }
      if (changed === 0) break
      moved = true
    }
    if (!moved) break
    // 社区编号压缩成 0..n-1，再把每个社区聚合成一个节点进入下一层。
    const renumber = new Map<number, number>()
    for (const value of community) if (!renumber.has(value)) renumber.set(value, renumber.size)
    membership = membership.map(value => renumber.get(community[value])!)
    const next: Map<number, number>[] = Array.from({ length: renumber.size }, () => new Map())
    graph.forEach((neighbors, node) => {
      const from = renumber.get(community[node])!
      for (const [neighbor, weight] of neighbors) {
        const to = renumber.get(community[neighbor])!
        next[from].set(to, (next[from].get(to) ?? 0) + weight)
      }
    })
    if (next.length === count) break
    graph = next
  }
  return membership
}

/** 为一组文件起名：取覆盖六成以上文件的最深目录；分散时取文件最多的两个二级目录。 */
function labelOf(files: string[]): { label: string; directories: { path: string; files: number }[] } {
  const counts = new Map<string, number>(), second = new Map<string, number>()
  for (const file of files) {
    const parts = file.split('/').slice(0, -1)
    const top = parts.length ? parts.slice(0, Math.min(2, parts.length)).join('/') : '(根目录)'
    second.set(top, (second.get(top) ?? 0) + 1)
    for (let depth = 1; depth <= Math.min(3, parts.length); depth += 1) { const prefix = parts.slice(0, depth).join('/'); counts.set(prefix, (counts.get(prefix) ?? 0) + 1) }
  }
  // 一级目录（如单仓多包的 packages）太笼统，不单独作为名称；二级及更深的目录覆盖六成文件即可。
  const dominant = [...counts.entries()].filter(([path, count]) => path.includes('/') && count >= files.length * 0.6).sort((a, b) => b[0].split('/').length - a[0].split('/').length || b[1] - a[1])[0]
  const directories = [...second.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4).map(([path, count]) => ({ path, files: count }))
  const label = dominant ? dominant[0] : directories.slice(0, 2).map(item => item.path).join(' + ')
  return { label, directories }
}

/**
 * 计算全局视图。
 * @param index 图谱索引。
 */
function computeViews(index: GraphIndex): Views {
  const graph = index.graph
  const fileNodes = graph.nodes.filter(isFileNode)
  const position = new Map(fileNodes.map((node, at) => [node.id, at]))
  const adjacency: Map<number, number>[] = fileNodes.map(() => new Map())
  /** 文件之间的有向关系数，用于聚类之间的依赖方向。 */
  const directed = new Map<string, number>()
  for (const edge of graph.edges) {
    const from = index.nodes.get(edge.from)!.file, to = index.nodes.get(edge.to)!.file
    if (from === to) continue
    const a = position.get(from), b = position.get(to)
    if (a === undefined || b === undefined) continue
    adjacency[a].set(b, (adjacency[a].get(b) ?? 0) + 1)
    adjacency[b].set(a, (adjacency[b].get(a) ?? 0) + 1)
    directed.set(from + '\0' + to, (directed.get(from + '\0' + to) ?? 0) + 1)
  }
  const membership = louvain(fileNodes.length, adjacency)
  const groups = new Map<number, string[]>()
  membership.forEach((group, at) => { const list = groups.get(group); if (list) list.push(fileNodes[at].id); else groups.set(group, [fileNodes[at].id]) })

  // 有路由表时以它为准，只再补上启动文件；没有路由表时按目录约定判断。
  const routeFiles = new Set((graph.routes ?? []).map(route => route.file))
  const byConvention = fileNodes.filter(node => !isTest(node.id) && (routeFiles.size ? isBootPath(node.id) : isEntryPath(node.id))).map(node => node.id)
  const entries = new Set<string>([...routeFiles, ...byConvention])

  const clusterOf = new Map<string, string>()
  const clusters: Cluster[] = []
  let scattered = 0
  for (const files of [...groups.values()].sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]))) {
    if (files.length < MIN_CLUSTER) { scattered += files.length; continue }
    const id = 'c' + (clusters.length + 1)
    const fileSet = new Set(files)
    let internal = 0, external = 0
    for (const file of files) for (const [neighbor, weight] of adjacency[position.get(file)!]) { if (fileSet.has(fileNodes[neighbor].id)) internal += weight; else external += weight }
    const { label, directories } = labelOf(files)
    const tokens = new Map<string, number>()
    const labelWords = new Set(words(label))
    for (const file of files) {
      for (const word of words(file.slice(file.lastIndexOf('/') + 1))) tokens.set(word, (tokens.get(word) ?? 0) + 2)
      for (const symbol of index.byFile.get(file) ?? []) if (symbol.exported) for (const word of words(symbol.name)) tokens.set(word, (tokens.get(word) ?? 0) + 1)
    }
    const keywords = [...tokens.entries()].filter(([word]) => !labelWords.has(word)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([word]) => word)
    // 代表成员：被聚类外部使用最多的符号或组件。
    const outside = (id: string) => (index.in.get(id) ?? []).filter(edge => edge.kind !== 'imports' && !fileSet.has(index.nodes.get(edge.from)!.file)).length
    const candidates = files.flatMap(file => [index.nodes.get(file)!, ...(index.byFile.get(file) ?? [])]).filter(node => node.kind !== 'file')
    const members = candidates.map(node => ({ id: node.id, kind: node.kind, usedBy: outside(node.id) })).filter(item => item.usedBy > 0).sort((a, b) => b.usedBy - a.usedBy || a.id.localeCompare(b.id)).slice(0, 8)
    const symbols = files.reduce((sum, file) => sum + (index.byFile.get(file)?.length ?? 0), 0)
    clusters.push({ id, label, files: files.length, symbols, cohesion: internal + external ? Math.round(internal / (internal + external) * 100) / 100 : 1, directories, keywords, members, dependsOn: [], entries: files.filter(file => entries.has(file)).length })
    for (const file of files) clusterOf.set(file, id)
  }
  // 目录相同的聚类（不论两个目录的先后）用各自最有代表性的关键词区分，仍然重名时再加序号。
  const sameDirectories = new Map<string, Cluster[]>()
  for (const cluster of clusters) { const key = cluster.label.split(' + ').sort().join('|'); const list = sameDirectories.get(key); if (list) list.push(cluster); else sameDirectories.set(key, [cluster]) }
  for (const group of sameDirectories.values()) {
    if (group.length < 2) continue
    const used = new Set<string>()
    for (const cluster of group) {
      const keyword = cluster.keywords.find(word => !used.has(word))
      if (keyword) used.add(keyword)
      cluster.label = cluster.label + ' · ' + (keyword ?? '其他')
    }
  }
  const finalNames = new Map<string, number>()
  for (const cluster of clusters) { const seen = finalNames.get(cluster.label) ?? 0; finalNames.set(cluster.label, seen + 1); if (seen) cluster.label += ' (' + (seen + 1) + ')' }
  const linkWeights = new Map<string, number>()
  for (const [key, weight] of directed) {
    const [from, to] = key.split('\0')
    const a = clusterOf.get(from), b = clusterOf.get(to)
    if (a && b && a !== b) linkWeights.set(a + '\0' + b, (linkWeights.get(a + '\0' + b) ?? 0) + weight)
  }
  const links = [...linkWeights.entries()].map(([key, weight]) => { const [from, to] = key.split('\0'); return { from, to, weight } }).sort((a, b) => b.weight - a.weight)
  const byId = new Map(clusters.map(cluster => [cluster.id, cluster]))
  for (const link of links) byId.get(link.from)!.dependsOn.push({ cluster: link.to, weight: link.weight })
  for (const cluster of clusters) cluster.dependsOn = cluster.dependsOn.slice(0, 8)

  const { flows, flowsOf } = computeFlows(index, entries, clusterOf)
  return { clusters, clusterOf, scattered, links, flows, flowsOf, entries, cycles: computeCycles(index) }
}

/** 从一个节点继续往下走：它自己的调用与渲染，文件或组件还要带上其中各符号的调用。 */
function forward(index: GraphIndex, id: string): { to: string; relation: EdgeKind; inferred: boolean }[] {
  const node = index.nodes.get(id)
  const sources = isFileNode(node) ? [id, ...(index.byFile.get(id) ?? []).map(symbol => symbol.id)] : [id, ...(index.children.get(id) ?? []).map(member => member.id)]
  const result: { to: string; relation: EdgeKind; inferred: boolean }[] = []
  for (const source of sources) for (const edge of index.out.get(source) ?? []) {
    if (edge.kind !== 'calls' && edge.kind !== 'renders') continue
    const target = index.nodes.get(edge.to)!
    // 调到同一文件里的符号不单列一步，整份文件已经是这一步。
    if (target.file === (isFileNode(node) ? id : node?.file) && isFileNode(node)) continue
    if (isTest(target.file)) continue
    result.push({ to: edge.to, relation: edge.kind, inferred: edge.confidence === 'inferred' })
  }
  return result
}

function computeFlows(index: GraphIndex, entries: Set<string>, clusterOf: Map<string, string>): { flows: Flow[]; flowsOf: Map<string, string[]> } {
  const routes = new Map((index.graph.routes ?? []).map(route => [route.file, route]))
  const flows: Flow[] = []
  for (const entry of [...entries].sort()) {
    if (!index.nodes.has(entry)) continue
    const steps: FlowStep[] = [{ id: entry, depth: 0 }]
    const seen = new Set([entry])
    let frontier = [entry], truncated = false
    for (let depth = 1; depth <= FLOW_DEPTH && frontier.length && !truncated; depth += 1) {
      const next: string[] = []
      for (const current of frontier) {
        for (const hop of forward(index, current)) {
          if (seen.has(hop.to)) continue
          if (steps.length >= FLOW_STEPS) { truncated = true; break }
          seen.add(hop.to)
          const parent = steps.find(step => step.id === current)
          steps.push({ id: hop.to, depth, via: current, relation: hop.relation, ...(hop.inferred || parent?.inferred ? { inferred: true as const } : {}) })
          next.push(hop.to)
        }
        if (truncated) break
      }
      frontier = next
    }
    if (steps.length < 2) continue
    const terminals = steps.filter(step => step.depth > 0 && forward(index, step.id).length === 0).map(step => step.id).sort((a, b) => usedBy(index, b) - usedBy(index, a))
    // 名称：页面标题，其次路由路径，再次文件名。
    const route = routes.get(entry)
    const label = route?.title ? route.title + '（' + route.path + '）' : route?.path ?? entry
    const clusters = [...new Set(steps.map(step => clusterOf.get(index.nodes.get(step.id)!.file)).filter((id): id is string => !!id))]
    flows.push({ id: entry, label, entry, ...(route ? { route: route.path } : {}), ...(route?.title ? { title: route.title } : {}), steps, clusters, terminals, ...(truncated ? { truncated: true as const } : {}) })
  }
  flows.sort((a, b) => b.steps.length - a.steps.length || a.id.localeCompare(b.id))
  const flowsOf = new Map<string, string[]>()
  for (const flow of flows) for (const step of flow.steps) { const list = flowsOf.get(step.id); if (list) list.push(flow.id); else flowsOf.set(step.id, [flow.id]) }
  return { flows, flowsOf }
}

/** 文件导入关系里的强连通分量（Tarjan，迭代实现，避免大仓库递归过深）。 */
function computeCycles(index: GraphIndex): Cycle[] {
  const out = new Map<string, string[]>()
  for (const edge of index.graph.edges) if (edge.kind === 'imports' && edge.from !== edge.to) { const list = out.get(edge.from); if (list) list.push(edge.to); else out.set(edge.from, [edge.to]) }
  const order = new Map<string, number>(), low = new Map<string, number>(), onStack = new Set<string>(), stack: string[] = []
  const components: string[][] = []
  let counter = 0
  for (const start of [...out.keys()].sort()) {
    if (order.has(start)) continue
    const work: { node: string; next: number }[] = [{ node: start, next: 0 }]
    order.set(start, counter); low.set(start, counter); counter += 1; stack.push(start); onStack.add(start)
    while (work.length) {
      const frame = work[work.length - 1]
      const targets = out.get(frame.node) ?? []
      if (frame.next < targets.length) {
        const target = targets[frame.next++]
        if (!order.has(target)) {
          order.set(target, counter); low.set(target, counter); counter += 1; stack.push(target); onStack.add(target)
          work.push({ node: target, next: 0 })
        } else if (onStack.has(target)) low.set(frame.node, Math.min(low.get(frame.node)!, order.get(target)!))
        continue
      }
      work.pop()
      if (work.length) low.set(work[work.length - 1].node, Math.min(low.get(work[work.length - 1].node)!, low.get(frame.node)!))
      if (low.get(frame.node) === order.get(frame.node)) {
        const component: string[] = []
        for (;;) { const node = stack.pop()!; onStack.delete(node); component.push(node); if (node === frame.node) break }
        if (component.length > 1) components.push(component.sort())
      }
    }
  }
  return components.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0])).slice(0, 50).map(files => {
    // 在分量内部从第一个文件出发找回到自身的最短路径，作为可读的示例。
    const inside = new Set(files), start = files[0]
    const parent = new Map<string, string>()
    let queue = [start], path: string[] = [start, start]
    search: while (queue.length) {
      const next: string[] = []
      for (const node of queue) for (const target of out.get(node) ?? []) {
        if (!inside.has(target)) continue
        if (target === start) { path = [start]; for (let at: string | undefined = node; at && at !== start; at = parent.get(at)) path.splice(1, 0, at); path.push(start); break search }
        if (!parent.has(target)) { parent.set(target, node); next.push(target) }
      }
      queue = next
    }
    return { files: files.slice(0, 30), size: files.length, path }
  })
}

const cache = new WeakMap<GraphIndex, Views>()

/** 取全局视图；同一份索引只计算一次。 */
export function viewsOf(index: GraphIndex): Views {
  let views = cache.get(index)
  if (!views) { views = computeViews(index); cache.set(index, views) }
  return views
}

/** 路径追踪的一跳。 */
export interface TraceHop { id: string; location: string; relation?: EdgeKind | 'contains'; inferred?: true }

/**
 * 找出从 A 到 B 的最短调用路径：沿调用、渲染、引用、继承前进，文件与类可以进入其成员。
 * 正向找不到时再找 B 到 A，并说明方向。
 * @param index 图谱索引。
 * @param from 起点。
 * @param to 终点；是文件时，走到其中任意符号即算到达。
 */
export function trace(index: GraphIndex, from: GraphNode, to: GraphNode): { found: boolean; direction?: 'forward' | 'reverse'; hops: TraceHop[]; explored: number } {
  const run = (start: GraphNode, goal: GraphNode) => {
    const reached = (node: GraphNode) => node.id === goal.id || (isFileNode(goal) && node.file === goal.id) || node.parent === goal.id
    const parent = new Map<string, { from: string; relation: EdgeKind | 'contains'; inferred: boolean }>([[start.id, { from: '', relation: 'contains', inferred: false }]])
    let queue = [start.id], explored = 0
    while (queue.length && explored < 200_000) {
      const next: string[] = []
      for (const id of queue) {
        explored += 1
        const node = index.nodes.get(id)!
        if (id !== start.id && reached(node)) {
          const hops: TraceHop[] = []
          for (let at = id; at; at = parent.get(at)!.from) {
            const step = parent.get(at)!, target = index.nodes.get(at)!
            hops.unshift({ id: at, location: target.file + ':' + target.line, ...(step.from ? { relation: step.relation } : {}), ...(step.inferred ? { inferred: true as const } : {}) })
          }
          return { found: true, hops, explored }
        }
        const neighbors: { to: string; relation: EdgeKind | 'contains'; inferred: boolean }[] = []
        for (const edge of index.out.get(id) ?? []) if (edge.kind !== 'imports') neighbors.push({ to: edge.to, relation: edge.kind, inferred: edge.confidence === 'inferred' })
        const contained = isFileNode(node) ? (index.byFile.get(id) ?? []).filter(item => !item.parent || item.parent === id) : index.children.get(id) ?? []
        for (const member of contained) neighbors.push({ to: member.id, relation: 'contains', inferred: false })
        for (const hop of neighbors) if (!parent.has(hop.to)) { parent.set(hop.to, { from: id, relation: hop.relation, inferred: hop.inferred }); next.push(hop.to) }
      }
      queue = next
    }
    return { found: false, hops: [] as TraceHop[], explored }
  }
  const forwardResult = run(from, to)
  if (forwardResult.found) return { ...forwardResult, direction: 'forward' }
  const reverse = run(to, from)
  if (reverse.found) return { ...reverse, direction: 'reverse' }
  return { found: false, hops: [], explored: forwardResult.explored + reverse.explored }
}
