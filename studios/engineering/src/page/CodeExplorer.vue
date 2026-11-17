<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { call, type CanvasData, type ImpactReport, type NodeContext, type Overview, type NodeBrief } from './api.ts'
import { useRequest } from './use-request.ts'
import GraphCanvas from './GraphCanvas.vue'
import ImpactView from './ImpactView.vue'
import StatTile from './StatTile.vue'
const props = defineProps<{ root: string; target?: string }>()
const canvasRequest = useRequest<CanvasData>()
const detailRequest = useRequest<{ id: string; context: NodeContext; impact: ImpactReport }>()
const searchRequest = useRequest<{ total: number; results: NodeBrief[] }>()
const projectRequest = useRequest<{ overview: Overview; canvas: CanvasData }>()
const overview = computed(() => projectRequest.data.value?.overview)
const canvas = computed(() => canvasRequest.data.value ?? projectRequest.data.value?.canvas)
const detail = detailRequest.data, results = searchRequest.data
const query = ref(''), picked = ref(''), listMode = ref(false)
const busy = computed(() => projectRequest.loading.value || canvasRequest.loading.value || detailRequest.loading.value || searchRequest.loading.value)
const error = computed(() => projectRequest.error.value || canvasRequest.error.value || detailRequest.error.value || searchRequest.error.value)
const projectName = (root: string) => root.split(/[\\/]/).filter(Boolean).pop() ?? root
const fileOf = (id: string) => id.includes('#') ? id.slice(0, id.indexOf('#')) : id
async function load() {
  projectRequest.reset(); canvasRequest.reset(); detailRequest.reset(); searchRequest.reset(); picked.value = ''; query.value = ''
  const loaded = await projectRequest.run(async signal => ({ overview: (await call({ action: 'overview', root: props.root }, signal)).overview, canvas: await call({ action: 'canvas', root: props.root }, signal) }))
  if (loaded && props.target) await inspect(props.target)
}
watch(() => props.root, load, { immediate: true })
watch(() => props.target, id => { if (id) void inspect(id) })
async function focus(cluster: string) { await canvasRequest.run(signal => call({ action: 'canvas', root: props.root, cluster }, signal)) }
async function find() {
  if (!query.value.trim()) return
  detailRequest.reset(); picked.value = ''
  await searchRequest.run(signal => call({ action: 'search', root: props.root, query: query.value }, signal))
}
async function inspect(id: string) {
  const root = props.root
  const value = await detailRequest.run(async signal => ({ id, context: await call({ action: 'context', root, target: id }, signal), impact: await call({ action: 'impact', root, target: id }, signal) }))
  if (!value || root !== props.root) return
  const file = fileOf(id)
  if (value.context.cluster && !canvas.value?.nodes.some(node => node.id === file)) await focus(value.context.cluster)
  if (root === props.root && detail.value?.id === id) picked.value = file
}
watch(picked, file => { if (!file) detailRequest.reset(); else if (fileOf(detail.value?.id ?? '') !== file) void inspect(file) })
</script>
<template>
  <section>
    <form class="flex flex-wrap gap-2" @submit.prevent="find">
      <label class="sr-only" for="symbol-search">搜索符号</label>
      <input id="symbol-search" v-model="query" class="field mt-0 min-w-0 flex-1" placeholder="搜索符号、文件或路径" spellcheck="false">
      <button class="primary" :disabled="!query.trim() || busy">搜索</button>
      <button type="button" class="ghost" @click="listMode = !listMode">{{ listMode ? '图谱画布' : '文件列表' }}</button>
    </form>
    <p v-if="error" role="alert" class="notice mt-3">{{ error }} <button class="link" @click="load">重试</button></p>
    <p v-if="busy" role="status" class="mt-2 text-xs text-muted">正在读取代码结构…</p>
    <ul v-if="listMode && canvas" class="card mt-3 max-h-96 overflow-auto p-2">
      <li v-for="node in canvas.nodes" :key="node.id"><button class="row font-mono text-xs" @click="inspect(node.id)">{{ node.id }}</button></li>
    </ul>
      <div v-if="overview && canvas" class="mt-3 grid flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
        <GraphCanvas v-if="!listMode" v-model:selected="picked" class="h-[62vh] min-h-[460px] xl:h-[calc(100dvh-280px)]" :data="canvas" :query="query" @focus="focus" />

        <aside class="card min-w-0 overflow-auto p-3 xl:max-h-[calc(100dvh-280px)]">
          <!-- 节点详情 -->
          <template v-if="detail">
            <div class="flex items-start gap-2">
              <h2 class="min-w-0 flex-1 break-all font-mono text-xs font-medium" :title="detail.id">{{ detail.id }}</h2>
              <button type="button" class="ghost shrink-0" @click="picked = ''; detail = null">关闭</button>
            </div>
            <p class="mt-1 text-xs text-muted">{{ detail.context.node.kind }} · 第 {{ detail.context.node.lines }} 行 · 被用 {{ detail.context.usedBy.total }} · 用到 {{ detail.context.uses.total }}</p>
            <button v-if="detail.context.cluster && canvas.scope === 'global'" type="button" class="link mt-1 text-xs" @click="focus(detail.context.cluster)">进入它所在的聚类 →</button>
            <pre v-if="detail.context.node.signature" class="code mt-2">{{ detail.context.node.signature }}</pre>
            <pre v-if="detail.context.node.component" class="code mt-2">{{ Object.entries(detail.context.node.component).map(([key, value]) => key + ': ' + (Array.isArray(value) ? value.join('; ') : value)).join('\n') }}</pre>
            <p v-if="detail.context.node.doc" class="mt-2 text-xs leading-5 text-muted">{{ detail.context.node.doc }}</p>
            <template v-if="detail.context.symbols?.length">
              <h3 class="mt-3 text-xs font-medium text-muted">文件里的符号 {{ detail.context.symbols.length }}</h3>
              <ul class="mt-1 space-y-0.5">
                <li v-for="item in detail.context.symbols.slice(0, 16)" :key="item.id">
                  <button type="button" class="row" :title="item.signature" @click="inspect(item.id)"><span class="min-w-0 flex-1 truncate font-mono text-xs">{{ item.name }}</span><span class="shrink-0 text-xs text-muted">{{ item.kind }} · {{ item.usedBy }}</span></button>
                </li>
              </ul>
            </template>
            <div class="mt-3 border-t border-line pt-3"><ImpactView :report="detail.impact" @select="inspect" /></div>
          </template>

          <!-- 搜索结果 -->
          <template v-else-if="results">
            <div class="flex items-center gap-2"><h2 class="flex-1 text-xs font-medium text-muted">全项目搜索结果 {{ results.total }}</h2><button type="button" class="ghost" @click="results = null; query = ''">清除</button></div>
            <ul class="mt-1.5 space-y-0.5">
              <li v-for="item in results.results" :key="item.id">
                <button type="button" class="row" :title="item.signature" @click="inspect(item.id)">
                  <span class="min-w-0 flex-1"><span class="block truncate font-mono text-xs">{{ item.name }}</span><span class="block truncate text-xs text-muted">{{ item.location }}</span></span>
                  <span class="shrink-0 text-xs text-muted">{{ item.kind }} · {{ item.usedBy }}</span>
                </button>
              </li>
            </ul>
            <p v-if="!results.results.length" class="mt-1 text-xs text-muted">没有匹配的符号</p>
          </template>

          <!-- 项目概览 -->
          <template v-else>
            <h2 class="title truncate text-sm font-semibold" :title="overview.root">{{ projectName(overview.root) }}</h2>
            <div class="mt-2 grid grid-cols-2 gap-2">
              <StatTile label="源码文件" :value="overview.stats.files" :hint="Object.entries(overview.stats.languages).map(([name, count]) => name + ' ' + count).join(' · ')" />
              <StatTile label="符号" :value="overview.stats.symbols" hint="函数、类、组件、类型" />
              <StatTile label="关系" :value="overview.stats.edges" :hint="overview.stats.inferredEdges ? overview.stats.inferredEdges + ' 条为推断' : '全部由导入确定'" />
              <StatTile label="未进图谱" :value="overview.stats.skipped" :hint="overview.stats.errors ? overview.stats.errors + ' 个只解析了一部分' : '构建产物与超大文件'" />
            </div>
            <p class="mt-3 text-xs leading-5 text-muted">
              <template v-if="canvas.scope === 'global'">图上是最大的 {{ canvas.clusters.length }} 个功能聚类里关系最多的文件<template v-if="canvas.total.hiddenClusters">，另有 {{ canvas.total.hiddenClusters }} 个较小的聚类没有画出</template>。点聚类名或下面的列表进入聚类看全部文件，点节点看它的符号与影响面。</template>
              <template v-else>正在看一个聚类的全部文件。点节点看它的符号与影响面，左上角可以回到全图。</template>
            </p>
            <h3 class="mt-3 text-xs font-medium text-muted">功能聚类</h3>
            <ul class="mt-1 space-y-0.5">
              <li v-for="item in overview.clusters" :key="item.id">
                <button type="button" class="row" :data-on="canvas.focus === item.id" :title="item.keywords.join(' · ')" @click="focus(item.id)"><span class="min-w-0 flex-1 truncate text-xs">{{ item.label }}</span><span class="shrink-0 text-xs tabular-nums text-muted">{{ item.files }} 文件 · 内聚 {{ item.cohesion }}</span></button>
              </li>
            </ul>
            <h3 class="mt-3 text-xs font-medium text-muted">被使用最多的符号</h3>
            <ul class="mt-1 space-y-0.5">
              <li v-for="hub in overview.hubs" :key="hub.id">
                <button type="button" class="row" :title="hub.signature" @click="inspect(hub.id)"><span class="min-w-0 flex-1"><span class="block truncate font-mono text-xs">{{ hub.name }}</span><span class="block truncate text-xs text-muted">{{ hub.location }}</span></span><span class="shrink-0 text-xs tabular-nums text-muted">{{ hub.usedBy }}</span></button>
              </li>
            </ul>
          </template>
        </aside>
      </div>
      <div v-else class="mt-3 flex min-h-60 flex-1 items-center justify-center rounded-xl border border-dashed border-line text-xs text-muted">{{ busy ? '正在读取图谱…' : '当前项目没有可显示的图谱' }}</div>
  </section>
</template>
