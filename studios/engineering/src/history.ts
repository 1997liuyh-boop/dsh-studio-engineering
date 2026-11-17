import { git } from './git.ts'

/**
 * 迭代历史：从 Git 提交记录里读出「最近改了什么、改得多频繁」。
 * 只读 git log，不改仓库；非 Git 目录或读取失败时 available 为 false，其余视图照常可用。
 */

/** 一个文件在统计窗口内的改动情况。 */
export interface FileChurn {
  /** 涉及它的提交数 */
  commits: number
  added: number
  removed: number
  /** 最近一次改动的日期（ISO） */
  last: string
  /** 最近 90 天内涉及它的提交数 */
  recent: number
}

/** 一次提交的摘要。 */
export interface CommitBrief {
  hash: string
  /** 提交日期（ISO） */
  date: string
  subject: string
  /** 约定式提交的类型（feat、fix……），识别不出为 other */
  type: string
  /** 改动的文件（相对路径，已按重命名取新路径） */
  files: string[]
}

export interface History {
  available: boolean
  /** 统计窗口的月数 */
  months: number
  /** 窗口内的提交数（不含合并提交） */
  commits: number
  /** 窗口内的提交者人数；只计数，不保留姓名 */
  authors: number
  /** 窗口内最早与最近一次提交的日期 */
  first?: string
  last?: string
  /** 最近 26 周每周的提交数，从早到晚；week 为该周周一的日期 */
  weeks: { week: string; commits: number }[]
  /** 按提交类型计数 */
  types: Record<string, number>
  /** 文件 → 改动情况 */
  files: Map<string, FileChurn>
  /** 最近的提交，从新到旧 */
  recent: CommitBrief[]
}

const RECENT_DAYS = 90
const RECENT_COMMITS = 40
const empty = (months: number): History => ({ available: false, months, commits: 0, authors: 0, weeks: [], types: {}, files: new Map(), recent: [] })

/** numstat 里的重命名写法（old => new、dir/{old => new}/file）取新路径。 */
export function renamedPath(path: string): string {
  const braces = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path)
  if (braces) return (braces[1] + braces[3] + braces[4]).replace(/\/\//g, '/')
  const arrow = path.indexOf(' => ')
  return arrow === -1 ? path : path.slice(arrow + 4)
}

/** 约定式提交的类型：feat、fix、refactor、perf、docs、test、chore、style、build、ci、release；其余为 other。 */
export function commitType(subject: string): string {
  const match = /^(feat|fix|refactor|perf|docs|test|chore|style|build|ci|release|revert)(?:\([^)]*\))?!?[:：]/i.exec(subject.trim())
  return match ? match[1].toLowerCase() : 'other'
}

/** 某个日期所在周的周一（UTC），用作按周分桶的键。 */
function weekOf(time: number): string {
  const date = new Date(time)
  const day = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - day)
  return date.toISOString().slice(0, 10)
}

/**
 * 解析 git log --numstat 的输出。记录以 \x01 开头，头部字段用 \x02 分隔：哈希、日期、作者邮箱、标题。
 * @param output git log 原文。
 * @param months 统计窗口月数，只用于回填结果。
 * @param now 当前时间（毫秒），测试时可固定。
 */
export function parseHistory(output: string, months: number, now = Date.now()): History {
  const history = empty(months)
  history.available = true
  const authors = new Set<string>()
  const weekly = new Map<string, number>()
  const recentSince = now - RECENT_DAYS * 86_400_000
  for (const record of output.split('\x01').slice(1)) {
    const lines = record.split('\n')
    const [hash, date, author, ...subjectParts] = lines[0].split('\x02')
    if (!hash || !date) continue
    const subject = subjectParts.join('\x02'), time = Date.parse(date)
    if (!Number.isFinite(time)) continue
    const files: string[] = []
    for (const line of lines.slice(1)) {
      const stat = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
      if (!stat) continue
      const file = renamedPath(stat[3])
      files.push(file)
      const churn = history.files.get(file) ?? { commits: 0, added: 0, removed: 0, last: date, recent: 0 }
      churn.commits += 1
      // 二进制文件的增删行数是「-」，不计入行数。
      churn.added += stat[1] === '-' ? 0 : Number(stat[1]); churn.removed += stat[2] === '-' ? 0 : Number(stat[2])
      if (date > churn.last) churn.last = date
      if (time >= recentSince) churn.recent += 1
      history.files.set(file, churn)
    }
    history.commits += 1
    authors.add(author)
    const type = commitType(subject)
    history.types[type] = (history.types[type] ?? 0) + 1
    weekly.set(weekOf(time), (weekly.get(weekOf(time)) ?? 0) + 1)
    if (!history.last || date > history.last) history.last = date
    if (!history.first || date < history.first) history.first = date
    if (history.recent.length < RECENT_COMMITS) history.recent.push({ hash: hash.slice(0, 10), date, subject: subject.slice(0, 160), type, files })
  }
  history.authors = authors.size
  // 最近 26 周逐周列出，没有提交的周记 0，页面上才能看出节奏的起伏。
  const monday = Date.parse(weekOf(now) + 'T00:00:00Z')
  for (let offset = 25; offset >= 0; offset -= 1) {
    const week = new Date(monday - offset * 7 * 86_400_000).toISOString().slice(0, 10)
    history.weeks.push({ week, commits: weekly.get(week) ?? 0 })
  }
  return history
}

/** 同一仓库、同一提交只读一次历史。 */
const cache = new Map<string, History>()

/**
 * 读取最近若干个月的提交历史。
 * @param root 项目根目录。
 * @param commit 当前 HEAD；用作缓存键，空串（非 Git 目录）直接返回不可用。
 * @param months 统计窗口，默认 12 个月。项目是仓库的子目录时只统计该目录，路径相对项目根（--relative）。
 */
export async function readHistory(root: string, commit: string, months = 12, signal?: AbortSignal): Promise<History> {
  if (!commit) return empty(months)
  const key = root + '\0' + commit + '\0' + months
  const cached = cache.get(key)
  if (cached) return cached
  const output = await git(root, ['log', '--since=' + months + '.months', '--no-merges', '--numstat', '--relative', '--date=iso-strict', '--format=%x01%H%x02%ad%x02%ae%x02%s'], signal)
  if (output === undefined) return empty(months)
  const history = parseHistory(output, months)
  if (cache.size > 20) cache.clear()
  cache.set(key, history)
  return history
}
