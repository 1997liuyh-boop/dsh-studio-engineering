<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ClusterLink, ClusterSummary } from './api.ts'

/** 架构图：功能聚类为圆，大小表示文件数；连线表示聚类之间的调用与引用，越粗关系越多。 */
interface Props {
  /** 要画出的聚类，按文件数从多到少 */
  clusters: ClusterSummary[]
  /** 聚类之间的有向关系 */
  links: ClusterLink[]
}
const props = defineProps<Props>()
/** 当前选中的聚类 ID；点击圆圈切换，点空白处取消 */
const selected = defineModel<string>('selected', { default: '' })

const WIDTH = 760, HEIGHT = 460
/** 只给最大的这几个聚类直接标名字，其余悬停查看，避免标签互相压住。 */
const LABELED = 10

interface Placed { cluster: ClusterSummary; x: number; y: number; r: number }

const radius = (files: number) => 7 + Math.sqrt(files) * 2.1

/** 合并双向关系：画图只看两个聚类之间一共有多少关系。 */
const pairs = computed(() => {
  const ids = new Set(props.clusters.map(cluster => cluster.id))
  const merged = new Map<string, { a: string; b: string; weight: number }>()
  for (const link of props.links) {
    if (!ids.has(link.from) || !ids.has(link.to)) continue
    const [a, b] = link.from < link.to ? [link.from, link.to] : [link.to, link.from]
    const entry = merged.get(a + '|' + b)
    if (entry) entry.weight += link.weight
    else merged.set(a + '|' + b, { a, b, weight: link.weight })
  }
  return [...merged.values()]
})

/**
 * 力导向布局：圆之间互相排斥，有关系的两端被拉近，所有点被拉向中心。
 * 初始位置按黄金角螺旋排列、迭代次数固定，同样的数据每次画出来一样。
 */
const layout = computed<Placed[]>(() => {
  const nodes = props.clusters.map((cluster, at) => {
    const angle = at * 2.399963, distance = 30 * Math.sqrt(at + 1)
    return { cluster, x: Math.cos(angle) * distance, y: Math.sin(angle) * distance, r: radius(cluster.files), vx: 0, vy: 0 }
  })
  const position = new Map(nodes.map((node, at) => [node.cluster.id, at]))
  const springs = pairs.value.map(pair => ({ a: position.get(pair.a)!, b: position.get(pair.b)!, strength: Math.min(1, Math.log10(pair.weight + 1) / 2.5) }))
  for (let step = 0; step < 320; step += 1) {
    const cooling = 1 - step / 320
    for (let i = 0; i < nodes.length; i += 1) for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i], b = nodes[j]
      let dx = b.x - a.x, dy = b.y - a.y
      const distance = Math.max(1, Math.hypot(dx, dy)), gap = a.r + b.r + 26
      const force = (12000 / (distance * distance)) + (distance < gap ? (gap - distance) * 0.6 : 0)
      dx /= distance; dy /= distance
      a.vx -= dx * force; a.vy -= dy * force; b.vx += dx * force; b.vy += dy * force
    }
    for (const spring of springs) {
      const a = nodes[spring.a], b = nodes[spring.b]
      const dx = b.x - a.x, dy = b.y - a.y, distance = Math.max(1, Math.hypot(dx, dy))
      const pull = (distance - (a.r + b.r + 70)) * 0.015 * spring.strength
      a.vx += dx / distance * pull; a.vy += dy / distance * pull; b.vx -= dx / distance * pull; b.vy -= dy / distance * pull
    }
    for (const node of nodes) {
      // 横向的拉力比纵向弱，让图铺满宽画布。
      node.vx -= node.x * 0.0016; node.vy -= node.y * 0.0032
      node.x += Math.max(-12, Math.min(12, node.vx)) * cooling; node.y += Math.max(-12, Math.min(12, node.vy)) * cooling
      node.vx *= 0.5; node.vy *= 0.5
    }
  }
  // 收尾：把仍然重叠的圆逐对推开（留出标签的高度）。
  for (let round = 0; round < 60; round += 1) {
    let moved = false
    for (let i = 0; i < nodes.length; i += 1) for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i], b = nodes[j], dx = b.x - a.x, dy = b.y - a.y, distance = Math.max(0.01, Math.hypot(dx, dy)), gap = a.r + b.r + 18
      if (distance >= gap) continue
      const push = (gap - distance) / 2
      a.x -= dx / distance * push; a.y -= dy / distance * push; b.x += dx / distance * push; b.y += dy / distance * push
      moved = true
    }
    if (!moved) break
  }
  // 缩放到画布：留出边距，横向拉伸以适配宽画布。
  const minX = Math.min(...nodes.map(node => node.x - node.r)), maxX = Math.max(...nodes.map(node => node.x + node.r))
  const minY = Math.min(...nodes.map(node => node.y - node.r)), maxY = Math.max(...nodes.map(node => node.y + node.r))
  const pad = 36, scaleX = (WIDTH - pad * 2) / Math.max(1, maxX - minX), scaleY = (HEIGHT - pad * 2 - 14) / Math.max(1, maxY - minY)
  const scale = Math.min(scaleX, scaleY, 1.6)
  const offsetX = (WIDTH - (maxX - minX) * scale) / 2, offsetY = (HEIGHT - 14 - (maxY - minY) * scale) / 2
  return nodes.map(node => ({ cluster: node.cluster, x: offsetX + (node.x - minX) * scale, y: offsetY + (node.y - minY) * scale, r: node.r * Math.min(1, Math.max(0.7, scale)) }))
})

const placed = computed(() => new Map(layout.value.map(node => [node.cluster.id, node])))
const maxWeight = computed(() => Math.max(1, ...pairs.value.map(pair => pair.weight)))
const neighbors = computed(() => {
  const set = new Set<string>()
  for (const pair of pairs.value) { if (pair.a === selected.value) set.add(pair.b); if (pair.b === selected.value) set.add(pair.a) }
  return set
})
const short = (label: string) => label.length > 26 ? label.slice(0, 25) + '…' : label
const labeled = computed(() => {
  const boxes: { x1: number; y1: number; x2: number; y2: number }[] = []
  const result = new Set<string>()
  // 中文按整字宽、其余按半字宽估算标签宽度。
  const width = (text: string) => [...text].reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 11 : 6.2), 0)
  for (const node of layout.value.slice(0, LABELED * 2)) {
    if (result.size >= LABELED) break
    const text = short(node.cluster.label), w = width(text), y = node.y + node.r + 4
    const box = { x1: node.x - w / 2 - 2, y1: y, x2: node.x + w / 2 + 2, y2: y + 13 }
    const hitsLabel = boxes.some(other => box.x1 < other.x2 && box.x2 > other.x1 && box.y1 < other.y2 && box.y2 > other.y1)
    const hitsDot = layout.value.some(other => other !== node && other.x + other.r > box.x1 && other.x - other.r < box.x2 && other.y + other.r > box.y1 && other.y - other.r < box.y2)
    if (hitsLabel || hitsDot) continue
    boxes.push(box)
    result.add(node.cluster.id)
  }
  return result
})

/** 节点状态：选中、与选中相邻、其余（有选中时淡化）。 */
const tone = (id: string) => !selected.value ? 'idle' : id === selected.value ? 'on' : neighbors.value.has(id) ? 'near' : 'dim'
const lineTone = (a: string, b: string) => !selected.value ? 'idle' : a === selected.value || b === selected.value ? 'on' : 'dim'
const strokeWidth = (weight: number) => 0.75 + 2.5 * Math.log(weight + 1) / Math.log(maxWeight.value + 1)

const hover = ref<{ cluster: ClusterSummary; x: number; y: number } | null>(null)

function toggle(id: string) { selected.value = selected.value === id ? '' : id }
</script>

<template>
  <div class="relative">
    <svg :viewBox="'0 0 ' + WIDTH + ' ' + HEIGHT" class="block h-auto w-full" role="img" :aria-label="'架构图：' + clusters.length + ' 个功能聚类及其相互关系'" @click.self="selected = ''">
      <g>
        <line v-for="pair in pairs" :key="pair.a + pair.b" class="map-link" :data-tone="lineTone(pair.a, pair.b)"
          :x1="placed.get(pair.a)!.x" :y1="placed.get(pair.a)!.y" :x2="placed.get(pair.b)!.x" :y2="placed.get(pair.b)!.y" :stroke-width="strokeWidth(pair.weight)" />
      </g>
      <g v-for="node in layout" :key="node.cluster.id" class="map-node" :data-tone="tone(node.cluster.id)" tabindex="0" role="button" :aria-label="node.cluster.label + '，' + node.cluster.files + ' 个文件'"
        @click.stop="toggle(node.cluster.id)" @keydown.enter.prevent="toggle(node.cluster.id)"
        @mouseenter="hover = { cluster: node.cluster, x: node.x, y: node.y - node.r }" @mouseleave="hover = null">
        <circle :cx="node.x" :cy="node.y" :r="node.r + 6" fill="transparent" />
        <circle class="map-dot" :cx="node.x" :cy="node.y" :r="node.r" />
        <text v-if="labeled.has(node.cluster.id) || node.cluster.id === selected" class="map-label" :x="node.x" :y="node.y + node.r + 13" text-anchor="middle">{{ short(node.cluster.label) }}</text>
      </g>
    </svg>
    <div v-if="hover" class="map-tip" :style="{ left: (hover.x / WIDTH * 100) + '%', top: (hover.y / HEIGHT * 100) + '%' }">
      <div class="font-medium text-ink">{{ hover.cluster.label }}</div>
      <div class="mt-0.5 tabular-nums">{{ hover.cluster.files }} 个文件 · {{ hover.cluster.symbols }} 个符号 · 内聚 {{ hover.cluster.cohesion }}</div>
      <div v-if="hover.cluster.keywords.length" class="mt-0.5">{{ hover.cluster.keywords.join(' · ') }}</div>
    </div>
  </div>
</template>
