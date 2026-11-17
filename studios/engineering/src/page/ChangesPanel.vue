<script setup lang="ts">
import { watch } from 'vue'
import { call, type ChangesReport } from './api.ts'
import { useRequest } from './use-request.ts'
import ImpactView from './ImpactView.vue'
const props = defineProps<{ root: string }>()
const emit = defineEmits<{ select: [id: string] }>()
const { data: report, loading, error, run } = useRequest<ChangesReport>()
const labels = { added: '新增', modified: '修改', deleted: '删除' }
async function load() { await run(signal => call({ action: 'changes', root: props.root }, signal)) }
watch(() => props.root, load, { immediate: true })
</script>
<template>
  <section>
    <div class="mb-4 flex flex-wrap items-center justify-between gap-2"><p class="text-xs text-muted">比较当前工作区与 HEAD，包含未提交和未跟踪的源码。</p><button class="ghost" :disabled="loading" @click="load">{{ loading ? '分析中…' : '重新分析' }}</button></div>
    <p v-if="error" role="alert" class="notice">{{ error }}</p><p v-if="loading" role="status" class="empty-state">正在读取 Git 改动并计算影响面…</p>
    <template v-else-if="report">
      <div v-if="!report.available" class="empty-state"><h3 class="font-semibold">当前无法读取 Git 改动</h3><p class="mt-2 text-xs text-muted">目录可能不是 Git 仓库、还没有 HEAD，或 Git 命令执行失败。代码探索仍然可用。</p></div>
      <div v-else-if="!report.files.length" class="empty-state"><h3 class="font-semibold">工作区没有待分析的改动</h3><p class="mt-2 text-xs text-muted">修改代码后，点击“重新分析”查看影响范围。</p></div>
      <div v-else class="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <div class="card min-w-0 p-5"><h3 class="font-semibold">改动文件 <span class="ml-2 font-mono text-muted">{{ report.files.length }}</span></h3><ul class="mt-4 divide-y divide-line"><li v-for="file in report.files" :key="file.file" class="flex gap-3 py-3 text-xs"><span class="shrink-0 text-muted">{{ labels[file.status] }}</span><button class="link min-w-0 break-all text-left font-mono" @click="emit('select', file.file)">{{ file.file }}</button></li></ul><p class="mt-4 text-xs leading-6 text-muted">已映射 {{ report.symbols.length }} 个符号；删除文件 {{ report.deleted.length }} 个；图谱范围外 {{ report.outside.length }} 个。</p><details v-if="report.outside.length" class="mt-3 text-xs text-muted"><summary class="cursor-pointer">查看图谱外文件</summary><ul class="mt-2 space-y-2 break-all font-mono"><li v-for="file in report.outside" :key="file">{{ file }}</li></ul></details></div>
        <div class="card min-w-0 p-5"><h3 class="mb-4 font-semibold">影响与回归范围</h3><ImpactView v-if="report.impact" :report="report.impact" @select="emit('select', $event)" /><p v-else class="text-xs leading-6 text-muted">当前改动没有映射到现存符号。删除、配置或图谱范围外的改动仍需要人工核实。</p></div>
      </div>
    </template>
  </section>
</template>
