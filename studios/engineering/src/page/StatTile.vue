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
  <div class="stat-tile">
    <div class="text-xs text-muted">{{ label }}</div>
    <div class="mt-2 break-words text-xl font-medium tabular-nums text-ink">{{ value }}</div>
    <div v-if="hint" class="mt-1 break-words text-xs leading-5 text-muted">{{ hint }}</div>
  </div>
</template>
