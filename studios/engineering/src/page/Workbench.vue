<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { call, type Snapshot } from './api.ts'
import { useRequest } from './use-request.ts'
import GlobalView from './GlobalView.vue'
import CodeExplorer from './CodeExplorer.vue'
import ChangesPanel from './ChangesPanel.vue'
import PlansPanel from './PlansPanel.vue'
import PrinciplesPanel from './PrinciplesPanel.vue'
type Page = 'overview' | 'explore' | 'changes' | 'plans' | 'principles'
const pages: { id: Page; label: string; description: string }[] = [
  { id: 'overview', label: '项目总览', description: '从质量依据和改动热点，找到最值得先做的事。' },
  { id: 'explore', label: '代码探索', description: '沿着文件、符号与执行流程，理解代码如何协作。' },
  { id: 'changes', label: '改动分析', description: '把当前 Git 改动映射到符号，确认影响范围与回归重点。' },
  { id: 'plans', label: '迭代方案', description: '阅读真实方案，并对照当前代码核对实施情况。' },
  { id: 'principles', label: '编码准则', description: '管理工程方法与全局附加规则，查看模型实际收到的要求。' },
]
function remembered(key: string): string {
  try { return localStorage.getItem('engineering.' + key) ?? '' }
  catch (error) { return '' /* 禁止存储时只在本次会话保留选择。 */ }
}
const page = ref<Page>(pages.find(item => item.id === remembered('page'))?.id ?? 'overview')
const selectedRoot = ref(remembered('root')), newRoot = ref(''), adding = ref(false), removing = ref(false)
const rulesDirty = ref(false), pendingPage = ref<Page | null>(null)
function navigate(next: Page) { if (page.value === 'principles' && rulesDirty.value && next !== page.value) pendingPage.value = next; else page.value = next }
function discardAndNavigate() { if (pendingPage.value) { page.value = pendingPage.value; pendingPage.value = null; rulesDirty.value = false } }
const revision = ref(0), target = ref(''), exploreMode = ref<'graph' | 'structure'>('graph')
const { data: snapshot, loading, error, run } = useRequest<Snapshot>()
const selected = computed(() => snapshot.value?.graphs.find(item => item.root === selectedRoot.value))
const current = computed(() => pages.find(item => item.id === page.value)!)
const projectName = (root: string) => root.split(/[\\/]/).filter(Boolean).pop() ?? root
const builtAt = computed(() => selected.value ? new Date(selected.value.builtAt).toLocaleString('zh-CN') : '')
function chooseProject(event: Event): void { if (event.target instanceof HTMLSelectElement) selectedRoot.value = event.target.value }
function acceptSnapshot(value: Snapshot): void { if (!value.graphs.some(item => item.root === selectedRoot.value)) selectedRoot.value = value.graphs[0]?.root ?? '' }
async function refresh() { const value = await run(() => call()); if (value) acceptSnapshot(value) }
async function build(force = false) {
  const root = force ? selectedRoot.value : newRoot.value.trim()
  if (!root || loading.value) return
  const value = await run(async () => {
    const result = force ? await call({ action: 'rebuild', root }) : await call({ action: 'build', root })
    selectedRoot.value = result.overview.root
    return call()
  })
  if (value) { acceptSnapshot(value); newRoot.value = ''; adding.value = false; revision.value += 1 }
}
async function remove() {
  if (loading.value) return
  const value = await run(() => call({ action: 'remove', root: selectedRoot.value }))
  if (value) { acceptSnapshot(value); removing.value = false; revision.value += 1 }
}
function inspect(id: string) { target.value = id; exploreMode.value = 'graph'; page.value = 'explore' }
watch(selectedRoot, () => { target.value = ''; removing.value = false })
watch([page, selectedRoot], () => {
  try { localStorage.setItem('engineering.page', page.value); localStorage.setItem('engineering.root', selectedRoot.value) }
  catch (error) { /* 存储受限时保留内存中的选择。 */ }
})
onMounted(refresh)
</script>
<template>
  <div class="workbench">
    <a href="#workspace" class="sr-only focus:not-sr-only focus:block focus:p-3">跳到工作区</a>
    <header class="studio-header">
      <div class="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3 px-5 pb-5 pt-6 sm:gap-4 sm:px-8">
        <span class="studio-mark" aria-hidden="true">研</span>
        <div class="mr-auto"><p class="text-[10px] font-medium tracking-[0.2em] text-muted">ENGINEERING STUDIO</p><h1 class="mt-1 text-lg font-medium tracking-tight">研发工作室</h1></div>
        <div class="flex w-full items-center gap-3 sm:w-auto">
          <label class="flex min-w-0 flex-1 items-center gap-3 text-xs text-muted sm:flex-none"><span class="shrink-0">当前项目</span><select :value="selectedRoot" class="field mt-0 min-w-0 flex-1 sm:w-60" :disabled="loading || !snapshot?.graphs.length" @change="chooseProject"><option v-if="!snapshot?.graphs.length" value="">尚未添加项目</option><option v-for="graph in snapshot?.graphs" :key="graph.root" :value="graph.root">{{ projectName(graph.root) }}</option></select></label>
          <button class="ghost shrink-0" :disabled="loading" @click="adding = !adding">{{ adding ? '收起' : '添加项目' }}</button>
        </div>
      </div>
      <div class="mx-auto max-w-[1600px] px-5 pb-5 sm:px-8"><nav aria-label="工作台导航" class="studio-nav"><button v-for="(item, index) in pages" :key="item.id" class="nav-item" :aria-current="page === item.id ? 'page' : undefined" @click="navigate(item.id)"><span class="nav-number" aria-hidden="true">0{{ index + 1 }}</span>{{ item.label }}</button></nav></div>
    </header>
    <main id="workspace" class="mx-auto max-w-[1600px] px-5 py-7 sm:px-8">
      <div v-if="pendingPage" role="alert" class="notice mb-5">编码准则有未保存的修改。请先保存，或放弃修改后切换。<button class="link ml-3" @click="discardAndNavigate">放弃并切换</button><button class="link ml-3" @click="pendingPage = null">继续编辑</button></div>
      <div v-if="error" role="alert" class="notice mb-5">{{ error }} <button class="link ml-2" @click="refresh">重新读取</button></div>
      <form v-if="adding || (snapshot && !snapshot.graphs.length)" class="card mb-6 p-5" @submit.prevent="build()"><h2 class="font-semibold">连接一个代码项目</h2><p class="mt-1 text-xs leading-6 text-muted">填写本机绝对目录。图谱保存在工作室数据目录，建立图谱不会向项目写入文件。</p><div class="mt-3 flex flex-wrap gap-2"><label for="new-root" class="sr-only">项目绝对路径</label><input id="new-root" v-model="newRoot" class="field mt-0 min-w-0 flex-1 basis-60" placeholder="例如 D:\projects\my-app" :disabled="loading" required><button class="primary" :disabled="loading || !newRoot.trim()">{{ loading ? '正在建立…' : '建立图谱' }}</button></div></form>
      <div class="mb-7 grid gap-4 sm:flex sm:flex-wrap sm:items-end"><div class="min-w-0 flex-1"><p class="text-xs text-muted">{{ selected ? projectName(selected.root) : '工作空间' }}</p><h2 class="mt-2 text-[28px] font-medium tracking-tight">{{ current.label }}</h2><p class="mt-2 text-xs leading-6 text-muted">{{ current.description }}</p></div><div v-if="selected && page !== 'principles'" class="flex flex-wrap items-center gap-2"><span class="mr-2 text-xs text-muted" :title="builtAt">{{ selected.stats.files }} 文件 · {{ selected.commit.slice(0, 8) || '非 Git 项目' }}</span><button class="ghost" :disabled="loading" @click="build(true)">{{ loading ? '同步中…' : '同步图谱' }}</button><button class="ghost" :disabled="loading" @click="removing = !removing">管理</button></div></div>
      <div v-if="removing" class="card mb-5 flex flex-wrap items-center gap-3 p-4"><p class="min-w-0 flex-1 text-xs text-muted">移除该项目的图谱缓存，项目源码与迭代文档会保留。之后可以重新添加。</p><button class="ghost" :disabled="loading" @click="remove">确认移除图谱</button><button class="ghost" @click="removing = false">取消</button></div>
      <p v-if="loading" role="status" class="mb-4 text-xs text-muted">正在处理项目，请稍候…</p>
      <PrinciplesPanel v-if="page === 'principles' && snapshot" :snapshot="snapshot" @saved="refresh" @dirty="rulesDirty = $event" />
      <template v-else-if="selected">
        <GlobalView v-if="page === 'overview'" :key="selectedRoot + revision" :root="selectedRoot" mode="health" />
        <section v-else-if="page === 'explore'"><div class="mb-4 flex gap-2"><button class="chip" :data-on="exploreMode === 'graph'" @click="exploreMode = 'graph'">文件与符号</button><button class="chip" :data-on="exploreMode === 'structure'" @click="exploreMode = 'structure'">架构与流程</button></div><CodeExplorer v-if="exploreMode === 'graph'" :key="selectedRoot + revision" :root="selectedRoot" :target="target" /><GlobalView v-else :key="selectedRoot + revision" :root="selectedRoot" mode="structure" /></section>
        <ChangesPanel v-else-if="page === 'changes'" :key="selectedRoot + revision" :root="selectedRoot" @select="inspect" />
        <PlansPanel v-else-if="page === 'plans'" :key="selectedRoot + revision" :root="selectedRoot" />
      </template>
      <section v-else-if="!loading" class="empty-state"><span class="text-3xl font-light text-muted" aria-hidden="true">＋</span><h3 class="mt-3 text-base font-semibold">从一个项目开始</h3><p class="mt-2 max-w-md text-xs leading-6 text-muted">连接项目后，可以查看代码图谱、分析改动、阅读迭代方案。编码准则可以先行设置。</p><button class="primary mt-5" @click="adding = true">添加项目</button></section>
      <footer class="mt-8 flex flex-wrap justify-between gap-2 border-t border-line pt-4 text-[11px] leading-5 text-muted"><span>静态分析覆盖 TypeScript / JavaScript / Vue；推断关系需要结合源码核实。</span><span>{{ selected ? '图谱更新于 ' + builtAt : '工程方法 · 代码证据 · 可验证的改动' }}</span></footer>
    </main>
  </div>
</template>
