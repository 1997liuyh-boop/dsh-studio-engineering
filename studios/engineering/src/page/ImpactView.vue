<script setup lang="ts">
import type { ImpactReport } from './api.ts'

/** 影响面报告：风险级别与三级依赖清单。 */
interface Props {
  /** 图谱计算出的影响面 */
  report: ImpactReport
}
defineProps<Props>()
/** 点击某个受影响的节点，交给父级继续查看它的上下文 */
const emit = defineEmits<{ select: [id: string] }>()

const riskLabels = { LOW: '低风险', MEDIUM: '中风险', HIGH: '高风险' } as const
const levels = [
  { key: 'direct', title: '直接依赖', hint: '改动后必须逐个核对' },
  { key: 'indirect', title: '间接依赖', hint: '很可能受影响' },
  { key: 'regression', title: '需回归', hint: '更远的传递依赖' },
] as const
</script>

<template>
  <div>
    <div class="flex flex-wrap items-center gap-2">
      <span class="risk" :data-risk="report.risk">{{ riskLabels[report.risk] }}</span>
      <span class="text-xs text-muted">波及 {{ report.summary.files }} 个文件 · {{ report.summary.modules.length }} 个模块<template v-if="report.summary.inferred"> · {{ report.summary.inferred }} 条为推断</template></span>
    </div>
    <p v-for="note in report.notes" :key="note" class="mt-2 rounded-md bg-canvas px-2.5 py-2 text-xs leading-5 text-muted">{{ note }}</p>
    <section v-for="level in levels" :key="level.key" class="mt-3">
      <h4 class="text-xs font-medium text-ink">{{ level.title }} <span class="font-normal text-muted">{{ report.summary[level.key] }} · {{ level.hint }}</span></h4>
      <ul v-if="report[level.key].length" class="mt-1.5 space-y-1">
        <li v-for="item in report[level.key]" :key="item.id">
          <button type="button" class="row" @click="emit('select', item.id)">
            <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ item.id }}</span>
            <span class="shrink-0 text-xs text-muted">{{ item.relation }}<template v-if="item.confidence === 'inferred'"> · 推断</template><template v-if="item.test"> · 测试</template></span>
          </button>
        </li>
      </ul>
      <p v-else class="mt-1 text-xs text-muted">无</p>
    </section>
  </div>
</template>
