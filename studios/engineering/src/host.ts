import type { IncomingMessage, ServerResponse } from 'node:http'

/** 执行工具的会话；工作区目录取自会话头，不借用其他会话或设置里的目录。 */
export interface StudioAgent {
  session: { id: string; header: { cwd?: string } }
}

/** 工具执行上下文，由宿主提供。 */
export interface Execution {
  agent?: StudioAgent
  signal: AbortSignal
}

export interface StudioTool {
  name: string
  description: string
  parameters: object
  output: { schema: object; render(args: unknown, value: unknown): { type: 'text'; text: string }[] }
  execute(args: unknown, execution: Execution): Promise<string>
  presentCall(args: unknown): object
}

/** 宿主技能注册表里一条技能的目录项（字段与宿主的 SkillCandidate 一致）。 */
export interface SkillCandidate {
  name: string
  description: string
  path: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  provider: string
  source: 'bundled'
  rank: number
  resourceBase: { kind: 'directory'; path: string }
  locator: unknown
}

/** 宿主技能提供方：list 给出目录，get 按需加载正文。 */
export interface SkillProvider {
  name: string
  list(options: { signal?: AbortSignal }): Promise<readonly SkillCandidate[]>
  get(candidate: SkillCandidate, options: { signal?: AbortSignal }): Promise<(Omit<SkillCandidate, 'rank' | 'locator'> & { content: string }) | undefined>
}

export interface SkillRegistry {
  registerProvider(create: () => SkillProvider): () => void
}

export interface StudioTask { id: string; label: string; description?: string; text: string }

/** 独立插件只声明用到的宿主能力，不复制宿主服务的实现。 */
export interface Host {
  get(name: string): unknown
  plugin(plugin: object, config?: Record<string, unknown>): unknown
  effect(callback: () => (() => void | Promise<void>), label: string): void
  tools: { register(tool: StudioTool): () => void }
  systemPrompt: { section(section: { name: string; order: number; interpolate: false; text: string }): () => void }
  studioProjects: { register(page: { id: string; root: string; name: string; icon: string; description: string; tasks?: StudioTask[]; handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> }): () => void }
}
