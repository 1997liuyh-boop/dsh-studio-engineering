/** 检查 Vue 源码和模板中的项目约定，作为可执行规范入口。 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'

const failures = []
function inspectCode(source, file, template) {
  const ast = ts.createSourceFile(file + '.ts', source, ts.ScriptTarget.Latest, true)
  function visit(node) {
    if (template && (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node))) failures.push(file + '：模板中禁止 TypeScript 类型断言')
    if (!template && ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name || ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))) {
      const name = node.name?.getText(ast)
      if (name?.includes('_')) failures.push(file + '：方法名必须使用 camelCase：' + name)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
}
function inspectTemplate(node, file) {
  if (!node || typeof node !== 'object') return
  if (node.type === 4 && !node.isStatic && typeof node.content === 'string') inspectCode(node.content, file, true)
  for (const key of ['children', 'props', 'branches']) for (const child of node[key] ?? []) inspectTemplate(child, file)
  if (node.content && typeof node.content === 'object') inspectTemplate(node.content, file)
  if (node.exp) inspectTemplate(node.exp, file)
}
async function scan(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, item.name)
    if (item.isDirectory()) await scan(file)
    else if (item.name.endsWith('.vue')) {
      const source = await readFile(file, 'utf8'), { descriptor, errors } = parse(source, { filename: file })
      for (const error of errors) failures.push(file + '：' + String(error))
      for (const script of [descriptor.script, descriptor.scriptSetup]) if (script) inspectCode(script.content, file, false)
      inspectTemplate(descriptor.template?.ast, file)
      if (!source.endsWith('\n') || source.endsWith('\n\n')) failures.push(file + '：文件末尾保留一个换行')
    }
  }
}
await scan(process.argv[2] ?? 'studios/engineering/src/page')
if (failures.length) { console.error([...new Set(failures)].join('\n')); process.exitCode = 1 }
else console.log('Vue 规范检查通过：模板无类型断言，方法使用 camelCase，文件换行一致。')
