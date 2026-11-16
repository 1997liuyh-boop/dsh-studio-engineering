import type { FileChange } from './git.ts'
import { impact, resolveReference, type GraphIndex, type ImpactReport } from './graph/query.ts'
import type { GraphNode } from './types.ts'

/** 功能点：需求文档里一条可独立验收的要求。 */
export interface Feature {
  id: string
  title: string
  description: string
  kind: 'new' | 'change' | 'remove'
  /** 验收标准，每条都要能判定通过与否 */
  acceptance: string[]
  /** 对应的需求文档章节或原文摘录 */
  source: string
}

export interface Param {
  name: string
  type: string
  required: boolean
  defaultValue: string
  description: string
}

/** 一处代码改动及其接口设计。 */
export interface Change {
  feature: string
  /** 「路径#符号」或文件路径 */
  target: string
  action: 'add' | 'modify' | 'remove'
  summary: string
  /** 改动后的签名；modify 时省略表示签名不变 */
  signature: string
  params: Param[]
  returns: string
  events: { name: string; payload: string; description: string }[]
  slots: { name: string; description: string }[]
  /** 对现有调用方的兼容性说明 */
  compatibility: string
}

export interface Step {
  id: string
  title: string
  features: string[]
  files: string[]
  detail: string
  /** 验证方式：命令或可观察的检查 */
  verify: string
  dependsOn: string[]
}

export interface Plan {
  slug: string
  title: string
  /** 需求来源：文档路径或「对话」 */
  source: string
  summary: string
  features: Feature[]
  changes: Change[]
  steps: Step[]
  openQuestions: string[]
}

/** 落盘的方案：计划本身加提交时的基准，实施后据此核对。 */
export interface SavedPlan {
  schemaVersion: 1
  createdAt: string
  /** 提交方案时的 HEAD，实施核对以它为基准比较改动 */
  baseCommit: string
  plan: Plan
  /** 提交时图谱里的现有签名：改动目标 → 签名 */
  currentSignatures: Record<string, string>
}

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' 必须是对象')
  return value as Record<string, unknown>
}
const string = (value: unknown, label: string, max = 4000, required = true): string => {
  if (value === undefined || value === null) { if (required) throw new Error(label + ' 不能为空'); return '' }
  if (typeof value !== 'string' || value.length > max) throw new Error(label + ' 必须是不超过 ' + max + ' 字的文字')
  if (required && !value.trim()) throw new Error(label + ' 不能为空')
  return value.trim()
}
const list = <T>(value: unknown, label: string, max: number, map: (item: unknown, label: string) => T, required = true): T[] => {
  if (value === undefined && !required) return []
  if (!Array.isArray(value) || value.length > max) throw new Error(label + ' 必须是不超过 ' + max + ' 项的数组')
  return value.map((item, position) => map(item, label + '[' + position + ']'))
}
const choice = <T extends string>(value: unknown, label: string, options: readonly T[]): T => {
  if (typeof value !== 'string' || !options.includes(value as T)) throw new Error(label + ' 只能是 ' + options.join(' / '))
  return value as T
}
/** 路径统一为正斜杠的相对路径，拒绝绝对路径与跳出项目的写法。 */
const path = (value: string, label: string) => {
  const clean = value.replaceAll('\\', '/').replace(/^\.\//, '')
  if (/^([A-Za-z]:|\/)/.test(clean) || clean.split('/').includes('..')) throw new Error(label + ' 必须是项目内的相对路径')
  return clean
}

/**
 * 校验模型提交的方案结构，补齐可省略的字段。结构不对直接抛错，内容上的问题由 validatePlan 汇总。
 * @param input 工具入参里的 plan。
 */
export function parsePlan(input: unknown): Plan {
  const value = record(input, 'plan')
  const slug = string(value.slug, 'slug', 64)
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)) throw new Error('slug 只能用小写字母、数字和连字符，例如 2026-11-order-export')
  return {
    slug, title: string(value.title, 'title', 200), source: string(value.source, 'source', 500, false) || '对话', summary: string(value.summary, 'summary', 2000, false),
    features: list(value.features, 'features', 50, (item, label) => {
      const row = record(item, label)
      return { id: string(row.id, label + '.id', 16), title: string(row.title, label + '.title', 200), description: string(row.description, label + '.description', 2000, false), kind: choice(row.kind, label + '.kind', ['new', 'change', 'remove'] as const),
        acceptance: list(row.acceptance, label + '.acceptance', 20, (entry, name) => string(entry, name, 500)), source: string(row.source, label + '.source', 1000, false) }
    }),
    changes: list(value.changes, 'changes', 200, (item, label) => {
      const row = record(item, label)
      const target = string(row.target, label + '.target', 600)
      const hash = target.indexOf('#')
      return { feature: string(row.feature, label + '.feature', 16), target: path(hash < 0 ? target : target.slice(0, hash), label + '.target') + (hash < 0 ? '' : target.slice(hash)), action: choice(row.action, label + '.action', ['add', 'modify', 'remove'] as const),
        summary: string(row.summary, label + '.summary', 1000), signature: string(row.signature, label + '.signature', 2000, false),
        params: list(row.params, label + '.params', 40, (entry, name) => { const param = record(entry, name); return { name: string(param.name, name + '.name', 100), type: string(param.type, name + '.type', 500), required: param.required !== false, defaultValue: string(param.default ?? param.defaultValue, name + '.default', 200, false), description: string(param.description, name + '.description', 500) } }, false),
        returns: string(row.returns, label + '.returns', 500, false),
        events: list(row.events, label + '.events', 30, (entry, name) => { const event = record(entry, name); return { name: string(event.name, name + '.name', 100), payload: string(event.payload, name + '.payload', 500, false), description: string(event.description, name + '.description', 500, false) } }, false),
        slots: list(row.slots, label + '.slots', 30, (entry, name) => { const slot = record(entry, name); return { name: string(slot.name, name + '.name', 100), description: string(slot.description, name + '.description', 500, false) } }, false),
        compatibility: string(row.compatibility, label + '.compatibility', 1000, false) }
    }),
    steps: list(value.steps, 'steps', 60, (item, label) => {
      const row = record(item, label)
      return { id: string(row.id, label + '.id', 16), title: string(row.title, label + '.title', 200), features: list(row.features, label + '.features', 50, (entry, name) => string(entry, name, 16)),
        files: list(row.files, label + '.files', 80, (entry, name) => path(string(entry, name, 600), name)), detail: string(row.detail, label + '.detail', 4000), verify: string(row.verify, label + '.verify', 1000), dependsOn: list(row.dependsOn, label + '.dependsOn', 20, (entry, name) => string(entry, name, 16), false) }
    }),
    openQuestions: list(value.openQuestions, 'openQuestions', 30, (entry, name) => string(entry, name, 500), false),
  }
}

const fileOf = (target: string) => target.includes('#') ? target.slice(0, target.indexOf('#')) : target
/** 比较签名时忽略空白、分号与导出关键字。 */
const normalizeSignature = (text: string) => text.replace(/\b(export|default|declare)\b/g, '').replace(/[\s;]+/g, '')

/** 一处改动在图谱里的解析结果。 */
export interface ResolvedChange {
  change: Change
  /** 现有节点；新增或图谱外的文件为空 */
  node?: GraphNode
  /** 影响面；只对已有节点的修改与删除计算 */
  impact?: ImpactReport
}

export interface Validation {
  issues: string[]
  warnings: string[]
  resolved: ResolvedChange[]
}

/**
 * 对照图谱核对方案：修改与删除的目标必须真实存在，新增的目标不能已经存在；功能点、改动、步骤之间要互相覆盖。
 * 有 issues 时方案不落盘，模型按提示改正后重新提交。
 * @param index 图谱索引。
 * @param plan 已通过结构校验的方案。
 * @param exists 判断项目内某个相对路径在磁盘上是否存在（图谱只含源码，配置与文档等要查磁盘）。
 */
export async function validatePlan(index: GraphIndex, plan: Plan, exists: (path: string) => Promise<boolean>): Promise<Validation> {
  const issues: string[] = [], warnings: string[] = [], resolved: ResolvedChange[] = []
  const unique = (ids: string[], label: string) => { for (const id of new Set(ids.filter((id, position) => ids.indexOf(id) !== position))) issues.push(label + ' ' + id + ' 重复') }
  unique(plan.features.map(feature => feature.id), '功能点编号')
  unique(plan.steps.map(step => step.id), '步骤编号')
  const featureIds = new Set(plan.features.map(feature => feature.id)), stepIds = new Set(plan.steps.map(step => step.id))
  if (!plan.features.length) issues.push('至少要有一个功能点')
  for (const feature of plan.features) {
    if (!feature.acceptance.length) issues.push('功能点 ' + feature.id + ' 没有验收标准')
    if (!plan.changes.some(change => change.feature === feature.id)) issues.push('功能点 ' + feature.id + ' 没有对应的代码改动（changes）')
    if (!plan.steps.some(step => step.features.includes(feature.id))) issues.push('功能点 ' + feature.id + ' 没有出现在任何步骤里')
  }
  const stepFiles = new Set(plan.steps.flatMap(step => step.files))
  for (const change of plan.changes) {
    const label = '改动 ' + change.target
    if (!featureIds.has(change.feature)) issues.push(label + ' 引用了不存在的功能点 ' + change.feature)
    const file = fileOf(change.target), symbol = change.target.includes('#')
    if (!stepFiles.has(file)) issues.push(label + ' 所在文件没有出现在任何步骤的 files 里')
    const resolution = resolveReference(index, change.target)
    const node = 'node' in resolution && resolution.node.file === file ? resolution.node : undefined
    if (change.action === 'add') {
      if (node && symbol) issues.push(label + ' 已经存在（' + node.file + ':' + node.line + '），应改为 modify 或换一个名字')
      else if (!symbol && (index.nodes.has(file) || await exists(file))) issues.push(label + ' 文件已存在，应改为 modify')
      if (symbol && !change.signature) issues.push(label + ' 是新增符号，必须给出 signature')
      resolved.push({ change })
      continue
    }
    if (node) {
      if (change.action === 'modify' && change.signature && node.signature && normalizeSignature(change.signature) === normalizeSignature(node.signature)) warnings.push(label + ' 的 signature 与现有签名相同；签名不变时可以省略该字段')
      resolved.push({ change, node, impact: impact(index, [node]) })
    } else if ('candidates' in resolution) {
      issues.push(label + ' 不唯一，请写成完整的「路径#符号」：' + resolution.candidates.map(item => item.id).join('、'))
      resolved.push({ change })
    } else if (!symbol && await exists(file)) {
      // 配置、样式、文档等不在图谱里的文件：存在即可，没有符号级影响面。
      resolved.push({ change })
    } else {
      const suggestions = 'missing' in resolution ? resolution.suggestions : []
      issues.push(label + ' 在项目里找不到' + (suggestions.length ? '，相近的有：' + suggestions.join('、') : '') + '。修改或删除的目标必须是现有代码，先用 eng_graph 的 search 确认')
      resolved.push({ change })
    }
    for (const param of change.params) if (change.signature && !change.signature.includes(param.name)) warnings.push(label + ' 的参数 ' + param.name + ' 没有出现在 signature 里')
  }
  for (const step of plan.steps) {
    for (const id of step.features) if (!featureIds.has(id)) issues.push('步骤 ' + step.id + ' 引用了不存在的功能点 ' + id)
    for (const id of step.dependsOn) if (!stepIds.has(id) || id === step.id) issues.push('步骤 ' + step.id + ' 的依赖 ' + id + ' 无效')
    if (!step.files.length) issues.push('步骤 ' + step.id + ' 没有列出要改的文件')
  }
  // 依赖成环：沿 dependsOn 深度优先，回到正在访问的步骤即成环。
  const state = new Map<string, 1 | 2>()
  const visit = (id: string): boolean => {
    if (state.get(id) === 2) return false
    if (state.get(id) === 1) return true
    state.set(id, 1)
    const cyclic = (plan.steps.find(step => step.id === id)?.dependsOn ?? []).some(next => stepIds.has(next) && visit(next))
    state.set(id, 2)
    return cyclic
  }
  if (plan.steps.some(step => visit(step.id))) issues.push('步骤之间的依赖成环，请调整 dependsOn')
  return { issues, warnings, resolved }
}

const actionLabels = { add: '新增', modify: '修改', remove: '删除' } as const
const kindLabels = { new: '新增', change: '修改', remove: '下线' } as const
const riskLabels = { LOW: '低', MEDIUM: '中', HIGH: '高' } as const
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n+/g, '<br>')
const code = (text: string) => '```ts\n' + text + '\n```'

/**
 * 把方案渲染成给人看的文档。影响范围一章由图谱计算，不采用模型自己写的内容。
 * @param plan 方案。
 * @param resolved 各处改动的解析结果与影响面。
 * @param meta 图谱提交与生成时间。
 */
export function renderPlan(plan: Plan, resolved: ResolvedChange[], meta: { commit: string; createdAt: string }): string {
  const impacts = resolved.filter(item => item.impact)
  const order = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const
  const overall = impacts.reduce<'LOW' | 'MEDIUM' | 'HIGH'>((worst, item) => order[item.impact!.risk] > order[worst] ? item.impact!.risk : worst, 'LOW')
  const lines: string[] = [
    '# ' + plan.title, '',
    '> 需求来源：' + plan.source + '　|　生成时间：' + meta.createdAt.slice(0, 16).replace('T', ' ') + '　|　图谱基准：' + (meta.commit ? meta.commit.slice(0, 8) : '非 Git 目录') + '　|　总体风险：' + riskLabels[overall],
    '>', '> 本文档由研发工作室根据提交的方案与代码图谱生成；「影响范围」一章来自图谱计算。修改方案请重新提交，不要直接编辑本文件。', '',
    ...(plan.summary ? [plan.summary, ''] : []),
    '## 一、功能点', '', '| 编号 | 功能点 | 类型 | 验收标准 |', '|---|---|---|---|',
    ...plan.features.map(feature => '| ' + feature.id + ' | ' + cell(feature.title) + ' | ' + kindLabels[feature.kind] + ' | ' + cell(feature.acceptance.map((item, position) => (position + 1) + '. ' + item).join('\n')) + ' |'), '',
  ]
  for (const feature of plan.features.filter(item => item.description || item.source)) {
    lines.push('### ' + feature.id + ' ' + feature.title, '')
    if (feature.description) lines.push(feature.description, '')
    if (feature.source) lines.push('需求出处：' + feature.source, '')
  }
  lines.push('## 二、迭代步骤', '')
  for (const step of plan.steps) {
    lines.push('### ' + step.id + ' ' + step.title, '', '- 对应功能点：' + step.features.join('、') + (step.dependsOn.length ? '　|　依赖：' + step.dependsOn.join('、') : ''), '- 涉及文件：' + step.files.map(file => '`' + file + '`').join('、'), '- 做法：' + step.detail.replace(/\n/g, '\n  '), '- 验证：' + step.verify.replace(/\n/g, '\n  '), '')
  }
  lines.push('## 三、影响范围', '')
  if (impacts.length) {
    lines.push('| 改动目标 | 风险 | 直接依赖 | 间接依赖 | 需回归 | 涉及模块 |', '|---|---|---|---|---|---|',
      ...impacts.map(item => '| `' + item.change.target + '` | ' + riskLabels[item.impact!.risk] + ' | ' + item.impact!.summary.direct + ' | ' + item.impact!.summary.indirect + ' | ' + item.impact!.summary.regression + ' | ' + cell(item.impact!.summary.modules.join('、') || '—') + ' |'), '')
    for (const item of impacts) {
      const report = item.impact!
      lines.push('### `' + item.change.target + '`', '')
      if (report.direct.length) lines.push('直接依赖（改动后必须逐个核对）：', '', ...report.direct.map(entry => '- `' + entry.id + '`（' + entry.location + '，' + entry.relation + (entry.confidence === 'inferred' ? '，推断' : '') + (entry.test ? '，测试' : '') + '）'), '')
      if (report.indirect.length) lines.push('间接依赖（很可能受影响）：', '', ...report.indirect.slice(0, 20).map(entry => '- `' + entry.id + '`，经由 `' + entry.via + '`' + (entry.confidence === 'inferred' ? '（推断）' : '')), ...(report.indirect.length > 20 ? ['- ……共 ' + report.summary.indirect + ' 处'] : []), '')
      if (report.summary.regression) lines.push('更远的传递依赖 ' + report.summary.regression + ' 处，建议回归。', '')
      if (report.summary.tests.length) lines.push('相关测试：' + report.summary.tests.map(file => '`' + file + '`').join('、'), '')
      if (report.summary.entries.length) lines.push('涉及入口：' + report.summary.entries.map(file => '`' + file + '`').join('、'), '')
      if (report.summary.flows.length) lines.push('需要回归的页面流程：' + report.summary.flows.map(flow => flow.label).join('、'), '')
      if (report.summary.clusters.length) lines.push('波及的功能聚类：' + report.summary.clusters.join('、'), '')
      for (const note of report.notes) lines.push('> ' + note, '')
    }
  } else lines.push('本次没有修改或删除图谱内的现有符号。', '')
  const additions = resolved.filter(item => item.change.action === 'add')
  if (additions.length) lines.push('新增内容（没有既有使用方）：' + additions.map(item => '`' + item.change.target + '`').join('、'), '')
  const outside = resolved.filter(item => item.change.action !== 'add' && !item.node)
  if (outside.length) lines.push('不在图谱内的改动（配置、样式、文档等，没有符号级影响面，需人工判断）：' + outside.map(item => '`' + item.change.target + '`').join('、'), '')

  lines.push('## 四、参数与方法设计', '')
  for (const item of resolved) {
    const change = item.change
    lines.push('### `' + change.target + '`（' + actionLabels[change.action] + '，' + change.feature + '）', '', change.summary, '')
    if (item.node?.signature) lines.push('现有签名（来自图谱，' + item.node.file + ':' + item.node.line + '）：', '', code(item.node.signature), '')
    if (item.node?.component) lines.push('现有组件接口：', '', code(Object.entries(item.node.component).map(([key, value]) => key + ': ' + (Array.isArray(value) ? value.join('; ') : value)).join('\n')), '')
    if (change.signature) lines.push((change.action === 'add' ? '签名：' : '改后签名：'), '', code(change.signature), '')
    else if (change.action === 'modify' && item.node?.signature) lines.push('签名不变。', '')
    if (change.params.length) lines.push('| 参数 | 类型 | 必填 | 默认值 | 说明 |', '|---|---|---|---|---|', ...change.params.map(param => '| `' + param.name + '` | `' + cell(param.type) + '` | ' + (param.required ? '是' : '否') + ' | ' + (param.defaultValue ? '`' + cell(param.defaultValue) + '`' : '—') + ' | ' + cell(param.description) + ' |'), '')
    if (change.returns) lines.push('返回值：' + change.returns, '')
    if (change.events.length) lines.push('| 事件 | 载荷 | 说明 |', '|---|---|---|', ...change.events.map(event => '| `' + event.name + '` | ' + (event.payload ? '`' + cell(event.payload) + '`' : '—') + ' | ' + cell(event.description || '—') + ' |'), '')
    if (change.slots.length) lines.push('| 插槽 | 说明 |', '|---|---|', ...change.slots.map(slot => '| `' + slot.name + '` | ' + cell(slot.description || '—') + ' |'), '')
    if (change.compatibility) lines.push('兼容性：' + change.compatibility, '')
  }
  if (plan.openQuestions.length) lines.push('## 五、待确认', '', ...plan.openQuestions.map(question => '- ' + question), '')
  return lines.join('\n')
}

/**
 * 实施后核对：计划里的每处改动是否落地、签名是否与设计一致、有没有计划外的改动、签名变化的直接调用方有没有跟着改。
 * @param index 实施后的最新图谱。
 * @param saved 提交方案时落盘的内容。
 * @param changes 自方案基准以来的文件改动；非 Git 目录为 undefined。
 * @param exists 判断相对路径在磁盘上是否存在。
 */
export async function checkPlan(index: GraphIndex, saved: SavedPlan, changes: FileChange[] | undefined, exists: (path: string) => Promise<boolean>) {
  const issues: string[] = [], warnings: string[] = []
  const plan = saved.plan
  const changed = new Set((changes ?? []).map(change => change.file.replaceAll('\\', '/')))
  const done: string[] = []
  for (const change of plan.changes) {
    const label = actionLabels[change.action] + ' ' + change.target
    const file = fileOf(change.target), symbol = change.target.includes('#')
    const resolution = resolveReference(index, change.target)
    const node = 'node' in resolution && resolution.node.file === file ? resolution.node : undefined
    const present = node ? true : symbol ? false : await exists(file)
    if (change.action === 'remove') { if (present) issues.push(label + '：目标仍然存在'); else done.push(change.target); continue }
    if (!present) { issues.push(label + '：' + (symbol ? '图谱里找不到这个符号' : '文件不存在') + '，尚未实现或名字与方案不一致'); continue }
    if (changes && !changed.has(file)) { issues.push(label + '：所在文件自方案提交以来没有改动'); continue }
    if (change.signature && node?.signature && normalizeSignature(change.signature) !== normalizeSignature(node.signature)) warnings.push(label + '：实际签名与方案不一致。方案：' + change.signature + '；实际：' + node.signature)
    // 签名变了的已有符号：直接调用方所在文件没动，可能漏改。
    const before = saved.currentSignatures[change.target]
    if (change.action === 'modify' && node?.signature && before && normalizeSignature(before) !== normalizeSignature(node.signature) && changes) {
      const untouched = impact(index, [node], { depth: 1, limit: 200 }).direct.filter(item => !item.test && !changed.has(item.id.split('#')[0]))
      if (untouched.length) warnings.push(label + '：签名已变，但这些直接依赖所在的文件没有改动，请确认兼容：' + untouched.slice(0, 12).map(item => item.id).join('、') + (untouched.length > 12 ? ' 等 ' + untouched.length + ' 处' : ''))
    }
    done.push(change.target)
  }
  if (changes) {
    const planned = new Set(plan.steps.flatMap(step => step.files))
    const unplanned = [...changed].filter(file => !planned.has(file) && !file.startsWith('docs/iterations/' + plan.slug + '/'))
    if (unplanned.length) warnings.push('计划外的改动（不在任何步骤的 files 里）：' + unplanned.slice(0, 30).join('、') + (unplanned.length > 30 ? ' 等 ' + unplanned.length + ' 个文件' : ''))
  } else warnings.push('当前目录不是 Git 仓库或基准提交不可用，无法核对文件改动范围，只核对了符号是否存在与签名。')
  return { ok: issues.length === 0, slug: plan.slug, implemented: done.length, total: plan.changes.length, changedFiles: changes ? changed.size : undefined, issues, warnings }
}
