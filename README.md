# dsh-studio-engineering

[中文](README.zh.md)

**Repository:** `dsh-studio-engineering`

**Description:** Engineering studio for DSH. It builds a code knowledge graph for the project, ships engineering-method and coding-behaviour skills, and turns a requirements document into an iteration plan: features, steps, impact scope, and parameter and method design.

`dsh-studio-engineering` is an independently installed DSH studio. It works inside the current DSH project session, opens no second chat, and writes no graph files into the project; the only files it writes there are iteration plans under `docs/iterations/`.

## Features

- **Code knowledge graph.** A built-in parser with no Python, native build or external database. Covers TypeScript, JavaScript and Vue single-file components (including uni-app `.nvue`, in both Composition and Options API style): symbols, signatures, doc comments, component props / emits / models / slots, and import, call, reference, inheritance and render relations.
- **Always current.** Every tool call compares files and re-parses only the ones that changed. There is no manual rebuild and no stale index.
- **Impact analysis.** What a change to a symbol reaches, grouped into direct, indirect and regression levels, with a risk rating, the entry points involved, related tests, the page flows that pass through the change and the functional clusters it touches. Current Git changes can be mapped to symbols first.
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

Tools: `eng_workspace` (prepare a task), `eng_graph` (`overview`, `search`, `context`, `impact`, `changes`, `rebuild`; global views `clusters`, `flows`, `trace`, `routes`, `cycles`), `eng_plan` (`submit`, `check`). The studio page lists graphed projects, searches symbols, and shows impact and the bundled skills; its Global View tab has the architecture map, execution flows, routes, import cycles and path tracing.

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
