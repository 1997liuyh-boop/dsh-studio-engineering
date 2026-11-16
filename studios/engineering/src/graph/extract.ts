import type { Node } from 'web-tree-sitter'
import type { ImportFact, ReexportFact, SymbolFact, UseFact } from '../types.ts'

/** 一段脚本的抽取结果；Vue 文件可能有两段脚本，合并后成为一个文件的事实。 */
export interface ScriptFacts {
  symbols: SymbolFact[]
  imports: ImportFact[]
  reexports: ReexportFact[]
  aliases: Record<string, string>
  uses: UseFact[]
  /** Vue 宏调用的原文：defineProps / defineEmits / defineModel / defineSlots */
  macros: { name: string; text: string; typeName?: string }[]
  /** this.$emit 用到的事件名；选项式组件没有声明 emits 时据此列出事件 */
  emitted: string[]
  /** 选项式组件引入的混入（本地名） */
  mixins: string[]
  /** 语法树里存在错误节点 */
  hasError: boolean
}

const SIGNATURE_LIMIT = 400
const TYPE_LIMIT = 1200
const DOC_LIMIT = 240
/** 同名使用只保留一条，保留语义更强的那种。 */
const useRank: Record<UseFact['kind'], number> = { ref: 0, call: 1, render: 1, implements: 2, extends: 2 }
const vueMacros = new Set(['defineProps', 'defineEmits', 'defineModel', 'defineSlots'])
/** 出现这些键的对象字面量按选项式组件（或混入）处理。 */
const optionKeys = new Set(['methods', 'data', 'computed', 'props', 'components', 'watch', 'mixins', 'emits', 'setup', 'created', 'mounted', 'onLoad', 'onShow', 'onLaunch'])
/** 把对象包成组件的函数：参数里的对象同样按选项式组件处理。 */
const componentFactories = new Set(['defineComponent', 'defineNuxtComponent', 'Vue.extend'])
/** 这些字段位置的标识符一定是声明（形参、别名、标签），不是使用。 */
const declarationFields = new Set(['pattern', 'alias', 'label', 'parameter'])
/** name 字段只在这些父节点下才是声明；泛型 Promise<T> 的 name 是类型引用。 */
const namedDeclarations = new Set(['variable_declarator', 'function_declaration', 'generator_function_declaration', 'function_expression', 'function_signature', 'class_declaration', 'abstract_class_declaration', 'class', 'interface_declaration', 'type_alias_declaration', 'enum_declaration', 'method_definition', 'import_specifier', 'namespace_import', 'module', 'internal_module', 'type_parameter'])

const squeeze = (text: string, limit: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat
}
/** 接口、类型与组件接口保留换行（成员之间靠换行分隔），只去掉缩进与空行。 */
const squeezeLines = (text: string, limit: number) => {
  const lines = text.split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')
  return lines.length > limit ? lines.slice(0, limit) + '…' : lines
}

/** 取字符串字面量的内容；模板字符串等动态写法返回空。 */
function literal(node: Node | null): string {
  if (!node || node.type !== 'string') return ''
  const fragment = node.namedChildren.find(child => child?.type === 'string_fragment')
  return fragment ? fragment.text : ''
}

/** 声明到函数体之前的原文；没有函数体（接口、类型）时取整段声明。 */
function signatureOf(node: Node, limit = SIGNATURE_LIMIT): string {
  const body = node.childForFieldName('body')
  const whole = !body || body.type === 'interface_body' || body.type === 'enum_body' || body.type === 'object_type'
  const text = whole ? node.text : node.text.slice(0, body.startIndex - node.startIndex)
  // 整段声明（接口、类型、枚举）保留换行；函数头压成一行。
  return whole && limit === TYPE_LIMIT ? squeezeLines(text, limit) : squeeze(text.replace(/=>\s*$/, '').replace(/=\s*$/, ''), limit)
}

/** 紧邻声明之前的注释首段（去掉注释符号），用于让模型知道符号的用途。 */
function docOf(node: Node): string | undefined {
  // 导出声明的注释挂在 export_statement 前面。
  const anchor = node.parent?.type === 'export_statement' ? node.parent : node
  const previous = anchor.previousNamedSibling
  if (!previous || previous.type !== 'comment' || anchor.startPosition.row - previous.endPosition.row > 1) return undefined
  const text = previous.text.replace(/^\/\*+|\*+\/$/g, '').split('\n').map(line => line.replace(/^\s*(\*|\/\/+)\s?/, '').trim()).filter(line => line && !line.startsWith('@')).join(' ')
  return text ? squeeze(text, DOC_LIMIT) : undefined
}

const isFunctionValue = (node: Node | null) => !!node && (node.type === 'arrow_function' || node.type === 'function_expression' || node.type === 'function' || node.type === 'generator_function')

/**
 * 抽取一段 TypeScript / JavaScript 脚本的符号、导入与使用关系。
 * @param root 语法树根节点。
 * @param lineOffset 脚本在文件中的起始行偏移（Vue 脚本块不从第 1 行开始）。
 */
export function extractScript(root: Node, lineOffset = 0): ScriptFacts {
  const symbols: SymbolFact[] = []
  const imports: ImportFact[] = []
  const reexports: ReexportFact[] = []
  const aliases: Record<string, string> = {}
  const macros: ScriptFacts['macros'] = []
  const emitted = new Set<string>()
  const mixins: string[] = []
  /** 待遍历的作用域：owner 为符号名，空串表示模块顶层；self 为「this.成员」对应的符号名前缀（类为「类名.」，选项式组件为空串），缺省表示不解析 this。 */
  const scopes: { owner: string; node: Node; self?: string }[] = []
  /** export { a, b } 里列出的本地名，遍历完再回填 exported。 */
  const exportedLocals = new Set<string>()
  let defaultLocal = ''
  const line = (node: Node) => node.startPosition.row + 1 + lineOffset
  const endLine = (node: Node) => node.endPosition.row + 1 + lineOffset

  const addSymbol = (node: Node, name: string, kind: SymbolFact['kind'], exported: boolean, isDefault: boolean, extra: Partial<SymbolFact> = {}) => {
    symbols.push({ name, kind, line: line(node), endLine: endLine(node), exported, ...(isDefault ? { isDefault: true } : {}), signature: signatureOf(node, kind === 'interface' || kind === 'type' || kind === 'enum' ? TYPE_LIMIT : SIGNATURE_LIMIT), ...(docOf(node) ? { doc: docOf(node) } : {}), ...extra })
  }

  /** 类：成员逐个成为符号与作用域，继承关系与其余部分归到类本身。 */
  const addClass = (node: Node, name: string, exported: boolean, isDefault: boolean) => {
    // 类的签名只取声明头，成员另列。
    const body = node.childForFieldName('body')
    symbols.push({ name, kind: 'class', line: line(node), endLine: endLine(node), exported, ...(isDefault ? { isDefault: true } : {}), signature: squeeze(body ? node.text.slice(0, body.startIndex - node.startIndex) : node.text, SIGNATURE_LIMIT), ...(docOf(node) ? { doc: docOf(node) } : {}) })
    for (const child of node.namedChildren) {
      if (!child || child === body || child.type === 'class_body') continue
      scopes.push({ owner: name, node: child, self: name + '.' })
    }
    for (const member of body?.namedChildren ?? []) {
      if (!member) continue
      const key = member.childForFieldName('name') ?? member.childForFieldName('property')
      const memberName = key && (key.type === 'property_identifier' || key.type === 'private_property_identifier') ? key.text : ''
      const value = member.childForFieldName('value')
      const callable = member.type === 'method_definition' || member.type === 'abstract_method_signature' || member.type === 'method_signature' || isFunctionValue(value)
      if (memberName && callable) {
        const qualified = name + '.' + memberName
        symbols.push({ name: qualified, kind: 'method', line: line(member), endLine: endLine(member), exported, parent: name, signature: signatureOf(isFunctionValue(value) ? value! : member).replace(/^/, isFunctionValue(value) ? memberName + ' = ' : ''), ...(docOf(member) ? { doc: docOf(member) } : {}) })
        scopes.push({ owner: qualified, node: member, self: name + '.' })
      } else scopes.push({ owner: name, node: member, self: name + '.' })
    }
  }

  /** 对象成员的键名与函数值：foo() {}、foo: function () {}、foo: () => {} 都算方法。 */
  const memberOf = (member: Node): { key: string; callable: boolean; value: Node | null } => {
    if (member.type === 'method_definition') return { key: member.childForFieldName('name')?.text ?? '', callable: true, value: member }
    if (member.type !== 'pair') return { key: '', callable: false, value: null }
    const keyNode = member.childForFieldName('key'), value = member.childForFieldName('value')
    const key = !keyNode ? '' : keyNode.type === 'string' ? literal(keyNode) : keyNode.type === 'property_identifier' ? keyNode.text : ''
    return { key, callable: isFunctionValue(value), value }
  }

  /**
   * 默认导出的对象字面量。选项式组件：methods 里的方法成为符号，props / emits 记为组件接口，其余选项归到组件本身；
   * 普通对象（接口封装、工具集合）：记一个 default 符号，函数成员成为它的成员，别处的 api.getUser() 才能连到具体函数。
   */
  const addObject = (node: Node) => {
    const members = node.namedChildren.filter((member): member is Node => !!member)
    if (members.some(member => optionKeys.has(memberOf(member).key))) {
      for (const member of members) {
        const { key, value } = memberOf(member)
        if (key === 'methods' && value?.type === 'object') {
          for (const method of value.namedChildren) {
            if (!method) continue
            const entry = memberOf(method)
            if (entry.key && entry.callable) {
              const target = method.type === 'pair' ? entry.value! : method
              symbols.push({ name: entry.key, kind: 'method', line: line(method), endLine: endLine(method), exported: false, viaThis: true, signature: squeeze((method.type === 'pair' ? entry.key + ': ' : '') + signatureOf(target), SIGNATURE_LIMIT), ...(docOf(method) ? { doc: docOf(method) } : {}) })
              scopes.push({ owner: entry.key, node: method, self: '' })
            } else scopes.push({ owner: '', node: method, self: '' })
          }
        } else if (key === 'mixins' && value?.type === 'array') {
          for (const item of value.namedChildren) if (item?.type === 'identifier') mixins.push(item.text)
          scopes.push({ owner: '', node: member, self: '' })
        } else if ((key === 'props' || key === 'emits') && value) {
          macros.push({ name: key === 'props' ? 'defineProps' : 'defineEmits', text: squeezeLines(value.text, TYPE_LIMIT) })
          scopes.push({ owner: '', node: member, self: '' })
        } else scopes.push({ owner: '', node: member, self: '' })
      }
      return
    }
    symbols.push({ name: 'default', kind: 'variable', line: line(node), endLine: endLine(node), exported: true, isDefault: true, signature: squeeze('export default { ' + members.map(member => memberOf(member).key).filter(Boolean).join(', ') + ' }', SIGNATURE_LIMIT) })
    for (const member of members) {
      const { key, callable, value } = memberOf(member)
      if (key && callable) {
        const target = member.type === 'pair' ? value! : member
        symbols.push({ name: 'default.' + key, kind: 'method', line: line(member), endLine: endLine(member), exported: true, parent: 'default', signature: squeeze((member.type === 'pair' ? key + ': ' : '') + signatureOf(target), SIGNATURE_LIMIT), ...(docOf(member) ? { doc: docOf(member) } : {}) })
        scopes.push({ owner: 'default.' + key, node: member, self: 'default.' })
      } else scopes.push({ owner: 'default', node: member, self: 'default.' })
    }
  }
  /** 取「对象字面量」或「defineComponent({...}) 这类包装调用里的对象」。 */
  const objectOf = (value: Node | null): Node | undefined => {
    if (value?.type === 'object') return value
    if (value?.type !== 'call_expression' || !componentFactories.has(value.childForFieldName('function')?.text ?? '')) return undefined
    const first = value.childForFieldName('arguments')?.namedChildren[0]
    return first?.type === 'object' ? first : undefined
  }

  /** 变量声明：函数值记为函数，其余记为变量；解构声明不产生符号，只归到模块顶层。 */
  const addVariables = (node: Node, exported: boolean) => {
    for (const declarator of node.namedChildren) {
      if (!declarator || declarator.type !== 'variable_declarator') continue
      const target = declarator.childForFieldName('name'), value = declarator.childForFieldName('value')
      // const x = require('y') / const { a } = require('y')
      const required = value?.type === 'call_expression' && value.childForFieldName('function')?.text === 'require' ? literal(value.childForFieldName('arguments')?.namedChildren[0] ?? null) : ''
      if (required) {
        const names = target?.type === 'identifier' ? [{ imported: '*', local: target.text }]
          : (target?.namedChildren ?? []).flatMap(item => !item ? [] : item.type === 'shorthand_property_identifier_pattern' ? [{ imported: item.text, local: item.text }]
            : item.type === 'pair_pattern' && item.childForFieldName('value')?.type === 'identifier' ? [{ imported: item.childForFieldName('key')?.text ?? '', local: item.childForFieldName('value')!.text }] : [])
        imports.push({ source: required, line: line(declarator), names })
        continue
      }
      if (!target || target.type !== 'identifier') { scopes.push({ owner: '', node: declarator }); continue }
      const callable = isFunctionValue(value)
      // 一条声明里有多个变量时，各自的签名只带声明关键字和自己那一段。
      const keyword = node.child(0)?.text ?? 'const'
      const head = keyword + ' ' + declarator.text.slice(0, value ? value.startIndex - declarator.startIndex : undefined)
      symbols.push({ name: target.text, kind: callable ? 'function' : 'variable', line: line(declarator), endLine: endLine(declarator), exported,
        signature: callable ? squeeze(head + signatureOf(value!), SIGNATURE_LIMIT) : squeeze(keyword + ' ' + declarator.text, 200), ...(docOf(node) ? { doc: docOf(node) } : {}) })
      scopes.push({ owner: target.text, node: declarator })
    }
  }

  const addDeclaration = (node: Node, exported: boolean, isDefault: boolean) => {
    const nameNode = node.childForFieldName('name')
    const name = nameNode?.text ?? (isDefault ? 'default' : '')
    switch (node.type) {
      case 'function_declaration': case 'generator_function_declaration': case 'function_signature':
        if (!name) return
        addSymbol(node, name, 'function', exported, isDefault)
        scopes.push({ owner: name, node })
        return
      // 匿名默认导出：export default function () {} / export default () => {}
      case 'function_expression': case 'arrow_function': case 'function':
        addSymbol(node, name || 'default', 'function', exported, isDefault)
        scopes.push({ owner: name || 'default', node })
        return
      case 'class_declaration': case 'abstract_class_declaration': case 'class':
        if (name) addClass(node, name, exported, isDefault)
        return
      case 'interface_declaration': case 'type_alias_declaration':
        if (!name) return
        addSymbol(node, name, node.type === 'interface_declaration' ? 'interface' : 'type', exported, isDefault)
        scopes.push({ owner: name, node })
        return
      case 'enum_declaration':
        if (name) addSymbol(node, name, 'enum', exported, isDefault)
        return
      case 'lexical_declaration': case 'variable_declaration':
        addVariables(node, exported)
        return
      // declare function / declare const 等环境声明：按其内部声明处理。
      case 'ambient_declaration':
        for (const child of node.namedChildren) if (child) addDeclaration(child, exported, false)
        return
      default: {
        // module.exports = { ... }：与 export default { ... } 同样处理。
        const assignment = node.type === 'expression_statement' ? node.namedChildren[0] : null
        const exportedObject = assignment?.type === 'assignment_expression' && assignment.childForFieldName('left')?.text === 'module.exports' ? objectOf(assignment.childForFieldName('right')) : undefined
        if (exportedObject && !symbols.some(symbol => symbol.name === 'default')) addObject(exportedObject)
        else scopes.push({ owner: '', node })
      }
    }
  }

  for (const statement of root.namedChildren) {
    if (!statement) continue
    if (statement.type === 'import_statement') {
      const source = literal(statement.childForFieldName('source'))
      if (!source) continue
      const typeOnly = statement.children.some(child => child?.type === 'type')
      const names: ImportFact['names'] = []
      const clause = statement.namedChildren.find(child => child?.type === 'import_clause')
      for (const part of clause?.namedChildren ?? []) {
        if (!part) continue
        if (part.type === 'identifier') names.push({ imported: 'default', local: part.text })
        else if (part.type === 'namespace_import') { const local = part.namedChildren.find(child => child?.type === 'identifier'); if (local) names.push({ imported: '*', local: local.text }) }
        else if (part.type === 'named_imports') for (const specifier of part.namedChildren) {
          if (!specifier || specifier.type !== 'import_specifier') continue
          const imported = specifier.childForFieldName('name')?.text
          if (imported) names.push({ imported, local: specifier.childForFieldName('alias')?.text ?? imported })
        }
      }
      imports.push({ source, line: line(statement), names, ...(typeOnly ? { typeOnly: true } : {}) })
      continue
    }
    if (statement.type === 'export_statement') {
      const source = literal(statement.childForFieldName('source'))
      const clause = statement.namedChildren.find(child => child?.type === 'export_clause')
      const isDefault = statement.children.some(child => child?.type === 'default')
      const declaration = statement.childForFieldName('declaration')
      if (source) {
        // export * from / export { a as b } from / export * as ns from
        const names = clause?.namedChildren.flatMap(specifier => { const imported = specifier?.childForFieldName('name')?.text; return imported ? [{ imported, exported: specifier!.childForFieldName('alias')?.text ?? imported }] : [] })
        reexports.push(names ? { source, names } : { source })
        continue
      }
      if (clause) {
        for (const specifier of clause.namedChildren) {
          const local = specifier?.childForFieldName('name')?.text
          if (!local) continue
          const exported = specifier!.childForFieldName('alias')?.text ?? local
          if (exported === 'default') defaultLocal = local
          else if (exported !== local) aliases[exported] = local
          exportedLocals.add(local)
        }
        continue
      }
      if (declaration) { addDeclaration(declaration, true, isDefault); continue }
      // export default 标识符 / 表达式
      const value = statement.childForFieldName('value')
      if (value?.type === 'identifier') { defaultLocal = value.text; scopes.push({ owner: '', node: value }) }
      else if (value && isFunctionValue(value)) addDeclaration(value, true, true)
      else if (value?.type === 'class') addDeclaration(value, true, true)
      else if (objectOf(value)) addObject(objectOf(value)!)
      else if (value) scopes.push({ owner: '', node: value })
      continue
    }
    addDeclaration(statement, false, false)
  }

  for (const symbol of symbols) {
    if (exportedLocals.has(symbol.name) || symbol.name === defaultLocal) symbol.exported = true
    if (symbol.name === defaultLocal) symbol.isDefault = true
    if (symbol.parent && (exportedLocals.has(symbol.parent) || symbol.parent === defaultLocal)) symbol.exported = true
  }

  // 只记录对「导入名或本文件顶层符号」的引用；调用另记，便于识别自动导入的函数。
  const interesting = new Set<string>([...imports.flatMap(item => item.names.map(name => name.local)), ...symbols.filter(symbol => !symbol.parent && !symbol.viaThis).map(symbol => symbol.name)])
  const thisOnly = new Set(symbols.filter(symbol => symbol.viaThis).map(symbol => symbol.name))
  const uses = new Map<string, UseFact>()
  const record =(from: string, name: string, kind: UseFact['kind'], row: number, member?: string) => {
    // 递归调用不记；但选项式组件的方法调用同名的裸函数时，对方是导入的函数，不是它自己。
    if (!name || (from && from === name && !member && !thisOnly.has(from))) return
    const key = from + '\0' + name + '\0' + (member ?? '')
    const existing = uses.get(key)
    if (!existing || useRank[kind] > useRank[existing.kind]) uses.set(key, { from, name, ...(member ? { member } : {}), kind, line: existing?.line ?? row + 1 + lineOffset })
  }

  for (const scope of scopes) {
    /** 已作为调用、继承或渲染目标记录过的标识符位置，遍历到时不再记为普通引用。 */
    const handled = new Set<number>()
    const owner = scope.owner, self = scope.self
    const cursor = scope.node.walk()
    const parents: string[] = []
    let descend = true
    for (;;) {
      if (descend) {
        const type = cursor.nodeType
        if (type === 'call_expression' || type === 'new_expression') {
          const node = cursor.currentNode
          const callee = node.childForFieldName(type === 'new_expression' ? 'constructor' : 'function')
          if (callee?.type === 'identifier') {
            handled.add(callee.startIndex)
            if (callee.text === 'require') { const source = literal(node.childForFieldName('arguments')?.namedChildren[0] ?? null); if (source) imports.push({ source, line: node.startPosition.row + 1 + lineOffset, names: [] }) }
            else {
              record(owner, callee.text, 'call', node.startPosition.row)
              if (vueMacros.has(callee.text)) {
                const typeArguments = node.childForFieldName('type_arguments'), args = node.childForFieldName('arguments')
                const inner = typeArguments?.namedChildren[0]
                // defineModel 的第一个字符串参数是模型名。
                const modelName = callee.text === 'defineModel' ? literal(args?.namedChildren[0] ?? null) : ''
                macros.push({ name: callee.text, text: squeezeLines((modelName ? modelName + ': ' : '') + (inner ? inner.text : args ? args.text.slice(1, -1) : ''), TYPE_LIMIT), ...(inner?.type === 'type_identifier' ? { typeName: inner.text } : {}) })
              }
            }
          } else if (callee?.type === 'import') {
            const source = literal(node.childForFieldName('arguments')?.namedChildren[0] ?? null)
            if (source) imports.push({ source, line: node.startPosition.row + 1 + lineOffset, names: [] })
          } else if (callee?.type === 'member_expression') {
            const object = callee.childForFieldName('object'), property = callee.childForFieldName('property')
            if (object?.type === 'this' && property && self !== undefined) {
              // this.$emit 记下事件名；其余 this.成员() 记为对本类或本组件成员的调用。
              if (property.text === '$emit') { const event = literal(node.childForFieldName('arguments')?.namedChildren[0] ?? null); if (event) emitted.add(event) }
              else record(owner, 'this', 'call', node.startPosition.row, self + property.text)
            }
            else if (object?.type === 'identifier' && property && interesting.has(object.text)) { handled.add(object.startIndex); record(owner, object.text, 'call', node.startPosition.row, property.text) }
          }
        } else if (type === 'jsx_opening_element' || type === 'jsx_self_closing_element') {
          const tag = cursor.currentNode.childForFieldName('name')
          if (tag?.type === 'identifier' && /^[A-Z]/.test(tag.text)) { handled.add(tag.startIndex); record(owner, tag.text, 'render', tag.startPosition.row) }
          else if (tag?.type === 'member_expression') { const object = tag.childForFieldName('object'); if (object?.type === 'identifier') { handled.add(object.startIndex); record(owner, object.text, 'render', tag.startPosition.row, tag.childForFieldName('property')?.text) } }
        } else if (type === 'extends_clause' || type === 'implements_clause' || type === 'extends_type_clause' || type === 'class_heritage') {
          // 继承与实现：取子句里的标识符；JS 的 class_heritage 直接包着表达式。
          const kind = type === 'implements_clause' ? 'implements' : 'extends'
          for (const child of cursor.currentNode.namedChildren) {
            const target = !child ? null : child.type === 'identifier' || child.type === 'type_identifier' ? child : child.type === 'generic_type' ? child.childForFieldName('name') : null
            if (target) { handled.add(target.startIndex); record(owner, target.text, kind, target.startPosition.row) }
          }
        } else if (type === 'identifier' || type === 'type_identifier' || type === 'shorthand_property_identifier') {
          const field = cursor.currentFieldName, parent = parents[parents.length - 1] ?? ''
          const declared = (field !== null && declarationFields.has(field)) || (field === 'name' && namedDeclarations.has(parent)) || parent === 'formal_parameters'
          if (!declared && !handled.has(cursor.startIndex)) {
            const name = cursor.nodeText
            if (interesting.has(name)) record(owner, name, 'ref', cursor.startPosition.row)
          }
        }
        if (cursor.gotoFirstChild()) { parents.push(type); continue }
      }
      if (cursor.gotoNextSibling()) { descend = true; continue }
      if (!cursor.gotoParent()) break
      parents.pop()
      descend = false
    }
    cursor.delete()
  }

  return { symbols, imports, reexports, aliases, uses: [...uses.values()], macros, emitted: [...emitted], mixins, hasError: root.hasError }
}
