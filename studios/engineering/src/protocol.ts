/** 页面与工作室宿主端之间的数据结构；字段与 src/index.ts 的 dispatch 返回值一致。画布与体检直接引用宿主端的类型定义，避免两边各写一份走样。 */
export type { CanvasData, CanvasEdge, CanvasKind, CanvasNode } from './graph/canvas.ts'
export type { ClusterHealth, Difficulty, Finding, HealthReport, Level } from './graph/health.ts'
/** 导出项目档案的结果：两个文件的项目相对路径与本次体检的结论。 */
export interface ArchiveResult { document: string; data: string; grade: string; score: number }
/** 节点详情：自身、文件里的符号、上下游数量与所在聚类。 */
export interface NodeContext {
  node: NodeBrief & { lines: string; component?: Record<string, string | string[]> }
  symbols?: NodeBrief[]
  usedBy: { total: number }
  uses: { total: number }
  /** 所在功能聚类的 ID；散落文件没有 */
  cluster?: string
}
export interface GraphStats { files: number; symbols: number; edges: number; inferredEdges: number; languages: Record<string, number>; errors: number; skipped: number }
export interface GraphMeta { root: string; commit: string; builtAt: string; stats: GraphStats }
export interface NodeBrief { id: string; kind: string; name: string; location: string; exported: boolean; signature?: string; doc?: string; usedBy: number }
export interface Overview {
  root: string; commit: string; builtAt: string; stats: GraphStats
  modules: { name: string; files: number; symbols: number }[]
  moduleDependencies: { link: string; count: number }[]
  hubs: NodeBrief[]
  /** 最大的若干功能聚类，按文件数从多到少 */
  clusters: { id: string; label: string; files: number; cohesion: number; keywords: string[] }[]
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
  settings: import('./settings.ts').Settings
}


/** 页面操作按名称绑定参数和返回值，避免调用方自行指定结果类型。 */
export interface Operations {
  snapshot: { input: object; output: Snapshot }
  configure: { input: { settings: Partial<import('./settings.ts').Settings> }; output: Snapshot }
  skill: { input: { name: string }; output: { name: string; description: string; content: string } }
  build: { input: { root: string }; output: { overview: Overview } }
  rebuild: { input: { root: string }; output: { overview: Overview } }
  overview: { input: { root: string }; output: { overview: Overview } }
  remove: { input: { root: string }; output: Snapshot }
  canvas: { input: { root: string; cluster?: string }; output: import('./graph/canvas.ts').CanvasData }
  search: { input: { root: string; query: string }; output: { total: number; results: NodeBrief[] } }
  context: { input: { root: string; target: string }; output: NodeContext }
  impact: { input: { root: string; target: string }; output: ImpactReport }
  views: { input: { root: string }; output: ViewsPayload }
  health: { input: { root: string }; output: import('./graph/health.ts').HealthReport }
  export: { input: { root: string }; output: ArchiveResult }
  cluster: { input: { root: string; id: string }; output: ClusterDetail }
  flow: { input: { root: string; id: string }; output: FlowDetail }
  trace: { input: { root: string; from: string; to: string }; output: TraceView }
  changes: { input: { root: string }; output: ChangesReport }
  plans: { input: { root: string }; output: { plans: import('./plan-service.ts').PlanSummary[] } }
  plan: { input: { root: string; slug: string }; output: import('./plan-service.ts').PlanDetail }
  'check-plan': { input: { root: string; slug: string }; output: import('./plan-service.ts').PlanCheck }
}
/** 当前工作区改动；非 Git 目录以 available=false 明确表示。 */
export interface ChangesReport { available: boolean; files: import('./git.ts').FileChange[]; symbols: NodeBrief[]; deleted: string[]; outside: string[]; impact?: ImpactReport }
export type OperationInput<K extends keyof Operations> = { action: K } & Operations[K]['input']
