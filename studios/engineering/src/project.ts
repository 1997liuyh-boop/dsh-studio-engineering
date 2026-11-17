import { access, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

/** 项目概况：只读配置文件，不执行项目里的任何脚本。 */
export interface Project {
  root: string
  name: string
  /** 识别出的框架，如 Nuxt、Vue、React、UniApp；识别不出为空数组 */
  frameworks: string[]
  packageManager: string
  scripts: Record<string, string>
  /** 存在的约定与说明文件（相对路径） */
  conventions: string[]
  /** docs/iterations 下已有的迭代方案 */
  iterations: string[]
}

export const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('需要 JSON 对象')
  return value as Record<string, unknown>
}
export const text = (value: unknown, max = 4096): string => {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error('文字参数无效')
  return value
}
export const exists = (path: string) => access(path).then(() => true, () => false)

const frameworkPackages: [string, string][] = [['nuxt', 'Nuxt'], ['next', 'Next.js'], ['@dcloudio/uni-app', 'UniApp'], ['vue', 'Vue'], ['react', 'React'], ['svelte', 'Svelte'], ['@nestjs/core', 'NestJS'], ['express', 'Express'], ['electron', 'Electron']]
const conventionFiles = ['AGENTS.md', 'CLAUDE.md', 'README.md', 'README.zh.md', 'CONTRIBUTING.md', 'docs/glossary.md', 'docs/design-rules.md', '.editorconfig']
const lockfiles: [string, string][] = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm']]

/**
 * 读取项目概况。没有 package.json 的目录同样可用（图谱与方案不依赖它），只是框架与脚本为空。
 * @param input 项目根目录（绝对路径）。
 */
export async function inspectProject(input: string): Promise<Project> {
  if (!isAbsolute(input)) throw new Error('项目目录必须是绝对路径')
  const root = await realpath(input)
  let pkg: Record<string, unknown> = {}
  try { pkg = object(JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))) } catch { /* 非 Node 项目或文件损坏时按空处理 */ }
  const dependencies = { ...(pkg.dependencies as object | undefined), ...(pkg.devDependencies as object | undefined) }
  const scripts = Object.fromEntries(Object.entries((pkg.scripts as object | undefined) ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  let packageManager = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : ''
  if (!packageManager) for (const [file, manager] of lockfiles) if (await exists(join(root, file))) { packageManager = manager; break }
  const conventions: string[] = []
  for (const file of conventionFiles) if (await exists(join(root, file))) conventions.push(file)
  let iterations: string[] = []
  try { iterations = (await readdir(join(root, 'docs/iterations'), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort() } catch { /* 还没有迭代方案 */ }
  return { root, name: typeof pkg.name === 'string' ? pkg.name : root.split(/[\\/]/).pop() ?? root, frameworks: frameworkPackages.filter(([name]) => name in dependencies).map(([, label]) => label), packageManager, scripts, conventions, iterations }
}

/** 只留「包名 → 版本字符串」的条目，忽略格式不对的内容。 */
const versions = (value: unknown): Record<string, string> => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}

/**
 * 读取根目录 package.json 声明的依赖；没有或损坏时返回 undefined。
 * @param root 项目根目录。
 */
export async function readManifest(root: string): Promise<{ dependencies: Record<string, string>; devDependencies: Record<string, string>; peerDependencies: Record<string, string> } | undefined> {
  try {
    const pkg = object(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')))
    return { dependencies: versions(pkg.dependencies), devDependencies: versions(pkg.devDependencies), peerDependencies: versions(pkg.peerDependencies) }
  } catch { return undefined }
}

/**
 * 读取 docs/iterations 下已有的迭代方案摘要；读不了的目录跳过。
 * @param root 项目根目录。
 */
export async function readPlans(root: string): Promise<{ slug: string; title: string; createdAt: string; features: number; changes: number; steps: number; checked: boolean }[]> {
  let names: string[]
  try { names = (await readdir(join(root, 'docs/iterations'), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort() } catch { return [] }
  const plans = []
  for (const slug of names.slice(-50)) {
    try {
      const saved = object(JSON.parse(await readFile(join(root, 'docs/iterations', slug, 'iteration.json'), 'utf8')))
      const plan = object(saved.plan)
      const count = (value: unknown) => Array.isArray(value) ? value.length : 0
      plans.push({ slug, title: typeof plan.title === 'string' ? plan.title : slug, createdAt: typeof saved.createdAt === 'string' ? saved.createdAt : '', features: count(plan.features), changes: count(plan.changes), steps: count(plan.steps), checked: await exists(join(root, 'docs/iterations', slug, 'check-report.json')) })
    } catch { /* 不是工作室生成的方案目录 */ }
  }
  return plans.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
