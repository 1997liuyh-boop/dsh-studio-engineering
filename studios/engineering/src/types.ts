/** 图谱节点类型：file 为普通源码文件，component 为 Vue 单文件组件（节点 ID 即文件路径）。 */
export type NodeKind = 'file' | 'component' | 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum' | 'variable'
/** 边类型：imports 只连文件，其余连符号（来源在模块顶层时落到文件节点）。 */
export type EdgeKind = 'imports' | 'calls' | 'references' | 'extends' | 'implements' | 'renders'
/** resolved：由 import 或同文件定义确定；inferred：靠自动导入约定、目录约定等推断。 */
export type Confidence = 'resolved' | 'inferred'
export type Language = 'ts' | 'tsx' | 'js' | 'jsx' | 'vue'

/** Vue 组件对外接口，取自 defineProps / defineEmits / defineModel / defineSlots 的原文。 */
export interface ComponentApi {
  props?: string
  emits?: string
  models?: string[]
  slots?: string
}

/** 单个文件内的符号；name 对类成员为「类名.成员名」。 */
export interface SymbolFact {
  name: string
  kind: Exclude<NodeKind, 'file' | 'component'>
  line: number
  endLine: number
  exported: boolean
  /** 是否为默认导出 */
  isDefault?: boolean
  /** 声明到函数体之前的原文（已压缩空白），类型与接口为完整声明 */
  signature?: string
  /** 紧邻声明的注释首段 */
  doc?: string
  /** 类成员所属的类名 */
  parent?: string
  /** 选项式组件 methods 里的方法：只能经 this 调用，同名的裸标识符不指向它 */
  viaThis?: boolean
}

export interface ImportFact {
  source: string
  line: number
  /** imported 为 default、*（命名空间）或导出名；local 为本文件里的名字 */
  names: { imported: string; local: string }[]
  typeOnly?: boolean
}

/** 转导出：export * from / export { a as b } from。 */
export interface ReexportFact {
  source: string
  /** 缺省表示 export * */
  names?: { imported: string; exported: string }[]
}

/** 符号体内对其他名字的使用；from 为空串表示模块顶层。 */
export interface UseFact {
  from: string
  name: string
  /** 成员访问的属性名，如 api.fetch() 的 fetch、this.save() 的 save */
  member?: string
  kind: 'call' | 'ref' | 'extends' | 'implements' | 'render'
  line: number
}

/** 一个文件的抽取结果，按内容哈希缓存；解析跨文件关系时不再读源码。 */
export interface FileFacts {
  path: string
  hash: string
  size: number
  mtime: number
  language: Language
  lines: number
  symbols: SymbolFact[]
  imports: ImportFact[]
  reexports: ReexportFact[]
  /** export { a as b } 这类本地别名导出：exported → local */
  aliases: Record<string, string>
  uses: UseFact[]
  component?: ComponentApi
  /** 选项式组件 mixins: [a, b] 里的本地名；this.方法() 在本组件找不到时到这些混入里找 */
  mixins?: string[]
  /** 压缩或打包产物的占位记录，不进图谱 */
  generated?: boolean
  /** 解析失败或语法错误的说明；有错误的文件仍保留已抽到的内容 */
  error?: string
}

export interface GraphNode {
  /** 文件节点为相对路径，符号节点为「路径#符号名」 */
  id: string
  kind: NodeKind
  name: string
  file: string
  line: number
  endLine: number
  exported: boolean
  signature?: string
  doc?: string
  /** 所属节点 ID：符号指向文件，类成员指向类 */
  parent?: string
  component?: ComponentApi
}

export interface GraphEdge {
  from: string
  to: string
  kind: EdgeKind
  confidence: Confidence
  line?: number
}

export interface GraphStats {
  files: number
  symbols: number
  edges: number
  inferredEdges: number
  languages: Record<string, number>
  /** 含解析器不认识的语法、只解析了一部分的文件数 */
  errors: number
  /** 因体积或数量上限跳过的文件数 */
  skipped: number
}

/** 框架按约定加载的入口：页面路由或服务端接口。 */
export interface Route {
  /** 访问路径，如 /pages/users/index、/api/orders */
  path: string
  /** 对应的源码文件（相对路径） */
  file: string
  kind: 'page' | 'api'
  /** 页面标题（uni-app 的 navigationBarTitleText） */
  title?: string
  /** 是否为 uni-app 底部导航页 */
  tab?: true
  /** 所在分包的根目录（uni-app） */
  subPackage?: string
  /** 接口的 HTTP 方法（Nuxt 的 .get.ts 等后缀） */
  method?: string
  /** 路由来自哪里：pages.json、Nuxt 的 pages 目录或 server 目录 */
  source: 'pages.json' | 'nuxt-pages' | 'nuxt-server'
}

export interface Graph {
  schemaVersion: 1
  engine: 'builtin'
  /** 生成这份图的引擎版本；与当前版本不同时不复用 */
  engineVersion?: number
  /** 生成时项目配置文件（package.json、tsconfig、pages.json 等）的体积与时间，配置变了要重算别名与路由 */
  configKey?: string
  /** 框架约定的页面与接口 */
  routes?: Route[]
  root: string
  /** 建图时的 HEAD；非 Git 目录为空串 */
  commit: string
  builtAt: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** 外部依赖包被多少个文件导入 */
  externals: Record<string, number>
  stats: GraphStats
}

/** 每次调用工具时的新鲜度说明。 */
export interface Freshness {
  /** built：首次建图；updated：检测到改动并已增量更新；fresh：无改动 */
  state: 'built' | 'updated' | 'fresh'
  changed: number
  removed: number
  elapsedMs: number
}
