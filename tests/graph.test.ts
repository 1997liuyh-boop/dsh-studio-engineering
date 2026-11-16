import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { parseDiff, workingChanges } from '../studios/engineering/src/git.ts'
import { GraphEngine } from '../studios/engineering/src/graph/engine.ts'
import { stripJsonComments } from '../studios/engineering/src/graph/layout.ts'
import { changedSymbols, context, impact, overview, resolveReference, search, type GraphIndex } from '../studios/engineering/src/graph/query.ts'
import { createProject } from './fixture.ts'

let root = '', store = '', engine: GraphEngine, index: GraphIndex
const node = (reference: string) => { const found = resolveReference(index, reference); assert.ok('node' in found, '应能解析：' + reference + ' → ' + JSON.stringify(found)); return found.node }
const edge = (from: string, to: string, kind: string) => index.graph.edges.find(item => item.from === from && item.to === to && item.kind === kind)

before(async () => {
  root = await createProject()
  store = await mkdtemp(join(tmpdir(), 'eng-store-'))
  engine = new GraphEngine(store)
  const result = await engine.ensure(root)
  assert.equal(result.freshness.state, 'built')
  index = result.index
})
after(async () => { await rm(root, { recursive: true, force: true }); await rm(store, { recursive: true, force: true }) })

test('符号带签名与注释，构建产物不进图谱', () => {
  const price = node('shared/money.ts#formatPrice')
  assert.equal(price.signature, 'function formatPrice(cents: number, currency = "CNY"): string')
  assert.equal(price.doc, '把分转成带两位小数的元。')
  assert.equal(price.exported, true)
  assert.equal(index.nodes.has('packages/ui/lib/index.js'), false)
  assert.equal(index.graph.stats.skipped, 1)
  assert.equal(index.graph.stats.errors, 0)
})

test('类成员、继承与 this 调用', () => {
  assert.equal(node('shared/cart.ts#Cart.add').parent, 'shared/cart.ts#Cart')
  assert.ok(edge('shared/cart.ts#Cart', 'shared/cart.ts#Base', 'extends'))
  assert.ok(edge('shared/cart.ts#Cart.add', 'shared/cart.ts#Cart.touch', 'calls'))
  assert.ok(edge('shared/cart.ts#Cart.total', 'shared/money.ts#formatPrice', 'calls'))
  assert.ok(edge('shared/cart.ts#Cart.total', 'shared/money.ts#TAX_RATE', 'references'))
})

test('tsconfig 别名、转导出改名与成员调用', () => {
  // useCart 经 #shared/index 的 export { Cart as ShoppingCart } 找到 Cart。
  assert.equal(edge('app/composables/useCart.ts#useCart', 'shared/cart.ts#Cart', 'calls')?.confidence, 'resolved')
  assert.ok(edge('app/composables/useCart.ts', 'shared/index.ts', 'imports'))
  assert.ok(edge('app/composables/useCart.ts#useCart', 'shared/cart.ts#CartItem', 'references'))
})

test('工作区包的入口指向构建产物时换回源码', () => {
  assert.ok(edge('app/utils/label.ts#label', 'packages/ui/src/index.ts#badge', 'calls'))
})

test('Vue 组件：接口、Nuxt 别名、模板标签与自动导入', () => {
  const tag = node('app/components/PriceTag.vue')
  assert.equal(tag.kind, 'component')
  assert.match(tag.component?.props ?? '', /cents: number/)
  assert.match(tag.component?.emits ?? '', /select/)
  assert.ok(edge('app/components/PriceTag.vue#label', 'shared/money.ts#formatPrice', 'calls'))
  // 模板里的 <price-tag> 没有 import：按组件名推断。
  assert.equal(edge('app/components/cart/CartPanel.vue', 'app/components/PriceTag.vue', 'renders')?.confidence, 'inferred')
  // useCart 没有 import：按 composables 目录的自动导入约定推断。
  assert.equal(edge('app/components/cart/CartPanel.vue', 'app/composables/useCart.ts#useCart', 'calls')?.confidence, 'inferred')
  assert.deepEqual(node('app/components/cart/CartPanel.vue').component?.models, ['open: boolean'])
  // 显式 import 的组件是确定关系。
  assert.equal(edge('app/pages/index.vue', 'app/components/cart/CartPanel.vue', 'renders')?.confidence, 'resolved')
})

test('搜索：精确名优先，测试文件靠后', () => {
  const found = search(index, 'formatPrice')
  assert.equal(found.results[0].id, 'shared/money.ts#formatPrice')
  assert.equal(found.results[0].usedBy, 3)
  assert.equal(search(index, 'cart panel').results[0].id, 'app/components/cart/CartPanel.vue')
})

test('引用解析：同名给候选，找不到给相近名字', () => {
  assert.ok('node' in resolveReference(index, 'formatPrice'))
  assert.ok('node' in resolveReference(index, 'cart/CartPanel.vue'))
  const missing = resolveReference(index, 'shared/money.ts#formatPrise')
  assert.ok('missing' in missing && missing.suggestions.includes('shared/money.ts#formatPrice'))
})

test('影响面按距离分级，推断关系会传递，测试单列', () => {
  const report = impact(index, [node('shared/money.ts#formatPrice')])
  assert.deepEqual(report.direct.map(item => item.id).sort(), ['app/components/PriceTag.vue', 'app/components/PriceTag.vue#label', 'shared/cart.ts#Cart.total', 'tests/money.test.ts'])
  assert.deepEqual(report.summary.tests, ['tests/money.test.ts'])
  assert.equal(report.risk, 'LOW')
  // label 与它所在的 PriceTag 组件同级 → CartPanel（经推断的渲染关系）→ 首页。
  const page = report.regression.find(item => item.id === 'app/pages/index.vue')
  assert.equal(page?.confidence, 'inferred')
  assert.deepEqual(report.summary.entries, ['app/pages/index.vue'])
  assert.ok(report.notes.some(note => note.includes('inferred')))
})

test('没有使用方时给出提示而不是结论', () => {
  const report = impact(index, [node('app/pages/index.vue')])
  assert.equal(report.direct.length, 0)
  assert.ok(report.notes.some(note => note.includes('没有找到使用方')))
})

test('上下文与概览', () => {
  const detail = context(index, node('shared/cart.ts#Cart'))
  assert.deepEqual(detail.members?.map(item => item.name), ['Cart.add', 'Cart.total', 'Cart.touch'])
  const summary = overview(index)
  assert.equal(summary.stats.files, 10)
  assert.ok(summary.hubs.some(item => item.id === 'shared/money.ts#formatPrice'))
  assert.ok(summary.entries.includes('app/pages/index.vue'))
  assert.equal(summary.externals.length, 0)
})

test('增量更新：只重新解析改动的文件，删除的文件从图里消失', async () => {
  assert.equal((await engine.ensure(root)).freshness.state, 'fresh')
  await writeFile(join(root, 'shared/money.ts'), '/** 把分转成元。 */\nexport function formatPrice(cents: number, options: { currency?: string } = {}): string {\n  return (options.currency ?? "CNY") + " " + (cents / 100).toFixed(2)\n}\nexport const TAX_RATE = 0.13\nexport function parsePrice(text: string): number { return Math.round(Number(text) * 100) }\n')
  await rm(join(root, 'app/utils/label.ts'))
  // 绕过两秒内不重复核对的保护。
  const updated = await new GraphEngine(store).ensure(root)
  assert.deepEqual({ state: updated.freshness.state, changed: updated.freshness.changed, removed: updated.freshness.removed }, { state: 'updated', changed: 1, removed: 1 })
  index = updated.index
  assert.match(node('shared/money.ts#formatPrice').signature ?? '', /options: \{ currency\?: string \}/)
  assert.ok(index.nodes.has('shared/money.ts#parsePrice'))
  assert.equal(index.nodes.has('app/utils/label.ts'), false)
})

test('Git 改动映射到符号', async () => {
  const changes = await workingChanges(root)
  assert.ok(changes)
  const mapped = changedSymbols(index, changes)
  assert.deepEqual(mapped.symbols.map(item => item.id).sort(), ['shared/money.ts#formatPrice', 'shared/money.ts#parsePrice'])
  assert.deepEqual(mapped.deleted, ['app/utils/label.ts'])
})

test('diff 解析：新增、修改、纯删除的块', () => {
  const changes = parseDiff(['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -3,2 +3,4 @@', '@@ -10,2 +12,0 @@', 'diff --git a/n.ts b/n.ts', '--- /dev/null', '+++ b/n.ts', '@@ -0,0 +1,5 @@', 'diff --git a/d.ts b/d.ts', '--- a/d.ts', '+++ /dev/null', '@@ -1,3 +0,0 @@'].join('\n'))
  assert.deepEqual(changes, [{ file: 'a.ts', status: 'modified', ranges: [[3, 6], [12, 12]] }, { file: 'n.ts', status: 'added', ranges: [[1, 5]] }, { file: 'd.ts', status: 'deleted', ranges: [[1, 1]] }])
})

test('tsconfig 的注释与尾逗号', () => {
  assert.deepEqual(JSON.parse(stripJsonComments('{ // 注释\n "a": "http://x/y", /* 块 */ "b": [1, 2,], }')), { a: 'http://x/y', b: [1, 2] })
})
