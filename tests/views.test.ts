import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { GraphEngine } from '../studios/engineering/src/graph/engine.ts'
import { clusterDetail, clusterList, cycleList, flowDetail, flowList, routeList, traceResult } from '../studios/engineering/src/graph/present.ts'
import { impact, resolveReference, type GraphIndex } from '../studios/engineering/src/graph/query.ts'
import { detectRoutes } from '../studios/engineering/src/graph/routes.ts'
import { loadLayout } from '../studios/engineering/src/graph/layout.ts'
import { louvain, viewsOf } from '../studios/engineering/src/graph/views.ts'

/** 小型 uni-app 项目：订单与用户两组功能、共用的请求层、pages.json 分包与底部导航，以及一处循环导入。 */
const files: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'mini-shop', dependencies: { vue: '2.6.0' } }),
  'pages.json': [
    '{',
    '  // 条件编译与注释都要能读',
    '  "pages": [',
    '    { "path": "pages/index/index", "style": { "navigationBarTitleText": "首页" } },',
    '    { "path": "pages/order/list", "style": { "navigationBarTitleText": "%order.title%" } }',
    '  ],',
    '  "subPackages": [{ "root": "sub/user", "pages": [{ "path": "profile", "style": { "navigationBarTitleText": "个人中心" } }, { "path": "missing" }] }],',
    '  "tabBar": { "list": [{ "pagePath": "pages/index/index", "text": "首页" }] },',
    '}',
  ].join('\n'),
  'utils/request.js': 'import store from "../store/index"\nexport function request(url) { return fetch(url + store.token) }\n',
  'store/index.js': 'import { refreshToken } from "../api/auth"\nexport default { token: "", refresh() { refreshToken() } }\n',
  'api/auth.js': 'import { request } from "../utils/request"\nexport function refreshToken() { return request("/auth/refresh") }\n',
  'api/order.js': 'import { request } from "../utils/request"\nexport function listOrders() { return request("/orders") }\nexport function cancelOrder(id) { return request("/orders/" + id + "/cancel") }\nexport function orderDetail(id) { return request("/orders/" + id) }\n',
  'api/user.js': 'import { request } from "../utils/request"\nexport function getProfile() { return request("/me") }\nexport function updateProfile(data) { return request("/me", data) }\n',
  'components/order/OrderItem.vue': '<template><view @click="cancel">{{ order.id }}</view></template>\n<script>\nimport { cancelOrder } from "@/api/order"\nexport default { props: ["order"], methods: { cancel() { cancelOrder(this.order.id) } } }\n</script>\n',
  'components/order/OrderSummary.vue': '<template><view>{{ total }}</view></template>\n<script>\nimport { orderDetail } from "@/api/order"\nexport default { methods: { load() { orderDetail(1) } } }\n</script>\n',
  'pages/order/list.vue': '<template><view><order-item v-for="o in list" :order="o" /><order-summary /></view></template>\n<script>\nimport { listOrders } from "@/api/order"\nimport OrderItem from "@/components/order/OrderItem.vue"\nimport OrderSummary from "@/components/order/OrderSummary.vue"\nexport default { components: { OrderItem, OrderSummary }, onLoad() { listOrders() } }\n</script>\n',
  'components/user/Avatar.vue': '<template><image /></template>\n<script>\nimport { getProfile } from "@/api/user"\nexport default { methods: { load() { getProfile() } } }\n</script>\n',
  'components/user/ProfileForm.vue': '<template><form @submit="save" /></template>\n<script>\nimport { updateProfile, getProfile } from "@/api/user"\nexport default { methods: { save() { updateProfile({}); getProfile() } } }\n</script>\n',
  'sub/user/profile.vue': '<template><view><avatar /><profile-form /></view></template>\n<script>\nimport Avatar from "@/components/user/Avatar.vue"\nimport ProfileForm from "@/components/user/ProfileForm.vue"\nimport { getProfile } from "@/api/user"\nexport default { components: { Avatar, ProfileForm }, onShow() { getProfile() } }\n</script>\n',
  'pages/index/index.vue': '<template><view>首页</view></template>\n<script>\nexport default {}\n</script>\n',
  'App.vue': '<script>\nimport store from "./store/index"\nexport default { onLaunch() { store.refresh() } }\n</script>\n',
}

let root = '', store = '', index: GraphIndex
const node = (reference: string) => { const found = resolveReference(index, reference); assert.ok('node' in found, '应能解析：' + reference); return found.node }

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'eng-views-')))
  store = await mkdtemp(join(tmpdir(), 'eng-store-'))
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content) }
  index = (await new GraphEngine(store).ensure(root)).index
})
after(async () => { await rm(root, { recursive: true, force: true }); await rm(store, { recursive: true, force: true }) })

test('Louvain：两团各自紧密、彼此只有一条边的图分成两组', () => {
  const edges: [number, number][] = [[0, 1], [1, 2], [0, 2], [3, 4], [4, 5], [3, 5], [2, 3]]
  const adjacency = Array.from({ length: 6 }, () => new Map<number, number>())
  for (const [a, b] of edges) { adjacency[a].set(b, 1); adjacency[b].set(a, 1) }
  const groups = louvain(6, adjacency)
  assert.equal(groups[0], groups[1]); assert.equal(groups[1], groups[2])
  assert.equal(groups[3], groups[4]); assert.equal(groups[4], groups[5])
  assert.notEqual(groups[0], groups[3])
})

test('路由：pages.json 的主包、分包与底部导航，国际化占位标题不当作标题，找不到文件的页面跳过', () => {
  const routes = routeList(index)
  assert.deepEqual(routes.routes.map(route => [route.path, route.file, route.title ?? '', route.tab ?? false, route.subPackage ?? '']), [
    ['/pages/index/index', 'pages/index/index.vue', '首页', true, ''],
    ['/pages/order/list', 'pages/order/list.vue', '', false, ''],
    ['/sub/user/profile', 'sub/user/profile.vue', '个人中心', false, 'sub/user'],
  ])
  assert.deepEqual(routes.sources, ['pages.json'])
  assert.equal(routeList(index, { query: '个人' }).total, 1)
})

test('Nuxt：pages 目录的动态段与 server 接口的方法后缀', async () => {
  const sources = ['app/pages/index.vue', 'app/pages/orders/[id].vue', 'app/pages/docs/[...slug].vue', 'server/api/orders.get.ts', 'server/api/orders/[id].delete.ts', 'server/routes/health.ts']
  const layout = await loadLayout(root, sources, [])
  layout.nuxt.push({ dir: '', srcDir: 'app' })
  const routes = await detectRoutes(root, layout, [])
  assert.deepEqual(routes.map(route => (route.method ? route.method + ' ' : '') + route.path), ['GET /api/orders', 'DELETE /api/orders/:id', '/health', '/', '/docs/:slug*', '/orders/:id'])
})

test('功能聚类：订单与用户各成一组，名称取主要目录', () => {
  const list = clusterList(index)
  const orderCluster = viewsOf(index).clusterOf.get('components/order/OrderItem.vue')
  const userCluster = viewsOf(index).clusterOf.get('components/user/ProfileForm.vue')
  assert.ok(orderCluster && userCluster && orderCluster !== userCluster, JSON.stringify(list.clusters.map(cluster => cluster.label)))
  assert.equal(viewsOf(index).clusterOf.get('api/order.js'), orderCluster)
  assert.equal(viewsOf(index).clusterOf.get('sub/user/profile.vue'), userCluster)
  const detail = clusterDetail(index, userCluster)!
  assert.ok(detail.fileList.some(item => item.file === 'sub/user/profile.vue' && item.entry))
  assert.ok(detail.cohesion > 0 && detail.cohesion <= 1)
})

test('执行流程：从路由页面出发逐层展开，终点是底层请求', () => {
  const detail = flowDetail(index, 'pages/order/list.vue')!
  assert.equal(detail.route, '/pages/order/list')
  assert.equal(detail.label, '/pages/order/list')
  const ids = detail.steps.map(step => step.id)
  assert.ok(ids.includes('api/order.js#listOrders'))
  assert.ok(ids.includes('components/order/OrderItem.vue'))
  // 子组件里的调用也会被展开。
  assert.ok(ids.includes('api/order.js#cancelOrder'))
  assert.equal(detail.steps.find(step => step.id === 'utils/request.js#request')?.depth, 2)
  assert.ok(detail.terminals.includes('request'))
  assert.equal(flowDetail(index, 'sub/user/profile.vue')?.title, '个人中心')
  // 有路由表时，组件不算入口；App.vue 作为启动文件算入口。
  const entries = flowList(index, { limit: 50 }).flows.map(flow => flow.id)
  assert.ok(entries.includes('App.vue'))
  assert.ok(!entries.some(id => id.startsWith('components/')))
  // 经过某个函数的流程。
  assert.deepEqual(flowList(index, { through: node('api/user.js#updateProfile') }).flows.map(flow => flow.id), ['sub/user/profile.vue'])
})

test('影响分析列出会经过改动的页面流程与波及的聚类', () => {
  const report = impact(index, [node('api/order.js#cancelOrder')])
  assert.deepEqual(report.summary.flows.map(flow => flow.id), ['pages/order/list.vue'])
  assert.ok(report.summary.clusters.length >= 1)
  assert.ok(report.summary.entries.includes('pages/order/list.vue'))
})

test('路径追踪：正向最短路径，反向时说明方向，不连通时说明原因', () => {
  const forward = traceResult(index, node('sub/user/profile.vue'), node('utils/request.js#request'))
  assert.equal(forward.found, true)
  assert.equal(forward.direction, 'forward')
  assert.deepEqual(forward.hops!.map(hop => hop.id), ['sub/user/profile.vue', 'api/user.js#getProfile', 'utils/request.js#request'])
  const reverse = traceResult(index, node('utils/request.js#request'), node('pages/order/list.vue'))
  assert.equal(reverse.direction, 'reverse')
  assert.match(reverse.note ?? '', /反向/)
  const none = traceResult(index, node('pages/index/index.vue'), node('api/user.js#updateProfile'))
  assert.equal(none.found, false)
})

test('循环依赖：找出 request → store → auth → request 的循环', () => {
  const cycles = cycleList(index)
  assert.equal(cycles.total, 1)
  assert.deepEqual(cycles.cycles[0].files, ['api/auth.js', 'store/index.js', 'utils/request.js'])
  assert.deepEqual(cycles.cycles[0].path, ['api/auth.js', 'utils/request.js', 'store/index.js', 'api/auth.js'])
})

test('pages.json 改动后路由会重算，源码没变也一样', async () => {
  await writeFile(join(root, 'pages.json'), files['pages.json'].replace('"首页" } }', '"商城首页" } }'))
  const updated = await new GraphEngine(store).ensure(root)
  assert.equal(updated.freshness.changed, 0)
  assert.equal((updated.index.graph.routes ?? []).find(route => route.file === 'pages/index/index.vue')?.title, '商城首页')
})
