/** 页面与工作室宿主端之间的数据结构；字段与 src/index.ts 的 dispatch 返回值一致。 */
export interface GraphStats { files: number; symbols: number; edges: number; inferredEdges: number; languages: Record<string, number>; errors: number; skipped: number }
export interface GraphMeta { root: string; commit: string; builtAt: string; stats: GraphStats }
export interface NodeBrief { id: string; kind: string; name: string; location: string; exported: boolean; signature?: string; doc?: string; usedBy: number }
export interface Overview {
  root: string; commit: string; builtAt: string; stats: GraphStats
  modules: { name: string; files: number; symbols: number }[]
  moduleDependencies: { link: string; count: number }[]
  hubs: NodeBrief[]
  entries: string[]
  externals: { name: string; files: number }[]
}
export interface ImpactItem { id: string; kind: string; location: string; via: string; relation: string; confidence: 'resolved' | 'inferred'; test?: true }
export interface ImpactReport {
  targets: string[]; risk: 'LOW' | 'MEDIUM' | 'HIGH'
  summary: { direct: number; indirect: number; regression: number; files: number; modules: string[]; tests: string[]; entries: string[]; inferred: number }
  direct: ImpactItem[]; indirect: ImpactItem[]; regression: ImpactItem[]; notes: string[]
}
/** 功能聚类摘要（全局视图列表与架构图） */
export interface ClusterSummary {
  id: string; label: string; files: number; symbols: number; cohesion: number; entries: number
  directories: { path: string; files: number }[]; keywords: string[]; members: string[]
  dependsOn: { cluster: string; label?: string; weight: number }[]
}
export interface ClusterLink { from: string; to: string; weight: number }
/** 聚类详情：全部文件与上下游聚类 */
export interface ClusterDetail {
  id: string; label: string; files: number; symbols: number; cohesion: number; entries: number
  directories: { path: string; files: number }[]; keywords: string[]
  members: { id: string; kind: string; usedBy: number }[]
  dependsOn: { cluster: string; label?: string; weight: number }[]
  usedBy: { cluster: string; label?: string; weight: number }[]
  fileList: { file: string; entry: boolean }[]
  truncated?: number
}
export interface FlowSummary { id: string; label: string; route?: string; steps: number; truncated?: boolean; clusters: string[]; terminals: string[] }
export interface FlowStepView { id: string; kind?: string; depth: number; location: string; via?: string; relation?: string; inferred?: boolean; cluster?: string }
export interface FlowDetail extends Omit<FlowSummary, 'steps'> { title?: string; steps: FlowStepView[] }
export interface RouteItem { path: string; file: string; kind: 'page' | 'api'; title?: string; tab?: true; subPackage?: string; method?: string; source: string; flowSteps: number }
export interface CycleItem { files: string[]; size: number; path: string[] }
export interface TraceView { found: boolean; from?: string; to?: string; direction?: 'forward' | 'reverse'; note?: string; hops?: { id: string; location: string; relation?: string; inferred?: true }[]; issue?: string; candidates?: NodeBrief[]; suggestions?: string[] }
/** 全局视图一次取回的数据 */
export interface ViewsPayload {
  clusters: { total: number; scatteredFiles: number; note: string; clusters: ClusterSummary[]; links: ClusterLink[] }
  flows: { total: number; note: string; flows: FlowSummary[] }
  routes: { total: number; sources: string[]; note: string; routes: RouteItem[] }
  cycles: { total: number; note: string; cycles: CycleItem[] }
}

export interface Snapshot {
  graphs: GraphMeta[]
  skills: { name: string; description: string }[]
  tasks: { id: string; label: string; description?: string; text: string }[]
  instructions: string
  principles: string
  settings: { schemaVersion: 1; principles: boolean }
}

/**
 * 调用工作室接口；失败时抛出宿主端给出的中文说明。
 * @param body 操作与参数；缺省读取快照。
 */
export async function call<T>(body?: Record<string, unknown>): Promise<T> {
  const response = await fetch('/studio-projects/engineering/api', body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined)
  const value = await response.json()
  if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : '请求失败')
  return value as T
}
