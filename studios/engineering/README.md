# 研发工作室源码

这里是 `dsh-studio-engineering` 的源码目录：`src/` 为 Host 入口、图谱引擎、方案工具与页面，`skills/` 为内置技能。

在仓库根目录运行 `npm run build`，构建产物会同步到根目录供 Git 安装使用。使用说明见仓库根目录的 [README.zh.md](../../README.zh.md)。

## 源码职责

`index.ts` 组装宿主工具和生命周期，`page-service.ts` 分发页面操作，`protocol.ts` 定义操作与响应的类型映射；`settings.ts` 原子保存全局规则，`plan-service.ts` 为页面和模型工具提供同一套方案读取与核对实现。

页面由 `page/Workbench.vue` 组装，探索、改动、方案和准则各自管理数据；`use-request.ts` 与 `request-state.ts` 使过期请求和卸载后的结果失效，图谱布局的纯计算在 `graph-layout.ts`。

`npm run typecheck` 包含 Vue 模板和未使用声明检查，`npm run lint` 检查模板类型断言、方法命名和换行。新增注释使用中文，样式使用 Tailwind，Vue 模板中的事件转换放到 script。

页面固定使用黑色主题；玻璃卡片、胶囊导航与图谱浮层由 `page/style.css` 的 Tailwind 组件类统一维护。图谱节点使用不透明底色，减少透明叠层对标签阅读的影响。
