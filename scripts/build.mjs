/** 构建源码后同步运行文件到根目录；Git 安装直接使用已提交的运行文件。 */
import { cp, rm, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
await import('./source-build.mjs')
for (const path of ['lib', 'static', 'skills', 'studio.json', 'dsh.plugin.json', 'cordis.patch.yml']) {
  const source = join(root, 'studios/engineering', path)
  if (!(await access(source).then(() => true, () => false))) continue
  // 先清空再拷贝：避免源码里已删除的技能或产物残留在根目录。
  await rm(join(root, path), { recursive: true, force: true })
  await cp(source, join(root, path), { recursive: true })
}
console.log('根目录安装文件已同步：engineering')
