# 研发工作台迁移说明

旧页面的“知识图谱”迁移到“代码探索 → 文件与符号”，“全局视图”中的体检迁移到“项目总览”，架构和执行流程迁移到“代码探索 → 架构与流程”。快捷任务和内置技能移到“编码准则”。新增“改动分析”和“迭代方案”独立入口。

旧 `settings.json` 的 `schemaVersion: 1` 与 `principles` 含义保持不变，新增可选 `customRules`，旧文件按无附加规则读取。附加规则对所有项目会话生效，不会写入项目约定文件；设置文件损坏会明确报错，不再静默覆盖。项目图谱、已有迭代文档和历史核对记录无需删除。核对记录只说明结构，不验证功能。

页面内部入口由 `App.vue` 替换为 `Workbench.vue`，请求使用按 action 推导返回值的 `call`，不再接受任意 `call<T>`。开发依赖新增 `vue-tsc`，更新后运行 `npm ci`，再执行 `npm run typecheck`、`npm run lint`、`npm test`、`npm run build` 与 `npm run check`。Git 安装使用同步后的根目录产物。
