<script setup lang="ts">
/** 概览里的一格统计数字。 */
interface Props {
  /** 指标名称 */
  label: string
  /** 指标数值 */
  value: number | string
  /** 数值下方的补充说明 */
  hint?: string
}
defineProps<Props>()
</script>

<template>
  <div class="rounded-lg border border-line bg-panel px-3 py-2.5">
    <div class="text-xs text-muted">{{ label }}</div>
    <div class="mt-1 text-xl font-semibold tabular-nums text-ink">{{ value }}</div>
    <div v-if="hint" class="mt-0.5 text-xs text-muted">{{ hint }}</div>
  </div>
</template>
