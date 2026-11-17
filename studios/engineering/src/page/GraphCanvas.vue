<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CanvasData, CanvasNode } from './api.ts'
import { layoutGraph, WASH, short } from './graph-layout.ts'

/**
 * 知识图谱画布：文件是一张张纸签，功能聚类用晕染的色块圈出，连线的虚实表示关系是确定的还是推断的。
 * 滚轮缩放、拖动平移；点节点看详情，点聚类名进入该聚类。布局由固定步数的力导向算出，同样的数据每次画出来一样。
 */
interface Props {
  /** 画布数据：节点、连线与聚类 */
  data: CanvasData
  /** 搜索词：名字或路径匹配的节点高亮，其余淡化 */
  query?: string
}
const props = withDefaults(defineProps<Props>(), { query: '' })
/** 当前选中的节点（文件路径）；点节点切换，点空白处取消 */
const selected = defineModel<string>('selected', { default: '' })
const emit = defineEmits<{
  /** 进入某个聚类；空串表示回到全图 */
  focus: [cluster: string]
}>()

/** 聚类色块的颜色：低饱和的矿物色，叠在纸底上像晕开的墨。 */
const NODE_HEIGHT = 22
const kindLabels: Record<CanvasNode['kind'], string> = { entry: '页面与入口', component: '组件', module: '脚本模块', test: '测试' }
const layout = computed(() => layoutGraph(props.data))


// ── 视口：屏幕坐标 = 世界坐标 × k + (x, y) ─────────────────
const host = ref<HTMLDivElement>()
const size = ref({ w: 900, h: 560 })
const view = ref({ x: 0, y: 0, k: 1 })
let observer: ResizeObserver | undefined

/** 把整张图放进视口并居中。 */
function fit() {
  const { bounds } = layout.value, { w, h } = size.value
  const k = Math.min(1.3, (w - 16) / (bounds.x2 - bounds.x1), (h - 16) / (bounds.y2 - bounds.y1))
  view.value = { k, x: w / 2 - (bounds.x1 + bounds.x2) / 2 * k, y: h / 2 - (bounds.y1 + bounds.y2) / 2 * k }
}
onMounted(() => {
  if (!host.value) return
  observer = new ResizeObserver(entries => {
    const box = entries[0].contentRect, first = size.value.w === 900 && size.value.h === 560
    size.value = { w: Math.max(320, box.width), h: Math.max(320, box.height) }
    if (first) fit()
  })
  observer.observe(host.value)
  const box = host.value.getBoundingClientRect()
  size.value = { w: Math.max(320, box.width), h: Math.max(320, box.height) }
  fit()
})
onBeforeUnmount(() => observer?.disconnect())
// 换了数据（切项目、进出聚类）重新取景。
watch(() => props.data, fit)

function zoomAt(factor: number, sx = size.value.w / 2, sy = size.value.h / 2) {
  const k = Math.max(0.2, Math.min(3, view.value.k * factor)), ratio = k / view.value.k
  view.value = { k, x: sx - (sx - view.value.x) * ratio, y: sy - (sy - view.value.y) * ratio }
}
function onWheel(event: WheelEvent) {
  const box = host.value!.getBoundingClientRect()
  zoomAt(Math.exp(-event.deltaY * 0.0016), event.clientX - box.left, event.clientY - box.top)
}

/** 拖动平移；移动不足几个像素的按点击处理。 */
const drag = ref<{ sx: number; sy: number; x: number; y: number; moved: boolean } | null>(null)
function onDown(event: PointerEvent) {
  if (event.button !== 0) return
  drag.value = { sx: event.clientX, sy: event.clientY, x: view.value.x, y: view.value.y, moved: false };
  (event.currentTarget as Element).setPointerCapture(event.pointerId)
}
function onMove(event: PointerEvent) {
  const state = drag.value
  if (!state) return
  const dx = event.clientX - state.sx, dy = event.clientY - state.sy
  if (!state.moved && Math.hypot(dx, dy) < 4) return
  state.moved = true
  view.value = { ...view.value, x: state.x + dx, y: state.y + dy }
}
function onUp(event: PointerEvent) {
  const state = drag.value
  drag.value = null
  if (!state || state.moved) return
  // 没有拖动：点到节点就选中它，点到聚类名进入聚类，点到空白取消选中。
  const target = (document.elementFromPoint(event.clientX, event.clientY) as Element | null)?.closest('[data-node],[data-area]')
  const node = target?.getAttribute('data-node'), area = target?.getAttribute('data-area')
  if (node) selected.value = selected.value === node ? '' : node
  else if (area) emit('focus', area)
  else selected.value = ''
}

/** 选中的节点不在视口里时把它移到中间（从搜索结果或侧栏选中时）。 */
watch(selected, id => {
  const item = id ? layout.value.at.get(id) : undefined
  if (!item) return
  const sx = item.x * view.value.k + view.value.x, sy = item.y * view.value.k + view.value.y
  if (sx < 60 || sx > size.value.w - 60 || sy < 60 || sy > size.value.h - 60) view.value = { ...view.value, x: size.value.w / 2 - item.x * view.value.k, y: size.value.h / 2 - item.y * view.value.k }
})

// ── 强调与淡化 ─────────────────────────────────────────
const hover = ref('')
const showResolved = ref(true)
const showInferred = ref(true)
const active = computed(() => hover.value || (layout.value.at.has(selected.value) ? selected.value : ''))
const neighbors = computed(() => {
  const set = new Set<string>()
  if (!active.value) return set
  for (const edge of props.data.edges) { if (edge.from === active.value) set.add(edge.to); if (edge.to === active.value) set.add(edge.from) }
  return set
})
const needle = computed(() => props.query.trim().toLowerCase())
const matches = computed(() => new Set(needle.value ? props.data.nodes.filter(node => node.label.toLowerCase().includes(needle.value) || node.id.toLowerCase().includes(needle.value)).map(node => node.id) : []))
const nodeTone = (id: string) => active.value ? (id === active.value ? 'on' : neighbors.value.has(id) ? 'near' : 'dim') : needle.value ? (matches.value.has(id) ? 'idle' : 'dim') : id === selected.value ? 'on' : 'idle'
const edgeTone = (from: string, to: string) => active.value ? (from === active.value || to === active.value ? 'on' : 'dim') : needle.value ? 'dim' : 'idle'
const washTone = (group: number) => { const item = active.value ? layout.value.at.get(active.value) : undefined; return item ? (item.group === group ? 'on' : 'dim') : 'idle' }
const visibleEdges = computed(() => props.data.edges.filter(edge => edge.inferred ? showInferred.value : showResolved.value))
const maxWeight = computed(() => Math.max(1, ...props.data.edges.map(edge => edge.weight)))
const strokeWidth = (weight: number) => 0.7 + 1.9 * Math.log(weight + 1) / Math.log(maxWeight.value + 1)
/** 被引用最多的那一成节点加粗显示，一眼能看出谁是枢纽。 */
const majorLine = computed(() => { const sorted = props.data.nodes.map(node => node.usedBy).sort((a, b) => b - a); return Math.max(3, sorted[Math.floor(sorted.length * 0.1)] ?? 3) })

const tip = computed(() => {
  const item = hover.value ? layout.value.at.get(hover.value) : undefined
  return item ? { node: item.node, left: item.x * view.value.k + view.value.x, top: (item.y - NODE_HEIGHT / 2) * view.value.k + view.value.y } : undefined
})

// ── 小地图 ────────────────────────────────────────────
const MINI = { w: 156, h: 104 }
const mini = computed(() => {
  const { bounds } = layout.value
  const k = Math.min(MINI.w / (bounds.x2 - bounds.x1), MINI.h / (bounds.y2 - bounds.y1))
  const ox = (MINI.w - (bounds.x2 - bounds.x1) * k) / 2 - bounds.x1 * k, oy = (MINI.h - (bounds.y2 - bounds.y1) * k) / 2 - bounds.y1 * k
  // 视口在世界坐标里的范围，再换算到小地图。
  const left = -view.value.x / view.value.k, top = -view.value.y / view.value.k
  return { k, ox, oy, frame: { x: left * k + ox, y: top * k + oy, w: size.value.w / view.value.k * k, h: size.value.h / view.value.k * k } }
})
function jump(event: MouseEvent) {
  const box = (event.currentTarget as Element).getBoundingClientRect()
  const wx = (event.clientX - box.left - mini.value.ox) / mini.value.k, wy = (event.clientY - box.top - mini.value.oy) / mini.value.k
  view.value = { ...view.value, x: size.value.w / 2 - wx * view.value.k, y: size.value.h / 2 - wy * view.value.k }
}
</script>

<template>
  <div ref="host" class="graph">
    <svg class="graph-stage" :viewBox="'0 0 ' + size.w + ' ' + size.h" :data-dragging="!!drag?.moved" role="img"
      :aria-label="'知识图谱：' + data.nodes.length + ' 个文件、' + data.edges.length + ' 条关系、' + data.clusters.length + ' 个功能聚类'"
      @wheel.prevent="onWheel" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="drag = null">
      <defs><filter id="graph-wash" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="26" /></filter></defs>
      <g :transform="'translate(' + view.x + ',' + view.y + ') scale(' + view.k + ')'">
        <!-- 聚类色块：每个节点下面一个大圆，整体高斯模糊后连成一片 -->
        <g v-for="(area, at) in data.clusters" :key="'wash' + area.id" class="graph-wash" :data-tone="washTone(at)" filter="url(#graph-wash)">
          <circle v-for="item in layout.placed.filter(entry => entry.group === at)" :key="item.node.id" :cx="item.x" :cy="item.y" r="54" :fill="WASH[at % WASH.length]" />
        </g>
        <g>
          <line v-for="edge in visibleEdges" :key="edge.from + '|' + edge.to" class="graph-edge" :data-inferred="edge.inferred" :data-tone="edgeTone(edge.from, edge.to)"
            :x1="layout.at.get(edge.from)?.x" :y1="layout.at.get(edge.from)?.y" :x2="layout.at.get(edge.to)?.x" :y2="layout.at.get(edge.to)?.y" :stroke-width="strokeWidth(edge.weight)" />
        </g>
        <text v-for="area in layout.areas" :key="'area' + area.id" class="graph-area" :data-area="data.scope === 'global' ? area.id : undefined" :x="area.x" :y="area.y" text-anchor="middle">
          — {{ area.label.length > 34 ? area.label.slice(0, 33) + '…' : area.label }}{{ area.more > 0 ? ' · 另有 ' + area.more + ' 个文件' : '' }} —
        </text>
        <g v-for="item in layout.placed" :key="item.node.id" class="graph-node" :data-node="item.node.id" :data-tone="nodeTone(item.node.id)" :data-major="item.node.usedBy >= majorLine"
          :data-match="matches.has(item.node.id)" tabindex="0" role="button" :aria-label="item.node.id + '，' + kindLabels[item.node.kind]"
          :transform="'translate(' + (item.x - item.w / 2) + ',' + (item.y - NODE_HEIGHT / 2) + ')'"
          @mouseenter="hover = item.node.id" @mouseleave="hover = ''" @keydown.enter.prevent="selected = selected === item.node.id ? '' : item.node.id">
          <rect class="graph-tab" :data-kind="item.node.kind" x="7" y="-4" width="13" height="7" rx="1.5" />
          <rect class="body" :width="item.w" :height="NODE_HEIGHT" rx="3" />
          <text :x="item.w / 2" y="15" text-anchor="middle">{{ short(item.node.label) }}</text>
        </g>
      </g>
    </svg>

    <div v-if="tip" class="graph-tip" :style="{ left: tip.left + 'px', top: tip.top + 'px' }">
      <div class="font-medium text-ink">{{ tip.node.id }}</div>
      <div class="mt-0.5 tabular-nums">{{ kindLabels[tip.node.kind] }} · {{ tip.node.lines }} 行 · 被引用 {{ tip.node.usedBy }} · 引用 {{ tip.node.uses }}</div>
    </div>

    <!-- 左上：连线筛选与返回 -->
    <div class="absolute left-3 top-3 flex flex-wrap items-center gap-1.5">
      <button v-if="data.scope === 'cluster'" type="button" class="chip" data-on="true" @click="emit('focus', '')">← 回到全图</button>
      <button type="button" class="chip" :data-off="!showResolved" :aria-pressed="showResolved" title="由 import 语句确定的关系" @click="showResolved = !showResolved"><svg width="22" height="6" aria-hidden="true"><line x1="0" y1="3" x2="22" y2="3" stroke="currentColor" stroke-width="2" /></svg>确定</button>
      <button type="button" class="chip" :data-off="!showInferred" :aria-pressed="showInferred" title="按自动导入、目录约定推断的关系，需要打开文件核对" @click="showInferred = !showInferred"><svg width="22" height="6" aria-hidden="true"><line x1="0" y1="3" x2="22" y2="3" stroke="currentColor" stroke-width="2" stroke-dasharray="5 4" /></svg>推断</button>
    </div>

    <!-- 右上：小地图 -->
    <svg class="graph-float right-3 top-3 hidden cursor-pointer sm:block" :width="MINI.w" :height="MINI.h" :viewBox="'0 0 ' + MINI.w + ' ' + MINI.h" aria-label="小地图：点击移动视野" @click="jump">
      <circle v-for="item in layout.placed" :key="item.node.id" :cx="item.x * mini.k + mini.ox" :cy="item.y * mini.k + mini.oy" r="1.8" :fill="WASH[item.group % WASH.length]" />
      <rect class="graph-mini" :x="mini.frame.x" :y="mini.frame.y" :width="mini.frame.w" :height="mini.frame.h" rx="2" />
    </svg>

    <!-- 左下：图例 -->
    <div class="graph-float bottom-3 left-3 px-3 py-2">
      <div class="title text-xs font-semibold text-ink">图例</div>
      <ul class="mt-1.5 space-y-1">
        <li v-for="(label, kind) in kindLabels" :key="kind" class="flex items-center gap-2">
          <svg width="26" height="16" aria-hidden="true"><rect class="graph-tab" :data-kind="kind" x="4" y="1" width="9" height="5" rx="1" /><rect class="graph-key" x="1" y="4" width="24" height="11" rx="2" /></svg>{{ label }}
        </li>
      </ul>
    </div>

    <!-- 右下：缩放 -->
    <div class="absolute bottom-3 right-3 flex flex-col gap-1.5">
      <button type="button" class="graph-round" aria-label="放大" @click="zoomAt(1.25)">＋</button>
      <button type="button" class="graph-round" aria-label="缩小" @click="zoomAt(0.8)">－</button>
      <button type="button" class="graph-round text-xs" aria-label="看全图" title="看全图" @click="fit">全</button>
    </div>

    <div class="graph-float pointer-events-none hidden sm:block bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap px-3 py-1 tabular-nums">
      {{ data.total.nodes }}/{{ data.total.files }} 文件 · {{ data.total.relations }} 关联 · {{ data.clusters.length }}/{{ data.total.clusters }} 聚类<template v-if="needle"> · 匹配 {{ matches.size }}</template>
    </div>
  </div>
</template>
