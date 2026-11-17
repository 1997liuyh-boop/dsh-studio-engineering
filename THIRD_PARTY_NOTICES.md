# 第三方声明

本仓库的原创集成代码与技能文本采用 MIT 许可（见 [LICENSE](LICENSE)）。下面列出随安装包分发的第三方内容，以及设计时参考过但没有随包分发的项目。

## 随包分发

| 内容 | 位置 | 版本 | 许可 | 版权 |
|---|---|---|---|---|
| web-tree-sitter | `lib/index.js`（打包）、`lib/wasm/web-tree-sitter.wasm` | 0.27.2 | MIT | Copyright (c) 2018 Max Brunsfeld |
| tree-sitter-typescript | `lib/wasm/tree-sitter-typescript.wasm`、`lib/wasm/tree-sitter-tsx.wasm` | 0.23.2 | MIT | Copyright (c) 2017 Max Brunsfeld |
| tree-sitter-javascript | `lib/wasm/tree-sitter-javascript.wasm` | 0.25.0 | MIT | Copyright (c) 2014 Max Brunsfeld |
| Vue | `static/app.js`（打包） | 3.5.42 | MIT | Copyright (c) 2018-present, Yuxi (Evan) You |
| dsh-studio-library SDK | `packages/sdk`、`lib/client.js`（打包） | 0.1.26 | MIT | 见 [SDK-SNAPSHOT.json](SDK-SNAPSHOT.json) |

以上 MIT 许可内容的许可全文：

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 方法参考（未分发原文）

`skills/` 下的技能是为本工作室用中文重新撰写的，流程与 `eng_graph`、`eng_plan` 工具绑定，没有收录下列项目的原文。它们的思路来自：

| 项目 | 许可 | 借鉴之处 |
|---|---|---|
| [obra/superpowers](https://github.com/obra/superpowers) | MIT，Copyright (c) 2025 Jesse Vincent | 「澄清 → 写计划 → 按计划执行 → 评审」的流程骨架，测试驱动、系统化调试与完成前验证的纪律 |
| [mattpocock/skills](https://github.com/mattpocock/skills) | MIT，Copyright (c) 2026 Matt Pocock | 盘问式澄清、把需求落成规格与任务、深模块设计、领域术语表 |
| [multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills) | 仓库声明为 MIT（没有 LICENSE 文件） | 四条编码行为准则，原始观点来自 Andrej Karpathy 的公开发言 |

## 图谱设计参考（未使用其代码）

内置图谱引擎是独立实现，没有包含、链接或改写下列项目的代码：

| 项目 | 许可 | 借鉴之处 |
|---|---|---|
| [abhigyanpatwari/GitNexus](https://github.com/abhigyanpatwari/GitNexus) | PolyForm Noncommercial 1.0.0 | 按距离分级的影响面、每次查询返回新鲜度、把 Git 改动映射到符号 |
| [Egonex-AI/Understand-Anything](https://github.com/Egonex-AI/Understand-Anything) | MIT | 用 WASM 语法解析避免原生编译、按内容指纹增量更新 |
| [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify) | Apache-2.0 | 区分「确定」与「推断」的关系置信度 |
| [sdyckjq-lab/llm-wiki-skill](https://github.com/sdyckjq-lab/llm-wiki-skill) | MIT | 知识图谱画布的表达方式：带类型色签的节点、聚类晕染色块、用连线虚实表示置信度、小地图与图例 |
