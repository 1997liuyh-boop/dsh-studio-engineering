/** 构建研发工作室：Host 入口、侧栏卡片、Vue 页面，并把语法解析所需的 wasm 文件放到 lib/wasm。 */
import { build } from 'esbuild'
import { parse, compileScript } from '@vue/compiler-sfc'
import postcss from 'postcss'
import tailwind from '@tailwindcss/postcss'
import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url)), dir = join(root, 'studios/engineering')
const project = JSON.parse(await readFile(join(dir, 'studio.json'), 'utf8'))
const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
const inject = ['studioProjects', 'tools', 'systemPrompt']

// 快捷任务文案只在 src/prompt.ts 维护：构建时生成并写回 studio.json，输入框 @ 候选读到的就是页面上同一份文案。
const promptModule = await build({ entryPoints: [join(dir, 'src/prompt.ts')], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node22' })
const { studioTasks } = await import('data:text/javascript;base64,' + Buffer.from(promptModule.outputFiles[0].text).toString('base64'))
if (JSON.stringify(project.tasks) !== JSON.stringify(studioTasks())) { project.tasks = studioTasks(); await writeFile(join(dir, 'studio.json'), JSON.stringify(project, null, 2) + '\n') }

await rm(join(dir, 'lib'), { recursive: true, force: true })
await mkdir(join(dir, 'lib/wasm'), { recursive: true }); await mkdir(join(dir, 'static'), { recursive: true })
const css = async path => (await postcss([tailwind()]).process(await readFile(path, 'utf8'), { from: path })).css

// web-tree-sitter 的 ESM 入口在 Node 下需要 require 与 __dirname，由 banner 补上。
await build({ entryPoints: [join(dir, 'src/index.ts')], outfile: join(dir, 'lib/index.js'), bundle: true, platform: 'node', format: 'esm', target: 'node22', define: { STUDIO_PROJECT: JSON.stringify(project) },
  banner: { js: "import {createRequire as __createRequire} from 'node:module';import {fileURLToPath as __fileURLToPath} from 'node:url';import {dirname as __pathDirname} from 'node:path';const require=__createRequire(import.meta.url);const __filename=__fileURLToPath(import.meta.url);const __dirname=__pathDirname(__filename);" } })
for (const [from, name] of [['web-tree-sitter', 'web-tree-sitter.wasm'], ['tree-sitter-typescript', 'tree-sitter-typescript.wasm'], ['tree-sitter-typescript', 'tree-sitter-tsx.wasm'], ['tree-sitter-javascript', 'tree-sitter-javascript.wasm']]) {
  await cp(join(root, 'node_modules', from, name), join(dir, 'lib/wasm', name))
}

await build({ entryPoints: [join(dir, 'src/client.tsx')], outfile: join(dir, 'lib/client.js'), bundle: true, platform: 'browser', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'],
  define: { STUDIO_PROJECT: JSON.stringify({ id: project.id, name: project.name, icon: project.icon, description: project.description }), STUDIO_PROJECT_ORDER: String(project.order), STUDIO_CARD_CSS: JSON.stringify(await css(join(root, 'packages/sdk/card.css'))) },
  banner: { js: `window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;` }, footer: { js: 'return module.exports;}});' } })

await build({ entryPoints: [join(dir, 'src/page/main.ts')], outfile: join(dir, 'static/app.js'), bundle: true, platform: 'browser', format: 'esm', minify: true,
  define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'false', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
  plugins: [{ name: 'vue-sfc', setup(builder) { builder.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
    const { descriptor, errors } = parse(await readFile(path, 'utf8'), { filename: path })
    if (errors.length) throw new Error(String(errors))
    return { contents: compileScript(descriptor, { id: 'studio-engineering', inlineTemplate: true }).content, loader: 'ts', resolveDir: dirname(path) }
  }) } }] })
await writeFile(join(dir, 'static/app.css'), await css(join(dir, 'src/page/style.css')))
await writeFile(join(dir, 'static/index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + project.name + '</title><link rel="stylesheet" href="/studio-projects/engineering/app.css"></head><body><div id="app"></div><script type="module" src="/studio-projects/engineering/app.js"></script></body></html>\n')
await writeFile(join(dir, 'dsh.plugin.json'), JSON.stringify({ name: pkg.name, version: pkg.version, description: project.description, entry: { name: pkg.name, inject }, client: { platform: 'web' } }, null, 2) + '\n')
console.log('研发工作室：Host、侧栏卡片、Vue 页面与语法解析文件已构建')
