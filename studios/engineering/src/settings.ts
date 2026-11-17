import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 工作室全局规则；旧设置没有 customRules 时按空文本读取。 */
export interface Settings { schemaVersion: 1; principles: boolean; customRules: string }

/** 校验持久化设置或页面设置，禁止把无效值当作成功保存。 */
export function parseSettings(value: unknown, previous: Settings = { schemaVersion: 1, principles: true, customRules: '' }): Settings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('编码准则设置格式无效')
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== undefined && record.schemaVersion !== 1) throw new Error('编码准则设置版本不受支持')
  if (record.principles !== undefined && typeof record.principles !== 'boolean') throw new Error('准则开关必须是布尔值')
  if (record.customRules !== undefined && (typeof record.customRules !== 'string' || record.customRules.length > 12000)) throw new Error('附加规则必须是最多 12000 字的文本')
  return { schemaVersion: 1, principles: typeof record.principles === 'boolean' ? record.principles : previous.principles, customRules: typeof record.customRules === 'string' ? record.customRules.trim() : previous.customRules }
}

/** 串行、原子保存规则；写入失败时保留此前生效的内存设置。 */
export class SettingsStore {
  private readonly path: string
  private current: Settings = { schemaVersion: 1, principles: true, customRules: '' }
  private pending: Promise<void> = Promise.resolve()
  constructor(path: string) { this.path = path }
  get value(): Settings { return { ...this.current } }
  async load(): Promise<void> {
    let raw: string
    try { raw = await readFile(this.path, 'utf8') }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return; throw error }
    this.current = parseSettings(JSON.parse(raw))
  }
  save(input: unknown): Promise<Settings> {
    const operation = this.pending.then(async () => {
      const next = parseSettings(input, this.current)
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = this.path + '.' + randomUUID() + '.tmp'
      try { await writeFile(temporary, JSON.stringify(next, null, 2) + '\n'); await rename(temporary, this.path) }
      catch (error) { await rm(temporary, { force: true }); throw error }
      this.current = next
      return this.value
    })
    this.pending = operation.then(() => {}, () => {})
    return operation
  }
}
