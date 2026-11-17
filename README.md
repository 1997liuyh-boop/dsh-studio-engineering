# dsh-studio-engineering

[中文](README.zh.md)

**Repository:** `dsh-studio-engineering`

**Description:** Engineering studio for DSH. It builds a code knowledge graph for the project, ships engineering-method and coding-behaviour skills, and turns a requirements document into an iteration plan: features, steps, impact scope, and parameter and method design.

`dsh-studio-engineering` is an independently installed DSH studio. It works inside the current DSH project session, opens no second chat, and writes no graph files into the project; it writes iteration plans under `docs/iterations/` and project archives under `docs/engineering/` when requested.

## Engineering workbench

The page has five areas: project overview, code exploration, change analysis, iteration plans, and coding principles. It uses a black background with iOS-inspired glass surfaces and supports narrow screens, a file-list alternative to the canvas, remembered project selection, and recoverable request errors.

Change analysis maps real worktree changes against HEAD to symbols and affected code. The plans page reads saved plans and can run the same structural check as `eng_plan`. Historical reports show their timestamp and commit; the presence of a report does not mean it passed. Structural checks do not execute functional acceptance criteria.

The principles page saves optional global rules to studio settings and updates the host system prompt. They apply to all project sessions, can be disabled by clearing the text, and never overwrite project conventions. Model instructions do not replace type checks, tests, or review.

## Features

- **Code knowledge graph.** A built-in parser with no Python, native build or external database. Covers TypeScript, JavaScript and Vue single-file components (including uni-app `.nvue`, in both Composition and Options API style): symbols, signatures, doc comments, component props / emits / models / slots, and import, call, reference, inheritance and render relations.
- **Always current.** Every tool call compares files and re-parses only the ones that changed. There is no manual rebuild and no stale index.
- **Impact analysis.** What a change to a symbol reaches, grouped into direct, indirect and regression levels, with a risk rating, the entry points involved, related tests, the page flows that pass through the change and the functional clusters it touches. Current Git changes can be mapped to symbols first.
- **Graph canvas.** The studio page draws the graph on a dark canvas: files are nodes with a colour tab for their kind, functional clusters are washed-in colour areas, solid lines are import-resolved relations and dashed lines are inferred ones. Zoom, pan, search highlight, legend and minimap; click a cluster name to open it, click a node for its symbols and impact.
- **Project health.** One report answering "what state is this project in and where to start", shared by the page, the tool and the exported archive: quality (import cycles, unused exports, unreferenced files, oversized files and functions, tests, graph confidence, each with evidence and a penalty that adds up to a score), dependencies (declared in `package.json` versus actually imported, and which clusters depend on which), iteration (commit pace over the last 12 months, commit types, most-changed files, activity per cluster, existing iteration plans) and change difficulty per cluster (refactoring difficulty and extension difficulty, with reasons). Difficulty is a relative ranking, not an estimate of hours.
- **Project archive.** Export the report to `docs/engineering/project-map.md` and `project-map.json` and commit them with the code, so a new teammate can read it and any model can take it as context without this studio.
- **Global views.**
  - Functional clusters: modules found from call and dependency relations between files (Louvain community detection) rather than from folders, with cohesion, representative members and inter-cluster dependencies, drawn as a clickable architecture map.
  - Execution flows: from pages, routes and boot files down through calls and renders to requests, stores and utilities.
  - Routes: uni-app `pages.json` (main package, sub-packages, tab bar) and Nuxt `pages` / `server` directories.
  - Path tracing: the shortest path by which A reaches B.
  - Import cycles: groups of files that import each other, with a concrete cycle path.
- **Iteration plans.** Reads the requirements, locates existing code through the graph, and accepts a structured plan. The tool checks that every modified or removed target exists and that features, changes and steps cover each other, then writes `docs/iterations/<slug>/iteration.md`; the impact chapter is computed from the graph.
- **Post-implementation check.** Whether each planned change landed, whether signatures match the design, whether unplanned files changed, and whether direct callers of a changed signature were updated.
- **Bundled skills.** Ten Chinese-language skills registered in the host skill catalog. The model loads them when relevant, and users can invoke them with `/skill-name`.

## Usage

In any project session:

| Input | Effect |
|---|---|
| `@研发工作室:建立知识图谱` | Parse the project and summarise the graph |
| `@研发工作室:分析需求文档 docs/requirements.md` | Produce an iteration plan |
| `@研发工作室:影响分析 formatPrice` | Show what a symbol or the current changes affect |
| `@研发工作室:按方案实现` | Implement a plan from `docs/iterations` step by step and check it |
| `@研发工作室:评审改动` | Review current changes against the requirements and the graph |

Tools: `eng_workspace` (prepare a task), `eng_graph` (`overview`, `search`, `context`, `impact`, `changes`, `rebuild`; global views `clusters`, `flows`, `trace`, `routes`, `cycles`; project health `health` and `export`), `eng_plan` (`submit`, `check`). The workbench separates the health report in Project overview from the canvas and structural views in Code exploration. Change analysis, Iteration plans, and Coding principles support the development workflow.

Three ways in: a model inside a DSH session calls `eng_graph`; any other model, script or tool reads the exported `docs/engineering/project-map.md` (or the JSON next to it); a teammate opens the studio page. The visual direction of the graph canvas follows [sdyckjq-lab/llm-wiki-skill](https://github.com/sdyckjq-lab/llm-wiki-skill); the implementation is written for this repository and includes none of its code.

## Install

The repository declares a DSH plugin bundle in `package.json` (`dsh.bundle.patch`). Quit Desktop completely, install the control bundle, then this studio:

```text
github:1997liuyh-boop/dsh-studio-library#v0.1.26
github:1997liuyh-boop/dsh-studio-engineering#v0.1.0
```

It requires compatible `dsh-worktable ^0.6.0` and `dsh-studio-projects ^0.5.0`, provided by the control bundle.

Local development needs Node.js 22.19 or later:

```sh
npm ci
npm run build
npm run typecheck
npm run lint
npm test
npm run check
```

`node scripts/dev-page.mjs` previews the studio page without starting DSH.

## Requirements and limits

- The graph covers TypeScript, JavaScript and Vue only. Code in other languages is not graphed; confirm its impact with a text search.
- Relations come from static syntax analysis without type inference. Calls made through object properties, strings or runtime registration are not visible, and pages, routes and handlers loaded by framework convention have no recorded users. Auto-imported functions and components (Nuxt and similar) are inferred from naming conventions and marked `inferred`.
- Build output (`lib` / `dist` directories in a package that also has `src`, scripts with a `.map` sibling), minified scripts, files over 512 KB and directory junctions are excluded. A project is limited to 20,000 source files.
- The first build runs inside the host process: a few seconds for a few thousand files, about 45 seconds for a repository of some 7,400 files. Later calls only do an incremental check.
- Graphs are stored under `DSH_HOME/studio/engineering/graphs/`, partitioned by project directory.

## Sources and license

The host is [1997liuyh-boop/deepseek-harness](https://github.com/1997liuyh-boop/deepseek-harness); the studio SDK comes from [1997liuyh-boop/dsh-studio-library](https://github.com/1997liuyh-boop/dsh-studio-library) (see [SDK-SNAPSHOT.json](SDK-SNAPSHOT.json)). Bundled third-party content and the projects consulted for methods and design are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Original integration code and skill text are MIT-licensed; see [LICENSE](LICENSE).
