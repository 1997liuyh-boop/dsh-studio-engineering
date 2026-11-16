import assert from 'node:assert/strict'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { workingChanges } from '../studios/engineering/src/git.ts'
import { GraphEngine } from '../studios/engineering/src/graph/engine.ts'
import type { GraphIndex } from '../studios/engineering/src/graph/query.ts'
import { checkPlan, parsePlan, renderPlan, validatePlan, type SavedPlan } from '../studios/engineering/src/plan.ts'
import { createProject } from './fixture.ts'

let root = '', store = '', index: GraphIndex
const onDisk = (path: string) => access(join(root, path)).then(() => true, () => false)

/** 一份合格的方案：给 formatPrice 增加选项参数，并新增 parsePrice。 */
const draft = () => ({
  slug: '2026-11-price-options', title: '价格格式化支持更多选项', source: 'docs/requirements/price.md', summary: '价格展示支持不显示币种。',
  features: [
    { id: 'F1', title: '价格可以不显示币种', kind: 'change', acceptance: ['传 showCurrency: false 时只输出金额'], source: '第 2 节' },
    { id: 'F2', title: '把文本解析成分', kind: 'new', acceptance: ['"12.30" 解析为 1230'] },
  ],
  changes: [
    { feature: 'F1', target: 'shared/money.ts#formatPrice', action: 'modify', summary: '第二个参数改为选项对象', signature: 'function formatPrice(cents: number, options: FormatOptions = {}): string',
      params: [{ name: 'cents', type: 'number', description: '金额，单位分' }, { name: 'options', type: 'FormatOptions', required: false, default: '{}', description: '币种与是否显示币种' }], returns: '格式化后的文本', compatibility: '原来传币种字符串的调用方需要改成 { currency }' },
    { feature: 'F2', target: 'shared/money.ts#parsePrice', action: 'add', summary: '新增解析函数', signature: 'function parsePrice(text: string): number' },
  ],
  steps: [
    { id: 'S1', title: '改造 formatPrice 并新增 parsePrice', features: ['F1', 'F2'], files: ['shared/money.ts'], detail: '先写测试，再改实现。', verify: 'pnpm vitest run tests/money.test.ts' },
    { id: 'S2', title: '更新调用方', features: ['F1'], files: ['app/components/PriceTag.vue'], detail: 'label 改用选项对象。', verify: '打开首页，价格显示正常', dependsOn: ['S1'] },
  ],
  openQuestions: ['是否需要千分位分隔'],
})

before(async () => {
  root = await createProject()
  store = await mkdtemp(join(tmpdir(), 'eng-store-'))
  index = (await new GraphEngine(store).ensure(root)).index
})
after(async () => { await rm(root, { recursive: true, force: true }); await rm(store, { recursive: true, force: true }) })

test('结构不对直接报错，并指出是哪个字段', () => {
  assert.throws(() => parsePlan({ ...draft(), slug: 'Bad Slug' }), /slug/)
  assert.throws(() => parsePlan({ ...draft(), features: [{ id: 'F1', title: 'x', kind: 'tweak', acceptance: [] }] }), /features\[0\]\.kind/)
  assert.throws(() => parsePlan({ ...draft(), changes: [{ feature: 'F1', target: '../outside.ts', action: 'modify', summary: 'x' }] }), /相对路径/)
  assert.equal(parsePlan(draft()).changes[0].params[1].required, false)
})

test('合格的方案通过核对，并为修改目标算出影响面', async () => {
  const validation = await validatePlan(index, parsePlan(draft()), onDisk)
  assert.deepEqual(validation.issues, [])
  const modified = validation.resolved[0]
  assert.equal(modified.node?.id, 'shared/money.ts#formatPrice')
  assert.equal(modified.impact?.summary.direct, 4)
  assert.equal(validation.resolved[1].impact, undefined)
})

test('目标不存在、新增已存在、覆盖不全、依赖成环都会被指出', async () => {
  const plan = draft()
  plan.changes[0].target = 'shared/money.ts#formatPrise'
  plan.changes[1] = { ...plan.changes[1], target: 'shared/money.ts#TAX_RATE' }
  plan.changes.push({ feature: 'F9', target: 'shared/missing.ts', action: 'modify', summary: '不存在的文件', signature: '' } as never)
  plan.features.push({ id: 'F3', title: '没人管的功能点', kind: 'new', acceptance: [] } as never)
  plan.steps[0].dependsOn = ['S2']
  const { issues } = await validatePlan(index, parsePlan(plan), onDisk)
  const has = (pattern: RegExp) => assert.ok(issues.some(issue => pattern.test(issue)), '缺少提示：' + pattern + '\n' + issues.join('\n'))
  has(/formatPrise 在项目里找不到，相近的有：.*shared\/money\.ts#formatPrice/)
  has(/TAX_RATE 已经存在/)
  has(/shared\/missing\.ts 引用了不存在的功能点 F9/)
  has(/shared\/missing\.ts 所在文件没有出现在任何步骤/)
  has(/功能点 F3 没有验收标准/)
  has(/功能点 F3 没有对应的代码改动/)
  has(/依赖成环/)
})

test('图谱外的文件只要磁盘上存在就可以修改', async () => {
  const plan = draft()
  plan.changes.push({ feature: 'F1', target: 'AGENTS.md', action: 'modify', summary: '补充约定', signature: '' } as never)
  plan.steps[0].files.push('AGENTS.md')
  assert.deepEqual((await validatePlan(index, parsePlan(plan), onDisk)).issues, [])
})

test('文档包含四章，影响范围来自图谱，现有签名来自源码', async () => {
  const plan = parsePlan(draft())
  const document = renderPlan(plan, (await validatePlan(index, plan, onDisk)).resolved, { commit: index.graph.commit, createdAt: '2026-11-16T06:00:00.000Z' })
  for (const heading of ['## 一、功能点', '## 二、迭代步骤', '## 三、影响范围', '## 四、参数与方法设计', '## 五、待确认']) assert.ok(document.includes(heading), heading)
  assert.ok(document.includes('| `shared/money.ts#formatPrice` | 低 | 4 | 1 | 1 |'), document)
  assert.ok(document.includes('- `shared/cart.ts#Cart.total`（shared/cart.ts:6，calls）'))
  assert.ok(document.includes('function formatPrice(cents: number, currency = "CNY"): string'))
  assert.ok(document.includes('| `options` | `FormatOptions` | 否 | `{}` | 币种与是否显示币种 |'))
  assert.ok(document.includes('新增内容（没有既有使用方）：`shared/money.ts#parsePrice`'))
  assert.ok(document.includes('相关测试：`tests/money.test.ts`'))
})

test('实施后核对：未落地、签名偏差、计划外改动与漏改的调用方', async () => {
  const plan = parsePlan(draft())
  const validation = await validatePlan(index, plan, onDisk)
  const saved: SavedPlan = { schemaVersion: 1, createdAt: '', baseCommit: index.graph.commit, plan, currentSignatures: Object.fromEntries(validation.resolved.flatMap(item => item.node?.signature ? [[item.change.target, item.node.signature]] : [])) }
  // 还没动手：两处改动都没落地。
  const untouched = await checkPlan(index, saved, await workingChanges(root, saved.baseCommit), onDisk)
  assert.equal(untouched.ok, false)
  assert.ok(untouched.issues.some(issue => issue.includes('formatPrice：所在文件自方案提交以来没有改动')))
  assert.ok(untouched.issues.some(issue => issue.includes('parsePrice：图谱里找不到这个符号')))
  // 实现了一半：签名和方案不一样，调用方没改，还顺手动了别的文件。
  await writeFile(join(root, 'shared/money.ts'), 'export interface FormatOptions { currency?: string; showCurrency?: boolean }\nexport function formatPrice(cents: number, opts: FormatOptions = {}): string {\n  return (opts.showCurrency === false ? "" : (opts.currency ?? "CNY") + " ") + (cents / 100).toFixed(2)\n}\nexport const TAX_RATE = 0.13\nexport function parsePrice(text: string): number { return Math.round(Number(text) * 100) }\n')
  await writeFile(join(root, 'shared/cart.ts'), (await import('./fixture.ts')).files['shared/cart.ts'] + '// 顺手加的注释\n')
  const after = (await new GraphEngine(store).ensure(root)).index
  const report = await checkPlan(after, saved, await workingChanges(root, saved.baseCommit), onDisk)
  assert.deepEqual(report.issues, [])
  assert.equal(report.implemented, 2)
  assert.ok(report.warnings.some(warning => warning.includes('实际签名与方案不一致')))
  assert.ok(report.warnings.some(warning => warning.includes('签名已变') && warning.includes('app/components/PriceTag.vue#label')), report.warnings.join('\n'))
  assert.ok(report.warnings.some(warning => warning.includes('计划外的改动') && warning.includes('shared/cart.ts')))
})
