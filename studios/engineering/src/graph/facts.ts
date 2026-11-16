import { createHash } from 'node:crypto'
import { basename, dirname, extname } from 'node:path'
import type { ComponentApi, FileFacts, Language, UseFact } from '../types.ts'
import { extractScript, type ScriptFacts } from './extract.ts'
import { parserFor } from './parser.ts'

/** 扩展名到语言；不在表里的文件不进图谱。 */
const languages: Record<string, Language> = { '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx', '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx', '.vue': 'vue', '.nvue': 'vue' }

/** 模板里不算组件的标签：HTML / SVG 原生标签与 Vue 内置元素。 */
const nativeTags = new Set('a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p picture pre progress q rp rt ruby s samp script search section select slot small source span strong style sub summary sup table tbody td template textarea tfoot th thead time title tr track u ul var video wbr svg path circle rect line polyline polygon ellipse g defs use text tspan lineargradient radialgradient stop clippath mask pattern image foreignobject symbol filter component transition transition-group keep-alive teleport suspense'.split(' '))

/**
 * 判断文件是否属于图谱支持的语言。
 * @param path 相对或绝对路径。
 */
export function languageOf(path: string): Language | undefined {
  return languages[extname(path).toLowerCase()]
}

/** 组件名：文件名转大驼峰；index.vue 取所在目录名。 */
export function componentName(path: string): string {
  const stem = basename(path, extname(path))
  const raw = stem.toLowerCase() === 'index' ? basename(dirname(path)) : stem
  return pascal(raw)
}

/** kebab-case / snake_case / camelCase 统一转大驼峰，用于匹配模板标签与组件文件。 */
export function pascal(name: string): string {
  return name.split(/[-_.\s]+/).filter(Boolean).map(part => part[0].toUpperCase() + part.slice(1)).join('')
}

const hashOf = (source: string) => createHash('sha1').update(source).digest('hex')

/** 解析一段脚本；语法树用完即释放，避免 wasm 内存累积。 */
async function parseScript(source: string, language: Exclude<Language, 'vue'>, lineOffset: number): Promise<ScriptFacts> {
  const parser = await parserFor(language)
  const tree = parser.parse(source)
  try {
    if (!tree) throw new Error('解析器没有返回语法树')
    return extractScript(tree.rootNode, lineOffset)
  } finally { tree?.delete(); parser.delete() }
}

/** 合并 Vue 文件里的多段脚本（<script> 与 <script setup>）。 */
function merge(parts: ScriptFacts[]): ScriptFacts {
  return {
    symbols: parts.flatMap(part => part.symbols), imports: parts.flatMap(part => part.imports), reexports: parts.flatMap(part => part.reexports),
    aliases: Object.assign({}, ...parts.map(part => part.aliases)), uses: parts.flatMap(part => part.uses), macros: parts.flatMap(part => part.macros), emitted: [...new Set(parts.flatMap(part => part.emitted))], mixins: parts.flatMap(part => part.mixins), hasError: parts.some(part => part.hasError),
  }
}

/** 把宏调用整理成组件接口；类型参数是本文件接口名时换成接口全文。 */
function componentApi(facts: ScriptFacts): ComponentApi | undefined {
  const expand = (macro: ScriptFacts['macros'][number]) => (macro.typeName && facts.symbols.find(symbol => symbol.name === macro.typeName)?.signature) || macro.text
  const pick = (name: string) => facts.macros.filter(macro => macro.name === name).map(expand).filter(Boolean)
  const api: ComponentApi = {}
  if (pick('defineProps').length) api.props = pick('defineProps')[0]
  if (pick('defineEmits').length) api.emits = pick('defineEmits')[0]
  // 选项式组件常常不声明 emits：按 this.$emit 实际用到的事件名列出。
  else if (facts.emitted.length) api.emits = facts.emitted.map(name => JSON.stringify(name)).join(', ')
  if (pick('defineModel').length) api.models = pick('defineModel')
  if (pick('defineSlots').length) api.slots = pick('defineSlots')[0]
  return Object.keys(api).length ? api : undefined
}

/**
 * 抽取 Vue 单文件组件：脚本块按各自语言解析，模板里的自定义标签记为渲染关系，
 * 模板里出现的脚本符号记为引用（事件处理函数等只在模板里用到的符号不至于显示为无人使用）。
 */
async function extractVue(source: string): Promise<ScriptFacts> {
  const parts: ScriptFacts[] = []
  for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    const lang = /\blang\s*=\s*["']?(\w+)/.exec(match[1])?.[1] ?? 'js'
    const language = lang === 'ts' ? 'ts' : lang === 'tsx' ? 'tsx' : lang === 'jsx' ? 'jsx' : 'js'
    const start = match.index + match[0].indexOf('>') + 1
    parts.push(await parseScript(match[2], language, source.slice(0, start).split('\n').length - 1))
  }
  const facts = merge(parts)
  const open = source.search(/<template\b[^>]*>/), close = source.lastIndexOf('</template>')
  if (open >= 0 && close > open) {
    const template = source.slice(open, close)
    const baseLine = source.slice(0, open).split('\n').length
    const seen = new Set<string>()
    const uses: UseFact[] = []
    for (const match of template.matchAll(/<([A-Za-z][\w.-]*)/g)) {
      const tag = match[1]
      // 自定义组件：大驼峰或带连字符；原生标签与内置元素跳过。
      if (nativeTags.has(tag.toLowerCase()) || !(/^[A-Z]/.test(tag) || tag.includes('-'))) continue
      const name = pascal(tag)
      if (seen.has(name)) continue
      seen.add(name)
      uses.push({ from: '', name, kind: 'render', line: baseLine + template.slice(0, match.index).split('\n').length - 1 })
    }
    const words = new Set(template.match(/[A-Za-z_$][\w$]*/g) ?? [])
    const known = new Set([...facts.symbols.filter(symbol => !symbol.parent).map(symbol => symbol.name), ...facts.imports.flatMap(item => item.names.map(name => name.local))])
    // 选项式组件的方法在模板里直接按名字使用，等同于 this.方法名。
    const thisOnly = new Set(facts.symbols.filter(symbol => symbol.viaThis).map(symbol => symbol.name))
    for (const name of known) if (words.has(name) && !seen.has(name)) uses.push(thisOnly.has(name) ? { from: '', name: 'this', member: name, kind: 'ref', line: baseLine } : { from: '', name, kind: 'ref', line: baseLine })
    facts.uses.push(...uses)
  }
  return facts
}

/**
 * 抽取一个文件的事实；解析异常不抛出，记录在 error 里并返回空事实，单个坏文件不影响整张图。
 * @param path 相对项目根目录的路径（正斜杠）。
 * @param source 文件内容。
 * @param stat 文件体积与修改时间，用于下次快速判断是否变化。
 */
export async function extractFile(path: string, source: string, stat: { size: number; mtime: number }): Promise<FileFacts> {
  const language = languageOf(path)
  if (!language) throw new Error('不支持的文件类型：' + path)
  const base = { path, hash: hashOf(source), size: stat.size, mtime: stat.mtime, language, lines: source.split('\n').length }
  try {
    const facts = language === 'vue' ? await extractVue(source) : await parseScript(source, language, 0)
    const component = language === 'vue' ? componentApi(facts) : undefined
    return { ...base, symbols: facts.symbols, imports: facts.imports, reexports: facts.reexports, aliases: facts.aliases, uses: facts.uses, ...(component ? { component } : {}), ...(facts.mixins.length ? { mixins: facts.mixins } : {}), ...(facts.hasError ? { error: '部分语法未被解析器识别，结果可能不完整' } : {}) }
  } catch (error) {
    return { ...base, symbols: [], imports: [], reexports: [], aliases: {}, uses: [], error: error instanceof Error ? error.message : '解析失败' }
  }
}
