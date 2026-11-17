<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ArchiveResult, Finding, HealthReport, Level } from './api.ts'
import StatTile from './StatTile.vue'

/** 项目体检的五个页面：总览、质量、依赖、迭代、难度。数据是同一份体检报告，这里只负责分页展示。 */
type Section = 'summary' | 'quality' | 'dependencies' | 'iteration' | 'difficulty'
interface Props {
  /** 体检报告 */
  report: HealthReport
  /** 当前显示哪一页 */
  section: Section
  /** 最近一次导出项目档案的结果；还没导出过为 null */
  archive?: ArchiveResult | null
  /** 是否有请求在途：导出按钮据此禁用 */
  busy?: boolean
}
const props = withDefaults(defineProps<Props>(), { archive: null, busy: false })
const emit = defineEmits<{
  /** 导出项目档案 */
  export: []
  /** 跳到另一页 */
  go: [section: Section]
}>()

const levelText: Record<Level, string> = { good: '正常', watch: '留意', risk: '优先处理' }
const sectionText: Record<string, string> = { quality: '质量', dependencies: '依赖', iteration: '迭代', difficulty: '难度' }
const kindText = { prod: '运行', dev: '开发', peer: '同伴' } as const
const day = (iso?: string) => iso ? iso.slice(0, 10) : '—'
const gradeLevel = computed<Level>(() => props.report.quality.grade === 'A' ? 'good' : props.report.quality.grade === 'B' ? 'watch' : 'risk')

/** 质量页：展开查看某一项的具体条目。 */
const openFinding = ref('')
const shownFindings = computed<Finding[]>(() => [...props.report.quality.findings].sort((a, b) => b.penalty - a.penalty))

const maxPackageFiles = computed(() => Math.max(1, ...props.report.dependencies.packages.map(item => item.files)))
const showAllPackages = ref(false)
const packages = computed(() => showAllPackages.value ? props.report.dependencies.packages : props.report.dependencies.packages.slice(0, 20))

const maxWeek = computed(() => Math.max(1, ...props.report.iteration.weeks.map(week => week.commits)))
const typeNames: Record<string, string> = { feat: '新功能', fix: '修复', refactor: '重构', perf: '性能', docs: '文档', test: '测试', chore: '杂项', style: '格式', build: '构建', ci: '流水线', release: '发版', revert: '回滚', other: '其他' }
const types = computed(() => { const total = Object.values(props.report.iteration.types).reduce((sum, count) => sum + count, 0) || 1; return Object.entries(props.report.iteration.types).sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count, share: Math.round(count / total * 100) })) })

/** 难度页：按哪一种难度排序，以及展开的聚类。 */
const sortBy = ref<'refactor' | 'extend'>('refactor')
const openCluster = ref('')
const ranked = computed(() => [...props.report.difficulty.clusters].sort((a, b) => b[sortBy.value].score - a[sortBy.value].score))
const levels = computed(() => { const count = { 高: 0, 中: 0, 低: 0 }; for (const cluster of props.report.difficulty.clusters) count[cluster.refactor.level] += 1; return count })
</script>

<template>
  <!-- 总览 -->
  <section v-if="section === 'summary'" class="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
    <div class="min-w-0">
      <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
        <div class="card flex items-center gap-3 px-3 py-2.5">
          <span class="title text-4xl font-bold" :class="gradeLevel === 'good' ? 'text-jade' : gradeLevel === 'watch' ? 'text-amber' : 'text-accent'">{{ report.quality.grade }}</span>
          <span><span class="block text-xs text-muted">质量</span><span class="block text-sm font-medium tabular-nums">{{ report.quality.score }} 分</span><button type="button" class="link text-xs" @click="emit('go', 'quality')">看扣分项</button></span>
        </div>
        <StatTile label="规模" :value="report.scale.files + ' 个文件'" :hint="'约 ' + report.scale.lines.toLocaleString() + ' 行 · ' + report.scale.symbols + ' 个符号'" />
        <StatTile label="结构" :value="report.scale.clusters + ' 个聚类'" :hint="report.scale.pages + ' 个页面' + (report.scale.apis ? ' · ' + report.scale.apis + ' 个接口' : '') + ' · ' + report.scale.scatteredFiles + ' 个散落文件'" />
        <StatTile label="迭代" :value="report.iteration.available ? report.iteration.commits + ' 次提交' : '无记录'" :hint="report.iteration.available ? '近 ' + report.iteration.months + ' 个月 · ' + report.iteration.authors + ' 位提交者' : '不是 Git 仓库'" />
      </div>

      <h3 class="title mt-4 text-sm font-semibold">最值得先看的</h3>
      <ul class="mt-2 space-y-1.5">
        <li v-for="(item, at) in report.highlights" :key="at" class="card flex items-start gap-2.5 px-3 py-2">
          <span class="risk mt-0.5" :data-level="item.level">{{ levelText[item.level] }}</span>
          <span class="min-w-0 flex-1 text-xs leading-5">{{ item.text }}</span>
          <button type="button" class="link shrink-0 text-xs" @click="emit('go', item.section)">{{ sectionText[item.section] }} →</button>
        </li>
        <li v-if="!report.highlights.length" class="card px-3 py-2 text-xs text-muted">没有需要优先处理的问题。</li>
      </ul>

      <h3 class="title mt-4 text-sm font-semibold">改动难度分布</h3>
      <p class="mt-1 text-xs text-muted">{{ report.scale.clusters }} 个功能聚类里，优化难度高的 {{ levels.高 }} 个、中的 {{ levels.中 }} 个、低的 {{ levels.低 }} 个。<button type="button" class="link" @click="emit('go', 'difficulty')">看每个聚类的原因 →</button></p>
    </div>

    <aside class="card min-w-0 p-3 text-xs leading-5">
      <h3 class="title text-sm font-semibold text-ink">交给别人或别的模型</h3>
      <p class="mt-1 text-muted">体检结果可以导出成两个文件，写在项目的 <code class="rounded bg-canvas px-1">docs/engineering/</code> 下，随代码一起提交。离开这个工作室也能用：人直接读，任意模型把它当上下文。</p>
      <button type="button" class="primary mt-2 w-full" :disabled="busy" @click="emit('export')">导出项目档案</button>
      <p v-if="archive" class="mt-2 rounded-md bg-canvas px-2.5 py-2 text-muted">已写入 <code>{{ archive.document }}</code> 与 <code>{{ archive.data }}</code>。</p>
      <h4 class="mt-3 font-medium text-ink">三种接入方式</h4>
      <ul class="mt-1 list-disc space-y-1 pl-4 text-muted">
        <li><span class="text-ink">会话里的模型</span>：说「给项目做个体检」，或直接调用 <code>eng_graph</code>（action=health）。</li>
        <li><span class="text-ink">任意模型或工具</span>：读导出的 <code>project-map.md</code>；能解析 JSON 的读 <code>project-map.json</code>，字段与本页一一对应。</li>
        <li><span class="text-ink">接手的同事</span>：从本页看起，再到「代码探索」里点开具体的聚类与文件。</li>
      </ul>
      <p class="mt-3 text-faint">数据来自静态分析与提交记录，对应提交 {{ report.commit ? report.commit.slice(0, 8) : '（非 Git 目录）' }}。动态调用、框架按约定加载的文件与其他语言的代码看不到。</p>
    </aside>
  </section>

  <!-- 质量 -->
  <section v-else-if="section === 'quality'">
    <p class="text-xs leading-5 text-muted">质量分从 100 起，按下面各项扣分，当前 <span class="font-medium text-ink">{{ report.quality.score }} 分（{{ report.quality.grade }} 级）</span>。分数用于同一个项目前后对比，不同项目之间不可比。点一行看具体是哪些文件与符号。</p>
    <table class="sheet mt-2">
      <thead><tr><th>检查项</th><th>结果</th><th>级别</th><th class="text-right">扣分</th></tr></thead>
      <tbody>
        <template v-for="finding in shownFindings" :key="finding.id">
          <tr data-click="true" @click="openFinding = openFinding === finding.id ? '' : finding.id">
            <td class="font-medium">{{ finding.title }}</td>
            <td class="tabular-nums">{{ finding.value }}</td>
            <td><span class="risk" :data-level="finding.level">{{ levelText[finding.level] }}</span></td>
            <td class="text-right tabular-nums text-muted">{{ finding.penalty ? '−' + finding.penalty : '—' }}</td>
          </tr>
          <tr v-if="openFinding === finding.id">
            <td colspan="4" class="bg-canvas/60">
              <p class="px-2 py-1 leading-5 text-muted">{{ finding.detail }}</p>
              <ul v-if="finding.items.length" class="px-2 pb-2">
                <li v-for="item in finding.items" :key="item.label" class="flex gap-3 py-0.5"><span class="min-w-0 flex-1 break-all font-mono">{{ item.label }}</span><span v-if="item.note" class="shrink-0 text-muted">{{ item.note }}</span></li>
              </ul>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </section>

  <!-- 依赖 -->
  <section v-else-if="section === 'dependencies'" class="grid grid-cols-1 gap-4 xl:grid-cols-2">
    <div class="min-w-0">
      <h3 class="title text-sm font-semibold">外部依赖 <span class="font-sans text-xs font-normal text-muted">{{ report.dependencies.packages.length }} 个</span></h3>
      <p class="mt-1 text-xs leading-5 text-muted">{{ report.dependencies.note }}</p>
      <div v-if="report.dependencies.unused.length" class="card mt-2 px-3 py-2 text-xs leading-5">
        <span class="risk" data-level="watch">留意</span> 声明了但源码里没有导入：
        <span v-for="name in report.dependencies.unused" :key="name" class="mr-1.5 inline-block font-mono">{{ name }}</span>
      </div>
      <div v-if="report.dependencies.undeclared.length" class="card mt-2 px-3 py-2 text-xs leading-5">
        <span class="risk" data-level="watch">留意</span> 导入了但没有声明：
        <span v-for="item in report.dependencies.undeclared.slice(0, 30)" :key="item.name" class="mr-1.5 inline-block font-mono">{{ item.name }}<span class="text-muted">（{{ item.files }}）</span></span>
      </div>
      <table class="sheet mt-2">
        <thead><tr><th>包</th><th>版本</th><th>类型</th><th class="w-2/5">导入它的文件数</th></tr></thead>
        <tbody>
          <tr v-for="item in packages" :key="item.name">
            <td class="font-mono">{{ item.name }}</td><td class="text-muted">{{ item.version || '—' }}</td><td class="text-muted">{{ kindText[item.kind] }}</td>
            <td><span class="flex items-center gap-2"><span class="meter flex-1"><span :style="{ width: item.files / maxPackageFiles * 100 + '%' }" /></span><span class="w-8 text-right tabular-nums" :class="item.files ? '' : 'text-muted'">{{ item.files }}</span></span></td>
          </tr>
        </tbody>
      </table>
      <button v-if="report.dependencies.packages.length > 20" type="button" class="ghost mt-2" @click="showAllPackages = !showAllPackages">{{ showAllPackages ? '只看前 20 个' : '查看全部 ' + report.dependencies.packages.length + ' 个' }}</button>
    </div>
    <div class="min-w-0">
      <h3 class="title text-sm font-semibold">内部依赖</h3>
      <p class="mt-1 text-xs leading-5 text-muted">被最多聚类依赖的是地基：改它的接口，依赖它的聚类都要跟着核对。</p>
      <table class="sheet mt-2">
        <thead><tr><th>聚类</th><th class="text-right">被多少个聚类依赖</th><th class="text-right">外部引用数</th></tr></thead>
        <tbody><tr v-for="item in report.dependencies.foundations" :key="item.id"><td>{{ item.label }}</td><td class="text-right tabular-nums">{{ item.fanIn }}</td><td class="text-right tabular-nums text-muted">{{ item.inWeight }}</td></tr></tbody>
      </table>
      <h4 class="mt-4 text-xs font-medium text-muted">聚类之间最重的依赖</h4>
      <table class="sheet mt-1">
        <thead><tr><th>从</th><th>到</th><th class="text-right">关系数</th></tr></thead>
        <tbody><tr v-for="(link, at) in report.dependencies.links" :key="at"><td>{{ link.from }}</td><td>{{ link.to }}</td><td class="text-right tabular-nums">{{ link.weight }}</td></tr></tbody>
      </table>
    </div>
  </section>

  <!-- 迭代 -->
  <section v-else-if="section === 'iteration'">
    <p class="text-xs leading-5">{{ report.iteration.pace }}</p>
    <template v-if="report.iteration.available && report.iteration.commits">
      <div class="mt-3 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div class="card min-w-0 p-3">
          <h3 class="text-xs font-medium text-muted">最近 26 周每周的提交数</h3>
          <div class="spark mt-2" role="img" :aria-label="'最近 26 周每周提交数，最多一周 ' + maxWeek + ' 次'">
            <span v-for="week in report.iteration.weeks" :key="week.week" :data-empty="!week.commits" :style="{ height: Math.max(3, week.commits / maxWeek * 100) + '%' }" :title="week.week + ' 那一周：' + week.commits + ' 次'" />
          </div>
          <div class="mt-1 flex justify-between text-xs tabular-nums text-faint"><span>{{ report.iteration.weeks[0]?.week }}</span><span>{{ report.iteration.weeks.at(-1)?.week }}</span></div>
        </div>
        <div class="card min-w-0 p-3">
          <h3 class="text-xs font-medium text-muted">提交类型</h3>
          <ul class="mt-2 space-y-1.5 text-xs">
            <li v-for="item in types.slice(0, 7)" :key="item.type" class="flex items-center gap-2"><span class="w-14 shrink-0">{{ typeNames[item.type] ?? item.type }}</span><span class="meter flex-1"><span :style="{ width: item.share + '%' }" /></span><span class="w-20 shrink-0 text-right tabular-nums text-muted">{{ item.count }} · {{ item.share }}%</span></li>
          </ul>
        </div>
      </div>
      <div class="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div class="min-w-0">
          <h3 class="title text-sm font-semibold">改动最频繁的文件</h3>
          <p class="mt-1 text-xs text-muted">改得多又大的文件，是出问题和冲突最集中的地方，也是拆分的首选。</p>
          <table class="sheet mt-2">
            <thead><tr><th>文件</th><th class="text-right">提交</th><th class="text-right">近 90 天</th><th class="text-right">行数</th><th class="text-right">被引用</th></tr></thead>
            <tbody><tr v-for="item in report.iteration.hotspots" :key="item.file"><td class="break-all font-mono" :title="item.cluster">{{ item.file }}</td><td class="text-right tabular-nums">{{ item.commits }}</td><td class="text-right tabular-nums text-muted">{{ item.recent }}</td><td class="text-right tabular-nums text-muted">{{ item.lines }}</td><td class="text-right tabular-nums text-muted">{{ item.usedBy }}</td></tr></tbody>
          </table>
        </div>
        <div class="min-w-0">
          <h3 class="title text-sm font-semibold">各聚类的活跃度</h3>
          <p class="mt-1 text-xs text-muted">改动次数是聚类里各文件被提交改动的次数之和。</p>
          <table class="sheet mt-2">
            <thead><tr><th>聚类</th><th class="text-right">改动</th><th class="text-right">近 90 天</th><th class="text-right">最近改动</th></tr></thead>
            <tbody><tr v-for="item in report.iteration.clusters.slice(0, 15)" :key="item.id"><td>{{ item.label }}</td><td class="text-right tabular-nums">{{ item.commits }}</td><td class="text-right tabular-nums text-muted">{{ item.recent }}</td><td class="text-right tabular-nums text-muted">{{ day(item.last) }}</td></tr></tbody>
          </table>
        </div>
      </div>
      <h3 class="title mt-4 text-sm font-semibold">最近的提交</h3>
      <ul class="mt-2 space-y-0.5 text-xs">
        <li v-for="commit in report.iteration.recent" :key="commit.hash" class="flex items-baseline gap-2"><span class="shrink-0 tabular-nums text-muted">{{ day(commit.date) }}</span><span class="shrink-0 font-mono text-faint">{{ commit.hash.slice(0, 7) }}</span><span class="min-w-0 flex-1 truncate" :title="commit.subject">{{ commit.subject }}</span><span class="shrink-0 tabular-nums text-muted">{{ commit.files }} 个文件</span></li>
      </ul>
    </template>
    <h3 class="title mt-4 text-sm font-semibold">迭代方案</h3>
    <table v-if="report.iteration.plans.length" class="sheet mt-2">
      <thead><tr><th>方案</th><th>标题</th><th>创建</th><th class="text-right">功能点</th><th class="text-right">改动</th><th class="text-right">步骤</th><th>已核对</th></tr></thead>
      <tbody><tr v-for="plan in report.iteration.plans" :key="plan.slug"><td class="font-mono">docs/iterations/{{ plan.slug }}</td><td>{{ plan.title }}</td><td class="tabular-nums text-muted">{{ day(plan.createdAt) }}</td><td class="text-right tabular-nums">{{ plan.features }}</td><td class="text-right tabular-nums">{{ plan.changes }}</td><td class="text-right tabular-nums">{{ plan.steps }}</td><td>{{ plan.checked ? '是' : '否' }}</td></tr></tbody>
    </table>
    <p v-else class="mt-1 text-xs text-muted">项目的 docs/iterations 下还没有迭代方案。在会话里发送「@研发工作室:分析需求文档」会生成一份。</p>
  </section>

  <!-- 难度 -->
  <section v-else>
    <p class="text-xs leading-5 text-muted">{{ report.difficulty.note }}</p>
    <div class="mt-2 flex items-center gap-1.5 text-xs">
      <span class="text-muted">排序</span>
      <button type="button" class="chip" :data-on="sortBy === 'refactor'" @click="sortBy = 'refactor'">优化难度</button>
      <button type="button" class="chip" :data-on="sortBy === 'extend'" @click="sortBy = 'extend'">迭代难度</button>
    </div>
    <table class="sheet mt-2">
      <thead><tr><th>聚类</th><th class="text-right">文件</th><th class="w-1/5">优化难度</th><th class="w-1/5">迭代难度</th><th class="hidden md:table-cell">主要原因</th></tr></thead>
      <tbody>
        <template v-for="cluster in ranked" :key="cluster.id">
          <tr data-click="true" @click="openCluster = openCluster === cluster.id ? '' : cluster.id">
            <td class="font-medium">{{ cluster.label }}</td>
            <td class="text-right tabular-nums">{{ cluster.files }}</td>
            <td><span class="flex items-center gap-2"><span class="risk" :data-level="cluster.refactor.level">{{ cluster.refactor.level }}</span><span class="meter flex-1" :data-level="cluster.refactor.level"><span :style="{ width: cluster.refactor.score + '%' }" /></span></span></td>
            <td><span class="flex items-center gap-2"><span class="risk" :data-level="cluster.extend.level">{{ cluster.extend.level }}</span><span class="meter flex-1" :data-level="cluster.extend.level"><span :style="{ width: cluster.extend.score + '%' }" /></span></span></td>
            <td class="hidden text-muted md:table-cell">{{ cluster[sortBy].reasons[0] ?? '结构简单、依赖少' }}</td>
          </tr>
          <tr v-if="openCluster === cluster.id">
            <td colspan="5" class="bg-canvas/60">
              <div class="grid grid-cols-1 gap-3 px-2 py-2 md:grid-cols-3">
                <div><div class="font-medium">优化难度 {{ cluster.refactor.score }}</div><ul class="mt-1 list-disc space-y-0.5 pl-4 text-muted"><li v-for="reason in cluster.refactor.reasons" :key="reason">{{ reason }}</li><li v-if="!cluster.refactor.reasons.length">被依赖少、没有循环，容易单独重构</li></ul></div>
                <div><div class="font-medium">迭代难度 {{ cluster.extend.score }}</div><ul class="mt-1 list-disc space-y-0.5 pl-4 text-muted"><li v-for="reason in cluster.extend.reasons" :key="reason">{{ reason }}</li><li v-if="!cluster.extend.reasons.length">依赖面小、边界清楚，容易加功能</li></ul></div>
                <div class="text-muted">
                  <div class="font-medium text-ink">数据</div>
                  <p class="mt-1 leading-5 tabular-nums">{{ cluster.lines.toLocaleString() }} 行 · {{ cluster.symbols }} 个符号 · 内聚 {{ cluster.cohesion }}<br>被 {{ cluster.fanIn }} 个聚类依赖 · 依赖 {{ cluster.fanOut }} 个聚类<br>循环导入 {{ cluster.cycleFiles }} 个文件 · 长函数 {{ cluster.bigSymbols }} 个 · 测试 {{ cluster.testFiles }} 个<br>近 90 天改动 {{ cluster.recentCommits }} 次<template v-if="cluster.lastChange"> · 最近 {{ day(cluster.lastChange) }}</template></p>
                </div>
              </div>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </section>
</template>
