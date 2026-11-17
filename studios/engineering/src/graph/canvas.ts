import type { EdgeKind, GraphNode } from '../types.ts'
import { isTest } from './paths.ts'
import type { GraphIndex } from './query.ts'
import { viewsOf } from './views.ts'

/**
 * 知识图谱画布的数据：把图谱裁成一张看得清的图。
 * 全局视角每个功能聚类只取关系最多的若干文件，聚类用色块圈出；进入某个聚类后画出它的全部文件。
 * 节点一律是文件（组件、页面、模块），符号级的细节在节点详情里看。
 */

/** 画布上的节点类型：entry 页面与入口，component 组件，module 普通脚本，test 测试。 */
export type CanvasKind = 'entry' | 'component' | 'module' | 'test'

export interface CanvasNode {
  /** 文件路径 */
  id: string
  /** 显示名：去掉扩展名的文件名，index 文件带上目录名 */
  label: string
  kind: CanvasKind
  /** 所在聚类 */
  cluster: string
  /** 被其他文件引用的次数，决定节点的强调程度 */
  usedBy: number
  /** 引用其他文件的次数 */
  uses: number
  lines: number
}

export interface CanvasEdge {
  from: string
  to: string
  /** 两个文件之间的关系数（双向合计） */
  weight: number
  /** 全部由自动导入、目录约定等推断而来 */
  inferred: boolean
  /** 占多数的关系类型 */
  kind: EdgeKind
}

export interface CanvasData {
  /** global：全项目各聚类的代表文件；cluster：一个聚类的全部文件 */
  scope: 'global' | 'cluster'
  /** cluster 视角下当前聚类的 ID */
  focus?: string
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  /** 画布上出现的聚类；shown 为画出来的文件数，files 为聚类的全部文件数 */
  clusters: { id: string; label: string; files: number; shown: number }[]
  total: { files: number; nodes: number; relations: number; clusters: number; hiddenClusters: number }
}

const GLOBAL_NODES = 140
const GLOBAL_CLUSTERS = 12
const CLUSTER_NODES = 160

/** 显示名：文件名去扩展名；index、main 这类到处都有的名字带上所在目录。 */
export function nodeLabel(file: string): string {
  const parts = file.split('/')
  const base = parts[parts.length - 1].replace(/\.[^.]+$/, '')
  return /^(index|main|app|list|detail|edit)$/i.test(base) && parts.length > 1 ? parts[parts.length - 2] + '/' + base : base
}

/**
 * 取画布数据。
 * @param index 图谱索引。
 * @param focus 聚类 ID；缺省为全局视角。
 */
export function canvasOf(index: GraphIndex, focus?: string): CanvasData {
  const views = viewsOf(index)
  const isFile = (node: GraphNode) => node.kind === 'file' || node.kind === 'component'
  // 文件之间的关系：按无向的一对合计，同时记下各类型与推断的数量。
  const pairs = new Map<string, { a: string; b: string; weight: number; inferred: number; kinds: Map<EdgeKind, number> }>()
  const usedBy = new Map<string, number>(), uses = new Map<string, number>()
  for (const edge of index.graph.edges) {
    const from = index.nodes.get(edge.from)!.file, to = index.nodes.get(edge.to)!.file
    if (from === to) continue
    usedBy.set(to, (usedBy.get(to) ?? 0) + 1); uses.set(from, (uses.get(from) ?? 0) + 1)
    const [a, b] = from < to ? [from, to] : [to, from], key = a + '\0' + b
    const pair = pairs.get(key) ?? { a, b, weight: 0, inferred: 0, kinds: new Map<EdgeKind, number>() }
    pair.weight += 1; pair.kinds.set(edge.kind, (pair.kinds.get(edge.kind) ?? 0) + 1)
    if (edge.confidence === 'inferred') pair.inferred += 1
    pairs.set(key, pair)
  }
  const degree = (file: string) => (usedBy.get(file) ?? 0) + (uses.get(file) ?? 0)
  const filesOf = new Map<string, string[]>()
  for (const node of index.graph.nodes) { if (!isFile(node)) continue; const id = views.clusterOf.get(node.id); if (!id) continue; const list = filesOf.get(id); if (list) list.push(node.id); else filesOf.set(id, [node.id]) }
  // 入口文件优先留在图上：它们是读图的起点，即使关系不多。
  const rank = (files: string[]) => [...files].sort((a, b) => (degree(b) + (views.entries.has(b) ? 6 : 0)) - (degree(a) + (views.entries.has(a) ? 6 : 0)) || a.localeCompare(b))

  const scoped = focus ? views.clusters.filter(cluster => cluster.id === focus) : views.clusters.slice(0, GLOBAL_CLUSTERS)
  const clustered = scoped.reduce((sum, cluster) => sum + cluster.files, 0)
  const chosen = new Set<string>()
  const clusters: CanvasData['clusters'] = []
  for (const cluster of scoped) {
    const files = filesOf.get(cluster.id) ?? []
    const quota = focus ? CLUSTER_NODES : Math.max(4, Math.round(GLOBAL_NODES * cluster.files / Math.max(1, clustered)))
    const picked = rank(files).slice(0, quota)
    for (const file of picked) chosen.add(file)
    clusters.push({ id: cluster.id, label: cluster.label, files: cluster.files, shown: picked.length })
  }
  const kindOf = (node: GraphNode): CanvasKind => isTest(node.id) ? 'test' : views.entries.has(node.id) ? 'entry' : node.kind === 'component' ? 'component' : 'module'
  const nodes: CanvasNode[] = [...chosen].map(file => {
    const node = index.nodes.get(file)!
    return { id: file, label: nodeLabel(file), kind: kindOf(node), cluster: views.clusterOf.get(file)!, usedBy: usedBy.get(file) ?? 0, uses: uses.get(file) ?? 0, lines: node.endLine }
  })
  const dominant = (kinds: Map<EdgeKind, number>) => [...kinds.entries()].sort((a, b) => b[1] - a[1])[0][0]
  // 连线太多图就糊了：按关系数取前若干条，再保证每个节点至少留下它最重的一条。
  const candidates = [...pairs.values()].filter(pair => chosen.has(pair.a) && chosen.has(pair.b)).sort((a, b) => b.weight - a.weight)
  const budget = Math.round(nodes.length * (focus ? 2.4 : 1.8))
  const kept = new Set(candidates.slice(0, budget))
  const linked = new Set<string>()
  for (const pair of kept) { linked.add(pair.a); linked.add(pair.b) }
  for (const pair of candidates) { if (linked.has(pair.a) && linked.has(pair.b)) continue; kept.add(pair); linked.add(pair.a); linked.add(pair.b) }
  const edges: CanvasEdge[] = [...kept].map(pair => ({ from: pair.a, to: pair.b, weight: pair.weight, inferred: pair.inferred === pair.weight, kind: dominant(pair.kinds) }))
  return {
    scope: focus ? 'cluster' : 'global', ...(focus ? { focus } : {}), nodes, edges, clusters,
    total: { files: index.graph.stats.files, nodes: nodes.length, relations: edges.length, clusters: views.clusters.length, hiddenClusters: focus ? 0 : Math.max(0, views.clusters.length - scoped.length) },
  }
}
