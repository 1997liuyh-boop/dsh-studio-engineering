import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { listTracked } from '../git.ts'
import { languageOf } from './facts.ts'

/** 不进图谱的目录：依赖、构建产物、缓存与工具目录。 */
const ignoredDirs = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.nuxt', '.output', '.next', '.vite', '.turbo', '.cache', 'coverage', 'vendor', '.venv', '__pycache__', '.idea', '.vscode', '.dsh', '.claude-tmp', '.playwright-mcp'])
/** 项目配置文件：解析路径别名、工作区包与自动导入约定时读取。 */
const configNames = /^(package\.json|tsconfig(\.[\w-]+)?\.json|jsconfig\.json|nuxt\.config\.(ts|js|mjs|mts)|pages\.json)$/
export const MAX_FILES = 20_000

export interface ScanResult {
  /** 图谱支持的源码文件（相对路径，正斜杠） */
  sources: string[]
  /** package.json、tsconfig、nuxt.config 与 uni-app 的 pages.json 的路径 */
  configs: string[]
  /** 超过数量上限被丢弃的源码文件数 */
  dropped: number
  /** 判定为构建产物而排除的文件数 */
  generated: number
}

/** 常见的构建输出目录名；只有同一个包里另有 src 源码目录时才把它们当作产物。 */
const outputDirs = new Set(['lib', 'dist', 'build', 'out', 'static', 'public', 'esm', 'cjs'])

const ignored = (path: string) => path.split('/').some(segment => ignoredDirs.has(segment)) || /\.min\.(js|mjs|cjs)$/.test(path)

/** 非 Git 目录的回退：递归列出文件，不跟随符号链接。 */
async function walk(root: string, signal?: AbortSignal): Promise<string[]> {
  const files: string[] = []
  const visit = async (dir: string): Promise<void> => {
    signal?.throwIfAborted()
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ignoredDirs.has(entry.name)) continue
      const path = dir ? dir + '/' + entry.name : entry.name
      if (entry.isDirectory()) { if (!entry.name.startsWith('.')) await visit(path) }
      else if (entry.isFile()) files.push(path)
      if (files.length > MAX_FILES * 4) return
    }
  }
  await visit('')
  return files
}

/**
 * 列出项目里要进图谱的文件。Git 仓库按 .gitignore 过滤（包含未跟踪的新文件），其余目录递归遍历。
 * @param root 项目根目录。
 */
export async function scanProject(root: string, signal?: AbortSignal): Promise<ScanResult> {
  const all = ((await listTracked(root, signal)) ?? await walk(root, signal)).map(path => path.replaceAll('\\', '/'))
  const listed = new Set(all)
  // 未跟踪的目录联接（如链接到别处的 node_modules）会被 git 当普通目录列出：逐级检查目录是否为链接，是则整棵跳过。
  const linked = new Map<string, boolean>()
  const underLink = async (path: string): Promise<boolean> => {
    const segments = path.split('/')
    for (let depth = 1; depth < segments.length; depth += 1) {
      const dir = segments.slice(0, depth).join('/')
      let known = linked.get(dir)
      if (known === undefined) { known = await lstat(join(root, dir)).then(info => info.isSymbolicLink(), () => true); linked.set(dir, known) }
      if (known) return true
    }
    return false
  }
  const candidates: string[] = [], configs: string[] = []
  for (const path of all) {
    if (ignored(path) || await underLink(path)) continue
    if (configNames.test(path.slice(path.lastIndexOf('/') + 1))) configs.push(path)
    else if (languageOf(path)) candidates.push(path)
  }
  // 有 src 源码目录的包：它的 lib / dist 等目录里的脚本是构建产物。带 .map 的脚本同样是产物。
  const sourceRoots = new Set(candidates.filter(path => /\.(ts|tsx|mts|vue)$/.test(path) && /(^|\/)src\//.test(path)).map(path => path.slice(0, path.lastIndexOf('src/'))))
  const isGenerated = (path: string) => {
    if (!/\.(js|mjs|cjs)$/.test(path)) return false
    if (listed.has(path + '.map')) return true
    const segments = path.split('/')
    return segments.some((segment, position) => outputDirs.has(segment) && sourceRoots.has(segments.slice(0, position).join('/') + (position ? '/' : '')))
  }
  const sources = candidates.filter(path => !isGenerated(path)).sort()
  const dropped = Math.max(0, sources.length - MAX_FILES)
  return { sources: sources.slice(0, MAX_FILES), configs, dropped, generated: candidates.length - sources.length }
}
