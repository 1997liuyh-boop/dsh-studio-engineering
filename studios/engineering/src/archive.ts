import type { HealthReport, Level } from './graph/health.ts'
import type { Project } from './project.ts'

/**
 * 项目档案：把体检报告写成任何人、任何模型都能直接读的文件。
 * Markdown 给人和不带工具的模型看；JSON 是同一份数据的结构化版本，给脚本与带工具的模型用。
 * 两个文件都写在项目的 docs/engineering/ 下，随代码一起提交，离开工作室也能用。
 */

export const ARCHIVE_DIR = 'docs/engineering'
export const ARCHIVE_MARKDOWN = ARCHIVE_DIR + '/project-map.md'
export const ARCHIVE_JSON = ARCHIVE_DIR + '/project-map.json'

/** 档案里用到的、体检报告之外的结构信息。 */
export interface ArchiveExtras {
  clusters: { id: string; label: string; files: number; cohesion: number; keywords: string[]; directories: { path: string; files: number }[]; members: string[]; dependsOn: { label?: string; cluster: string; weight: number }[] }[]
  /** 被使用最多的符号 */
  hubs: { id: string; usedBy: number; signature?: string }[]
  /** 入口文件 */
  entries: string[]
  routes: { path: string; file: string; title?: string; kind: string }[]
}

const mark: Record<Level, string> = { good: '正常', watch: '留意', risk: '优先处理' }
const day = (iso: string | undefined) => iso ? iso.slice(0, 10) : '—'
/** 表格单元格里的竖线与换行会破坏表格。 */
const cell = (value: string | number) => String(value).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')
const table = (head: string[], rows: (string | number)[][]) => rows.length ? ['| ' + head.join(' | ') + ' |', '| ' + head.map(() => '---').join(' | ') + ' |', ...rows.map(row => '| ' + row.map(cell).join(' | ') + ' |')].join('\n') : '（无）'

/**
 * 生成项目档案的 Markdown。
 * @param project 项目概况。
 * @param report 体检报告。
 * @param extras 聚类明细、关键符号、入口与路由。
 */
export function renderArchive(project: Project, report: HealthReport, extras: ArchiveExtras): string {
  const { scale, quality, dependencies, iteration, difficulty } = report
  const lines: string[] = [
    '# 项目档案：' + project.name,
    '',
    '> 由研发工作室根据代码知识图谱与 Git 提交记录自动生成。生成于 ' + day(new Date().toISOString()) + '，对应提交 `' + (report.commit ? report.commit.slice(0, 10) : '非 Git 目录') + '`。',
    '> 不要手改本文件：在研发工作室页面点「导出项目档案」，或让模型调用 `eng_graph`（action=export）重新生成。结构化数据见同目录的 `project-map.json`。',
    '',
    '## 怎么用这份档案',
    '',
    '- **第一次接手**：先看「一览」和「最值得先看的」，再按「功能聚类」找到要改的那块代码在哪里、依赖谁。',
    '- **评估一项改动**：在「改动难度」里找到它所在的聚类，看优化难度、迭代难度和原因；再看「质量」里它有没有循环导入、超长函数。',
    '- **给模型用**：把本文件作为上下文交给任意模型即可；能调用工具的模型读 `project-map.json`，字段与下面各节一一对应。',
    '- **边界**：结论来自静态分析（TypeScript / JavaScript / Vue）与提交记录。动态调用、字符串拼出来的路径、框架按约定加载的文件、其他语言的代码看不到；标「推断」的关系来自自动导入等约定，需要打开文件核对。难度是用来排先后的相对值，不是工时。',
    '',
    '## 一览',
    '',
    table(['项目', '数值'], [
      ['框架', project.frameworks.join('、') || '未识别'],
      ['规模', scale.files + ' 个源码文件、' + scale.symbols + ' 个符号、约 ' + scale.lines + ' 行'],
      ['语言', Object.entries(scale.languages).map(([name, count]) => name + ' ' + count).join('、')],
      ['结构', scale.clusters + ' 个功能聚类，另有 ' + scale.scatteredFiles + ' 个散落文件；' + scale.pages + ' 个页面、' + scale.apis + ' 个接口路由'],
      ['质量', quality.grade + ' 级（' + quality.score + ' 分）'],
      ['测试', scale.testFiles ? scale.testFiles + ' 个测试文件' : '没有测试'],
      ['迭代', iteration.pace],
    ]),
    '',
    '### 最值得先看的',
    '',
    ...(report.highlights.length ? report.highlights.map(item => '- **' + mark[item.level] + '** ' + item.text) : ['- 没有需要优先处理的问题。']),
    '',
    '## 功能聚类',
    '',
    '聚类按文件之间的调用、引用与渲染关系自动划分，不按目录。内聚度是内部关系占全部关系的比例，越接近 1 越独立。',
    '',
    table(['聚类', '文件', '内聚', '主要目录', '关键词', '依赖'], extras.clusters.map(cluster => [cluster.label, cluster.files, cluster.cohesion, cluster.directories.slice(0, 2).map(dir => dir.path).join('、'), cluster.keywords.join(' '), cluster.dependsOn.slice(0, 3).map(item => item.label ?? item.cluster).join('、') || '—'])),
    '',
    '### 对外提供最多的符号',
    '',
    table(['符号', '被使用', '签名'], extras.hubs.map(hub => ['`' + hub.id + '`', hub.usedBy, hub.signature ? '`' + hub.signature.slice(0, 120) + '`' : ''])),
    '',
    '## 质量',
    '',
    '质量分从 100 起，按下面各项扣分；分数只用于同一个项目前后对比。',
    '',
    table(['检查项', '结果', '级别', '扣分'], quality.findings.map(finding => [finding.title, finding.value, mark[finding.level], finding.penalty || '—'])),
    '',
  ]
  for (const finding of quality.findings.filter(item => item.level !== 'good' || item.items.length)) {
    lines.push('### ' + finding.title, '', finding.detail, '')
    for (const item of finding.items.slice(0, 12)) lines.push('- `' + item.label + '`' + (item.note ? '（' + item.note + '）' : ''))
    if (finding.items.length) lines.push('')
  }
  lines.push(
    '## 依赖',
    '',
    dependencies.note,
    '',
    '### 外部依赖',
    '',
    table(['包', '版本', '类型', '导入它的文件数'], dependencies.packages.slice(0, 40).map(item => [item.name, item.version || '—', item.kind === 'prod' ? '运行' : item.kind === 'dev' ? '开发' : '同伴', item.files])),
    '',
    '- 声明了但源码里没有导入：' + (dependencies.unused.length ? dependencies.unused.map(name => '`' + name + '`').join('、') : '无'),
    '- 导入了但没有声明：' + (dependencies.undeclared.length ? dependencies.undeclared.slice(0, 20).map(item => '`' + item.name + '`（' + item.files + ' 个文件）').join('、') : '无'),
    '',
    '### 内部依赖',
    '',
    '被最多聚类依赖的是地基，改它波及面最大：',
    '',
    table(['聚类', '被多少个聚类依赖', '外部引用数'], dependencies.foundations.map(item => [item.label, item.fanIn, item.inWeight])),
    '',
    '聚类之间最重的依赖：',
    '',
    table(['从', '到', '关系数'], dependencies.links.map(link => [link.from, link.to, link.weight])),
    '',
    '## 迭代情况',
    '',
    iteration.pace,
    '',
  )
  if (iteration.available && iteration.commits) {
    lines.push(
      '提交类型：' + Object.entries(iteration.types).sort((a, b) => b[1] - a[1]).map(([type, count]) => type + ' ' + count).join('、') + '。',
      '',
      '### 改动最频繁的文件',
      '',
      table(['文件', '提交数', '近 90 天', '行数', '被引用', '所在聚类'], iteration.hotspots.map(item => ['`' + item.file + '`', item.commits, item.recent, item.lines, item.usedBy, item.cluster ?? '—'])),
      '',
      '### 各聚类的活跃度',
      '',
      table(['聚类', '改动次数', '近 90 天', '最近改动'], iteration.clusters.slice(0, 20).map(item => [item.label, item.commits, item.recent, day(item.last)])),
      '',
      '### 最近的提交',
      '',
      ...iteration.recent.slice(0, 15).map(commit => '- ' + day(commit.date) + ' `' + commit.hash + '` ' + commit.subject + '（' + commit.files + ' 个文件）'),
      '',
    )
  }
  lines.push(
    '### 迭代方案',
    '',
    iteration.plans.length ? table(['方案', '标题', '创建', '功能点', '改动', '步骤', '已核对'], iteration.plans.map(plan => ['`docs/iterations/' + plan.slug + '`', plan.title, day(plan.createdAt), plan.features, plan.changes, plan.steps, plan.checked ? '是' : '否'])) : '`docs/iterations` 下还没有迭代方案。',
    '',
    '## 改动难度',
    '',
    difficulty.note,
    '',
    table(['聚类', '文件', '优化难度', '迭代难度', '主要原因'], [...difficulty.clusters].sort((a, b) => b.refactor.score - a.refactor.score).map(cluster => [cluster.label, cluster.files, cluster.refactor.level + '（' + cluster.refactor.score + '）', cluster.extend.level + '（' + cluster.extend.score + '）', [...new Set([...cluster.refactor.reasons.slice(0, 2), ...cluster.extend.reasons.slice(0, 1)])].join('；') || '结构简单、依赖少'])),
    '',
    '## 入口与路由',
    '',
    extras.routes.length ? table(['路径', '标题', '文件'], extras.routes.slice(0, 60).map(route => [(route.kind === 'api' ? '接口 ' : '') + route.path, route.title ?? '—', '`' + route.file + '`'])) + (extras.routes.length > 60 ? '\n\n共 ' + extras.routes.length + ' 条路由，这里列出前 60 条，完整列表见 `project-map.json`。' : '') : '没有识别出路由表。入口文件：' + (extras.entries.slice(0, 20).map(file => '`' + file + '`').join('、') || '无'),
    '',
  )
  return lines.join('\n')
}
