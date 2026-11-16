import type { GraphNode } from '../types.ts'
import type { GraphIndex } from './query.ts'
import { trace, viewsOf, type Flow, type TraceHop } from './views.ts'

/**
 * 全局视图的对外格式：工具返回给模型、页面画图都用这一份。
 * 只放定位与结论需要的字段，节点一律用「路径#符号」或文件路径表示。
 */

const location = (index: GraphIndex, id: string) => { const node = index.nodes.get(id); return node ? node.file + ':' + node.line : id }
const nameOf = (index: GraphIndex, id: string) => index.nodes.get(id)?.name ?? id

/**
 * 功能聚类列表。
 * @param index 图谱索引。
 * @param limit 最多列出多少个聚类。
 */
export function clusterList(index: GraphIndex, limit = 30) {
  const views = viewsOf(index)
  const labels = new Map(views.clusters.map(cluster => [cluster.id, cluster.label]))
  return {
    total: views.clusters.length,
    scatteredFiles: views.scattered,
    note: '聚类按文件之间的调用、引用与渲染关系自动划分（Louvain 社区算法），不按目录；内聚度是内部关系占全部关系的比例，越接近 1 越独立。少于 3 个文件的小团与孤立文件计入 scatteredFiles。',
    clusters: views.clusters.slice(0, limit).map(cluster => ({
      id: cluster.id, label: cluster.label, files: cluster.files, symbols: cluster.symbols, cohesion: cluster.cohesion, entries: cluster.entries,
      directories: cluster.directories, keywords: cluster.keywords, members: cluster.members.slice(0, 5).map(member => member.id + '（外部使用 ' + member.usedBy + '）'),
      dependsOn: cluster.dependsOn.slice(0, 5).map(item => ({ cluster: item.cluster, label: labels.get(item.cluster), weight: item.weight })),
    })),
    links: views.links.filter(link => views.clusters.findIndex(cluster => cluster.id === link.from) < limit && views.clusters.findIndex(cluster => cluster.id === link.to) < limit).slice(0, limit * 4),
  }
}

/**
 * 一个聚类的详情：全部文件、对外依赖与被依赖。
 * @param index 图谱索引。
 * @param clusterId 聚类 ID。
 * @param limit 最多列出多少个文件。
 */
export function clusterDetail(index: GraphIndex, clusterId: string, limit = 200) {
  const views = viewsOf(index)
  const cluster = views.clusters.find(item => item.id === clusterId)
  if (!cluster) return undefined
  const labels = new Map(views.clusters.map(item => [item.id, item.label]))
  const files = [...views.clusterOf.entries()].filter(([, id]) => id === clusterId).map(([file]) => file).sort()
  return {
    ...cluster,
    dependsOn: cluster.dependsOn.map(item => ({ ...item, label: labels.get(item.cluster) })),
    usedBy: views.links.filter(link => link.to === clusterId).slice(0, 8).map(link => ({ cluster: link.from, label: labels.get(link.from), weight: link.weight })),
    fileList: files.slice(0, limit).map(file => ({ file, entry: views.entries.has(file) })),
    ...(files.length > limit ? { truncated: files.length } : {}),
  }
}

/** 节点所在的聚类。 */
export function clusterOfNode(index: GraphIndex, node: GraphNode): string | undefined {
  return viewsOf(index).clusterOf.get(node.file)
}

const flowSummary = (index: GraphIndex, flow: Flow, labels: Map<string, string>) => ({
  id: flow.id, label: flow.label, ...(flow.route ? { route: flow.route } : {}), steps: flow.steps.length, ...(flow.truncated ? { truncated: true } : {}),
  clusters: flow.clusters.map(id => labels.get(id) ?? id), terminals: flow.terminals.slice(0, 5).map(id => nameOf(index, id)),
})

/**
 * 执行流程列表；给了节点时只列经过它的流程。
 * @param index 图谱索引。
 * @param options through 为经过的节点；query 为按名称与路由过滤；limit 为最多条数。
 */
export function flowList(index: GraphIndex, options: { through?: GraphNode; query?: string; limit?: number } = {}) {
  const views = viewsOf(index)
  const labels = new Map(views.clusters.map(cluster => [cluster.id, cluster.label]))
  let flows = views.flows
  if (options.through) {
    // 经过文件或组件本身，或经过其中任一符号，都算经过。
    const ids = new Set([options.through.id, ...(index.byFile.get(options.through.id) ?? []).map(node => node.id), ...(index.children.get(options.through.id) ?? []).map(node => node.id)])
    const hit = new Set([...ids].flatMap(id => views.flowsOf.get(id) ?? []))
    flows = flows.filter(flow => hit.has(flow.id))
  }
  if (options.query) { const needle = options.query.toLowerCase(); flows = flows.filter(flow => flow.label.toLowerCase().includes(needle) || flow.id.toLowerCase().includes(needle)) }
  const limit = options.limit ?? 30
  return {
    total: flows.length,
    note: '执行流程从入口（路由表里的页面与接口、按目录约定的入口文件）出发，沿调用与渲染关系逐层展开，最多 5 层、60 步；terminals 是不再往下调用的底层能力。动态调用、事件总线、按字符串跳转的页面看不到。',
    flows: flows.slice(0, limit).map(flow => flowSummary(index, flow, labels)),
  }
}

/**
 * 一条流程的步骤明细。
 * @param index 图谱索引。
 * @param flowId 流程 ID（即入口文件路径）。
 */
export function flowDetail(index: GraphIndex, flowId: string) {
  const views = viewsOf(index)
  const flow = views.flows.find(item => item.id === flowId)
  if (!flow) return undefined
  const labels = new Map(views.clusters.map(cluster => [cluster.id, cluster.label]))
  return {
    ...flowSummary(index, flow, labels),
    ...(flow.title ? { title: flow.title } : {}),
    steps: flow.steps.map(step => ({ id: step.id, kind: index.nodes.get(step.id)?.kind, depth: step.depth, location: location(index, step.id), ...(step.via ? { via: step.via, relation: step.relation } : {}), ...(step.inferred ? { inferred: true } : {}), cluster: labels.get(views.clusterOf.get(index.nodes.get(step.id)?.file ?? '') ?? '') })),
  }
}

/**
 * 路由表：框架约定的页面与接口。
 * @param index 图谱索引。
 * @param options query 按路径、标题或文件过滤；limit 为最多条数。
 */
export function routeList(index: GraphIndex, options: { query?: string; limit?: number } = {}) {
  const views = viewsOf(index)
  let routes = index.graph.routes ?? []
  if (options.query) { const needle = options.query.toLowerCase(); routes = routes.filter(route => route.path.toLowerCase().includes(needle) || route.file.toLowerCase().includes(needle) || (route.title ?? '').toLowerCase().includes(needle)) }
  const flowSteps = new Map(views.flows.map(flow => [flow.id, flow.steps.length]))
  return {
    total: routes.length,
    sources: [...new Set((index.graph.routes ?? []).map(route => route.source))],
    note: (index.graph.routes ?? []).length ? '路由来自 uni-app 的 pages.json（含分包与底部导航）或 Nuxt 的 pages 与 server 目录。' : '没有识别到路由：目前支持 uni-app 的 pages.json 与 Nuxt 的 pages、server 目录；Vue Router 手写的路由表不在其中，请用文本搜索 path: 定位。',
    routes: routes.slice(0, options.limit ?? 100).map(route => ({ ...route, flowSteps: flowSteps.get(route.file) ?? 0 })),
  }
}

/**
 * 循环依赖：文件导入关系里互相依赖的一组文件。
 * @param index 图谱索引。
 * @param limit 最多列出多少组。
 */
export function cycleList(index: GraphIndex, limit = 20) {
  const cycles = viewsOf(index).cycles
  return {
    total: cycles.length,
    note: '每组是文件导入关系里的一个强连通分量（组内任意两个文件都能经导入互相到达），path 是其中一条具体的循环路径。只看 import / require，不含类型导入以外的运行时依赖。',
    cycles: cycles.slice(0, limit),
  }
}

/**
 * 路径追踪：A 怎样调用到 B。
 * @param index 图谱索引。
 * @param from 起点节点。
 * @param to 终点节点。
 */
export function traceResult(index: GraphIndex, from: GraphNode, to: GraphNode): { found: boolean; from: string; to: string; direction?: 'forward' | 'reverse'; note?: string; hops?: TraceHop[]; explored?: number } {
  const result = trace(index, from, to)
  if (!result.found) return { found: false, from: from.id, to: to.id, explored: result.explored, note: '沿调用、渲染、引用与继承关系双向都没有找到路径：两者可能只通过动态调用、事件或路由跳转联系，或者其中一方不在图谱范围内。' }
  return {
    found: true, from: from.id, to: to.id, direction: result.direction,
    ...(result.direction === 'reverse' ? { note: '正向没有路径，这里给出的是从「' + to.id + '」到「' + from.id + '」的反向路径。' } : {}),
    hops: result.hops,
  }
}
