import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { GraphEngine } from '../studios/engineering/src/graph/engine.ts'
import { context, impact, resolveReference, type GraphIndex } from '../studios/engineering/src/graph/query.ts'

/** 选项式写法的小项目（uni-app / Vue 2 风格）：默认导出对象、methods、this 调用、$emit、小写注册名与 module.exports。 */
const files: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'legacy-app', dependencies: { vue: '2.6.0' } }),
  'utils/money.js': 'export function formatPrice(cents) { return (cents / 100).toFixed(2) }\n',
  'api/order.js': 'import request from "../utils/request"\nexport default {\n  /** 订单详情 */\n  detail(id) { return request.get("/order/" + id) },\n  list: () => request.get("/orders"),\n  pageSize: 20\n}\n',
  'utils/request.js': 'function get(url) { return fetch(url) }\nmodule.exports = { get, post: function (url, body) { return fetch(url, { method: "POST", body }) } }\n',
  'components/priceTag.vue': '<template><text>{{ text }}</text></template>\n<script>\nexport default {\n  props: ["cents"],\n  computed: { text() { return this.cents } }\n}\n</script>\n',
  'components/OrderCard.vue': [
    '<template>',
    '  <view @click="open"><price-tag :cents="order.cents" /><text>{{ label }}</text></view>',
    '</template>',
    '<script>',
    'import { formatPrice } from "@/utils/money"',
    'import orderApi from "@/api/order"',
    'import priceTag from "./priceTag.vue"',
    'export default {',
    '  name: "OrderCard",',
    '  components: { priceTag },',
    '  props: {',
    '    order: { type: Object, required: true }',
    '  },',
    '  data() { return { label: "" } },',
    '  created() { this.refresh() },',
    '  methods: {',
    '    /** 重新取订单并刷新文案 */',
    '    refresh() { this.label = formatPrice(this.order.cents); orderApi.detail(this.order.id) },',
    '    formatPrice() { return formatPrice(1) },',
    '    open: function () { this.$emit("open", this.order.id); this.formatPrice() }',
    '  }',
    '}',
    '</script>',
  ].join('\n'),
  'mixins/share.js': 'const request = require("../utils/request")\nexport default {\n  methods: {\n    share() { request.post("/share") }\n  }\n}\n',
  'components/ShareButton.vue': '<script>\nimport share from "@/mixins/share"\nexport default {\n  mixins: [share],\n  methods: { tap() { this.share(); this.missing() } }\n}\n</script>\n',
}

let root = '', store = '', index: GraphIndex
const node = (reference: string) => { const found = resolveReference(index, reference); assert.ok('node' in found, '应能解析：' + reference + ' → ' + JSON.stringify(found)); return found.node }
const edge = (from: string, to: string, kind: string) => index.graph.edges.find(item => item.from === from && item.to === to && item.kind === kind)

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'eng-options-')))
  store = await mkdtemp(join(tmpdir(), 'eng-store-'))
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content) }
  // 非 Git 目录：走递归遍历的回退路径。
  index = (await new GraphEngine(store).ensure(root)).index
})
after(async () => { await rm(root, { recursive: true, force: true }); await rm(store, { recursive: true, force: true }) })

test('methods 里的方法成为符号，props 与 $emit 的事件进入组件接口', () => {
  const card = node('components/OrderCard.vue')
  assert.match(card.component?.props ?? '', /order: \{ type: Object, required: true \}/)
  assert.equal(card.component?.emits, '"open"')
  assert.deepEqual(context(index, card).symbols?.map(item => item.name), ['refresh', 'formatPrice', 'open'])
  const refresh = node('components/OrderCard.vue#refresh')
  assert.equal(refresh.kind, 'method')
  assert.equal(refresh.signature, 'refresh()')
  assert.equal(refresh.doc, '重新取订单并刷新文案')
  assert.equal(node('components/OrderCard.vue#open').signature, 'open: function ()')
  assert.equal(node('components/priceTag.vue').component?.props, '["cents"]')
})

test('this 调用连到本组件的方法，生命周期与模板里的使用归到组件', () => {
  assert.ok(edge('components/OrderCard.vue', 'components/OrderCard.vue#refresh', 'calls'), 'created 里的 this.refresh()')
  assert.ok(edge('components/OrderCard.vue#open', 'components/OrderCard.vue#formatPrice', 'calls'))
  assert.ok(edge('components/OrderCard.vue', 'components/OrderCard.vue#open', 'references'), '模板里的 @click="open"')
})

test('方法与导入同名时，裸调用指向导入而不是方法自己', () => {
  assert.ok(edge('components/OrderCard.vue#formatPrice', 'utils/money.js#formatPrice', 'calls'))
  assert.ok(edge('components/OrderCard.vue#refresh', 'utils/money.js#formatPrice', 'calls'))
  assert.equal(edge('components/OrderCard.vue#refresh', 'components/OrderCard.vue#formatPrice', 'calls'), undefined)
})

test('默认导出的普通对象：成员可以被 api.detail() 这样的调用找到', () => {
  const detail = node('api/order.js#default.detail')
  assert.deepEqual({ kind: detail.kind, parent: detail.parent, doc: detail.doc, exported: detail.exported }, { kind: 'method', parent: 'api/order.js#default', doc: '订单详情', exported: true })
  assert.equal(node('api/order.js#default').signature, 'export default { detail, list, pageSize }')
  assert.equal(edge('components/OrderCard.vue#refresh', 'api/order.js#default.detail', 'calls')?.confidence, 'resolved')
  const report = impact(index, [detail])
  assert.deepEqual(report.direct.map(item => item.id).sort(), ['components/OrderCard.vue', 'components/OrderCard.vue#refresh'])
})

test('module.exports 的对象与 require 的成员调用', () => {
  assert.ok(index.nodes.has('utils/request.js#default.post'))
  assert.ok(edge('mixins/share.js#share', 'utils/request.js#default.post', 'calls'))
  // 默认导入后调用成员：request.get() 连到 module.exports 里的 get。
  assert.ok(edge('api/order.js#default.detail', 'utils/request.js#default', 'calls') ?? edge('api/order.js#default.detail', 'utils/request.js', 'calls'))
})

test('混入的方法：this 调用在本组件找不到时到 mixins 里找', () => {
  assert.equal(edge('components/ShareButton.vue#tap', 'mixins/share.js#share', 'calls')?.confidence, 'resolved')
  assert.equal(index.graph.edges.filter(item => item.from === 'components/ShareButton.vue#tap' && item.kind === 'calls').length, 1)
})

test('模板标签按注册名忽略大小写与连字符匹配', () => {
  assert.equal(edge('components/OrderCard.vue', 'components/priceTag.vue', 'renders')?.confidence, 'resolved')
})
