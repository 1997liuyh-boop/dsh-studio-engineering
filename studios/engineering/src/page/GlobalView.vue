<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { call, type ArchiveResult, type ClusterDetail, type FlowDetail, type FlowStepView, type HealthReport, type TraceView, type ViewsPayload } from './api.ts'
import ClusterMap from './ClusterMap.vue'
import HealthPanel from './HealthPanel.vue'
import { RequestGate } from './request-state.ts'

/**
 * 全局视图：先回答「这个项目怎么样」——体检总览、质量、依赖、迭代情况与改动难度，
 * 再往下是结构层面的架构图、执行流程、路由表、循环依赖与路径追踪。
 */
interface Props {
  /** 已建过图谱的项目根目录 */
  root: string
  mode: 'health' | 'structure'
}
const props = defineProps<Props>()

type HealthSection = 'summary' | 'quality' | 'dependencies' | 'iteration' | 'difficulty'
type Section = HealthSection | 'map' | 'flows' | 'routes' | 'cycles' | 'trace'
const healthSections: { id: HealthSection; label: string }[] = [{ id: 'summary', label: '总览' }, { id: 'quality', label: '质量' }, { id: 'dependencies', label: '依赖' }, { id: 'iteration', label: '迭代' }, { id: 'difficulty', label: '难度' }]
const sections: { id: Section; label: string }[] = [{ id: 'map', label: '架构图' }, { id: 'flows', label: '执行流程' }, { id: 'routes', label: '路由' }, { id: 'cycles', label: '循环依赖' }, { id: 'trace', label: '路径追踪' }]
const isHealth = (id: Section): id is HealthSection => healthSections.some(item => item.id === id)
const section = ref<Section>(props.mode === 'health' ? 'summary' : 'map')
const views = ref<ViewsPayload | null>(null)
/** 项目体检报告；与结构视图分开加载，读提交历史较慢时不挡住其余页面 */
const health = ref<HealthReport | null>(null)
const archive = ref<ArchiveResult | null>(null)
const error = ref('')
const loading = ref('')

const selectedCluster = ref('')
const cluster = ref<ClusterDetail | null>(null)
const showFiles = ref(false)
const flowQuery = ref('')
const flow = ref<FlowDetail | null>(null)
const routeQuery = ref('')
const traceFrom = ref('')
const traceTo = ref('')
const traced = ref<TraceView | null>(null)

const gate = new RequestGate()
onBeforeUnmount(() => gate.cancel())
/** 新操作使旧读取失效；卸载后不再把结果写回界面。 */
async function run<T>(label: string, task: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  const ticket = gate.begin()
  loading.value = label; error.value = ''
  try { const value = await task(ticket.signal); return ticket.current() ? value : undefined }
  catch (cause) { if (ticket.current()) error.value = cause instanceof Error ? cause.message : '操作失败'; return undefined }
  finally { if (ticket.current()) loading.value = '' }
}
async function load() {
  views.value = null; health.value = null; archive.value = null; cluster.value = null; flow.value = null; traced.value = null; selectedCluster.value = ''
  if (props.mode === 'health') {
    const value = await run('读取项目体检', signal => call({ action: 'health', root: props.root }, signal))
    if (value) health.value = value
  } else {
    const value = await run('读取代码结构', signal => call({ action: 'views', root: props.root }, signal))
    if (value) views.value = value
  }
}

/** 把体检结果写成项目档案（docs/engineering 下的两个文件）。 */
async function exportArchive() {
  const value = await run('导出项目档案', signal => call({ action: 'export', root: props.root }, signal))
  if (value) archive.value = value
}
watch(() => props.root, load, { immediate: true })

/** 架构图里选中聚类后取它的详情；取消选中时清空。 */
watch(selectedCluster, async id => {
  showFiles.value = false
  if (!id) { cluster.value = null; return }
  const value = await run('读取聚类', signal => call({ action: 'cluster', root: props.root, id }, signal))
  if (value && selectedCluster.value === id) cluster.value = value
})

const filteredFlows = computed(() => {
  const needle = flowQuery.value.trim().toLowerCase()
  const list = views.value?.flows.flows ?? []
  return needle ? list.filter(item => item.label.toLowerCase().includes(needle) || item.id.toLowerCase().includes(needle)) : list
})
const filteredRoutes = computed(() => {
  const needle = routeQuery.value.trim().toLowerCase()
  const list = views.value?.routes.routes ?? []
  return needle ? list.filter(item => item.path.toLowerCase().includes(needle) || item.file.toLowerCase().includes(needle) || (item.title ?? '').toLowerCase().includes(needle)) : list
})

async function openFlow(id: string) {
  section.value = 'flows'
  const value = await run('读取流程', signal => call({ action: 'flow', root: props.root, id }, signal))
  if (value) flow.value = value
}

/** 按「经由」关系把广度优先的步骤排成树：每一步紧跟在它的上一步后面。 */
const flowRows = computed(() => {
  const steps = flow.value?.steps ?? []
  const children = new Map<string, FlowStepView[]>()
  for (const step of steps.slice(1)) { const list = children.get(step.via ?? ''); if (list) list.push(step); else children.set(step.via ?? '', [step]) }
  const rows: FlowStepView[] = []
  const visit = (step: FlowStepView) => { rows.push(step); for (const child of children.get(step.id) ?? []) visit(child) }
  if (steps[0]) visit(steps[0])
  return rows
})
const relationLabels: Record<string, string> = { calls: '调用', renders: '渲染', references: '引用', extends: '继承', implements: '实现', contains: '包含' }
const nameOf = (id: string) => id.includes('#') ? id.slice(id.indexOf('#') + 1) : id.slice(id.lastIndexOf('/') + 1)

async function runTrace() {
  if (!traceFrom.value.trim() || !traceTo.value.trim()) return
  const value = await run('追踪路径', signal => call({ action: 'trace', root: props.root, from: traceFrom.value, to: traceTo.value }, signal))
  if (value) traced.value = value
}

/** 从其他视图带着起点跳到路径追踪。 */
function traceFromHere(id: string) { traceFrom.value = id; traced.value = null; section.value = 'trace' }
</script>

<template>
  <div class="min-w-0">
    <div class="flex flex-wrap items-center gap-2">
      <nav class="flex flex-wrap items-center gap-1">

        <button v-for="item in (mode === 'health' ? healthSections : [])" :key="item.id" type="button" class="chip" :data-on="section === item.id" @click="section = item.id">
          {{ item.label }}
          <span v-if="health && item.id === 'quality'" class="tabular-nums" :class="health.quality.grade === 'A' ? 'text-jade' : 'text-accent'">{{ health.quality.grade }}</span>
        </button>

        <button v-for="item in (mode === 'structure' ? sections : [])" :key="item.id" type="button" class="chip" :data-on="section === item.id" @click="section = item.id">
          {{ item.label }}
          <span v-if="views && item.id === 'map'" class="tabular-nums text-muted">{{ views.clusters.total }}</span>
          <span v-if="views && item.id === 'flows'" class="tabular-nums text-muted">{{ views.flows.total }}</span>
          <span v-if="views && item.id === 'routes'" class="tabular-nums text-muted">{{ views.routes.total }}</span>
          <span v-if="views && item.id === 'cycles'" class="tabular-nums" :class="views.cycles.total ? 'text-danger' : 'text-muted'">{{ views.cycles.total }}</span>
        </button>
      </nav>
      <span v-if="loading" class="text-xs text-muted">{{ loading }}中…</span>
    </div>
    <p v-if="error" role="alert" class="notice mt-3">{{ error }} <button class="link" @click="load">重新读取</button></p>

    <div v-if="isHealth(section)" class="mt-3">
      <HealthPanel v-if="health" :report="health" :section="section" :archive="archive" :busy="!!loading" @export="exportArchive" @go="section = $event" />
      <div v-else-if="!error" class="flex min-h-40 items-center justify-center rounded-xl border border-dashed border-line text-xs text-muted">正在读取提交历史并做体检…</div>
    </div>

    <template v-else-if="views">
      <!-- 架构图：聚类关系图 + 详情 + 表格视图 -->
      <section v-if="section === 'map'" class="mt-3">
        <p class="text-xs leading-5 text-muted">圆的大小是文件数，连线粗细是两个聚类之间的调用与引用数。点一个圆查看它负责什么、依赖谁；共 {{ views.clusters.total }} 个聚类，另有 {{ views.clusters.scatteredFiles }} 个散落文件未归类。</p>
        <div class="mt-2 grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div class="min-w-0 rounded-lg border border-line bg-panel p-2">
            <ClusterMap v-model:selected="selectedCluster" :clusters="views.clusters.clusters" :links="views.clusters.links" />
          </div>
          <aside v-if="cluster" class="min-w-0 rounded-lg border border-line bg-panel p-3 text-xs">
            <h3 class="text-sm font-medium text-ink">{{ cluster.label }}</h3>
            <p class="mt-1 text-muted">{{ cluster.files }} 个文件 · {{ cluster.symbols }} 个符号 · {{ cluster.entries }} 个入口 · 内聚 {{ cluster.cohesion }}</p>
            <p v-if="cluster.keywords.length" class="mt-2"><span class="text-muted">关键词</span> {{ cluster.keywords.join(' · ') }}</p>
            <h4 class="mt-3 font-medium text-ink">主要目录</h4>
            <ul class="mt-1 space-y-0.5"><li v-for="dir in cluster.directories" :key="dir.path" class="flex gap-2"><span class="min-w-0 flex-1 truncate font-mono">{{ dir.path }}</span><span class="tabular-nums text-muted">{{ dir.files }}</span></li></ul>
            <h4 v-if="cluster.members.length" class="mt-3 font-medium text-ink">对外提供最多的</h4>
            <ul class="mt-1 space-y-0.5"><li v-for="member in cluster.members" :key="member.id" class="flex gap-2"><button type="button" class="link min-w-0 flex-1 truncate text-left font-mono" :title="member.id" @click="traceFromHere(member.id)">{{ nameOf(member.id) }}</button><span class="tabular-nums text-muted">{{ member.usedBy }}</span></li></ul>
            <h4 v-if="cluster.dependsOn.length" class="mt-3 font-medium text-ink">依赖</h4>
            <ul class="mt-1 space-y-0.5"><li v-for="item in cluster.dependsOn" :key="item.cluster" class="flex gap-2"><button type="button" class="link min-w-0 flex-1 truncate text-left" @click="selectedCluster = item.cluster">{{ item.label }}</button><span class="tabular-nums text-muted">{{ item.weight }}</span></li></ul>
            <h4 v-if="cluster.usedBy.length" class="mt-3 font-medium text-ink">被依赖</h4>
            <ul class="mt-1 space-y-0.5"><li v-for="item in cluster.usedBy" :key="item.cluster" class="flex gap-2"><button type="button" class="link min-w-0 flex-1 truncate text-left" @click="selectedCluster = item.cluster">{{ item.label }}</button><span class="tabular-nums text-muted">{{ item.weight }}</span></li></ul>
            <button type="button" class="ghost mt-3" @click="showFiles = !showFiles">{{ showFiles ? '收起文件' : '查看全部 ' + cluster.files + ' 个文件' }}</button>
            <ul v-if="showFiles" class="mt-2 max-h-64 space-y-0.5 overflow-auto font-mono"><li v-for="item in cluster.fileList" :key="item.file" class="truncate" :title="item.file">
              <button v-if="item.entry" type="button" class="link text-left" @click="openFlow(item.file)">{{ item.file }}</button><span v-else>{{ item.file }}</span>
            </li></ul>
          </aside>
          <aside v-else class="flex min-h-40 items-center justify-center rounded-lg border border-dashed border-line px-4 text-center text-xs leading-5 text-muted">点击架构图里的圆，或下表中的一行，查看聚类详情</aside>
        </div>
        <table class="mt-3 w-full text-xs">
          <thead><tr class="border-b border-line text-left text-muted"><th class="py-1.5 font-normal">聚类</th><th class="py-1.5 text-right font-normal">文件</th><th class="w-32 py-1.5 pl-3 font-normal">内聚</th><th class="hidden py-1.5 pl-3 font-normal md:table-cell">关键词</th></tr></thead>
          <tbody>
            <tr v-for="item in views.clusters.clusters" :key="item.id" class="cursor-pointer border-b border-line/70 hover:bg-canvas" tabindex="0" @keydown.enter="selectedCluster = item.id" @keydown.space.prevent="selectedCluster = item.id" :data-on="selectedCluster === item.id" @click="selectedCluster = item.id">
              <td class="max-w-0 truncate py-1.5" :class="selectedCluster === item.id ? 'font-medium text-accent' : ''" :title="item.label">{{ item.label }}</td>
              <td class="py-1.5 text-right tabular-nums">{{ item.files }}</td>
              <td class="py-1.5 pl-3"><span class="flex items-center gap-1.5"><span class="h-1.5 flex-1 overflow-hidden rounded-full bg-line"><span class="block h-full rounded-full bg-accent" :style="{ width: item.cohesion * 100 + '%' }" /></span><span class="w-8 tabular-nums text-muted">{{ item.cohesion }}</span></span></td>
              <td class="hidden max-w-0 truncate py-1.5 pl-3 text-muted md:table-cell">{{ item.keywords.join(' · ') }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- 执行流程：列表 + 逐层展开的调用链 -->
      <section v-else-if="section === 'flows'" class="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div class="min-w-0">
          <input v-model="flowQuery" class="field mt-0" placeholder="按页面标题、路由或文件过滤" spellcheck="false">
          <p class="mt-2 text-xs leading-5 text-muted">{{ views.flows.note }}</p>
          <ul class="mt-2 space-y-1">
            <li v-for="item in filteredFlows.slice(0, 200)" :key="item.id">
              <button type="button" class="row items-start" :data-on="flow?.id === item.id" @click="openFlow(item.id)">
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-xs font-medium">{{ item.label }}</span>
                  <span class="block truncate text-xs text-muted">终点：{{ item.terminals.slice(0, 3).join('、') || '无' }}</span>
                </span>
                <span class="shrink-0 text-xs tabular-nums text-muted">{{ item.steps }}{{ item.truncated ? '+' : '' }} 步</span>
              </button>
            </li>
          </ul>
          <p v-if="!filteredFlows.length" class="mt-2 text-xs text-muted">没有匹配的流程</p>
        </div>
        <div v-if="flow" class="order-first min-w-0 rounded-lg border border-line bg-panel p-3 xl:order-none">
          <div class="flex items-start gap-2">
            <h3 class="min-w-0 flex-1 text-sm font-medium">{{ flow.label }}</h3>
            <button type="button" class="ghost shrink-0" @click="traceFromHere(flow.id)">从这里追踪</button>
          </div>
          <p class="mt-1 text-xs text-muted">{{ flow.steps.length }} 步<template v-if="flow.truncated">（已达上限，后面还有）</template> · 经过 {{ flow.clusters.length }} 个聚类：{{ flow.clusters.slice(0, 4).join('、') }}</p>
          <ol class="mt-3 max-h-[560px] space-y-0.5 overflow-auto">
            <li v-for="step in flowRows" :key="step.id" class="flex items-baseline gap-2 text-xs" :style="{ paddingLeft: step.depth * 14 + 'px' }">
              <span v-if="step.relation" class="shrink-0 text-muted">{{ relationLabels[step.relation] ?? step.relation }}</span>
              <span class="min-w-0 truncate font-mono" :class="step.depth === 0 ? 'font-medium' : ''" :title="step.id">{{ nameOf(step.id) }}</span>
              <span v-if="step.inferred" class="shrink-0 text-amber" title="经过按命名约定推断的关系">推断</span>
              <span class="ml-auto shrink-0 truncate text-muted" :title="step.location">{{ step.location.slice(step.location.lastIndexOf('/') + 1) }}</span>
            </li>
          </ol>
        </div>
        <div v-else class="order-first flex min-h-40 items-center justify-center rounded-lg border border-dashed border-line text-xs text-muted xl:order-none">选择一条流程查看调用链</div>
      </section>

      <!-- 路由表 -->
      <section v-else-if="section === 'routes'" class="mt-3">
        <input v-model="routeQuery" class="field mt-0" placeholder="按路径、标题或文件过滤" spellcheck="false">
        <p class="mt-2 text-xs leading-5 text-muted">{{ views.routes.note }}</p>
        <table v-if="filteredRoutes.length" class="mt-2 w-full text-xs">
          <thead><tr class="border-b border-line text-left text-muted"><th class="py-1.5 font-normal">路径</th><th class="py-1.5 font-normal">标题</th><th class="hidden py-1.5 font-normal md:table-cell">位置</th><th class="py-1.5 text-right font-normal">调用链</th></tr></thead>
          <tbody>
            <tr v-for="route in filteredRoutes.slice(0, 400)" :key="route.kind + route.path + route.file" class="border-b border-line/70">
              <td class="max-w-0 truncate py-1.5 font-mono" :title="route.file"><span v-if="route.method" class="mr-1 text-muted">{{ route.method }}</span>{{ route.path }}</td>
              <td class="max-w-0 truncate py-1.5">{{ route.title || '—' }}</td>
              <td class="hidden py-1.5 text-muted md:table-cell"><span v-if="route.kind === 'api'">接口</span><span v-else-if="route.tab">底部导航</span><span v-else-if="route.subPackage">分包 {{ route.subPackage }}</span><span v-else>主包</span></td>
              <td class="py-1.5 text-right"><button v-if="route.flowSteps" type="button" class="link tabular-nums" @click="openFlow(route.file)">{{ route.flowSteps }} 步</button><span v-else class="text-muted">—</span></td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- 循环依赖 -->
      <section v-else-if="section === 'cycles'" class="mt-3">
        <p class="text-xs leading-5 text-muted">{{ views.cycles.note }}</p>
        <p v-if="!views.cycles.total" class="mt-3 rounded-md bg-canvas px-3 py-2 text-xs text-muted">没有发现循环导入。</p>
        <ul class="mt-2 space-y-2">
          <li v-for="(cycle, at) in views.cycles.cycles" :key="at" class="rounded-lg border border-line bg-panel p-3 text-xs">
            <div class="font-medium">{{ cycle.size }} 个文件互相依赖</div>
            <ol class="mt-2 space-y-0.5 font-mono">
              <li v-for="(file, step) in cycle.path" :key="step" class="flex gap-2"><span class="w-4 shrink-0 text-right text-muted">{{ step ? '→' : '' }}</span><span class="min-w-0 truncate" :title="file">{{ file }}</span></li>
            </ol>
            <details v-if="cycle.size > cycle.path.length - 1" class="mt-2 text-muted"><summary class="cursor-pointer">组内全部文件</summary><ul class="mt-1 font-mono"><li v-for="file in cycle.files" :key="file" class="truncate">{{ file }}</li></ul></details>
          </li>
        </ul>
      </section>

      <!-- 路径追踪 -->
      <section v-else class="mt-3 max-w-3xl">
        <form class="grid grid-cols-1 gap-2 md:grid-cols-[1fr_1fr_auto]" @submit.prevent="runTrace">
          <input v-model="traceFrom" class="field mt-0" placeholder="起点：路径#符号、文件或符号名" spellcheck="false">
          <input v-model="traceTo" class="field mt-0" placeholder="终点，如 request" spellcheck="false">
          <button type="submit" class="primary" :disabled="!!loading || !traceFrom.trim() || !traceTo.trim()">追踪</button>
        </form>
        <p class="mt-2 text-xs leading-5 text-muted">沿调用、渲染、引用与继承关系找最短路径；正向找不到时会给出反向路径。</p>
        <div v-if="traced" class="mt-3 rounded-lg border border-line bg-panel p-3 text-xs">
          <template v-if="traced.issue">
            <p>{{ traced.issue }}</p>
            <ul v-if="traced.candidates" class="mt-1 font-mono"><li v-for="item in traced.candidates" :key="item.id">{{ item.id }}</li></ul>
            <p v-if="traced.suggestions?.length" class="mt-1 text-muted">相近的：{{ traced.suggestions.join('、') }}</p>
          </template>
          <p v-else-if="!traced.found" class="text-muted">{{ traced.note }}</p>
          <template v-else>
            <p v-if="traced.note" class="mb-2 text-amber">{{ traced.note }}</p>
            <ol class="space-y-1">
              <li v-for="(hop, step) in traced.hops" :key="hop.id" class="flex items-baseline gap-2">
                <span class="w-10 shrink-0 text-right text-muted">{{ step ? (relationLabels[hop.relation ?? ''] ?? hop.relation) : '起点' }}</span>
                <span class="min-w-0 truncate font-mono" :title="hop.id">{{ hop.id }}</span>
                <span v-if="hop.inferred" class="shrink-0 text-amber">推断</span>
                <span class="ml-auto shrink-0 text-muted">{{ hop.location.slice(hop.location.lastIndexOf('/') + 1) }}</span>
              </li>
            </ol>
          </template>
        </div>
      </section>
    </template>
    <div v-else-if="!error" class="mt-3 flex min-h-40 items-center justify-center rounded-xl border border-dashed border-line text-xs text-muted">{{ loading || '计算全局视图' }}中…</div>
  </div>
</template>
