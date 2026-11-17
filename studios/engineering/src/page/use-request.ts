import { onBeforeUnmount, ref, shallowRef } from 'vue'
import { RequestGate } from './request-state.ts'

/** 一个资源拥有独立的读取状态；新请求替换旧请求，卸载后不再提交结果。 */
export function useRequest<T>() {
  const data = shallowRef<T | null>(null), loading = ref(false), error = ref('')
  const gate = new RequestGate()
  async function run(task: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    const ticket = gate.begin()
    loading.value = true; error.value = ''
    try {
      const value = await task(ticket.signal)
      if (ticket.current()) { data.value = value; return value }
    } catch (cause) {
      if (ticket.current()) error.value = cause instanceof Error ? cause.message : '操作失败，请重试'
    } finally { if (ticket.current()) loading.value = false }
    return undefined
  }
  function reset(): void { gate.cancel(); data.value = null; error.value = ''; loading.value = false }
  onBeforeUnmount(() => gate.cancel())
  return { data, loading, error, run, reset }
}
