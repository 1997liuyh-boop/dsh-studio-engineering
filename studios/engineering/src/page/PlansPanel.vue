<script setup lang="ts">
import { ref, watch } from 'vue'
import { call } from './api.ts'
import type { PlanCheck, PlanDetail, PlanSummary } from '../plan-service.ts'
import { useRequest } from './use-request.ts'
const props = defineProps<{ root: string }>()
const list = useRequest<{ plans: PlanSummary[] }>(), detail = useRequest<PlanDetail>(), checking = useRequest<PlanCheck>()
const { data: plans, loading, error } = list
const { data: selected, loading: reading, error: detailError } = detail
const { loading: verifying, error: checkError } = checking
const active = ref('')
async function load() { await list.run(signal => call({ action: 'plans', root: props.root }, signal)) }
async function open(slug: string) { active.value = slug; detail.reset(); checking.reset(); await detail.run(signal => call({ action: 'plan', root: props.root, slug }, signal)) }
async function verify() {
  if (!selected.value || verifying.value) return
  const slug = selected.value.slug
  const result = await checking.run(() => call({ action: 'check-plan', root: props.root, slug }))
  if (result && selected.value?.slug === slug) { selected.value = { ...selected.value, report: result }; await load() }
}
watch(() => props.root, () => { active.value = ''; detail.reset(); checking.reset(); void load() }, { immediate: true })
</script>
<template>
  <section>
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3"><p class="text-xs leading-6 text-muted">方案来自项目的 <code>docs/iterations/</code>。新方案请在会话里使用“@研发工作室:分析需求文档”。</p><button class="ghost" :disabled="loading || verifying" @click="load">刷新列表</button></div>
    <p v-if="error || detailError || checkError" role="alert" class="notice mb-4">{{ error || detailError || checkError }} <button v-if="active" class="link" @click="open(active)">重新读取方案</button></p>
    <p v-if="loading" role="status" class="mb-4 text-xs text-muted">读取迭代方案…</p>
    <div v-if="plans?.plans.length" class="grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
      <ul class="space-y-2"><li v-for="item in plans.plans" :key="item.slug"><button class="project p-4" :data-on="active === item.slug" :disabled="verifying" @click="open(item.slug)"><span class="block font-medium">{{ item.title }}</span><span class="mt-2 block text-xs text-muted">{{ item.features }} 功能 · {{ item.steps }} 步骤</span><span class="mt-2 block text-[11px] text-muted">{{ item.createdAt.slice(0, 10) }} · {{ item.checked ? '有历史报告' : '尚未核对' }}</span></button></li></ul>
      <article v-if="selected" class="card min-w-0 p-5 sm:p-7">
        <div class="flex flex-wrap items-start gap-4"><div class="min-w-0 flex-1"><p class="font-mono text-xs text-muted">{{ selected.slug }}</p><h3 class="mt-2 text-xl font-semibold">{{ selected.plan.title }}</h3><p class="mt-2 text-xs leading-6 text-muted">{{ selected.plan.summary }}</p></div><button class="primary" :disabled="verifying" @click="verify">{{ verifying ? '核对中…' : '对照当前代码核对' }}</button></div>
        <p class="mt-5 rounded-lg bg-canvas p-3 text-xs leading-6 text-muted">核对会写入该方案的 check-report.json，只检查文件、符号、签名和改动范围。功能验收项仍需实际运行验证。</p>
        <div v-if="selected.report" class="mt-5 border-l-2 border-accent pl-4"><h4 class="font-medium">{{ !selected.report.ok ? '核对发现问题' : selected.report.warnings.length ? '结构核对完成，仍有警告' : '结构核对通过' }}</h4><p class="mt-2 break-all text-xs leading-6 text-muted">历史核对：{{ selected.report.checkedAt }} · {{ selected.report.commit.slice(0, 8) || '无 Git 提交' }}；之后的代码变化可能使结果过期。</p><ul class="mt-2 space-y-2 text-xs"><li v-for="issue in selected.report.issues" :key="issue" class="text-accent">问题：{{ issue }}</li><li v-for="warning in selected.report.warnings" :key="warning" class="text-amber">警告：{{ warning }}</li></ul></div>
        <h4 class="mt-7 font-semibold">功能与验收</h4><section v-for="feature in selected.plan.features" :key="feature.id" class="mt-4 border-t border-line pt-4"><h5 class="font-medium">{{ feature.id }} · {{ feature.title }}</h5><p class="mt-2 text-xs leading-6 text-muted">{{ feature.description }}</p><ul class="mt-2 list-disc space-y-1 pl-4 text-xs leading-6"><li v-for="criterion in feature.acceptance" :key="criterion">{{ criterion }}</li></ul></section>
        <h4 class="mt-7 font-semibold">实施步骤</h4><ol class="mt-3 space-y-4"><li v-for="step in selected.plan.steps" :key="step.id" class="rounded-xl bg-canvas p-4"><h5 class="font-medium">{{ step.id }} · {{ step.title }}</h5><p class="mt-2 whitespace-pre-wrap text-xs leading-6 text-muted">{{ step.detail }}</p><p class="mt-2 break-all font-mono text-xs text-muted">{{ step.files.join(' · ') }}</p><p class="mt-3 text-xs leading-6">验证：{{ step.verify }}</p></li></ol>
        <details class="mt-6 text-xs"><summary class="cursor-pointer font-medium">接口与改动设计（{{ selected.plan.changes.length }}）</summary><div v-for="change in selected.plan.changes" :key="change.target" class="mt-4 border-t border-line pt-3"><p class="break-all font-mono">{{ change.target }}</p><p class="mt-2 leading-6 text-muted">{{ change.summary }}</p><pre v-if="change.signature" class="code mt-2">{{ change.signature }}</pre></div></details>
      </article>
      <div v-else class="empty-state" role="status">{{ reading ? '正在读取方案…' : '选择一个迭代方案查看功能、步骤与核对记录。' }}</div>
    </div>
    <div v-else-if="!loading && !error" class="empty-state"><h3 class="font-semibold">这个项目还没有迭代方案</h3><p class="mt-2 max-w-lg text-xs leading-6 text-muted">在当前项目会话中发送“@研发工作室:分析需求文档”并附上需求，模型会对照代码提交结构化方案。</p></div>
  </section>
</template>
