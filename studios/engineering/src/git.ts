import { execFile } from 'node:child_process'

/**
 * 在项目目录运行 git；目录不是仓库、没装 git 或命令失败时返回 undefined，由调用方走非 Git 的回退路径。
 * @param root 项目根目录。
 * @param args git 参数。
 */
export function git(root: string, args: string[], signal?: AbortSignal): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd: root, windowsHide: true, maxBuffer: 128 * 1024 * 1024, signal }, (error, stdout) => resolve(error ? undefined : stdout))
  })
}

/** 当前 HEAD 提交；非 Git 目录或尚无提交时为空串。 */
export async function headCommit(root: string, signal?: AbortSignal): Promise<string> {
  return (await git(root, ['rev-parse', 'HEAD'], signal))?.trim() ?? ''
}

/** 已跟踪与未跟踪但未被忽略的文件（相对路径，正斜杠）；非 Git 目录返回 undefined。 */
export async function listTracked(root: string, signal?: AbortSignal): Promise<string[] | undefined> {
  const output = await git(root, ['ls-files', '-co', '--exclude-standard', '-z'], signal)
  return output === undefined ? undefined : output.split('\0').filter(Boolean)
}

/** 一个文件的改动：ranges 为新版本里被改动的行区间；新增文件整份算改动。 */
export interface FileChange {
  file: string
  status: 'added' | 'modified' | 'deleted'
  ranges: [number, number][]
}

/**
 * 解析 git diff --unified=0 的输出，得到每个文件在新版本里的改动行区间。
 * @param output diff 原文。
 */
export function parseDiff(output: string): FileChange[] {
  const changes: FileChange[] = []
  let current: FileChange | undefined
  for (const line of output.split('\n')) {
    if (line.startsWith('diff --git ')) { current = undefined; continue }
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim()
      if (path === '/dev/null') { if (current) current.status = 'deleted'; continue }
      const file = path.replace(/^b\//, '')
      if (current) current.file = file
      else { current = { file, status: 'modified', ranges: [] }; changes.push(current) }
      continue
    }
    if (line.startsWith('--- ')) {
      const path = line.slice(4).trim()
      current = { file: path.replace(/^a\//, ''), status: path === '/dev/null' ? 'added' : 'modified', ranges: [] }
      changes.push(current)
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk && current) {
      const start = Number(hunk[1]), count = hunk[2] === undefined ? 1 : Number(hunk[2])
      // 纯删除的块在新版本里没有行，记到删除位置那一行，便于定位所在符号。
      current.ranges.push(count === 0 ? [Math.max(start, 1), Math.max(start, 1)] : [start, start + count - 1])
    }
  }
  return changes
}

/**
 * 工作区相对某个基准的改动（含已暂存与未暂存），外加未跟踪的新文件。
 * @param root 项目根目录。
 * @param base 基准提交或分支，缺省为 HEAD。
 * @returns 改动清单；非 Git 目录返回 undefined。
 */
export async function workingChanges(root: string, base = 'HEAD', signal?: AbortSignal): Promise<FileChange[] | undefined> {
  if (!/^[\w./~^@{}-]+$/.test(base) || base.startsWith('-')) throw new Error('基准提交格式无效')
  const diff = await git(root, ['diff', '--unified=0', '--no-color', '--no-ext-diff', base, '--'], signal)
  if (diff === undefined) return undefined
  const changes = parseDiff(diff)
  const untracked = await git(root, ['ls-files', '-o', '--exclude-standard', '-z'], signal)
  for (const file of untracked?.split('\0').filter(Boolean) ?? []) changes.push({ file, status: 'added', ranges: [[1, Number.MAX_SAFE_INTEGER]] })
  return changes
}
