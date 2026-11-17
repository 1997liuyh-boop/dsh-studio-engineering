import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { studioTasks, taskMethods } from '../studios/engineering/src/prompt.ts'
import { loadSkills, parseSkill, skillProvider } from '../studios/engineering/src/skills.ts'
import { createProject } from './fixture.ts'

const repository = fileURLToPath(new URL('../', import.meta.url))
type Tool = { name: string; execute(args: unknown, execution: object): Promise<string>; presentCall(args: unknown): { title: string } }
type Provider = ReturnType<typeof skillProvider>

let root = '', home = ''
const tools = new Map<string, Tool>()
const prompts = new Map<string, string>()
const providers: Provider[] = []
let page: { id: string; root: string; tasks: unknown[]; handle(req: object, res: object, path: string): Promise<boolean> }
const disposers: (() => void | Promise<void>)[] = []

/** 以会话身份调用工具并解析返回的 JSON。 */
const invoke = async (name: string, args: object, cwd: string | undefined = root) => JSON.parse(await tools.get(name)!.execute(args, { agent: { session: { id: 's1', header: { cwd } } }, signal: new AbortController().signal }))
/** 模拟页面请求工作室接口。 */
const request = async (body?: object) => {
  const req = Object.assign(new EventEmitter(), { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)) } })
  let status = 0, payload = ''
  await page.handle(req, { writeHead(code: number) { status = code }, end(text: string) { payload = text } }, 'api')
  return { status, body: JSON.parse(payload) }
}

before(async () => {
  root = await createProject()
  home = await mkdtemp(join(tmpdir(), 'eng-home-'))
  process.env.DSH_HOME = home
  // 加载根目录下已构建并同步的安装入口，与用户安装后运行的是同一份文件。
  const plugin = await import(pathToFileURL(join(repository, 'lib/index.js')).href)
  assert.equal(plugin.name, 'dsh-studio-engineering')
  assert.deepEqual(plugin.inject, ['studioProjects', 'tools', 'systemPrompt'])
  const effect = (callback: () => () => void | Promise<void>) => { disposers.push(callback()) }
  await plugin.apply({
    effect, get: () => undefined,
    // 子插件：提供技能注册表后立即启动，等同宿主已挂载技能服务。
    plugin(sub: { inject: string[]; apply(ctx: object): void }) { assert.deepEqual(sub.inject, ['skills']); sub.apply({ effect, skills: { registerProvider(create: () => Provider) { providers.push(create()); return () => {} } } }) },
    tools: { register(tool: Tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    systemPrompt: { section(section: { name: string; text: string }) { prompts.set(section.name, section.text); return () => prompts.delete(section.name) } },
    studioProjects: { register(value: typeof page) { page = value; return () => {} } },
  })
})
after(async () => {
  for (const dispose of disposers) await dispose()
  delete process.env.DSH_HOME
  await rm(root, { recursive: true, force: true }); await rm(home, { recursive: true, force: true })
})

test('技能文件齐全，任务引用的方法都存在', async () => {
  const skills = await loadSkills(join(repository, 'studios/engineering/skills'))
  assert.equal(skills.length, 10)
  for (const skill of skills) { assert.match(skill.name, /^eng-[a-z-]+$/); assert.ok(skill.description.length > 20 && skill.content.length > 400, skill.name) }
  const names = new Set(skills.map(skill => skill.name))
  for (const name of Object.values(taskMethods).flat()) assert.ok(names.has(name), name)
  assert.throws(() => parseSkill('没有 frontmatter', 'x'), /frontmatter/)
})

test('注册了三个工具、系统提示词、页面与技能提供方', async () => {
  assert.deepEqual([...tools.keys()].sort(), ['eng_graph', 'eng_plan', 'eng_workspace'])
  const prompt = prompts.get('studio-engineering-workspace') ?? ''
  assert.ok(prompt.includes('@研发工作室') && prompt.includes('eng-coding-principles'))
  assert.equal(page.id, 'engineering')
  assert.deepEqual(page.tasks, studioTasks())
  assert.equal(providers.length, 1)
  const candidates = await providers[0].list({})
  assert.equal(candidates.length, 10)
  const loaded = await providers[0].get(candidates.find(item => item.name === 'eng-tdd')!, {})
  assert.ok(loaded?.content.startsWith('# 测试驱动开发') && !('rank' in loaded))
})

test('没有工作区时提示先打开项目会话', async () => {
  await assert.rejects(invoke('eng_graph', { action: 'overview' }, ''), /请先在 dsh 工作区打开项目会话/)
})

test('eng_workspace：首次调用建图，返回流程、方法与项目约定', async () => {
  const graph = await invoke('eng_workspace', { task: 'graph', request: '' })
  assert.equal(graph.graph.freshness.state, 'built')
  assert.equal(graph.overview.stats.files, 10)
  const analyze = await invoke('eng_workspace', { task: 'analyze', request: 'docs/requirements/price.md' })
  assert.deepEqual(analyze.methods.map((method: { name: string }) => method.name), ['eng-clarify-requirements', 'eng-iteration-plan', 'eng-module-design'])
  assert.ok(analyze.instructions.includes('先读项目约定：AGENTS.md'))
  assert.ok(analyze.instructions.includes('"frameworks": [\n    "Nuxt",\n    "Vue"\n  ]'))
  assert.ok(analyze.instructions.includes('docs/requirements/price.md'))
  assert.equal(tools.get('eng_workspace')!.presentCall({ task: 'analyze' }).title, '研发工作室 · 分析需求文档')
})

test('eng_graph：搜索、上下文、影响面与同名提示', async () => {
  assert.equal((await invoke('eng_graph', { action: 'search', query: 'formatPrice' })).results[0].id, 'shared/money.ts#formatPrice')
  assert.equal((await invoke('eng_graph', { action: 'context', target: 'shared/cart.ts#Cart' })).members.length, 3)
  const report = await invoke('eng_graph', { action: 'impact', targets: ['formatPrice'] })
  assert.equal(report.summary.direct, 4)
  const unknown = await invoke('eng_graph', { action: 'impact', targets: ['shared/money.ts#nope'] })
  assert.ok(unknown.problems[0].suggestions.includes('shared/money.ts#formatPrice'))
  assert.deepEqual((await invoke('eng_graph', { action: 'changes' })).symbols, [])
})

test('eng_plan：有问题不落盘，通过后生成文档，实施后可核对', async () => {
  const plan = {
    slug: 'price-options', title: '价格格式化支持选项',
    features: [{ id: 'F1', title: '可以不显示币种', kind: 'change', acceptance: ['showCurrency 为 false 时只输出金额'] }],
    changes: [{ feature: 'F1', target: 'shared/money.ts#formatPrise', action: 'modify', summary: '第二个参数改为选项对象' }],
    steps: [{ id: 'S1', title: '改造 formatPrice', features: ['F1'], files: ['shared/money.ts'], detail: '改签名与实现', verify: 'pnpm vitest run' }],
  }
  const rejected = await invoke('eng_plan', { stage: 'submit', plan })
  assert.equal(rejected.ok, false)
  assert.ok(rejected.issues[0].includes('相近的有'))
  await assert.rejects(readFile(join(root, 'docs/iterations/price-options/iteration.md')))

  plan.changes[0].target = 'shared/money.ts#formatPrice'
  const accepted = await invoke('eng_plan', { stage: 'submit', plan })
  assert.deepEqual({ ok: accepted.ok, document: accepted.document, impact: accepted.impact }, { ok: true, document: 'docs/iterations/price-options/iteration.md', impact: [{ target: 'shared/money.ts#formatPrice', risk: 'LOW', direct: 4, indirect: 1, tests: 1 }] })
  assert.ok((await readFile(join(root, 'docs/iterations/price-options/iteration.md'), 'utf8')).includes('## 三、影响范围'))
  const saved = JSON.parse(await readFile(join(root, 'docs/iterations/price-options/iteration.json'), 'utf8'))
  assert.equal(saved.currentSignatures['shared/money.ts#formatPrice'], 'function formatPrice(cents: number, currency = "CNY"): string')

  const checked = await invoke('eng_plan', { stage: 'check', slug: 'price-options' })
  assert.equal(checked.ok, false)
  assert.ok(checked.issues[0].includes('没有改动'))
  assert.ok((await readFile(join(root, 'docs/iterations/price-options/check-report.json'), 'utf8')).includes('"ok": false'))
  // 已有方案会出现在后续任务的项目概况里。
  assert.ok((await invoke('eng_workspace', { task: 'implement', request: '' })).instructions.includes('项目已有的迭代方案：price-options'))
})

test('页面接口：快照、查询、设置与来源校验', async () => {
  const snapshot = await request()
  assert.equal(snapshot.status, 200)
  assert.equal(snapshot.body.graphs.length, 1)
  assert.equal(snapshot.body.skills.length, 10)
  const found = await request({ action: 'search', root, query: 'Cart' })
  assert.ok(found.body.results.some((item: { id: string }) => item.id === 'shared/cart.ts#Cart'))
  assert.equal((await request({ action: 'impact', root, target: 'shared/money.ts#formatPrice' })).body.risk, 'LOW')
  assert.equal((await request({ action: 'search', root: join(root, 'shared'), query: 'x' })).body.error, '这个项目还没有建过图谱')
  // 关闭常驻准则后，系统提示词只保留调用指引。
  assert.equal((await request({ action: 'configure', settings: { principles: false } })).body.settings.principles, false)
  assert.equal(prompts.get('studio-engineering-workspace')!.includes('eng-coding-principles'), false)
  assert.ok((await request({ action: 'skill', name: 'eng-debugging' })).body.content.includes('根因'))
  assert.equal((await request({ action: 'remove', root })).body.graphs.length, 0)
})

test('eng_graph 的全局视图操作与页面接口', async () => {
  const clusters = await invoke('eng_graph', { action: 'clusters' })
  assert.ok(clusters.total >= 1 && Array.isArray(clusters.links))
  const own = await invoke('eng_graph', { action: 'clusters', target: 'shared/cart.ts#Cart' })
  assert.ok(own.fileList.some((item: { file: string }) => item.file === 'shared/cart.ts'))
  assert.equal((await invoke('eng_graph', { action: 'clusters', target: 'c999' })).issue, '没有这个聚类')
  const flows = await invoke('eng_graph', { action: 'flows' })
  assert.ok(flows.flows.some((flow: { id: string }) => flow.id === 'app/pages/index.vue'))
  const detail = await invoke('eng_graph', { action: 'flows', target: 'app/pages/index.vue' })
  assert.equal(detail.route, '/')
  assert.ok(detail.steps.some((step: { id: string }) => step.id === 'shared/money.ts#formatPrice'))
  const through = await invoke('eng_graph', { action: 'flows', target: 'shared/money.ts#formatPrice' })
  assert.deepEqual(through.flows.map((flow: { id: string }) => flow.id), ['app/pages/index.vue'])
  const path = await invoke('eng_graph', { action: 'trace', from: 'app/pages/index.vue', to: 'formatPrice' })
  assert.equal(path.found, true)
  assert.equal(path.hops.at(-1).id, 'shared/money.ts#formatPrice')
  assert.equal((await invoke('eng_graph', { action: 'routes' })).routes[0].path, '/')
  assert.equal((await invoke('eng_graph', { action: 'cycles' })).total, 0)
  assert.equal(tools.get('eng_graph')!.presentCall({ action: 'trace' }).title, '研发工作室 · 路径追踪')
  // 页面接口：一次取回全局视图，再按需取聚类与流程明细。
  await invoke('eng_workspace', { task: 'graph', request: '' })
  const views = await request({ action: 'views', root })
  assert.equal(views.status, 200)
  assert.ok(views.body.clusters.clusters.length >= 1 && views.body.flows.total >= 1 && views.body.routes.total === 1)
  assert.equal((await request({ action: 'cluster', root, id: views.body.clusters.clusters[0].id })).status, 200)
  assert.equal((await request({ action: 'flow', root, id: 'app/pages/index.vue' })).body.route, '/')
  assert.equal((await request({ action: 'flow', root, id: 'nope.vue' })).body.error, '没有这条流程')
  assert.equal((await request({ action: 'trace', root, from: 'app/pages/index.vue', to: 'formatPrice' })).body.found, true)
})

test('项目体检、图谱画布与项目档案：工具与页面接口用同一份数据', async () => {
  const health = await invoke('eng_graph', { action: 'health' })
  assert.match(health.quality.grade, /^[ABCD]$/)
  assert.ok(health.quality.findings.length >= 6 && health.quality.findings.every((item: { items: unknown[] }) => item.items.length <= 5), '总览里每项只带前几条')
  assert.equal(health.iteration.available, true)
  assert.ok(Array.isArray(health.difficulty.clusters) && typeof health.more === 'string')
  const quality = await invoke('eng_graph', { action: 'health', target: 'quality' })
  assert.equal(quality.section, 'quality'); assert.equal(quality.score, health.quality.score)
  assert.match((await invoke('eng_graph', { action: 'health', target: 'nope' })).issue, /quality、dependencies、iteration、difficulty/)
  assert.equal(tools.get('eng_graph')!.presentCall({ action: 'health' }).title, '研发工作室 · 项目体检')

  const page = await request({ action: 'health', root })
  assert.equal(page.status, 200)
  assert.equal(page.body.quality.score, health.quality.score, '页面与工具的质量分一致')
  assert.equal(page.body.schemaVersion, 1)

  const canvas = await request({ action: 'canvas', root })
  assert.equal(canvas.body.scope, 'global'); assert.ok(canvas.body.nodes.length > 0)
  const focused = await request({ action: 'canvas', root, cluster: canvas.body.clusters[0].id })
  assert.equal(focused.body.focus, canvas.body.clusters[0].id)
  assert.equal(typeof (await request({ action: 'context', root, target: canvas.body.nodes[0].id })).body.cluster, 'string', '节点上下文带出所在聚类')

  // 导出：在项目里写两个文件，内容与体检一致；页面按钮与工具动作都走同一个实现。
  const exported = await invoke('eng_graph', { action: 'export' })
  assert.deepEqual([exported.ok, exported.document, exported.data], [true, 'docs/engineering/project-map.md', 'docs/engineering/project-map.json'])
  const markdown = await readFile(join(root, 'docs/engineering/project-map.md'), 'utf8')
  assert.ok(markdown.startsWith('# 项目档案：shop') && markdown.includes('## 改动难度'))
  const data = JSON.parse(await readFile(join(root, 'docs/engineering/project-map.json'), 'utf8'))
  assert.equal(data.schemaVersion, 1); assert.equal(data.quality.score, health.quality.score); assert.equal(data.project.name, 'shop')
  assert.ok(Array.isArray(data.structure.clusters) && Array.isArray(data.structure.routes))
  assert.equal((await request({ action: 'export', root })).body.document, 'docs/engineering/project-map.md')
  assert.match(prompts.get('studio-engineering-workspace')!, /health 看体检结果/)
})

test('工作台：全局规则实际更新提示词，页面可以查看方案并执行结构核对', async () => {
  const configured = await request({ action: 'configure', settings: { principles: true, customRules: '新增注释使用中文。' } })
  assert.equal(configured.status, 200)
  assert.equal(configured.body.settings.customRules, '新增注释使用中文。')
  assert.match(prompts.get('studio-engineering-workspace')!, /新增注释使用中文/)
  assert.equal((await request({ action: 'configure', settings: { customRules: 123 } })).status, 400)
  assert.equal((await request()).body.settings.customRules, '新增注释使用中文。')
  assert.equal((await request({ action: 'configure', settings: { principles: false } })).body.settings.customRules, '新增注释使用中文。')
  assert.match(prompts.get('studio-engineering-workspace')!, /新增注释使用中文/)
  const plans = await request({ action: 'plans', root })
  assert.ok(plans.body.plans.some((plan: { slug: string }) => plan.slug === 'price-options'))
  const detail = await request({ action: 'plan', root, slug: 'price-options' })
  assert.equal(detail.status, 200)
  assert.equal(detail.body.plan.features.length, 1)
  assert.equal(detail.body.report.ok, false)
  const checked = await request({ action: 'check-plan', root, slug: 'price-options' })
  assert.equal(checked.status, 200)
  assert.equal(checked.body.ok, false)
  assert.ok(checked.body.checkedAt && checked.body.commit)
  assert.equal((await request({ action: 'plan', root, slug: '../escape' })).status, 400)
  const changes = await request({ action: 'changes', root })
  assert.equal(changes.status, 200)
  assert.equal(changes.body.available, true)
  assert.ok(Array.isArray(changes.body.files) && Array.isArray(changes.body.symbols))
})
