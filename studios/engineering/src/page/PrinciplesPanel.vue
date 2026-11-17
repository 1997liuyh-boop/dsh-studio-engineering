<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { call, type Snapshot } from './api.ts'
import { useRequest } from './use-request.ts'
const props = defineProps<{ snapshot: Snapshot }>()
const emit = defineEmits<{ saved: []; dirty: [value: boolean] }>()
const principles = ref(true), rules = ref(''), savedRules = ref(''), savedPrinciples = ref(true), message = ref('')
const { loading, error, run } = useRequest<Snapshot>()
const skillRequest = useRequest<{ name: string; description: string; content: string }>()
const { data: skill, error: skillError } = skillRequest
const dirty = computed(() => principles.value !== savedPrinciples.value || rules.value.trim() !== savedRules.value)
watch(dirty, value => emit('dirty', value))
const effective = computed(() => [savedPrinciples.value ? props.snapshot.principles : '', savedRules.value].filter(Boolean).join('\n\n'))
let copyTimer: ReturnType<typeof setTimeout> | undefined
function reset() { principles.value = props.snapshot.settings.principles; rules.value = props.snapshot.settings.customRules; savedRules.value = rules.value; savedPrinciples.value = principles.value }
watch(() => props.snapshot, () => { if (!dirty.value) reset() }, { immediate: true })
async function save() {
  if (loading.value) return
  const value = await run(() => call({ action: 'configure', settings: { principles: principles.value, customRules: rules.value } }))
  if (value) { savedRules.value = value.settings.customRules; savedPrinciples.value = value.settings.principles; rules.value = savedRules.value; message.value = '规则已保存，后续模型请求将使用新规则。'; emit('saved') }
}
async function showSkill(name: string) { await skillRequest.run(signal => call({ action: 'skill', name }, signal)) }
async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); message.value = '指令已复制，请在项目会话中发送。' }
  catch (error) { message.value = '复制失败，请手动选择并复制指令。' }
  clearTimeout(copyTimer); copyTimer = setTimeout(() => { message.value = '' }, 4000)
}
function beforeLeave(event: BeforeUnloadEvent) { if (dirty.value) event.preventDefault() }
window.addEventListener('beforeunload', beforeLeave)
onBeforeUnmount(() => { clearTimeout(copyTimer); window.removeEventListener('beforeunload', beforeLeave) })
</script>
<template>
  <section class="grid items-start gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(280px,0.8fr)]">
    <div class="min-w-0 space-y-5">
      <form class="card p-5 sm:p-7" @submit.prevent="save"><div class="flex items-start justify-between gap-3"><div><h3 class="text-base font-semibold">提供给模型的规则</h3><p class="mt-2 text-xs leading-6 text-muted">此设置对所有项目会话生效。项目约定仍由模型按工作室指引读取。</p></div><span v-if="dirty" class="shrink-0 text-xs text-amber">尚未保存</span></div>
        <label class="mt-5 flex cursor-pointer items-start gap-3"><input v-model="principles" type="checkbox" class="mt-1 size-4 accent-accent" :disabled="loading"><span><span class="font-medium">常驻通用编码准则</span><span class="mt-1 block text-xs leading-6 text-muted">先明确要求、保持简单、控制改动范围、以实际验证结果驱动。</span></span></label>
        <label for="custom-rules" class="mt-6 block font-medium">全局附加规则</label><p id="rules-help" class="mt-1 text-xs leading-6 text-muted">可以填写注释语言、命名和验证要求。留空即停用附加规则；最多 12000 字。</p><textarea id="custom-rules" v-model="rules" class="field min-h-56 resize-y font-mono text-xs leading-6" :disabled="loading" maxlength="12000" aria-describedby="rules-help" placeholder="例如：新增注释使用中文；Vue 模板不使用 TypeScript 断言；完成后运行项目检查。" />
        <div class="mt-4 flex items-center gap-3"><button class="primary" :disabled="loading || !dirty">{{ loading ? '保存中…' : '保存规则' }}</button><button type="button" class="ghost" :disabled="loading || !dirty" @click="reset">放弃修改</button><span class="ml-auto font-mono text-xs text-muted">{{ rules.length }} / 12000</span></div><p v-if="error" role="alert" class="notice mt-4">{{ error }}</p><p v-if="message" role="status" class="mt-4 text-xs text-jade">{{ message }}</p>
      </form>
      <section class="card p-5"><h3 class="font-semibold">当前已保存的生效内容</h3><pre class="mt-3 whitespace-pre-wrap break-words text-xs leading-7 text-muted">{{ effective || '通用准则和附加规则均未启用。' }}</pre><p class="mt-4 border-t border-line pt-3 text-xs leading-6 text-muted">规则属于模型指引，不能代替类型检查、测试与人工评审；关闭常驻通用准则后，研发任务仍会加载所需工程方法。</p></section>
    </div>
    <aside class="min-w-0 space-y-5">
      <section class="card p-5"><h3 class="font-semibold">在项目会话里继续</h3><ul class="mt-3 divide-y divide-line"><li v-for="task in snapshot.tasks" :key="task.id" class="py-3"><button class="link text-left text-xs font-medium" @click="copy('@研发工作室:' + task.label + ' ')">{{ task.label }} ↗</button><code class="mt-1 block break-all text-[11px] text-muted">@研发工作室:{{ task.label }}</code></li></ul></section>
      <section class="card p-5"><h3 class="font-semibold">内置工程技能 <span class="text-xs font-normal text-muted">{{ snapshot.skills.length }} 项</span></h3><ul class="mt-3 space-y-1"><li v-for="item in snapshot.skills" :key="item.name"><button class="row items-start" @click="showSkill(item.name)"><span class="min-w-0"><span class="block break-all font-mono text-[11px]">{{ item.name }}</span><span class="mt-1 block text-xs leading-5 text-muted">{{ item.description }}</span></span></button></li></ul><p v-if="skillError" role="alert" class="notice mt-3">{{ skillError }}</p></section>
      <article v-if="skill" class="card p-5"><div class="flex gap-2"><h3 class="min-w-0 flex-1 break-all font-mono text-xs">{{ skill.name }}</h3><button class="link text-xs" @click="copy('/' + skill.name)">复制</button></div><pre class="mt-4 max-h-[32rem] overflow-auto whitespace-pre-wrap text-xs leading-6 text-muted">{{ skill.content }}</pre></article>
    </aside>
  </section>
</template>
