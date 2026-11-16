import { readFile } from 'node:fs/promises'
import { posix, resolve } from 'node:path'

/** 一份 tsconfig / jsconfig 里的路径别名；dir 为配置所在目录（相对项目根，根目录为空串）。 */
export interface AliasConfig {
  dir: string
  /** 匹配模式（可带一个 *）与目标路径（相对项目根） */
  paths: { pattern: string; targets: string[] }[]
  /** baseUrl（相对项目根）；设置后裸路径也按它解析 */
  baseUrl?: string
}

/** 解析导入路径所需的项目布局。 */
export interface Layout {
  /** 图谱内的全部源码文件 */
  files: Set<string>
  /** 含有源码文件的目录 */
  dirs: Set<string>
  /** 路径别名，目录深的在前 */
  aliases: AliasConfig[]
  /** 工作区包：包名 → 目录与入口候选 */
  packages: Map<string, { dir: string; entries: string[] }>
  /** package.json 所在目录，目录深的在前 */
  packageDirs: string[]
  /** Nuxt 应用：根目录与源码目录（Nuxt 4 为 app/） */
  nuxt: { dir: string; srcDir: string }[]
  /** 项目启用了自动导入（Nuxt 或 unplugin-auto-import） */
  autoImport: boolean
}

/** 去掉 JSON 里的注释与尾逗号（tsconfig 允许），字符串内容原样保留。 */
export function stripJsonComments(text: string): string {
  let out = '', inString = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index], next = text[index + 1]
    if (inString) {
      out += char
      if (char === '\\') { out += next ?? ''; index += 1 }
      else if (char === '"') inString = false
    } else if (char === '"') { inString = true; out += char }
    else if (char === '/' && next === '/') { while (index < text.length && text[index] !== '\n') index += 1; out += '\n' }
    else if (char === '/' && next === '*') { index = text.indexOf('*/', index + 2); if (index < 0) break; index += 1 }
    else out += char
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

const depth = (dir: string) => dir ? dir.split('/').length : 0
const join = (...parts: string[]) => { const joined = posix.normalize(parts.filter(Boolean).join('/')); return joined === '.' ? '' : joined.replace(/\/$/, '') }

async function readJson(root: string, path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(resolve(root, path), 'utf8')
    const value: unknown = JSON.parse(stripJsonComments(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw))
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch { return undefined }
}

/** 读取一份 tsconfig 的别名，并跟进 extends 与 references（Nuxt 把别名写在 .nuxt 下的生成配置里）。 */
async function readAliases(root: string, path: string, seen: Set<string>): Promise<Omit<AliasConfig, 'dir'>> {
  const result: Omit<AliasConfig, 'dir'> = { paths: [] }
  if (seen.has(path) || seen.size > 12) return result
  seen.add(path)
  const config = await readJson(root, path)
  if (!config) return result
  const dir = posix.dirname(path) === '.' ? '' : posix.dirname(path)
  // extends 省略扩展名时指向同名 .json；references 指向目录时取其中的 tsconfig.json。
  const relative = (item: unknown): item is string => typeof item === 'string' && item.startsWith('.')
  const linked = [
    ...(typeof config.extends === 'string' ? [config.extends] : Array.isArray(config.extends) ? config.extends : []).filter(relative).map(item => item.endsWith('.json') ? item : item + '.json'),
    ...(Array.isArray(config.references) ? config.references.map(item => item && typeof item === 'object' ? (item as { path?: unknown }).path : undefined) : []).filter(relative).map(item => item.endsWith('.json') ? item : item + '/tsconfig.json'),
  ]
  for (const link of linked) {
    const target = join(dir, link)
    // 只跟进项目目录内的配置。
    if (target.startsWith('..')) continue
    const inherited = await readAliases(root, target, seen)
    result.paths.push(...inherited.paths)
    result.baseUrl ??= inherited.baseUrl
  }
  const options = config.compilerOptions && typeof config.compilerOptions === 'object' ? config.compilerOptions as Record<string, unknown> : {}
  const baseUrl = typeof options.baseUrl === 'string' ? join(dir, options.baseUrl) : undefined
  if (baseUrl !== undefined && !baseUrl.startsWith('..')) result.baseUrl = baseUrl
  if (options.paths && typeof options.paths === 'object') {
    const own = Object.entries(options.paths as Record<string, unknown>).flatMap(([pattern, targets]) => Array.isArray(targets)
      ? [{ pattern, targets: targets.filter((item): item is string => typeof item === 'string').map(item => join(baseUrl ?? dir, item)).filter(item => !item.startsWith('..')) }] : [])
    // 自己声明的别名优先于继承来的。
    result.paths.unshift(...own)
  }
  return result
}

/**
 * 读取项目配置，整理出解析导入路径要用的别名、工作区包与自动导入约定。只读 JSON，不执行项目里的任何脚本。
 * @param root 项目根目录（绝对路径）。
 * @param sources 图谱内的源码文件。
 * @param configs 扫描到的 package.json / tsconfig / nuxt.config 路径。
 */
export async function loadLayout(root: string, sources: string[], configs: string[]): Promise<Layout> {
  const files = new Set(sources), dirs = new Set<string>([''])
  for (const file of sources) for (let dir = posix.dirname(file); dir !== '.' && !dirs.has(dir); dir = posix.dirname(dir)) dirs.add(dir)
  const layout: Layout = { files, dirs, aliases: [], packages: new Map(), packageDirs: [], nuxt: [], autoImport: false }
  for (const path of configs) {
    const name = path.slice(path.lastIndexOf('/') + 1), dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    if (name === 'package.json') {
      layout.packageDirs.push(dir)
      const pkg = await readJson(root, path)
      if (!pkg) continue
      const deps = { ...(pkg.dependencies as object | undefined), ...(pkg.devDependencies as object | undefined) }
      if ('unplugin-auto-import' in deps || 'nuxt' in deps) layout.autoImport = true
      if (typeof pkg.name === 'string' && dir) {
        const exported = pkg.exports && typeof pkg.exports === 'object' ? (pkg.exports as Record<string, unknown>)['.'] : pkg.exports
        const entry = (value: unknown): string[] => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(entry) : []
        layout.packages.set(pkg.name, { dir, entries: [...entry(pkg.source), ...entry(exported), ...entry(pkg.module), ...entry(pkg.main)].map(item => join(dir, item)) })
      }
    } else if (name.startsWith('nuxt.config.')) {
      // Nuxt 4 默认源码目录为 app/；没有该目录时沿用项目根。
      layout.nuxt.push({ dir, srcDir: dirs.has(join(dir, 'app')) ? join(dir, 'app') : dir })
      layout.autoImport = true
    } else if (name === 'tsconfig.json' || name === 'jsconfig.json') {
      const aliases = await readAliases(root, path, new Set())
      if (aliases.paths.length || aliases.baseUrl !== undefined) layout.aliases.push({ dir, ...aliases })
    }
  }
  layout.aliases.sort((a, b) => depth(b.dir) - depth(a.dir))
  layout.packageDirs.sort((a, b) => depth(b) - depth(a))
  layout.nuxt.sort((a, b) => depth(b.dir) - depth(a.dir))
  return layout
}

const extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.nvue']
const within = (dir: string, file: string) => !dir || file === dir || file.startsWith(dir + '/')

/** 把不带扩展名的路径落到实际文件：原路径、补扩展名、目录下的 index，以及 ESM 写法里 .js 指向 .ts 的情况。 */
function toFile(layout: Layout, base: string): string | undefined {
  if (!base || base.startsWith('..')) return undefined
  if (layout.files.has(base)) return base
  const stripped = base.replace(/\.(js|mjs|cjs|jsx)$/, '')
  for (const candidate of stripped === base ? [base] : [stripped, base]) {
    for (const extension of extensions) if (layout.files.has(candidate + extension)) return candidate + extension
    if (layout.dirs.has(candidate)) for (const extension of extensions) if (layout.files.has(candidate + '/index' + extension)) return candidate + '/index' + extension
  }
  return undefined
}

/**
 * 把导入路径解析为图谱内的文件；外部依赖、样式、JSON 等不在图谱内的目标返回 undefined。
 * @param layout 项目布局。
 * @param from 发起导入的文件（相对路径）。
 * @param source 导入路径原文。
 */
export function resolveImport(layout: Layout, from: string, source: string): string | undefined {
  const clean = source.split('?')[0]
  if (clean.startsWith('.')) return toFile(layout, join(posix.dirname(from) === '.' ? '' : posix.dirname(from), clean))
  if (clean.startsWith('/') || clean.startsWith('node:')) return undefined
  // 最近的 tsconfig 声明的别名。
  for (const config of layout.aliases) {
    if (!within(config.dir, from)) continue
    for (const { pattern, targets } of config.paths) {
      const star = pattern.indexOf('*')
      const matched = star < 0 ? (clean === pattern ? '' : undefined)
        : clean.startsWith(pattern.slice(0, star)) && clean.endsWith(pattern.slice(star + 1)) ? clean.slice(star, clean.length - (pattern.length - star - 1)) : undefined
      if (matched === undefined) continue
      for (const target of targets) { const hit = toFile(layout, target.replace('*', matched)); if (hit) return hit }
    }
    if (config.baseUrl !== undefined) { const hit = toFile(layout, join(config.baseUrl, clean)); if (hit) return hit }
  }
  // 约定别名：Nuxt 的 ~ / @ 指向源码目录、~~ / @@ 指向应用根；其余项目的 @ / ~ 指向最近包的 src。
  const convention = /^(~~|@@|~|@)\/(.*)$/.exec(clean)
  if (convention) {
    const nuxt = layout.nuxt.find(app => within(app.dir, from))
    if (nuxt) return toFile(layout, join(convention[1].length === 2 ? nuxt.dir : nuxt.srcDir, convention[2])) ?? toFile(layout, join(nuxt.dir, convention[2]))
    const packageDir = layout.packageDirs.find(dir => within(dir, from)) ?? ''
    return toFile(layout, join(packageDir, 'src', convention[2])) ?? toFile(layout, join(packageDir, convention[2]))
  }
  // 工作区内的包：包名或包名下的子路径。
  const segments = clean.split('/')
  const name = clean.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
  const workspace = layout.packages.get(name)
  if (!workspace) return undefined
  const rest = clean.slice(name.length + 1)
  if (rest) return toFile(layout, join(workspace.dir, rest)) ?? toFile(layout, join(workspace.dir, 'src', rest))
  for (const entry of workspace.entries) {
    // 入口常指向构建产物（lib / dist），优先换回同名源码。
    const hit = toFile(layout, entry.replace(/(^|\/)(lib|dist|build|out)\//, '$1src/')) ?? toFile(layout, entry)
    if (hit) return hit
  }
  return toFile(layout, join(workspace.dir, 'src/index')) ?? toFile(layout, join(workspace.dir, 'index'))
}

/** 导入路径对应的外部包名；相对路径、别名与 Node 内置模块返回 undefined。 */
export function externalPackage(source: string): string | undefined {
  if (/^(\.|\/|~|#|node:)/.test(source) || /^@\//.test(source) || /^@@\//.test(source)) return undefined
  const segments = source.split('/')
  return source.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}
