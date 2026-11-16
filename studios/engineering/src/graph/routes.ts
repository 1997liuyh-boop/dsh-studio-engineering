import { readFile } from 'node:fs/promises'
import { posix, resolve } from 'node:path'
import type { Route } from '../types.ts'
import { stripJsonComments, type Layout } from './layout.ts'

/** 页面文件可能的扩展名：uni-app 的页面也可以是 .nvue。 */
const pageExtensions = ['.vue', '.nvue', '.tsx', '.jsx', '.ts', '.js']
const httpMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options'])

async function readJson(root: string, path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(resolve(root, path), 'utf8')
    const value: unknown = JSON.parse(stripJsonComments(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw))
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch { return undefined }
}

const list = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : []
const string = (value: unknown) => typeof value === 'string' ? value : ''

/**
 * 读 uni-app 的 pages.json：主包页面、分包页面与底部导航。条件编译注释（#ifdef）按普通注释去掉，各端页面都会列出。
 * @param root 项目根目录。
 * @param path pages.json 的相对路径。
 * @param files 图谱内的源码文件。
 */
async function uniRoutes(root: string, path: string, files: Set<string>): Promise<Route[]> {
  const config = await readJson(root, path)
  if (!config) return []
  const base = posix.dirname(path) === '.' ? '' : posix.dirname(path)
  const tabs = new Set(list((config.tabBar as Record<string, unknown> | undefined)?.list).map(item => string(item.pagePath).replace(/^\//, '')))
  const routes: Route[] = []
  const add = (page: Record<string, unknown>, prefix: string, subPackage?: string) => {
    const pagePath = (prefix ? prefix.replace(/\/$/, '') + '/' : '') + string(page.path).replace(/^\//, '')
    if (!string(page.path)) return
    const stem = base ? base + '/' + pagePath : pagePath
    const file = pageExtensions.map(extension => stem + extension).find(candidate => files.has(candidate))
    if (!file) return
    const style = page.style && typeof page.style === 'object' ? page.style as Record<string, unknown> : {}
    // %key% 是国际化占位符，不是给人看的标题。
    const raw = string(style.navigationBarTitleText).trim()
    const title = /^%[^%]+%$/.test(raw) ? '' : raw
    routes.push({ path: '/' + pagePath, file, kind: 'page', source: 'pages.json', ...(title ? { title } : {}), ...(tabs.has(pagePath) ? { tab: true as const } : {}), ...(subPackage ? { subPackage } : {}) })
  }
  for (const page of list(config.pages)) add(page, '')
  for (const pack of [...list(config.subPackages), ...list(config.subpackages)]) {
    const packRoot = string(pack.root)
    for (const page of list(pack.pages)) add(page, packRoot, packRoot)
  }
  return routes
}

/** Nuxt 文件路由的一段：index 去掉，[id] → :id，[...slug] → :slug*，[[id]] → :id?。 */
const segment = (name: string) => name === 'index' ? '' : name.replace(/^\[\[(\w+)\]\]$/, ':$1?').replace(/^\[\.\.\.(\w+)\]$/, ':$1*').replace(/\[(\w+)\]/g, ':$1')

/**
 * 识别项目里框架按约定加载的页面与接口。只读配置与文件名，不执行项目脚本。
 * @param root 项目根目录。
 * @param layout 项目布局（含 Nuxt 应用目录）。
 * @param configs 扫描到的配置文件。
 */
export async function detectRoutes(root: string, layout: Layout, configs: string[]): Promise<Route[]> {
  const routes: Route[] = []
  for (const path of configs.filter(item => item === 'pages.json' || item.endsWith('/pages.json'))) routes.push(...await uniRoutes(root, path, layout.files))
  for (const app of layout.nuxt) {
    const pagesDir = (app.srcDir ? app.srcDir + '/' : '') + 'pages/'
    const serverDir = (app.dir ? app.dir + '/' : '') + 'server/'
    for (const file of layout.files) {
      if (file.startsWith(pagesDir) && /\.(vue|tsx|jsx)$/.test(file)) {
        const path = '/' + file.slice(pagesDir.length).replace(/\.\w+$/, '').split('/').map(segment).filter(Boolean).join('/')
        routes.push({ path, file, kind: 'page', source: 'nuxt-pages' })
      } else if (file.startsWith(serverDir + 'api/') || file.startsWith(serverDir + 'routes/')) {
        const relative = file.slice(serverDir.length).replace(/\.(ts|js|mjs|mts)$/, '')
        const parts = relative.split('.')
        const method = parts.length > 1 && httpMethods.has(parts[parts.length - 1]) ? parts.pop()!.toUpperCase() : undefined
        const route = parts.join('.').replace(/^routes\//, '').split('/').map(segment).filter(Boolean).join('/')
        routes.push({ path: '/' + route, file, kind: 'api', source: 'nuxt-server', ...(method ? { method } : {}) })
      }
    }
  }
  return routes.sort((a, b) => a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path))
}
