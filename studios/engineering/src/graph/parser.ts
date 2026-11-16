import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Language as Grammar, Parser } from 'web-tree-sitter'
import type { Language } from '../types.ts'

/** 语法文件名；Vue 的脚本块按其 lang 走 ts / js。 */
const grammarFiles: Record<Exclude<Language, 'vue'>, string> = {
  ts: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  js: 'tree-sitter-javascript.wasm',
  jsx: 'tree-sitter-javascript.wasm',
}
/** 开发与测试时语法文件在各自的 npm 包里；打包后统一放在 lib/wasm。 */
const packageOf: Record<string, string> = {
  'web-tree-sitter.wasm': 'web-tree-sitter',
  'tree-sitter-typescript.wasm': 'tree-sitter-typescript',
  'tree-sitter-tsx.wasm': 'tree-sitter-typescript',
  'tree-sitter-javascript.wasm': 'tree-sitter-javascript',
}

const exists = (path: string) => access(path).then(() => true, () => false)

/**
 * 定位 wasm 文件：先找本模块旁的 wasm 目录（已打包），再逐级向上找 node_modules（源码运行）。
 * @param name wasm 文件名。
 */
async function locate(name: string): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url))
  const bundled = join(here, 'wasm', name)
  if (await exists(bundled)) return bundled
  for (let dir = here; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', packageOf[name], name)
    if (await exists(candidate)) return candidate
    if (dirname(dir) === dir) break
  }
  throw new Error('找不到语法解析文件：' + name)
}

let ready: Promise<void> | undefined
const grammars = new Map<string, Promise<Grammar>>()

/**
 * 取指定语言的解析器；运行时与语法只加载一次，解析器每次新建（解析器不可并发复用）。
 * @param language 脚本语言。
 */
export async function parserFor(language: Exclude<Language, 'vue'>): Promise<Parser> {
  ready ??= locate('web-tree-sitter.wasm').then(path => Parser.init({ locateFile: () => path }))
  await ready
  const file = grammarFiles[language]
  let grammar = grammars.get(file)
  if (!grammar) {
    grammar = locate(file).then(path => Grammar.load(path))
    grammars.set(file, grammar)
  }
  const parser = new Parser()
  parser.setLanguage(await grammar)
  return parser
}
