import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { ARCHIVE_MARKDOWN, renderArchive } from '../studios/engineering/src/archive.ts'
import { canvasOf, nodeLabel } from '../studios/engineering/src/graph/canvas.ts'
import { GraphEngine } from '../studios/engineering/src/graph/engine.ts'
import { healthOf, packageName } from '../studios/engineering/src/graph/health.ts'
import type { GraphIndex } from '../studios/engineering/src/graph/query.ts'
import { commitType, parseHistory, readHistory, renamedPath } from '../studios/engineering/src/history.ts'
import { inspectProject, readManifest, readPlans } from '../studios/engineering/src/project.ts'
import { createProject } from './fixture.ts'

let root = '', home = ''
let index: GraphIndex

const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: root, stdio: 'ignore' })

before(async () => {
  root = await createProject()
  home = await mkdtemp(join(tmpdir(), 'eng-health-'))
  // 再提交两次：一次改购物车（修复），一次加一个没人用的导出和一份迭代方案。
  await writeFile(join(root, 'shared/cart.ts'), (await readFile(join(root, 'shared/cart.ts'), 'utf8')) + 'export const CART_LIMIT = 99\n')
  git('add', '-A'); git('commit', '-q', '-m', 'fix(cart): 限制购物车数量')
  await mkdir(join(root, 'docs/iterations/2026-11-cart-limit'), { recursive: true })
  await writeFile(join(root, 'docs/iterations/2026-11-cart-limit/iteration.json'), JSON.stringify({ schemaVersion: 1, createdAt: '2026-11-01T00:00:00.000Z', plan: { title: '购物车限购', features: [{}, {}], changes: [{}], steps: [{}, {}, {}] } }))
  await writeFile(join(root, 'shared/money.ts'), (await readFile(join(root, 'shared/money.ts'), 'utf8')) + 'export function legacyFormat(cents: number): string { return String(cents) }\n')
  git('add', '-A'); git('commit', '-q', '-m', 'feat: 旧格式兼容')
  index = (await new GraphEngine(join(home, 'graphs')).ensure(root)).index
})
after(async () => { await rm(root, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }) })

test('提交历史：解析类型、重命名与每周提交数，二进制文件不计行数', () => {
  assert.equal(commitType('feat(order): 导出'), 'feat'); assert.equal(commitType('Fix：登录'), 'fix'); assert.equal(commitType('调整文案'), 'other')
  assert.equal(renamedPath('src/{old => new}/a.ts'), 'src/new/a.ts'); assert.equal(renamedPath('a.ts => b.ts'), 'b.ts'); assert.equal(renamedPath('src/{ => lib}/a.ts'), 'src/lib/a.ts')
  const now = Date.parse('2026-11-16T12:00:00Z')
  const log = ['\x01aaaaaaaaaaaa\x022026-11-10T10:00:00+08:00\x02a@x.com\x02feat: 加导出', '', '10\t2\tsrc/a.ts', '-\t-\tpublic/logo.png',
    '\x01bbbbbbbbbbbb\x022026-05-01T10:00:00+08:00\x02b@x.com\x02fix: 改 a', '', '3\t1\tsrc/{old => new}/a.ts', '1\t0\tsrc/a.ts', ''].join('\n')
  const history = parseHistory(log, 12, now)
  assert.deepEqual([history.commits, history.authors], [2, 2])
  assert.deepEqual(history.types, { feat: 1, fix: 1 })
  assert.deepEqual(history.files.get('src/a.ts'), { commits: 2, added: 11, removed: 2, last: '2026-11-10T10:00:00+08:00', recent: 1 })
  assert.deepEqual(history.files.get('public/logo.png'), { commits: 1, added: 0, removed: 0, last: '2026-11-10T10:00:00+08:00', recent: 1 })
  assert.ok(history.files.has('src/new/a.ts'), '重命名取新路径')
  assert.equal(history.weeks.length, 26)
  assert.deepEqual(history.weeks.at(-1), { week: '2026-11-16', commits: 0 }); assert.deepEqual(history.weeks.at(-2), { week: '2026-11-09', commits: 1 })
  assert.equal(history.recent[0].files.length, 2)
})

test('提交历史：从真实仓库读取，非 Git 目录标为不可用', async () => {
  const history = await readHistory(root, index.graph.commit, 12)
  assert.equal(history.available, true)
  assert.equal(history.commits, 3)
  assert.deepEqual(history.types, { feat: 1, fix: 1, other: 1 })
  assert.equal(history.files.get('shared/cart.ts')?.commits, 2)
  assert.equal((await readHistory(home, '', 12)).available, false)
})

test('依赖：包名归一，别名与虚拟模块不算外部包', () => {
  assert.equal(packageName('lodash/get'), 'lodash'); assert.equal(packageName('@scope/pkg/sub'), '@scope/pkg'); assert.equal(packageName('vue'), 'vue')
  for (const source of ['./a', '~/a', '#shared/a', '@/api/a', 'node:fs', 'virtual:uno.css', 'uni_modules/x', '@scope']) assert.equal(packageName(source), '', source)
  assert.equal(packageName('crypto'), 'crypto', '与内置模块同名的包是否算外部依赖，看有没有声明')
})

test('体检报告：质量、依赖、迭代与难度都给出结论和依据', async () => {
  const report = healthOf(index, await readHistory(root, index.graph.commit, 12), await readManifest(root), await readPlans(root))
  assert.equal(report.scale.files, index.graph.stats.files); assert.ok(report.scale.lines > 20); assert.equal(report.scale.testFiles, 1)
  const finding = (id: string) => report.quality.findings.find(item => item.id === id)!
  assert.equal(finding('cycles').level, 'good')
  assert.ok(finding('unused-exports').items.some(item => item.label === 'shared/money.ts#legacyFormat'), '新增的没人用的导出被列出')
  assert.ok(!finding('unused-exports').items.some(item => item.label === 'shared/money.ts#formatPrice'), '被使用的导出不列')
  assert.equal(finding('tests').level, 'good'); assert.match(finding('tests').value, /1 个测试文件/)
  assert.ok(report.quality.score <= 100 && report.quality.score >= 0)
  assert.equal(report.quality.score, 100 - report.quality.findings.reduce((sum, item) => sum + item.penalty, 0))
  // 依赖：nuxt 声明了但源码里没有 import（自动导入），vue 同理；@shop/ui 是工作区内的子包，被导入但根目录没有声明。
  assert.equal(report.dependencies.manifest, true)
  assert.deepEqual(report.dependencies.packages.map(item => item.name).sort(), ['nuxt', 'vue'])
  assert.deepEqual(report.dependencies.unused.sort(), ['nuxt', 'vue'])
  // 迭代
  assert.equal(report.iteration.available, true); assert.equal(report.iteration.commits, 3)
  assert.match(report.iteration.pace, /最近 12 个月 3 次提交/)
  assert.equal(report.iteration.hotspots[0].file, 'shared/cart.ts')
  assert.deepEqual(report.iteration.plans, [{ slug: '2026-11-cart-limit', title: '购物车限购', createdAt: '2026-11-01T00:00:00.000Z', features: 2, changes: 1, steps: 3, checked: false }])
  // 难度：每个聚类都有两种难度，分数在 0–100 之间，等级与分数对应。
  assert.equal(report.difficulty.clusters.length, report.scale.clusters)
  for (const cluster of report.difficulty.clusters) {
    for (const item of [cluster.refactor, cluster.extend]) { assert.ok(item.score >= 0 && item.score <= 100); assert.equal(item.level, item.score < 34 ? '低' : item.score < 67 ? '中' : '高') }
  }
  // 非 Git 目录：迭代不可用，其余照常。
  const offline = healthOf(index, await readHistory(root, '', 12), undefined)
  assert.equal(offline.iteration.available, false); assert.match(offline.iteration.pace, /不是 Git 仓库/)
  assert.equal(offline.dependencies.manifest, false); assert.deepEqual(offline.dependencies.unused, [])
})

test('画布数据：全局取各聚类的代表文件，进入聚类取全部文件，连线两端都在图上', () => {
  assert.equal(nodeLabel('app/pages/index.vue'), 'pages/index'); assert.equal(nodeLabel('shared/money.ts'), 'money'); assert.equal(nodeLabel('main.ts'), 'main')
  const global = canvasOf(index)
  assert.equal(global.scope, 'global')
  assert.ok(global.nodes.length > 0 && global.nodes.length <= 140)
  const ids = new Set(global.nodes.map(node => node.id))
  for (const edge of global.edges) assert.ok(ids.has(edge.from) && ids.has(edge.to) && edge.weight > 0)
  assert.equal(global.total.files, index.graph.stats.files)
  for (const node of global.nodes) assert.ok(global.clusters.some(cluster => cluster.id === node.cluster), node.id)
  const kinds = Object.fromEntries(global.nodes.map(node => [node.id, node.kind]))
  assert.deepEqual([kinds['app/components/PriceTag.vue'], kinds['shared/money.ts'], kinds['tests/money.test.ts']], ['component', 'module', 'test'])
  assert.ok(!('app/pages/index.vue' in kinds), '没有归入聚类的散落文件不上图')
  const first = global.clusters[0]
  const focused = canvasOf(index, first.id)
  assert.deepEqual([focused.scope, focused.focus, focused.clusters.length], ['cluster', first.id, 1])
  assert.equal(focused.nodes.length, first.files)
  assert.ok(focused.nodes.every(node => node.cluster === first.id))
  assert.deepEqual(canvasOf(index, 'c999').nodes, [], '不存在的聚类返回空图')
})

test('项目档案：Markdown 写明用法与边界，各节与体检报告对应', async () => {
  const report = healthOf(index, await readHistory(root, index.graph.commit, 12), await readManifest(root), await readPlans(root))
  const text = renderArchive(await inspectProject(root), report, { clusters: [], hubs: [{ id: 'shared/money.ts#formatPrice', usedBy: 3, signature: 'export function formatPrice(cents: number | string): string' }], entries: ['app/pages/index.vue'], routes: [] })
  assert.equal(ARCHIVE_MARKDOWN, 'docs/engineering/project-map.md')
  for (const heading of ['# 项目档案：shop', '## 怎么用这份档案', '## 一览', '## 功能聚类', '## 质量', '## 依赖', '## 迭代情况', '## 改动难度', '## 入口与路由']) assert.ok(text.includes(heading), heading)
  assert.ok(text.includes('shared/money.ts#legacyFormat'), '质量问题的具体条目写进档案')
  assert.ok(text.includes('number \\| string'), '表格单元格里的竖线要转义')
  assert.ok(text.includes('docs/iterations/2026-11-cart-limit'))
  assert.ok(text.includes('没有识别出路由表。入口文件：`app/pages/index.vue`'))
})
