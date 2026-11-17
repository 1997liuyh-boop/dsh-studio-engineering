import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { headCommit, workingChanges } from './git.ts'
import { checkPlan, parsePlan, type SavedPlan } from './plan.ts'
import { exists, object, readPlans, text } from './project.ts'
import type { GraphIndex } from './graph/query.ts'

/** 核对记录只说明结构与改动范围，不代表功能验收通过。 */
export type PlanCheck = Awaited<ReturnType<typeof checkPlan>> & { checkedAt: string; commit: string }
/** 页面读取的真实方案及历史核对结果。 */
export interface PlanDetail { slug: string; createdAt: string; baseCommit: string; plan: SavedPlan['plan']; report: PlanCheck | null }
export type PlanSummary = Awaited<ReturnType<typeof readPlans>>[number]

/** 限制方案目录名，所有读写均留在项目的迭代文档目录。 */
function planDirectory(root: string, slug: string): string {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)) throw new Error('slug 格式无效')
  return join(root, 'docs/iterations', slug)
}

/** 读取并校验已有方案，页面与模型工具共用。 */
export async function readSavedPlan(root: string, slug: string): Promise<SavedPlan> {
  const raw = object(JSON.parse(await readFile(join(planDirectory(root, slug), 'iteration.json'), 'utf8')))
  if (raw.schemaVersion !== 1) throw new Error('方案文件版本不受支持')
  const signatures = object(raw.currentSignatures)
  if (Object.values(signatures).some(value => typeof value !== 'string')) throw new Error('方案签名记录格式无效')
  const plan = parsePlan(raw.plan)
  if (plan.slug !== slug) throw new Error('方案目录与内容中的 slug 不一致')
  return { schemaVersion: 1, createdAt: text(raw.createdAt, 100), baseCommit: typeof raw.baseCommit === 'string' ? raw.baseCommit : '', plan, currentSignatures: signatures as Record<string, string> }
}

/** 读取历史报告时校验关键字段，损坏的报告不能显示为通过。 */
export function parseCheck(value: unknown): PlanCheck {
  const raw = object(value)
  if (typeof raw.ok !== 'boolean' || typeof raw.slug !== 'string' || typeof raw.checkedAt !== 'string' || typeof raw.commit !== 'string'
    || typeof raw.implemented !== 'number' || typeof raw.total !== 'number'
    || !Array.isArray(raw.issues) || !raw.issues.every(item => typeof item === 'string')
    || !Array.isArray(raw.warnings) || !raw.warnings.every(item => typeof item === 'string')) throw new Error('历史核对报告格式无效，请重新核对')
  return raw as PlanCheck
}

/** 返回方案详情及历史报告；只有报告不存在时才标记为未核对。 */
export async function planDetail(root: string, slug: string): Promise<PlanDetail> {
  const saved = await readSavedPlan(root, slug)
  let report: PlanCheck | null = null
  try { report = parseCheck(JSON.parse(await readFile(join(planDirectory(root, slug), 'check-report.json'), 'utf8'))) }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
  return { slug, createdAt: saved.createdAt, baseCommit: saved.baseCommit, plan: saved.plan, report }
}

/** 按当前代码核对并写入报告；页面和 eng_plan 共用同一流程。 */
export async function verifyPlan(index: GraphIndex, slug: string, signal?: AbortSignal): Promise<PlanCheck> {
  const root = index.graph.root, saved = await readSavedPlan(root, slug)
  const changes = saved.baseCommit ? await workingChanges(root, saved.baseCommit, signal) : undefined
  const report = { checkedAt: new Date().toISOString(), commit: await headCommit(root, signal), ...await checkPlan(index, saved, changes, path => exists(join(root, path))) }
  signal?.throwIfAborted()
  await mkdir(planDirectory(root, slug), { recursive: true })
  await writeFile(join(planDirectory(root, slug), 'check-report.json'), JSON.stringify(report, null, 2) + '\n')
  return report
}
