import type { History } from '../history.ts'
import type { GraphNode } from '../types.ts'
import { isTest } from './paths.ts'
import type { GraphIndex } from './query.ts'
import { viewsOf } from './views.ts'

/**
 * 项目体检：把图谱、Git 历史与依赖清单汇成一份「接手的人或模型先看什么」的报告——
 * 规模、质量、依赖、迭代情况，以及每个功能聚类的优化难度与迭代难度。
 * 工作室页面、eng_graph 的 health 动作与导出的项目档案用的是同一份数据。
 * 所有结论都来自静态分析与提交记录，是提示而不是判决：动态调用、框架约定加载、其他语言的代码看不到。
 */

/** 结论的级别：good 没有问题，watch 值得留意，risk 建议优先处理。 */
export type Level = 'good' | 'watch' | 'risk'

/** 一条体检结论：结论、数值、依据与具体条目。 */
export interface Finding {
  id: string
  level: Level
  title: string
  /** 一眼能读的数值，如「3 组」「12%」 */
  value: string
  /** 这个数怎么来的、意味着什么 */
  detail: string
  /** 质量分里扣掉的分数；不参与评分的结论为 0 */
  penalty: number
  items: { label: string; note?: string }[]
}

/** 难度评估：分数 0–100，等级与主要原因。 */
export interface Difficulty {
  score: number
  level: '低' | '中' | '高'
  reasons: string[]
}

/** 一个功能聚类的体检结果。 */
export interface ClusterHealth {
  id: string
  label: string
  files: number
  symbols: number
  lines: number
  cohesion: number
  /** 有多少个其他聚类依赖它 / 它依赖多少个其他聚类 */
  fanIn: number
  fanOut: number
  /** 外部对它的引用数 / 它对外部的引用数 */
  inWeight: number
  outWeight: number
  /** 卷入循环导入的文件数 */
  cycleFiles: number
  /** 直接引用它的测试文件数 */
  testFiles: number
  /** 超过 80 行的函数或方法数 */
  bigSymbols: number
  /** 统计窗口内其中文件的改动次数之和 / 最近 90 天的改动次数 / 最近一次改动 */
  commits: number
  recentCommits: number
  lastChange?: string
  /** 优化难度：重构、拆分、改接口的难度 */
  refactor: Difficulty
  /** 迭代难度：在它上面加功能、改行为的难度 */
  extend: Difficulty
}

export interface PackageUse { name: string; version: string; kind: 'prod' | 'dev' | 'peer'; files: number }

/** 根目录 package.json 里声明的依赖。 */
export interface Manifest {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  peerDependencies: Record<string, string>
}

/** docs/iterations 下的一份迭代方案。 */
export interface PlanBrief { slug: string; title: string; createdAt: string; features: number; changes: number; steps: number; checked: boolean }

export interface HealthReport {
  schemaVersion: 1
  root: string
  commit: string
  builtAt: string
  scale: { files: number; symbols: number; lines: number; languages: Record<string, number>; clusters: number; scatteredFiles: number; pages: number; apis: number; entries: number; testFiles: number; relations: number; inferredRelations: number }
  quality: { score: number; grade: 'A' | 'B' | 'C' | 'D'; findings: Finding[] }
  dependencies: {
    /** 是否读到了 package.json */
    manifest: boolean
    packages: PackageUse[]
    /** 声明在 dependencies 里、源码中没有任何导入的包 */
    unused: string[]
    /** 源码里导入了、package.json 没有声明的包 */
    undeclared: { name: string; files: number }[]
    /** 聚类之间最重的依赖关系 */
    links: { from: string; to: string; weight: number }[]
    /** 被最多聚类依赖的聚类：动它波及面最大 */
    foundations: { id: string; label: string; fanIn: number; inWeight: number }[]
    note: string
  }
  iteration: {
    available: boolean
    months: number
    commits: number
    authors: number
    first?: string
    last?: string
    weeks: { week: string; commits: number }[]
    types: Record<string, number>
    /** 一句话概括节奏 */
    pace: string
    /** 改动最频繁的源码文件 */
    hotspots: { file: string; commits: number; recent: number; lines: number; usedBy: number; cluster?: string }[]
    /** 各聚类的活跃度（其中文件的改动次数之和），按最近 90 天排序 */
    clusters: { id: string; label: string; commits: number; recent: number; last?: string }[]
    recent: { hash: string; date: string; subject: string; type: string; files: number }[]
    plans: PlanBrief[]
  }
  difficulty: { note: string; clusters: ClusterHealth[] }
  /** 最值得先看的几条结论 */
  highlights: { level: Level; section: 'quality' | 'dependencies' | 'iteration' | 'difficulty'; text: string }[]
}

const isFileNode = (node: GraphNode) => node.kind === 'file' || node.kind === 'component'
const percent = (part: number, whole: number) => whole ? Math.round(part / whole * 100) : 0
const clamp = (value: number) => Math.max(0, Math.min(1, value))
const day = (iso: string | undefined) => iso ? iso.slice(0, 10) : ''

/** Node 内置模块与运行时提供的模块：没有在 package.json 里声明也不算「未声明」。 */
const builtins = new Set(['assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns', 'events', 'fs', 'http', 'http2', 'https', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'querystring', 'readline', 'stream', 'string_decoder', 'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib', 'electron'])

/** 导入来源 → 包名；别名与虚拟模块返回空串。 */
export function packageName(source: string): string {
  if (!source || /^(node:|virtual:|[.~#/]|@\/|uni_modules\/)/.test(source) || source.includes(':')) return ''
  const parts = source.split('/')
  const name = source.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  return source.startsWith('@') && parts.length < 2 ? '' : name
}

/** 难度等级：分数 34 以下为低，67 以下为中，其余为高。 */
const grade = (score: number): Difficulty['level'] => score < 34 ? '低' : score < 67 ? '中' : '高'

/**
 * 生成项目体检报告。
 * @param index 图谱索引。
 * @param history 提交历史；非 Git 目录时传不可用的空历史。
 * @param manifest 根目录 package.json 的依赖声明；读不到时为 undefined。
 * @param plans docs/iterations 下已有的迭代方案。
 */
export function healthOf(index: GraphIndex, history: History, manifest: Manifest | undefined, plans: PlanBrief[] = []): HealthReport {
  const graph = index.graph, views = viewsOf(index)
  const files = graph.nodes.filter(isFileNode)
  const source = files.filter(node => !isTest(node.id))
  const tests = files.filter(node => isTest(node.id))
  const lines = files.reduce((sum, node) => sum + node.endLine, 0)

  // 文件之间的引用数（不分关系类型），与引用某个文件的测试文件。
  const fileIn = new Map<string, number>(), fileOut = new Map<string, number>()
  const testedBy = new Map<string, Set<string>>()
  for (const edge of graph.edges) {
    const from = index.nodes.get(edge.from)!.file, to = index.nodes.get(edge.to)!.file
    if (from === to) continue
    fileOut.set(from, (fileOut.get(from) ?? 0) + 1); fileIn.set(to, (fileIn.get(to) ?? 0) + 1)
    if (isTest(from) && !isTest(to)) { const set = testedBy.get(to); if (set) set.add(from); else testedBy.set(to, new Set([from])) }
  }
  const usedBy = (id: string) => (index.in.get(id) ?? []).filter(edge => edge.kind !== 'imports').length

  // ── 质量 ──────────────────────────────────────────────
  const findings: Finding[] = []
  const cycleFiles = new Set(views.cycles.flatMap(cycle => cycle.files))
  const largestCycle = Math.max(0, ...views.cycles.map(cycle => cycle.size))
  findings.push({
    id: 'cycles', level: views.cycles.length === 0 ? 'good' : largestCycle >= 6 || views.cycles.length >= 4 ? 'risk' : 'watch', title: '循环导入',
    value: views.cycles.length ? views.cycles.length + ' 组' : '没有', penalty: views.cycles.length ? Math.min(20, views.cycles.length * 4 + largestCycle) : 0,
    detail: views.cycles.length ? '文件之间互相导入，最大的一组有 ' + largestCycle + ' 个文件。循环里的文件改一个就可能牵动一圈，初始化顺序也容易出问题。' : '文件之间没有互相导入的环。',
    items: views.cycles.slice(0, 8).map(cycle => ({ label: cycle.path.join(' → '), note: cycle.size + ' 个文件' })),
  })

  const topLevel = graph.nodes.filter(node => !isFileNode(node) && node.exported && node.parent === node.file && !isTest(node.file))
  const unusedExports = topLevel.filter(node => usedBy(node.id) === 0 && !views.entries.has(node.file))
  const unusedShare = percent(unusedExports.length, topLevel.length)
  findings.push({
    id: 'unused-exports', level: unusedShare >= 25 ? 'risk' : unusedShare >= 10 ? 'watch' : 'good', title: '没有被用到的导出',
    value: unusedExports.length + ' 个（' + unusedShare + '%）', penalty: Math.min(15, Math.round(unusedShare * 0.4)),
    detail: '导出了但图谱里找不到任何使用方的函数、类、类型与变量，占全部顶层导出的 ' + unusedShare + '%。可能是死代码，也可能只被动态调用、模板字符串或项目外部使用，删除前用文本搜索确认。',
    items: unusedExports.sort((a, b) => (b.endLine - b.line) - (a.endLine - a.line)).slice(0, 20).map(node => ({ label: node.id, note: node.kind + ' · ' + (node.endLine - node.line + 1) + ' 行' })),
  })

  const orphanComponents = files.filter(node => node.kind === 'component' && !isTest(node.id) && !views.entries.has(node.id) && !fileIn.get(node.id))
  const orphanFiles = files.filter(node => node.kind === 'file' && !isTest(node.id) && !views.entries.has(node.id) && !fileIn.get(node.id) && !fileOut.get(node.id))
  const orphans = [...orphanComponents, ...orphanFiles]
  findings.push({
    id: 'orphans', level: orphans.length === 0 ? 'good' : percent(orphans.length, source.length) >= 10 ? 'risk' : 'watch', title: '没有被引用的文件',
    value: orphans.length + ' 个', penalty: Math.min(10, Math.round(percent(orphans.length, source.length) * 0.5)),
    detail: '不是页面或入口、也没有任何文件引用它的组件（' + orphanComponents.length + ' 个）和与其他文件毫无关系的脚本（' + orphanFiles.length + ' 个）。按框架约定自动注册、或只在配置里引用的文件会被误列。',
    items: orphans.sort((a, b) => b.endLine - a.endLine).slice(0, 20).map(node => ({ label: node.id, note: node.endLine + ' 行' })),
  })

  const LARGE_FILE = 500, BIG_SYMBOL = 80
  const largeFiles = source.filter(node => node.endLine > LARGE_FILE).sort((a, b) => b.endLine - a.endLine)
  findings.push({
    id: 'large-files', level: percent(largeFiles.length, source.length) >= 8 ? 'risk' : largeFiles.length ? 'watch' : 'good', title: '超过 ' + LARGE_FILE + ' 行的文件',
    value: largeFiles.length + ' 个', penalty: Math.min(15, Math.round(percent(largeFiles.length, source.length) * 1.2)),
    detail: '占源码文件的 ' + percent(largeFiles.length, source.length) + '%（Vue 单文件组件的模板与样式也计入行数）。文件越大，一次改动要读懂的上下文越多，多人同时改时也越容易冲突。',
    items: largeFiles.slice(0, 15).map(node => ({ label: node.id, note: node.endLine + ' 行 · 被 ' + (fileIn.get(node.id) ?? 0) + ' 处引用' })),
  })

  const callables = graph.nodes.filter(node => (node.kind === 'function' || node.kind === 'method') && !isTest(node.file))
  const bigSymbols = callables.filter(node => node.endLine - node.line + 1 > BIG_SYMBOL).sort((a, b) => (b.endLine - b.line) - (a.endLine - a.line))
  findings.push({
    id: 'big-symbols', level: percent(bigSymbols.length, callables.length) >= 5 ? 'risk' : bigSymbols.length ? 'watch' : 'good', title: '超过 ' + BIG_SYMBOL + ' 行的函数与方法',
    value: bigSymbols.length + ' 个', penalty: Math.min(10, Math.round(percent(bigSymbols.length, callables.length) * 1.5)),
    detail: '占全部函数与方法的 ' + percent(bigSymbols.length, callables.length) + '%。长函数通常同时做几件事，是拆分与补测试的首选对象。',
    items: bigSymbols.slice(0, 15).map(node => ({ label: node.id, note: (node.endLine - node.line + 1) + ' 行 · 被用 ' + usedBy(node.id) })),
  })

  const testedFiles = source.filter(node => testedBy.has(node.id)).length
  const testShare = percent(testedFiles, source.length)
  findings.push({
    id: 'tests', level: tests.length === 0 ? 'risk' : testShare < 10 ? 'watch' : 'good', title: '测试',
    value: tests.length ? tests.length + ' 个测试文件' : '没有测试', penalty: tests.length === 0 ? 20 : testShare < 5 ? 12 : testShare < 15 ? 6 : 0,
    detail: tests.length ? '被测试文件直接引用的源码文件有 ' + testedFiles + ' 个，占 ' + testShare + '%。这是静态的引用关系，不是行覆盖率。' : '没有找到测试文件（tests / __tests__ / e2e 目录或 .test / .spec 后缀）。改动只能靠人工回归。',
    items: [],
  })

  const hubs = graph.nodes.filter(node => !isFileNode(node) && !isTest(node.file)).map(node => ({ node, count: usedBy(node.id) })).filter(item => item.count >= 20).sort((a, b) => b.count - a.count)
  findings.push({
    id: 'hubs', level: hubs.length ? 'watch' : 'good', title: '被大量使用的符号', value: hubs.length + ' 个', penalty: 0,
    detail: '被 20 处以上使用的函数、类与变量。它们本身不是问题，但改签名或行为的波及面最大，动之前先跑影响分析。',
    items: hubs.slice(0, 12).map(item => ({ label: item.node.id, note: '被用 ' + item.count + ' 处' })),
  })

  const inferredShare = percent(graph.stats.inferredEdges, graph.stats.edges)
  findings.push({
    id: 'coverage', level: graph.stats.errors > source.length * 0.05 || inferredShare >= 40 ? 'watch' : 'good', title: '图谱的可信度',
    value: inferredShare + '% 为推断', penalty: Math.min(10, Math.round(percent(graph.stats.errors, files.length) * 0.8)) + (inferredShare >= 40 ? 3 : 0),
    detail: graph.stats.edges + ' 条关系里有 ' + graph.stats.inferredEdges + ' 条来自自动导入、目录约定等推断，不是 import 语句确定的；' + graph.stats.errors + ' 个文件只解析了一部分，' + graph.stats.skipped + ' 个文件（构建产物、压缩脚本、超大文件）没有进图谱。这些部分的结论要打开文件核对。',
    items: [],
  })

  const score = Math.max(0, 100 - findings.reduce((sum, finding) => sum + finding.penalty, 0))
  const quality = { score, grade: (score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : 'D') as HealthReport['quality']['grade'], findings }

  // ── 依赖 ──────────────────────────────────────────────
  const usage = new Map<string, number>()
  for (const [name, count] of Object.entries(graph.externals)) { const pkg = packageName(name); if (pkg) usage.set(pkg, (usage.get(pkg) ?? 0) + count) }
  const declared = new Map<string, { version: string; kind: PackageUse['kind'] }>()
  for (const [kind, group] of [['peer', manifest?.peerDependencies], ['dev', manifest?.devDependencies], ['prod', manifest?.dependencies]] as const) {
    for (const [name, version] of Object.entries(group ?? {})) declared.set(name, { version, kind })
  }
  const packages: PackageUse[] = [...declared.entries()].map(([name, info]) => ({ name, version: info.version, kind: info.kind, files: usage.get(name) ?? 0 })).sort((a, b) => b.files - a.files || a.name.localeCompare(b.name))
  const clusterLabels = new Map(views.clusters.map(cluster => [cluster.id, cluster.label]))
  const fanIn = new Map<string, { clusters: number; weight: number }>(), fanOut = new Map<string, { clusters: number; weight: number }>()
  for (const link of views.links) {
    const into = fanIn.get(link.to) ?? { clusters: 0, weight: 0 }; into.clusters += 1; into.weight += link.weight; fanIn.set(link.to, into)
    const out = fanOut.get(link.from) ?? { clusters: 0, weight: 0 }; out.clusters += 1; out.weight += link.weight; fanOut.set(link.from, out)
  }
  const dependencies: HealthReport['dependencies'] = {
    manifest: !!manifest, packages,
    unused: packages.filter(item => item.kind === 'prod' && item.files === 0).map(item => item.name),
    undeclared: manifest ? [...usage.entries()].filter(([name]) => !declared.has(name) && !builtins.has(name)).map(([name, count]) => ({ name, files: count })).sort((a, b) => b.files - a.files) : [],
    links: views.links.slice(0, 12).map(link => ({ from: clusterLabels.get(link.from) ?? link.from, to: clusterLabels.get(link.to) ?? link.to, weight: link.weight })),
    foundations: views.clusters.map(cluster => ({ id: cluster.id, label: cluster.label, fanIn: fanIn.get(cluster.id)?.clusters ?? 0, inWeight: fanIn.get(cluster.id)?.weight ?? 0 })).filter(item => item.fanIn > 0).sort((a, b) => b.fanIn - a.fanIn || b.inWeight - a.inWeight).slice(0, 8),
    note: manifest ? '只读了根目录的 package.json；「未使用」指 TypeScript / JavaScript / Vue 源码里没有导入，只在配置文件、样式、命令行或构建脚本里用到的包会被误列；子包各自的 package.json 没有计入，子包里声明的依赖会出现在「未声明」里。' : '根目录没有 package.json，只能列出源码里导入了哪些外部包。',
  }
  if (!manifest) dependencies.packages = [...usage.entries()].filter(([name]) => !builtins.has(name)).map(([name, count]) => ({ name, version: '', kind: 'prod' as const, files: count })).sort((a, b) => b.files - a.files)

  // ── 聚类体检与难度 ──────────────────────────────────────
  const clusterFiles = new Map<string, GraphNode[]>()
  for (const node of files) { const id = views.clusterOf.get(node.id); if (!id) continue; const list = clusterFiles.get(id); if (list) list.push(node); else clusterFiles.set(id, [node]) }
  // 聚类的改动次数是其中各文件改动次数之和（一次提交改了同聚类的三个文件记三次），反映的是改动量而不是提交数。
  const churnOf = (id: string) => {
    let commits = 0, recent = 0, last = ''
    for (const node of clusterFiles.get(id) ?? []) { const churn = history.files.get(node.id); if (!churn) continue; commits += churn.commits; recent += churn.recent; if (churn.last > last) last = churn.last }
    return { commits, recent, last }
  }
  const maxRecent = Math.max(1, ...views.clusters.map(cluster => churnOf(cluster.id).recent))
  const maxFanIn = Math.max(1, ...views.clusters.map(cluster => fanIn.get(cluster.id)?.clusters ?? 0))
  const maxFanOut = Math.max(1, ...views.clusters.map(cluster => fanOut.get(cluster.id)?.clusters ?? 0))
  const clusters: ClusterHealth[] = views.clusters.map(cluster => {
    const members = clusterFiles.get(cluster.id) ?? []
    const memberIds = new Set(members.map(node => node.id))
    const totalLines = members.reduce((sum, node) => sum + node.endLine, 0)
    const inCycles = members.filter(node => cycleFiles.has(node.id)).length
    const testers = new Set(members.flatMap(node => [...(testedBy.get(node.id) ?? [])]))
    const big = bigSymbols.filter(node => memberIds.has(node.file)).length
    const churn = churnOf(cluster.id)
    const into = fanIn.get(cluster.id) ?? { clusters: 0, weight: 0 }, out = fanOut.get(cluster.id) ?? { clusters: 0, weight: 0 }
    const average = members.length ? totalLines / members.length : 0
    const factors = {
      fanIn: clamp(into.clusters / Math.max(4, maxFanIn)),
      fanOut: clamp(out.clusters / Math.max(4, maxFanOut)),
      size: clamp(members.length / 60),
      complexity: clamp(average / 400 * 0.6 + big / Math.max(4, members.length * 0.5) * 0.4),
      cycles: clamp(inCycles / Math.max(3, members.length * 0.3)),
      untested: testers.size ? 0 : 1,
      scattered: clamp(1 - cluster.cohesion),
      churn: history.available ? clamp(churn.recent / maxRecent) : 0,
    }
    const reason = (key: keyof typeof factors): string => ({
      fanIn: '被 ' + into.clusters + ' 个聚类依赖（外部引用 ' + into.weight + ' 处），改接口波及面大',
      fanOut: '依赖 ' + out.clusters + ' 个其他聚类（对外引用 ' + out.weight + ' 处），加功能要同时理解多块代码',
      size: members.length + ' 个文件、' + totalLines + ' 行，体量大',
      complexity: '平均每个文件 ' + Math.round(average) + ' 行' + (big ? '，有 ' + big + ' 个超过 ' + BIG_SYMBOL + ' 行的函数' : ''),
      cycles: inCycles + ' 个文件卷在循环导入里',
      untested: '没有测试文件直接引用它，改动缺少自动回归',
      scattered: '内聚度 ' + cluster.cohesion + '，一半以上的关系指向聚类外部',
      churn: '最近 90 天其中的文件被改动 ' + churn.recent + ' 次，正在频繁变化',
    })[key]
    const assess = (weights: Partial<Record<keyof typeof factors, number>>): Difficulty => {
      const parts = (Object.entries(weights) as [keyof typeof factors, number][]).map(([key, weight]) => ({ key, value: factors[key] * weight }))
      const total = Math.round(parts.reduce((sum, part) => sum + part.value, 0) * 100)
      // 整个项目都没有测试时，这一条对每个聚类都一样，区分不出谁更难：分数照算，原因里只在没有别的可说时才列。
      const notable = parts.filter(part => part.value >= 0.06).sort((a, b) => b.value - a.value)
      const specific = tests.length ? notable : notable.filter(part => part.key !== 'untested')
      return { score: total, level: grade(total), reasons: (specific.length ? specific : notable).slice(0, 3).map(part => reason(part.key)) }
    }
    return {
      id: cluster.id, label: cluster.label, files: members.length, symbols: cluster.symbols, lines: totalLines, cohesion: cluster.cohesion,
      fanIn: into.clusters, fanOut: out.clusters, inWeight: into.weight, outWeight: out.weight, cycleFiles: inCycles, testFiles: testers.size, bigSymbols: big,
      commits: churn.commits, recentCommits: churn.recent, ...(churn.last ? { lastChange: churn.last } : {}),
      // 优化（重构）难在「牵一发动全身」：被依赖多、有循环、体量大、没有测试兜底。
      refactor: assess({ fanIn: 0.3, cycles: 0.2, untested: 0.2, size: 0.15, complexity: 0.15 }),
      // 迭代（加功能）难在「要懂的东西多」：依赖面广、边界不清、函数长、正被频繁改动。
      extend: assess({ fanOut: 0.25, scattered: 0.2, complexity: 0.2, churn: 0.15, untested: 0.1, size: 0.1 }),
    }
  })

  // ── 迭代 ──────────────────────────────────────────────
  const recentWeeks = history.weeks.slice(-8), activeWeeks = recentWeeks.filter(week => week.commits > 0).length
  const perWeek = recentWeeks.length ? Math.round(recentWeeks.reduce((sum, week) => sum + week.commits, 0) / recentWeeks.length * 10) / 10 : 0
  const pace = !history.available ? '不是 Git 仓库，读不到提交历史。' : history.commits === 0 ? '最近 ' + history.months + ' 个月没有提交。'
    : '最近 ' + history.months + ' 个月 ' + history.commits + ' 次提交、' + history.authors + ' 位提交者；最近 8 周有 ' + activeWeeks + ' 周有提交，平均每周 ' + perWeek + ' 次，最近一次在 ' + day(history.last) + '。'
  const hotspots = [...history.files.entries()].filter(([file]) => { const node = index.nodes.get(file); return !!node && isFileNode(node) && !isTest(file) })
    .map(([file, churn]) => ({ file, commits: churn.commits, recent: churn.recent, lines: index.nodes.get(file)!.endLine, usedBy: fileIn.get(file) ?? 0, ...(views.clusterOf.get(file) ? { cluster: clusterLabels.get(views.clusterOf.get(file)!) } : {}) }))
    .sort((a, b) => b.commits * Math.log2(b.lines + 2) - a.commits * Math.log2(a.lines + 2)).slice(0, 15)
  const iteration: HealthReport['iteration'] = {
    available: history.available, months: history.months, commits: history.commits, authors: history.authors, ...(history.first ? { first: history.first } : {}), ...(history.last ? { last: history.last } : {}),
    weeks: history.weeks, types: history.types, pace, hotspots,
    clusters: clusters.map(cluster => ({ id: cluster.id, label: cluster.label, commits: cluster.commits, recent: cluster.recentCommits, ...(cluster.lastChange ? { last: cluster.lastChange } : {}) })).sort((a, b) => b.recent - a.recent || b.commits - a.commits),
    recent: history.recent.slice(0, 25).map(commit => ({ hash: commit.hash, date: commit.date, subject: commit.subject, type: commit.type, files: commit.files.length })),
    plans,
  }

  // ── 最值得先看的 ──────────────────────────────────────
  const highlights: HealthReport['highlights'] = []
  for (const finding of findings.filter(item => item.level === 'risk')) highlights.push({ level: 'risk', section: 'quality', text: finding.title + '：' + finding.value + '。' + finding.detail.split('。')[0] + '。' })
  if (dependencies.unused.length) highlights.push({ level: 'watch', section: 'dependencies', text: dependencies.unused.length + ' 个声明的依赖在源码里没有导入：' + dependencies.unused.slice(0, 5).join('、') + (dependencies.unused.length > 5 ? ' 等' : '') + '。' })
  if (dependencies.undeclared.length) highlights.push({ level: 'watch', section: 'dependencies', text: dependencies.undeclared.length + ' 个导入的包没有在根目录 package.json 里声明：' + dependencies.undeclared.slice(0, 5).map(item => item.name).join('、') + (dependencies.undeclared.length > 5 ? ' 等' : '') + '。' })
  const hardest = [...clusters].sort((a, b) => b.refactor.score - a.refactor.score)[0]
  if (hardest && hardest.refactor.level !== '低') highlights.push({ level: hardest.refactor.level === '高' ? 'risk' : 'watch', section: 'difficulty', text: '最难动的聚类是「' + hardest.label + '」（优化难度' + hardest.refactor.level + '）：' + hardest.refactor.reasons.slice(0, 2).join('；') + '。' })
  const hottest = hotspots[0]
  if (hottest && hottest.commits >= 5) highlights.push({ level: 'watch', section: 'iteration', text: '改动最频繁的文件是 ' + hottest.file + '：' + hottest.commits + ' 次提交、' + hottest.lines + ' 行' + (hottest.usedBy ? '、被 ' + hottest.usedBy + ' 处引用' : '') + '。' })
  for (const finding of findings.filter(item => item.level === 'watch' && item.penalty >= 5)) highlights.push({ level: 'watch', section: 'quality', text: finding.title + '：' + finding.value + '。' })

  const routes = graph.routes ?? []
  return {
    schemaVersion: 1, root: graph.root, commit: graph.commit, builtAt: graph.builtAt,
    scale: { files: files.length, symbols: graph.stats.symbols, lines, languages: graph.stats.languages, clusters: views.clusters.length, scatteredFiles: views.scattered, pages: routes.filter(route => route.kind === 'page').length, apis: routes.filter(route => route.kind === 'api').length, entries: views.entries.size, testFiles: tests.length, relations: graph.stats.edges, inferredRelations: graph.stats.inferredEdges },
    quality, dependencies, iteration,
    difficulty: { note: '难度是按结构与提交记录估算的相对值，用来排先后，不是工时。优化难度看「牵一发动全身」的程度：被多少聚类依赖、有没有循环导入、有没有测试兜底、体量与函数长度；迭代难度看「加功能要懂多少东西」：依赖面、边界是否清楚、函数长度、最近是否在频繁改动。' + (tests.length ? '' : '项目没有测试，所有聚类的难度都因此上调了一档左右；下面的原因只列各聚类自己的特点。'), clusters },
    highlights: highlights.slice(0, 8),
  }
}
