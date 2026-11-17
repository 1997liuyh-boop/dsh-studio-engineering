import type { CanvasData, CanvasNode } from './api.ts'
const NODE_HEIGHT = 22
export const WASH = ['#7d9a80', '#c9a26b', '#7f95a8', '#a88aa6', '#b98a7a', '#8fa3a0', '#b7a97a', '#9a8fb5', '#6f9aa3', '#c08f8f', '#93a877', '#a79a8c']

interface Placed { node: CanvasNode; x: number; y: number; w: number; group: number }

/** 估算标签宽度：中文按整字宽，其余按半字宽。 */
const labelWidth = (text: string) => Math.max(44, [...text].reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 12 : 6.7), 0) + 18)
export const short = (label: string) => label.length > 22 ? label.slice(0, 21) + '…' : label


/** 根据图谱数据生成确定性布局，不访问 DOM 或组件状态。 */
export function layoutGraph(data: CanvasData) {
  const groups = data.clusters
  const groupAt = new Map(groups.map((group, at) => [group.id, at]))
  const radii = groups.map(group => 50 + Math.sqrt(group.shown) * 31)
  // 聚类之间的关系数：两个聚类之间的连线越多，圆心拉得越近。
  const bond = new Map<string, number>()
  const clusterOf = new Map(data.nodes.map(node => [node.id, groupAt.get(node.cluster) ?? 0]))
  for (const edge of data.edges) {
    const a = clusterOf.get(edge.from)!, b = clusterOf.get(edge.to)!
    if (a === b) continue
    const key = Math.min(a, b) + ':' + Math.max(a, b)
    bond.set(key, (bond.get(key) ?? 0) + edge.weight)
  }
  const centers = groups.map((_, at) => { const angle = at * 2.399963, distance = 120 * Math.sqrt(at); return { x: Math.cos(angle) * distance * 1.5, y: Math.sin(angle) * distance, vx: 0, vy: 0 } })
  for (let step = 0; step < 260; step += 1) {
    const cooling = 1 - step / 260
    for (let i = 0; i < centers.length; i += 1) for (let j = i + 1; j < centers.length; j += 1) {
      const a = centers[i], b = centers[j]
      let dx = b.x - a.x, dy = b.y - a.y
      const distance = Math.max(1, Math.hypot(dx, dy)), gap = radii[i] + radii[j] + 46
      const force = distance < gap ? (gap - distance) * 0.35 : 0
      dx /= distance; dy /= distance
      a.vx -= dx * force; a.vy -= dy * force; b.vx += dx * force; b.vy += dy * force
    }
    for (const [key, weight] of bond) {
      const [i, j] = key.split(':').map(Number), a = centers[i], b = centers[j]
      const dx = b.x - a.x, dy = b.y - a.y, distance = Math.max(1, Math.hypot(dx, dy))
      const pull = Math.max(0, distance - (radii[i] + radii[j] + 40)) * 0.004 * Math.min(4, Math.log2(weight + 1))
      a.vx += dx / distance * pull; a.vy += dy / distance * pull; b.vx -= dx / distance * pull; b.vy -= dy / distance * pull
    }
    for (const center of centers) {
      // 横向的回中力远弱于纵向：画布是宽的，让图横着铺开，取景时才不会被高度卡住。
      center.vx -= center.x * 0.0016; center.vy -= center.y * 0.014
      center.x += Math.max(-30, Math.min(30, center.vx)) * cooling; center.y += Math.max(-30, Math.min(30, center.vy)) * cooling
      center.vx *= 0.55; center.vy *= 0.55
    }
  }
  const seat = groups.map(() => 0)
  const nodes = data.nodes.map(node => {
    const group = groupAt.get(node.cluster) ?? 0, at = seat[group]++
    const angle = at * 2.399963, distance = radii[group] * 0.82 * Math.sqrt((at + 0.5) / Math.max(1, groups[group].shown))
    return { node, x: centers[group].x + Math.cos(angle) * distance, y: centers[group].y + Math.sin(angle) * distance * 0.8, w: labelWidth(short(node.label)), group, vx: 0, vy: 0 }
  })
  const position = new Map(nodes.map((item, at) => [item.node.id, at]))
  const springs = data.edges.map(edge => ({ a: position.get(edge.from)!, b: position.get(edge.to)!, weight: edge.weight }))
  for (let step = 0; step < 220; step += 1) {
    const cooling = 1 - step / 220
    for (let i = 0; i < nodes.length; i += 1) for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i], b = nodes[j]
      let dx = b.x - a.x, dy = b.y - a.y
      const distance = Math.max(1, Math.hypot(dx, dy))
      if (distance > 260) continue
      const reach = (a.w + b.w) / 2 * 0.62 + 20
      const force = 2600 / (distance * distance) + (distance < reach ? (reach - distance) * 0.5 : 0)
      dx /= distance; dy /= distance
      a.vx -= dx * force; a.vy -= dy * force; b.vx += dx * force; b.vy += dy * force
    }
    for (const spring of springs) {
      const a = nodes[spring.a], b = nodes[spring.b], same = a.group === b.group
      const dx = b.x - a.x, dy = b.y - a.y, distance = Math.max(1, Math.hypot(dx, dy))
      const pull = (distance - (same ? 84 : 240)) * (same ? 0.018 : 0.0012) * Math.min(3, Math.log2(spring.weight + 1))
      a.vx += dx / distance * pull; a.vy += dy / distance * pull; b.vx -= dx / distance * pull; b.vy -= dy / distance * pull
    }
    for (const item of nodes) {
      const center = centers[item.group]
      // 只有一个聚类时没有别的聚类把图撑宽：横向的回中力放轻，让节点沿宽画布摊开。
      item.vx += (center.x - item.x) * (groups.length === 1 ? 0.012 : 0.03); item.vy += (center.y - item.y) * (groups.length === 1 ? 0.046 : 0.034)
      item.x += Math.max(-16, Math.min(16, item.vx)) * cooling; item.y += Math.max(-16, Math.min(16, item.vy)) * cooling
      item.vx *= 0.5; item.vy *= 0.5
    }
  }
  // 收尾：纸签是横向的矩形，仍然压在一起的按重叠较小的方向推开。
  for (let round = 0; round < 90; round += 1) {
    let moved = false
    for (let i = 0; i < nodes.length; i += 1) for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i], b = nodes[j]
      const overlapX = (a.w + b.w) / 2 + 8 - Math.abs(b.x - a.x), overlapY = NODE_HEIGHT + 9 - Math.abs(b.y - a.y)
      if (overlapX <= 0 || overlapY <= 0) continue
      if (overlapX < overlapY * 1.6) { const push = overlapX / 2 * (b.x >= a.x ? 1 : -1); a.x -= push; b.x += push }
      else { const push = overlapY / 2 * (b.y >= a.y ? 1 : -1); a.y -= push; b.y += push }
      moved = true
    }
    if (!moved) break
  }
  const placed: Placed[] = nodes.map(item => ({ node: item.node, x: item.x, y: item.y, w: item.w, group: item.group }))
  // 聚类的名字写在它最上面那个节点的上方。
  const areas = groups.map((group, at) => {
    const members = placed.filter(item => item.group === at)
    const top = Math.min(...members.map(item => item.y)), cx = members.reduce((sum, item) => sum + item.x, 0) / Math.max(1, members.length)
    return { id: group.id, label: group.label, more: group.files - group.shown, x: cx, y: top - 30, color: WASH[at % WASH.length], empty: !members.length }
  }).filter(area => !area.empty)
  const xs = placed.flatMap(item => [item.x - item.w / 2, item.x + item.w / 2]), ys = placed.map(item => item.y)
  const bounds = placed.length ? { x1: Math.min(...xs) - 40, x2: Math.max(...xs) + 40, y1: Math.min(...ys) - 64, y2: Math.max(...ys) + 44 } : { x1: -200, x2: 200, y1: -150, y2: 150 }
  return { placed, areas, bounds, at: new Map(placed.map(item => [item.node.id, item])) }
}
