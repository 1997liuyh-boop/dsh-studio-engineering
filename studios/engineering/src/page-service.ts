import { isAbsolute } from 'node:path'
import { workingChanges } from './git.ts'
import { canvasOf } from './graph/canvas.ts'
import type { GraphEngine } from './graph/engine.ts'
import type { HealthReport } from './graph/health.ts'
import { clusterDetail, clusterList, clusterOfNode, cycleList, flowDetail, flowList, routeList, traceResult } from './graph/present.ts'
import { brief, changedSymbols, context, impact, overview, search, type GraphIndex } from './graph/query.ts'
import { planDetail, verifyPlan } from './plan-service.ts'
import { readPlans, text } from './project.ts'
import type { ArchiveResult, Snapshot } from './protocol.ts'
import type { BundledSkill } from './skills.ts'
import type { GraphNode } from './types.ts'

/** 页面与模型工具复用已有的图谱、报告和设置实现。 */
interface PageServices {
  engine: GraphEngine; signal: AbortSignal; skills: BundledSkill[]
  snapshot(): Promise<Snapshot>
  configure(input: unknown): Promise<void>
  assess(index: GraphIndex, signal: AbortSignal): Promise<HealthReport>
  exportArchive(index: GraphIndex, signal: AbortSignal): Promise<ArchiveResult>
  locate(index: GraphIndex, reference: string): { node: GraphNode } | { problem: object }
}
/** 页面操作的独立入口；写操作仍由用户显式触发。 */
export function createPageDispatch(services: PageServices) {
  const { engine, signal, skills, snapshot, configure, assess, exportArchive, locate } = services
  return async (input: Record<string, unknown>): Promise<object> => {
    const action = text(input.action, 32)
    if (action === 'snapshot') return snapshot()
    if (action === 'configure') {
      await configure(input.settings)
      return snapshot()
    }
    if (action === 'skill') {
      const skill = skills.find(item => item.name === text(input.name, 64))
      if (!skill) throw new Error('没有这个技能')
      return { name: skill.name, description: skill.description, content: skill.content }
    }
    const root = text(input.root, 2048)
    if (!isAbsolute(root)) throw new Error('请填写项目的绝对路径')
    if (action === 'remove') { await engine.remove(root); return snapshot() }
    if (action !== 'build' && !(await engine.list()).some(meta => meta.root === root)) throw new Error('这个项目还没有建过图谱')
    const { index, freshness } = await engine.ensure(root, { signal: signal, force: action === 'rebuild' })
    if (action === 'build' || action === 'rebuild' || action === 'overview') return { freshness, overview: overview(index) }
    if (action === 'search') return { freshness, ...search(index, text(input.query, 200), 30) }
    if (action === 'views') return { clusters: clusterList(index, 40), flows: flowList(index, { limit: 400 }), routes: routeList(index, { limit: 1000 }), cycles: cycleList(index, 50) }
    if (action === 'plans') return { plans: await readPlans(root) }
    if (action === 'plan') return planDetail(root, text(input.slug, 64))
    if (action === 'check-plan') return verifyPlan(index, text(input.slug, 64), signal)
    if (action === 'changes') {
      const files = await workingChanges(root, 'HEAD', signal)
      if (!files) return { available: false, files: [], symbols: [], deleted: [], outside: [] }
      const mapped = changedSymbols(index, files)
      return { available: true, files, symbols: mapped.symbols.map(node => brief(index, node)), deleted: mapped.deleted, outside: mapped.outside, impact: mapped.symbols.length ? impact(index, mapped.symbols, { limit: 100 }) : undefined }
    }
    if (action === 'health') return assess(index, signal)
    if (action === 'canvas') return canvasOf(index, input.cluster === undefined || input.cluster === '' ? undefined : text(input.cluster, 16))
    if (action === 'export') return exportArchive(index, signal)
    if (action === 'cluster') { const detail = clusterDetail(index, text(input.id, 16)); if (!detail) throw new Error('没有这个聚类'); return detail }
    if (action === 'flow') { const detail = flowDetail(index, text(input.id, 2048)); if (!detail) throw new Error('没有这条流程'); return detail }
    if (action === 'trace') {
      const from = locate(index, text(input.from, 600)), to = locate(index, text(input.to, 600))
      if ('problem' in from) return from.problem
      if ('problem' in to) return to.problem
      return traceResult(index, from.node, to.node)
    }
    if (action === 'context' || action === 'impact') {
      const found = locate(index, text(input.target, 600))
      if ('problem' in found) return found.problem
      // 页面要据此把画布切到节点所在的聚类。
      return action === 'context' ? { ...context(index, found.node, 40), cluster: clusterOfNode(index, found.node) } : impact(index, [found.node], { limit: 60 })
    }
    throw new Error('未知工作室操作')
  }
}
