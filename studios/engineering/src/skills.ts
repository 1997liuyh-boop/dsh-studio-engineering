import { readFile, readdir } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { SkillCandidate, SkillProvider } from './host.ts'

/** 随工作室分发的一条技能。 */
export interface BundledSkill {
  name: string
  description: string
  /** 去掉 frontmatter 后的正文 */
  content: string
  /** SKILL.md 的绝对路径 */
  path: string
  directory: string
}

/** 与宿主内置技能同级的优先级：用户或项目里的同名技能优先于随包技能。 */
const BUNDLED_RANK = 600
export const PROVIDER_NAME = 'dsh-studio-engineering'

/**
 * 解析 SKILL.md：frontmatter 只取 name 与 description 两个单行字段。
 * @param raw 文件内容。
 * @param path 文件路径，只用于报错。
 */
export function parseSkill(raw: string, path: string): { name: string; description: string; content: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw)
  if (!match) throw new Error('技能文件缺少 frontmatter：' + path)
  const field = (key: string) => new RegExp('^' + key + ':[ \\t]*(.+)$', 'm').exec(match[1])?.[1].trim().replace(/^["'](.*)["']$/, '$1') ?? ''
  const name = field('name'), description = field('description')
  if (!/^[a-z][a-z0-9-]*$/.test(name) || !description) throw new Error('技能文件的 name 或 description 无效：' + path)
  return { name, description, content: (raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw).slice(match[0].length).trim() }
}

/**
 * 读取技能目录下的全部技能，按名称排序。
 * @param root 技能根目录，每个子目录一条技能。
 */
export async function loadSkills(root: string): Promise<BundledSkill[]> {
  const skills: BundledSkill[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const directory = join(root, entry.name), path = join(directory, 'SKILL.md')
    const parsed = parseSkill(await readFile(path, 'utf8'), path)
    if (parsed.name !== entry.name) throw new Error('技能目录名与 name 不一致：' + path)
    skills.push({ ...parsed, path, directory })
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 把随包技能包装成宿主的技能提供方：模型可按名称加载，用户可用 /名称 直接调用。
 * @param skills 已读取的技能。
 */
export function skillProvider(skills: BundledSkill[]): SkillProvider {
  const candidates: SkillCandidate[] = skills.map(skill => ({
    name: skill.name, description: skill.description, path: skill.path,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER_NAME, source: 'bundled', rank: BUNDLED_RANK,
    resourceBase: { kind: 'directory', path: skill.directory.split(sep).join('/') }, locator: skill.path,
  }))
  return {
    name: PROVIDER_NAME,
    list: () => Promise.resolve(candidates),
    async get(candidate) {
      // 每次加载都重新读文件，本地调试技能时改完即生效。
      const { rank: _rank, locator, ...summary } = candidate
      const parsed = parseSkill(await readFile(String(locator), 'utf8'), String(locator))
      return { ...summary, content: parsed.content }
    },
  }
}
