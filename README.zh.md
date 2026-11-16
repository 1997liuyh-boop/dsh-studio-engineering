# dsh-studio-engineering

[English](README.md)

**仓库名称：** `dsh-studio-engineering`

**仓库描述：**研发工作室：为项目建立代码知识图谱，内置工程方法与编码行为技能，并根据需求文档产出迭代方案（功能点、迭代步骤、影响范围、参数与方法设计）。

`dsh-studio-engineering` 是独立安装的 DSH 工作室。它在当前 DSH 项目会话里工作，不创建第二个聊天，也不向项目写入图谱文件；写入项目的只有 `docs/iterations/` 下的迭代方案。

## 功能与特性

- **代码知识图谱**：内置解析引擎，不依赖 Python、原生编译或外部数据库。覆盖 TypeScript、JavaScript 与 Vue 单文件组件（含 uni-app 的 `.nvue`，组合式与选项式写法都支持），抽取符号、签名、注释、组件的 Props / 事件 / 双向绑定 / 插槽，以及导入、调用、引用、继承、渲染关系。
- **自动保持最新**：每次调用工具时比对文件，只重新解析有变化的文件；不需要手动重建，也不会出现「索引落后几百个提交」。
- **影响分析**：改动某个符号会波及哪里，按直接依赖、间接依赖、需回归三级列出，给出风险级别、涉及的入口、相关测试、会经过改动的页面流程与波及的功能聚类；也可以把当前 Git 改动映射到符号再算影响面。
- **全局视图**：
  - 功能聚类：按文件之间的调用与依赖关系自动划分模块（Louvain 社区算法），不按目录，给出内聚度、代表成员与聚类间依赖，页面上画成可点选的架构图。
  - 执行流程：从页面、路由与启动文件出发，沿调用与渲染关系逐层展开到底层的请求、存储与工具函数。
  - 路由表：uni-app 的 `pages.json`（主包、分包、底部导航）与 Nuxt 的 `pages`、`server` 目录。
  - 路径追踪：A 怎样调用到 B 的最短路径。
  - 循环依赖：文件之间互相导入的分组与具体循环路径。
- **需求迭代方案**：读需求文档，对照图谱定位现有代码，提交结构化方案。工具核对修改与删除的目标是否真实存在、功能点与步骤是否互相覆盖，通过后生成 `docs/iterations/<slug>/iteration.md`，其中「影响范围」一章由图谱计算。
- **实施后核对**：方案里的每处改动是否落地、签名是否与设计一致、有没有计划外的改动、签名变化的直接调用方有没有跟着改。
- **内置技能**：十条中文技能登记到宿主的技能目录，模型在相应场景自动加载，也可以用 `/技能名` 直接调用。

## 使用

在任意项目会话里输入：

| 写法 | 作用 |
|---|---|
| `@研发工作室:建立知识图谱` | 解析当前项目并说明图谱概况 |
| `@研发工作室:分析需求文档 docs/需求.md` | 产出迭代方案 |
| `@研发工作室:影响分析 formatPrice` | 查看改动某个符号或当前改动会波及哪里 |
| `@研发工作室:按方案实现` | 按 `docs/iterations` 下的方案逐步实现并核对 |
| `@研发工作室:评审改动` | 对照需求与图谱评审当前改动 |

也可以直接提问，例如「`useCart` 被哪些地方用到」，模型会调用 `eng_graph` 查询。工作室页面可以浏览已建图的项目、搜索符号、查看影响面和内置技能；「全局视图」页签有架构图、执行流程、路由、循环依赖与路径追踪。

### 工具

| 工具 | 说明 |
|---|---|
| `eng_workspace` | 准备任务：读取会话工作区与项目约定，同步图谱，返回该任务的内置流程 |
| `eng_graph` | 查询图谱：`overview`、`search`、`context`、`impact`、`changes`、`rebuild`；全局视图：`clusters`、`flows`、`trace`、`routes`、`cycles` |
| `eng_plan` | 迭代方案：`submit` 提交并生成文档，`check` 实施后核对 |

### 内置技能

| 技能 | 用途 |
|---|---|
| `eng-coding-principles` | 四条编码行为准则 |
| `eng-clarify-requirements` | 需求澄清，整理成可验收的功能点 |
| `eng-iteration-plan` | 写迭代方案与接口设计 |
| `eng-execute-plan` | 按方案逐步实现 |
| `eng-tdd` | 测试驱动开发 |
| `eng-debugging` | 系统化调试 |
| `eng-verify-before-done` | 完成前验证 |
| `eng-code-review` | 评审改动 |
| `eng-module-design` | 模块与接口设计 |
| `eng-domain-glossary` | 领域术语表 |

## 安装

本仓库在 `package.json` 的 `dsh.bundle.patch` 中声明 DSH 插件包。请完整退出 Desktop 后，先安装控制包，再安装本工作室：

```text
github:1997liuyh-boop/dsh-studio-library#v0.1.26
github:1997liuyh-boop/dsh-studio-engineering#v0.1.0
```

本插件要求兼容的 `dsh-worktable ^0.6.0` 和 `dsh-studio-projects ^0.5.0`，由控制包提供。

本地开发需要 Node.js 22.19 或更高版本：

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run check
```

`node scripts/dev-page.mjs` 可以在不启动 DSH 的情况下预览工作室页面。

## 要求与限制

- 图谱目前只覆盖 TypeScript、JavaScript 与 Vue。其他语言的代码不进图谱，相关的影响面需要用文本搜索确认。
- 路由目前识别 uni-app 的 `pages.json` 与 Nuxt 的文件路由；Vue Router 手写的路由表不在其中，这类项目按 `pages/`、`views/` 等目录约定判断入口。执行流程最多展开 5 层、60 步。
- 关系来自静态语法分析，没有类型推断：通过对象属性、字符串或运行时注册发生的调用在图里看不到；框架按约定加载的页面、路由与接口没有使用方。Nuxt 等自动导入的函数与组件按命名约定推断，标为 `inferred`。
- 构建产物（同包内另有 `src` 的 `lib` / `dist` 目录、带 `.map` 的脚本）、压缩脚本、超过 512 KB 的文件和目录联接不进图谱。单个项目最多 20000 个源码文件。
- 首次建图在宿主进程内完成：数千个文件约几秒，七千多个文件的大仓库约 45 秒。之后的调用只做增量核对。
- 图谱保存在 `DSH_HOME/studio/engineering/graphs/`，按项目目录分区。

## 来源与许可

宿主为 [1997liuyh-boop/deepseek-harness](https://github.com/1997liuyh-boop/deepseek-harness)，工作室 SDK 来自 [1997liuyh-boop/dsh-studio-library](https://github.com/1997liuyh-boop/dsh-studio-library)（见 [SDK-SNAPSHOT.json](SDK-SNAPSHOT.json)）。随包分发的第三方内容与方法、设计上的参考来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本仓库原创集成代码与技能文本采用 MIT 许可，详见 [LICENSE](LICENSE)。
