import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { headCommit, workingChanges } from './git.ts'
import { GraphEngine } from './graph/engine.ts'
import { clusterDetail, clusterList, clusterOfNode, cycleList, flowDetail, flowList, routeList, traceResult } from './graph/present.ts'
import { brief, changedSymbols, context, impact, overview, resolveReference, search, type GraphIndex } from './graph/query.ts'
import type { Host, SkillRegistry, StudioTask } from './host.ts'
import { checkPlan, parsePlan, renderPlan, validatePlan, type SavedPlan } from './plan.ts'
import { exists, inspectProject, object, text } from './project.ts'
import { principlesSummary, taskLabels, taskMethods, taskPrompt, workspaceInstructions, type TaskKind } from './prompt.ts'
import { loadSkills, skillProvider } from './skills.ts'
import type { GraphNode } from './types.ts'

/** 插件注册名与安装包一致。 */
export const name = 'dsh-studio-engineering'
/** 页面托管、工具与系统提示词由宿主提供；技能注册表可选，在子插件里按需注入。 */
export const inject = ['studioProjects', 'tools', 'systemPrompt']
/** 构建时注入的 studio.json 声明；tasks 是输入框 @ 候选里的快捷任务。 */
declare const STUDIO_PROJECT: { name: string; icon: string; description: string; tasks?: StudioTask[] }

interface Settings {
  schemaVersion: 1
  /** 是否把编码准则摘要写进常驻系统提示词 */
  principles: boolean
}

const tasks = Object.keys(taskLabels) as TaskKind[]
const graphActions = ['overview', 'search', 'context', 'impact', 'changes', 'clusters', 'flows', 'trace', 'routes', 'cycles', 'rebuild'] as const
const json = (value: object) => JSON.stringify(value)

/** 注册研发工作室的工具、技能、系统提示词与页面；任务始终使用执行会话自己的目录。 */
export async function apply(ctx: Host): Promise<void> {
  const home = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'studio/engineering')
  const engine = new GraphEngine(join(home, 'graphs'))
  const lifetime = new AbortController()
  const skills = await loadSkills(fileURLToPath(new URL('../skills/', import.meta.url)))
  const methods = (names: string[]) => names.flatMap(name => { const skill = skills.find(item => item.name === name); return skill ? [{ name, content: skill.content }] : [] })

  const settingsPath = join(home, 'settings.json')
  let settings: Settings = { schemaVersion: 1, principles: true }
  try { const saved = object(JSON.parse(await readFile(settingsPath, 'utf8'))); if (saved.schemaVersion === 1) settings = { schemaVersion: 1, principles: saved.principles !== false } } catch { /* 首次运行使用默认设置 */ }

  ctx.effect(() => () => lifetime.abort(), '研发工作室：结束在途的建图')
  // 系统提示词段随设置重新登记：关闭常驻准则后只保留调用指引。
  let disposePrompt = () => {}
  const registerPrompt = () => {
    disposePrompt()
    disposePrompt = ctx.systemPrompt.section({ name: 'studio-engineering-workspace', order: 925, interpolate: false, text: workspaceInstructions + (settings.principles ? principlesSummary : '') })
  }
  ctx.effect(() => { registerPrompt(); return () => disposePrompt() }, '研发工作室：调用指引与编码准则')

  // 技能注册表不是每种宿主组合都有：放进子插件，注册表可用时才登记，缺失时其余功能不受影响。
  try {
    ctx.plugin({ name: name + '-skills', inject: ['skills'], apply(sub: { skills: SkillRegistry; effect: Host['effect'] }) { sub.effect(() => sub.skills.registerProvider(() => skillProvider(skills)), '研发工作室：内置技能') } })
  } catch { /* 宿主不支持子插件时跳过；任务提示词里已内联所需方法 */ }

  /** 取执行会话的工作区；没有工作区时要求用户先打开项目会话。 */
  const workspace = (execution: { agent?: { session: { header: { cwd?: string } } } }) => {
    const root = execution.agent?.session.header.cwd
    if (!root) throw new Error('请先在 dsh 工作区打开项目会话，再 @研发工作室')
    return root
  }
  const ensure = (root: string, signal: AbortSignal, force = false) => engine.ensure(root, { signal: AbortSignal.any([signal, lifetime.signal]), force })
  /** 把引用解析成节点；解析不到时返回给模型看的说明，不抛错。 */
  const locate = (index: GraphIndex, reference: string): { node: GraphNode } | { problem: object } => {
    const resolution = resolveReference(index, reference)
    if ('node' in resolution) return { node: resolution.node }
    if ('candidates' in resolution) return { problem: { reference, issue: '有多个同名目标，请改用完整的「路径#符号」', candidates: resolution.candidates } }
    return { problem: { reference, issue: '图谱里没有找到', suggestions: resolution.suggestions } }
  }
  const graphBrief = (index: GraphIndex) => ({ commit: index.graph.commit, builtAt: index.graph.builtAt, stats: index.graph.stats })

  ctx.effect(() => ctx.tools.register({
    name: 'eng_workspace',
    description: '准备当前会话的研发任务：读取实际工作区与项目约定，同步代码知识图谱，返回该任务的内置流程与所用方法。graph 建立或刷新图谱并给出项目概览；analyze 根据需求文档产出迭代方案（功能点、步骤、影响范围、参数与方法设计）；impact 分析改动影响；implement 按迭代方案实现；review 评审改动。',
    parameters: { type: 'object', properties: { task: { type: 'string', enum: tasks }, request: { type: 'string', maxLength: 20000, description: '用户需求原文；analyze 时可以是需求文档路径或正文' } }, required: ['task', 'request'], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(input, execution) {
      const args = object(input), task = text(args.task, 32) as TaskKind
      if (!tasks.includes(task)) throw new Error('未知研发任务')
      const project = await inspectProject(workspace(execution))
      const { index, freshness } = await ensure(project.root, execution.signal)
      execution.signal.throwIfAborted()
      return json({ ready: true, root: project.root, graph: { ...graphBrief(index), freshness }, ...(task === 'graph' ? { overview: overview(index) } : {}), instructions: taskPrompt(task, project, text(args.request, 20000)), methods: methods(taskMethods[task]) })
    },
    presentCall(input) { return { card: 'generic', title: '研发工作室 · ' + (taskLabels[String(object(input).task) as TaskKind] ?? '准备工作区'), kind: 'read', rawInput: input } },
  }), '研发工作室：当前会话任务工具')

  ctx.effect(() => ctx.tools.register({
    name: 'eng_graph',
    description: '查询当前项目的代码知识图谱（TypeScript / JavaScript / Vue），每次调用自动同步最新代码。overview：项目规模、模块与依赖、被使用最多的符号、入口；search：按名字、路径或用途找符号（query）；context：一个符号或文件的签名、成员、谁在用它、它用了谁（target）；impact：改动若干目标会波及哪里，按直接 / 间接 / 需回归分级并给出风险（targets）；changes：把 Git 改动对应到符号并计算影响面（base 缺省为 HEAD，即工作区未提交的改动）；clusters：按调用关系自动划分的功能聚类及其相互依赖，带 target 时返回目标所在聚类的全部文件（target 也可以直接写聚类 ID，如 c3）；flows：从页面、路由与入口出发的执行流程，带 target 时只列经过它的流程，target 是某条流程的入口文件时返回逐步明细，query 按名称或路由过滤；trace：从 from 到 to 的最短调用路径（A 怎样调用到 B）；routes：框架约定的页面与接口路由（uni-app 的 pages.json、Nuxt 的 pages 与 server 目录），query 过滤；cycles：文件之间的循环导入；rebuild：丢弃缓存全量重建。目标写「路径#符号」、文件路径或符号名；同名时返回候选。',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: [...graphActions] },
      query: { type: 'string', maxLength: 200, description: 'search：关键词；flows / routes：按名称、路由或文件过滤' },
      target: { type: 'string', maxLength: 600, description: 'context / clusters / flows：路径#符号、文件路径、符号名或聚类 ID' },
      from: { type: 'string', maxLength: 600, description: 'trace：起点' },
      to: { type: 'string', maxLength: 600, description: 'trace：终点' },
      targets: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 600 }, description: 'impact：要改动的目标' },
      depth: { type: 'integer', minimum: 1, maximum: 6, description: 'impact / changes：遍历深度，默认 3' },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: '每类结果最多返回多少条（impact 默认 40）；summary 里的数量大于列表长度时说明被截断，可调大后重查' },
      base: { type: 'string', maxLength: 200, description: 'changes：比较基准，分支名或提交，默认 HEAD' },
    }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(input, execution) {
      const args = object(input), action = text(args.action, 32) as typeof graphActions[number]
      if (!graphActions.includes(action)) throw new Error('未知图谱操作')
      const root = workspace(execution)
      const { index, freshness } = await ensure(root, execution.signal, action === 'rebuild')
      execution.signal.throwIfAborted()
      const limit = typeof args.limit === 'number' ? args.limit : undefined, depth = typeof args.depth === 'number' ? args.depth : undefined
      if (action === 'overview' || action === 'rebuild') return json({ freshness, ...overview(index) })
      if (action === 'search') return json({ freshness, ...search(index, text(args.query, 200), limit ?? 20) })
      if (action === 'context') {
        const found = locate(index, text(args.target, 600))
        return json('problem' in found ? { freshness, ...found.problem } : { freshness, ...context(index, found.node, limit ?? 30) })
      }
      if (action === 'clusters') {
        if (args.target === undefined) return json({ freshness, ...clusterList(index, limit ?? 30) })
        const reference = text(args.target, 600)
        if (/^c\d+$/.test(reference)) return json({ freshness, ...(clusterDetail(index, reference, limit ?? 200) ?? { issue: '没有这个聚类' }) })
        const found = locate(index, reference)
        if ('problem' in found) return json({ freshness, ...found.problem })
        const cluster = clusterOfNode(index, found.node)
        return json(cluster ? { freshness, target: found.node.id, ...clusterDetail(index, cluster, limit ?? 200) } : { freshness, target: found.node.id, issue: '目标所在文件与其他文件关系很少，没有归入任何聚类' })
      }
      if (action === 'flows') {
        const query = args.query === undefined ? undefined : text(args.query, 200)
        if (args.target === undefined) return json({ freshness, ...flowList(index, { query, limit: limit ?? 30 }) })
        const found = locate(index, text(args.target, 600))
        if ('problem' in found) return json({ freshness, ...found.problem })
        const detail = flowDetail(index, found.node.file === found.node.id ? found.node.id : '')
        return json(detail ? { freshness, ...detail } : { freshness, through: found.node.id, ...flowList(index, { through: found.node, query, limit: limit ?? 30 }) })
      }
      if (action === 'trace') {
        const from = locate(index, text(args.from, 600)), to = locate(index, text(args.to, 600))
        const problems = [from, to].flatMap(item => 'problem' in item ? [item.problem] : [])
        if (problems.length) return json({ freshness, issue: '起点或终点无法确定，请修正后重试', problems })
        return json({ freshness, ...traceResult(index, (from as { node: GraphNode }).node, (to as { node: GraphNode }).node) })
      }
      if (action === 'routes') return json({ freshness, ...routeList(index, { query: args.query === undefined ? undefined : text(args.query, 200), limit: limit ?? 100 }) })
      if (action === 'cycles') return json({ freshness, ...cycleList(index, limit ?? 20) })
      if (action === 'impact') {
        if (!Array.isArray(args.targets) || !args.targets.length) throw new Error('impact 需要 targets')
        const found = args.targets.map(item => locate(index, text(item, 600)))
        const problems = found.flatMap(item => 'problem' in item ? [item.problem] : [])
        if (problems.length) return json({ freshness, issue: '有目标无法确定，请修正后重试', problems })
        return json({ freshness, ...impact(index, found.flatMap(item => 'node' in item ? [item.node] : []), { depth, limit }) })
      }
      const changes = await workingChanges(root, args.base === undefined ? 'HEAD' : text(args.base, 200), execution.signal)
      if (!changes) return json({ freshness, issue: '当前目录不是 Git 仓库，或比较基准不存在，无法读取改动' })
      const mapped = changedSymbols(index, changes)
      return json({ freshness, changedFiles: changes.length, symbols: mapped.symbols.map(node => brief(index, node)), deletedFiles: mapped.deleted, outsideGraph: mapped.outside.slice(0, 60), impact: mapped.symbols.length ? impact(index, mapped.symbols, { depth, limit }) : undefined })
    },
    presentCall(input) { const args = object(input); const labels: Record<string, string> = { overview: '项目概览', search: '搜索符号', context: '查看上下文', impact: '影响分析', changes: '分析当前改动', clusters: '功能聚类', flows: '执行流程', trace: '路径追踪', routes: '路由表', cycles: '循环依赖', rebuild: '重建图谱' }; return { card: 'generic', title: '研发工作室 · ' + (labels[String(args.action)] ?? '查询图谱'), kind: 'read', rawInput: input } },
  }), '研发工作室：图谱查询工具')

  ctx.effect(() => ctx.tools.register({
    name: 'eng_plan',
    description: '迭代方案的提交与核对。submit：提交结构化方案（功能点、代码改动与接口设计、步骤、待确认项），工具对照图谱核对修改与删除的目标是否真实存在、功能点与步骤是否互相覆盖，通过后生成 docs/iterations/<slug>/iteration.md（影响范围一章由图谱计算）与 iteration.json；返回 issues 时改正后重新提交。check：实施后核对方案是否落地、签名是否与设计一致、有没有计划外改动、签名变化的直接调用方是否跟着改，报告写入 check-report.json。',
    parameters: { type: 'object', properties: { stage: { type: 'string', enum: ['submit', 'check'] }, plan: { type: 'object', description: 'submit：方案内容，字段见 eng_workspace(task=analyze) 返回的说明' }, slug: { type: 'string', maxLength: 64, description: 'check：方案目录名' } }, required: ['stage'], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(input, execution) {
      const args = object(input), root = workspace(execution)
      const onDisk = (path: string) => exists(join(root, path))
      if (args.stage === 'submit') {
        const plan = parsePlan(args.plan)
        const { index } = await ensure(root, execution.signal)
        const validation = await validatePlan(index, plan, onDisk)
        if (validation.issues.length) return json({ ok: false, issues: validation.issues, warnings: validation.warnings, instructions: '方案没有保存。逐条改正 issues 后重新提交完整的 plan；目标找不到时先用 eng_graph 的 search 或 context 确认，不要改成一个猜测的名字。' })
        const createdAt = new Date().toISOString(), baseCommit = await headCommit(root, execution.signal)
        const directory = join(root, 'docs/iterations', plan.slug)
        const saved: SavedPlan = { schemaVersion: 1, createdAt, baseCommit, plan, currentSignatures: Object.fromEntries(validation.resolved.flatMap(item => item.node?.signature ? [[item.change.target, item.node.signature]] : [])) }
        execution.signal.throwIfAborted()
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, 'iteration.md'), renderPlan(plan, validation.resolved, { commit: index.graph.commit, createdAt }))
        await writeFile(join(directory, 'iteration.json'), JSON.stringify(saved, null, 2) + '\n')
        return json({ ok: true, document: 'docs/iterations/' + plan.slug + '/iteration.md', features: plan.features.length, changes: plan.changes.length, steps: plan.steps.length, warnings: validation.warnings,
          impact: validation.resolved.flatMap(item => item.impact ? [{ target: item.change.target, risk: item.impact.risk, direct: item.impact.summary.direct, indirect: item.impact.summary.indirect, tests: item.impact.summary.tests.length }] : []) })
      }
      if (args.stage === 'check') {
        const slug = text(args.slug, 64)
        if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)) throw new Error('slug 格式无效')
        const directory = join(root, 'docs/iterations', slug)
        let saved: SavedPlan
        try { saved = JSON.parse(await readFile(join(directory, 'iteration.json'), 'utf8')) as SavedPlan } catch { throw new Error('找不到 docs/iterations/' + slug + '/iteration.json，请先用 stage=submit 提交方案') }
        if (saved.schemaVersion !== 1) throw new Error('方案文件版本不受支持')
        const { index } = await ensure(root, execution.signal)
        const changes = saved.baseCommit ? await workingChanges(root, saved.baseCommit, execution.signal) : undefined
        const report = await checkPlan(index, saved, changes, onDisk)
        await writeFile(join(directory, 'check-report.json'), JSON.stringify({ checkedAt: new Date().toISOString(), commit: index.graph.commit, ...report }, null, 2) + '\n')
        return json({ ...report, report: 'docs/iterations/' + slug + '/check-report.json' })
      }
      throw new Error('未知方案阶段')
    },
    presentCall(input) { const args = object(input); return { card: 'generic', title: '研发工作室 · ' + (args.stage === 'check' ? '核对方案落地' : '提交迭代方案'), kind: args.stage === 'check' ? 'read' : 'edit', rawInput: input } },
  }), '研发工作室：迭代方案工具')

  /** 页面操作：只对已建过图的项目做查询；建图需要用户填写绝对路径。 */
  const snapshot = async () => ({ graphs: await engine.list(), skills: skills.map(skill => ({ name: skill.name, description: skill.description })), tasks: STUDIO_PROJECT.tasks ?? [], instructions: workspaceInstructions, principles: principlesSummary, settings })
  const dispatch = async (input: Record<string, unknown>): Promise<object> => {
    const action = text(input.action, 32)
    if (action === 'snapshot') return snapshot()
    if (action === 'configure') {
      settings = { schemaVersion: 1, principles: object(input.settings).principles !== false }
      await mkdir(home, { recursive: true })
      await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n')
      registerPrompt()
      return snapshot()
    }
    if (action === 'skill') {
      const skill = skills.find(item => item.name === text(input.name, 64))
      if (!skill) throw new Error('没有这个技能')
      return { name: skill.name, description: skill.description, content: skill.content }
    }
    const root = text(input.root, 2048)
    if (!isAbsolute(root)) throw new Error('请填写项目的绝对路径')
    if (action === 'remove') { await engine.remove(root); return snapshot() }
    if (action !== 'build' && !(await engine.list()).some(meta => meta.root === root)) throw new Error('这个项目还没有建过图谱')
    const { index, freshness } = await engine.ensure(root, { signal: lifetime.signal, force: action === 'rebuild' })
    if (action === 'build' || action === 'rebuild' || action === 'overview') return { freshness, overview: overview(index) }
    if (action === 'search') return { freshness, ...search(index, text(input.query, 200), 30) }
    if (action === 'views') return { clusters: clusterList(index, 40), flows: flowList(index, { limit: 400 }), routes: routeList(index, { limit: 1000 }), cycles: cycleList(index, 50) }
    if (action === 'cluster') { const detail = clusterDetail(index, text(input.id, 16)); if (!detail) throw new Error('没有这个聚类'); return detail }
    if (action === 'flow') { const detail = flowDetail(index, text(input.id, 2048)); if (!detail) throw new Error('没有这条流程'); return detail }
    if (action === 'trace') {
      const from = locate(index, text(input.from, 600)), to = locate(index, text(input.to, 600))
      if ('problem' in from) return from.problem
      if ('problem' in to) return to.problem
      return traceResult(index, from.node, to.node)
    }
    if (action === 'context' || action === 'impact') {
      const found = locate(index, text(input.target, 600))
      if ('problem' in found) return found.problem
      return action === 'context' ? context(index, found.node, 40) : impact(index, [found.node], { limit: 60 })
    }
    throw new Error('未知工作室操作')
  }
  const send = (res: ServerResponse, status: number, value: object) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    res.end(JSON.stringify(value))
  }
  ctx.effect(() => ctx.studioProjects.register({ id: 'engineering', ...STUDIO_PROJECT, root: fileURLToPath(new URL('../static/', import.meta.url)), async handle(req: IncomingMessage, res, path) {
    if (path !== 'api') return false
    try {
      if (req.method === 'GET') { send(res, 200, await snapshot()); return true }
      if (req.method !== 'POST') { send(res, 405, { error: '仅支持 GET 与 POST' }); return true }
      if (req.headers['sec-fetch-site'] === 'cross-site' || req.headers['content-type']?.split(';')[0] !== 'application/json') { send(res, 403, { error: '请求来源或格式无效' }); return true }
      let size = 0
      const chunks: Buffer[] = []
      for await (const chunk of req) { size += chunk.length; if (size > 64_000) { send(res, 413, { error: '请求内容过大' }); return true }; chunks.push(chunk) }
      send(res, 200, await dispatch(object(JSON.parse(Buffer.concat(chunks).toString('utf8')))))
    } catch (error) { send(res, 400, { error: error instanceof Error ? error.message : '工作室操作失败，请查看 dsh 日志' }) }
    return true
  } }), '研发工作室：登记独立页面')
}
