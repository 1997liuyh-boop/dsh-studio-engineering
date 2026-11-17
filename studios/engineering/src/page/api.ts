import type { Operations, OperationInput, Snapshot } from '../protocol.ts'
export type * from '../protocol.ts'

/** 根据操作名称推导返回类型，并把取消信号传到 HTTP 请求。 */
export function call(): Promise<Snapshot>
export function call<K extends keyof Operations>(body: OperationInput<K>, signal?: AbortSignal): Promise<Operations[K]['output']>
export async function call(body?: { action: string }, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch('/studio-projects/engineering/api', body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal } : { signal })
  let value: unknown
  try { value = await response.json() } catch (error) { if (signal?.aborted) throw error; throw new Error('工作室返回了无效响应，请刷新重试') }
  if (!response.ok) throw new Error(value && typeof value === 'object' && 'error' in value && typeof value.error === 'string' ? value.error : '请求失败，请重试')
  if (!value || typeof value !== 'object') throw new Error('工作室响应内容无效')
  if ('issue' in value && body?.action !== 'trace') throw new Error(String(value.issue))
  return value
}
