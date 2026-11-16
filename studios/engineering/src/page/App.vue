<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { call, type GraphMeta, type ImpactReport, type NodeBrief, type Overview, type Snapshot } from './api.ts'
import GlobalView from './GlobalView.vue'
import ImpactView from './ImpactView.vue'
import StatTile from './StatTile.vue'

type Tab = 'graph' | 'global' | 'skills' | 'tasks'
const tabs: { id: Tab; label: string }[] = [{ id: 'graph', label: '知识图谱' }, { id: 'global', label: '全局视图' }, { id: 'skills', label: '内置技能' }, { id: 'tasks', label: '快捷任务' }]
const tab = ref<Tab>('graph')
const snapshot = ref<Snapshot | null>(null)
const error = ref('')
/** 正在进行的操作名称；非空时禁用会触发请求的按钮 */
const busy = ref('')

const selectedRoot = ref('')
const overview = ref<Overview | null>(null)
const newRoot = ref('')
const query = ref('')
const results = ref<{ total: number; results: NodeBrief[] } | null>(null)
/** 当前查看的节点：上下文与影响面 */
const detail = ref<{ id: string; context: { node: NodeBrief & { lines: string; component?: Record<string, string | string[]> }; usedBy: { total: number }; uses: { total: number } }; impact: ImpactReport } | null>(null)
const skill = ref<{ name: string; description: string; content: string } | null>(null)
const copied = ref('')

const selected = computed<GraphMeta | undefined>(() => snapshot.value?.graphs.find(graph => graph.root === selectedRoot.value))
const projectName = (root: string) => root.split(/[\\/]/).filter(Boolean).pop() ?? root
const time = (iso: string) => new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

/** 统一处理加载状态与报错，避免每个操作各写一遍。 */
async function run<T>(label: string, task: () => Promise<T>): Promise<T | undefined> {
  if (busy.value) return undefined
  busy.value = label; error.value = ''
  try { return await task() }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '操作失败'; return undefined }
  finally { busy.value = '' }
}

async function refresh() {
  const value = await run('读取', () => call<Snapshot>())
  if (!value) return
  snapshot.value = value
  if (!selectedRoot.value && value.graphs.length) await open(value.graphs[0].root)
}

async function open(root: string) {
  selectedRoot.value = root; overview.value = null; results.value = null; detail.value = null
  const value = await run('读取概览', () => call<{ overview: Overview }>({ action: 'overview', root }))
  if (value) overview.value = value.overview
}

async function build(root: string, force = false) {
  const path = root.trim()
  if (!path) return
  const value = await run(force ? '重建图谱' : '建立图谱', () => call<{ overview: Overview }>({ action: force ? 'rebuild' : 'build', root: path }))
  if (!value) return
  newRoot.value = ''
  snapshot.value = await call<Snapshot>()
  selectedRoot.value = value.overview.root; overview.value = value.overview; results.value = null; detail.value = null
}

async function remove(root: string) {
  const value = await run('移除', () => call<Snapshot>({ action: 'remove', root }))
  if (!value) return
  snapshot.value = value
  if (selectedRoot.value === root) { selectedRoot.value = ''; overview.value = null; results.value = null; detail.value = null }
}

async function find() {
  if (!query.value.trim() || !selectedRoot.value) return
  const value = await run('搜索', () => call<{ total: number; results: NodeBrief[] }>({ action: 'search', root: selectedRoot.value, query: query.value }))
  if (value) { results.value = value; detail.value = null }
}

async function inspect(id: string) {
  const root = selectedRoot.value
  const value = await run('分析影响', async () => ({ id, context: await call<NonNullable<typeof detail.value>['context']>({ action: 'context', root, target: id }), impact: await call<ImpactReport>({ action: 'impact', root, target: id }) }))
  if (value) detail.value = value
}

/** 从「被使用最多的符号」直接查看某个符号；有请求在途时不响应，避免与搜索结果互相覆盖。 */
function pick(hub: NodeBrief) {
  if (busy.value) return
  query.value = hub.name
  results.value = { total: 1, results: [hub] }
  void inspect(hub.id)
}

async function showSkill(name: string) {
  const value = await run('读取技能', () => call<NonNullable<typeof skill.value>>({ action: 'skill', name }))
  if (value) skill.value = value
}

async function togglePrinciples() {
  if (!snapshot.value) return
  const value = await run('保存设置', () => call<Snapshot>({ action: 'configure', settings: { principles: !snapshot.value!.settings.principles } }))
  if (value) snapshot.value = value
}

async function copy(text: string) {
  await navigator.clipboard.writeText(text)
  copied.value = text
  setTimeout(() => { if (copied.value === text) copied.value = '' }, 1500)
}

onMounted(refresh)
</script>

<template>
  <main class="mx-auto flex min-h-screen max-w-6xl flex-col px-5 py-4 text-sm text-ink">
    <header class="flex flex-wrap items-center gap-3">
      <h1 class="text-base font-semibold">研发工作室</h1>
      <nav class="flex gap-1 rounded-lg bg-line/60 p-0.5">
        <button v-for="item in tabs" :key="item.id" type="button" class="tab" :data-on="tab === item.id" @click="tab = item.id">{{ item.label }}</button>
      </nav>
      <span v-if="busy" class="text-xs text-muted">{{ busy }}中…</span>
    </header>
    <p v-if="error" class="mt-3 rounded-md border border-[#f3c4c4] bg-[#fff5f5] px-3 py-2 text-xs text-[#b42318]">{{ error }}</p>

    <section v-if="tab === 'graph'" class="mt-4 grid flex-1 grid-cols-1 content-start gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside>
        <h2 class="text-xs font-medium text-muted">已建图的项目</h2>
        <ul class="mt-2 grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-1.5 lg:grid-cols-1">
          <li v-for="graph in snapshot?.graphs ?? []" :key="graph.root" class="min-w-0">
            <button type="button" class="project" :data-on="graph.root === selectedRoot" :title="graph.root" @click="open(graph.root)">
              <span class="block truncate font-medium">{{ projectName(graph.root) }}</span>
              <span class="mt-0.5 block text-xs text-muted">{{ graph.stats.files }} 个文件 · {{ graph.stats.symbols }} 个符号 · {{ time(graph.builtAt) }}</span>
            </button>
          </li>
        </ul>
        <p v-if="snapshot && !snapshot.graphs.length" class="mt-2 text-xs leading-5 text-muted">还没有图谱。在会话里发送「@研发工作室:建立知识图谱」，或在下面填写项目目录。</p>
        <form class="mt-4" @submit.prevent="build(newRoot)">
          <label class="text-xs font-medium text-muted" for="new-root">添加项目</label>
          <div class="mt-1.5 flex gap-2 lg:block">
            <input id="new-root" v-model="newRoot" class="field mt-0 flex-1" placeholder="项目的绝对路径" spellcheck="false">
            <button type="submit" class="primary shrink-0 lg:mt-2 lg:w-full" :disabled="!!busy || !newRoot.trim()">建立图谱</button>
          </div>
        </form>
        <p class="mt-3 hidden text-xs leading-5 text-muted lg:block">图谱保存在工作室数据目录，不向项目写入文件；在会话里使用时每次调用都会自动同步最新代码。</p>
      </aside>

      <div v-if="overview && selected" class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="min-w-0 flex-1 truncate font-medium" :title="overview.root">{{ overview.root }}</h2>
          <span class="text-xs text-muted">{{ overview.commit ? overview.commit.slice(0, 8) : '非 Git 目录' }}</span>
          <button type="button" class="ghost" :disabled="!!busy" @click="build(overview.root, true)">重建</button>
          <button type="button" class="ghost" :disabled="!!busy" @click="remove(overview.root)">移除</button>
        </div>
        <div class="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
          <StatTile label="源码文件" :value="overview.stats.files" :hint="Object.entries(overview.stats.languages).map(([name, count]) => name + ' ' + count).join(' · ')" />
          <StatTile label="符号" :value="overview.stats.symbols" hint="函数、类、组件、类型等" />
          <StatTile label="关系" :value="overview.stats.edges" :hint="overview.stats.inferredEdges ? '其中 ' + overview.stats.inferredEdges + ' 条为推断' : '全部由导入确定'" />
          <StatTile label="未进图谱" :value="overview.stats.skipped" :hint="overview.stats.errors ? '另有 ' + overview.stats.errors + ' 个文件只解析了一部分' : '构建产物、压缩脚本或超大文件'" />
        </div>

        <form class="mt-4 flex gap-2" @submit.prevent="find">
          <input v-model="query" class="field mt-0 flex-1" placeholder="搜索符号、组件或路径，如 useCart、OrderList、server/api" spellcheck="false">
          <button type="submit" class="primary" :disabled="!!busy || !query.trim()">搜索</button>
        </form>

        <div v-if="results" class="mt-3 grid grid-cols-1 gap-4 xl:grid-cols-2">
          <div class="min-w-0">
            <h3 class="text-xs font-medium text-muted">搜索结果 {{ results.total }}</h3>
            <ul class="mt-1.5 space-y-1">
              <li v-for="item in results.results" :key="item.id">
                <button type="button" class="row" :data-on="detail?.id === item.id" :title="item.signature" @click="inspect(item.id)">
                  <span class="min-w-0 flex-1">
                    <span class="block truncate font-mono text-xs">{{ item.name }}</span>
                    <span class="block truncate text-xs text-muted">{{ item.location }}</span>
                  </span>
                  <span class="shrink-0 text-xs text-muted">{{ item.kind }} · 被用 {{ item.usedBy }}</span>
                </button>
              </li>
            </ul>
            <p v-if="!results.results.length" class="mt-1 text-xs text-muted">没有匹配的符号</p>
          </div>
          <div v-if="detail" class="order-first min-w-0 rounded-lg border border-line bg-panel p-3 xl:order-none">
            <h3 class="truncate font-mono text-xs font-medium" :title="detail.id">{{ detail.id }}</h3>
            <p class="mt-1 text-xs text-muted">{{ detail.context.node.kind }} · 第 {{ detail.context.node.lines }} 行 · 被用 {{ detail.context.usedBy.total }} · 用到 {{ detail.context.uses.total }}</p>
            <pre v-if="detail.context.node.signature" class="code mt-2">{{ detail.context.node.signature }}</pre>
            <pre v-if="detail.context.node.component" class="code mt-2">{{ Object.entries(detail.context.node.component).map(([key, value]) => key + ': ' + (Array.isArray(value) ? value.join('; ') : value)).join('\n') }}</pre>
            <p v-if="detail.context.node.doc" class="mt-2 text-xs leading-5 text-muted">{{ detail.context.node.doc }}</p>
            <div class="mt-3 border-t border-line pt-3"><ImpactView :report="detail.impact" @select="inspect" /></div>
          </div>
        </div>

        <div v-else class="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <div class="min-w-0">
            <h3 class="text-xs font-medium text-muted">模块</h3>
            <table class="mt-1.5 w-full text-xs">
              <tbody>
                <tr v-for="module in overview.modules.slice(0, 14)" :key="module.name" class="border-b border-line/70">
                  <td class="truncate py-1.5 font-mono">{{ module.name }}</td>
                  <td class="py-1.5 text-right tabular-nums text-muted">{{ module.files }} 文件 · {{ module.symbols }} 符号</td>
                </tr>
              </tbody>
            </table>
            <h3 class="mt-4 text-xs font-medium text-muted">模块间依赖</h3>
            <ul class="mt-1.5 space-y-1 text-xs">
              <li v-for="link in overview.moduleDependencies.slice(0, 10)" :key="link.link" class="flex gap-2"><span class="min-w-0 flex-1 truncate font-mono">{{ link.link }}</span><span class="tabular-nums text-muted">{{ link.count }}</span></li>
            </ul>
          </div>
          <div class="min-w-0">
            <h3 class="text-xs font-medium text-muted">被使用最多的符号</h3>
            <ul class="mt-1.5 space-y-1">
              <li v-for="hub in overview.hubs" :key="hub.id">
                <button type="button" class="row" :title="hub.signature" @click="pick(hub)">
                  <span class="min-w-0 flex-1"><span class="block truncate font-mono text-xs">{{ hub.name }}</span><span class="block truncate text-xs text-muted">{{ hub.location }}</span></span>
                  <span class="shrink-0 text-xs tabular-nums text-muted">{{ hub.usedBy }}</span>
                </button>
              </li>
            </ul>
          </div>
        </div>
      </div>
      <div v-else class="flex min-h-40 items-center justify-center rounded-lg border border-dashed border-line text-xs text-muted">{{ busy ? busy + '中…' : '选择一个项目查看图谱' }}</div>
    </section>

    <section v-else-if="tab === 'global'" class="mt-4 flex-1">
      <div v-if="snapshot?.graphs.length" class="flex flex-wrap items-center gap-2">
        <label class="text-xs text-muted" for="global-root">项目</label>
        <select id="global-root" v-model="selectedRoot" class="field mt-0 w-auto max-w-full py-1.5">
          <option v-for="graph in snapshot.graphs" :key="graph.root" :value="graph.root">{{ projectName(graph.root) }}（{{ graph.stats.files }} 个文件）</option>
        </select>
      </div>
      <GlobalView v-if="selectedRoot" :key="selectedRoot" class="mt-3" :root="selectedRoot" />
      <p v-else class="mt-2 text-xs leading-5 text-muted">还没有图谱。先在「知识图谱」页签建图，或在会话里发送「@研发工作室:建立知识图谱」。</p>
    </section>

    <section v-else-if="tab === 'skills'" class="mt-4 grid flex-1 grid-cols-1 content-start gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <ul class="space-y-1.5">
        <li v-for="item in snapshot?.skills ?? []" :key="item.name">
          <button type="button" class="project" :data-on="skill?.name === item.name" @click="showSkill(item.name)">
            <span class="block font-mono text-xs font-medium">{{ item.name }}</span>
            <span class="mt-0.5 block text-xs leading-5 text-muted">{{ item.description }}</span>
          </button>
        </li>
      </ul>
      <article v-if="skill" class="order-first min-w-0 rounded-lg border border-line bg-panel p-4 lg:order-none">
        <div class="flex items-center gap-2"><h2 class="flex-1 font-mono text-sm font-medium">{{ skill.name }}</h2><button type="button" class="ghost" @click="copy('/' + skill.name)">{{ copied === '/' + skill.name ? '已复制' : '复制调用命令' }}</button></div>
        <pre class="mt-3 whitespace-pre-wrap text-xs leading-6">{{ skill.content }}</pre>
      </article>
      <div v-else class="order-first flex items-center justify-center rounded-lg border border-dashed border-line px-6 py-6 text-center text-xs leading-5 text-muted lg:order-none">这些技能随工作室登记到宿主的技能目录：模型在相应场景自动加载，也可以在会话里输入「/技能名」直接调用。</div>
    </section>

    <section v-else class="mt-4 max-w-3xl">
      <p class="text-xs leading-5 text-muted">在任意项目会话里输入下面的写法即可发起任务，后面可以接需求文档路径或补充说明。</p>
      <ul class="mt-3 space-y-2">
        <li v-for="task in snapshot?.tasks ?? []" :key="task.id" class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-panel px-3 py-2.5">
          <span class="min-w-40 flex-1"><span class="block font-medium">{{ task.label }}</span><span class="block text-xs text-muted">{{ task.description }}</span></span>
          <code class="shrink-0 rounded bg-canvas px-2 py-1 text-xs">@研发工作室:{{ task.label }}</code>
          <button type="button" class="ghost" @click="copy('@研发工作室:' + task.label + ' ')">{{ copied === '@研发工作室:' + task.label + ' ' ? '已复制' : '复制' }}</button>
        </li>
      </ul>
      <div v-if="snapshot" class="mt-5 rounded-lg border border-line bg-panel p-3">
        <label class="flex cursor-pointer items-start gap-2.5">
          <input type="checkbox" class="mt-0.5" :checked="snapshot.settings.principles" :disabled="!!busy" @change="togglePrinciples">
          <span><span class="block font-medium">常驻编码准则</span><span class="mt-0.5 block text-xs leading-5 text-muted">开启后，所有会话的系统提示词都会带上四条编码准则的摘要；关闭后只在研发任务里使用。</span></span>
        </label>
        <p class="mt-2 rounded-md bg-canvas px-2.5 py-2 text-xs leading-5 text-muted">{{ snapshot.principles }}</p>
      </div>
      <details v-if="snapshot" class="mt-3 text-xs text-muted">
        <summary class="cursor-pointer">查看写入系统提示词的调用指引</summary>
        <p class="mt-2 leading-5">{{ snapshot.instructions }}</p>
      </details>
    </section>
  </main>
</template>
