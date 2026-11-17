import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { parseSettings, SettingsStore } from '../studios/engineering/src/settings.ts'
import { RequestGate } from '../studios/engineering/src/page/request-state.ts'
import { parseCheck, planDetail } from '../studios/engineering/src/plan-service.ts'
import { layoutGraph } from '../studios/engineering/src/page/graph-layout.ts'

test('规则保存兼容旧开关，拒绝非法输入，持久化失败不改变生效值', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eng-settings-'))
  try {
    const path = join(root, 'settings.json')
    await writeFile(path, JSON.stringify({ schemaVersion: 1, principles: false }))
    const store = new SettingsStore(path)
    await store.load()
    assert.deepEqual(store.value, { schemaVersion: 1, principles: false, customRules: '' })
    await Promise.all([store.save({ customRules: ' 注释使用中文 ' }), store.save({ principles: true })])
    assert.deepEqual(store.value, { schemaVersion: 1, principles: true, customRules: '注释使用中文' })
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), store.value)
    await assert.rejects(store.save({ principles: 'false' }), /布尔值/)
    assert.throws(() => parseSettings({ customRules: 'x'.repeat(12001) }), /12000/)
    assert.throws(() => parseSettings({ schemaVersion: 999 }), /版本/)
    const blocked = new SettingsStore(join(root, 'not-a-folder', 'settings.json'))
    await writeFile(join(root, 'not-a-folder'), 'file')
    await assert.rejects(blocked.save({ customRules: '不能生效' }))
    assert.equal(blocked.value.customRules, '')
    await writeFile(path, '{bad json')
    await assert.rejects(store.load(), SyntaxError)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('切换请求与卸载会使旧结果失效，新的请求可以继续', () => {
  const gate = new RequestGate(), first = gate.begin(), second = gate.begin()
  assert.equal(first.signal.aborted, true)
  assert.equal(first.current(), false)
  assert.equal(second.current(), true)
  gate.cancel()
  assert.equal(second.current(), false)
  assert.equal(gate.begin().current(), true)
})

test('历史报告缺失、失败和损坏严格区分，方案路径不能越界', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eng-plan-detail-'))
  try {
    const directory = join(root, 'docs/iterations/sample-plan')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'iteration.json'), JSON.stringify({ schemaVersion: 1, createdAt: '2026-11-17', baseCommit: '', currentSignatures: {}, plan: { slug: 'sample-plan', title: '测试方案', features: [], changes: [], steps: [] } }))
    assert.equal((await planDetail(root, 'sample-plan')).report, null)
    const report = { ok: false, slug: 'sample-plan', checkedAt: '2026-11-17', commit: '', implemented: 0, total: 1, issues: ['目标未实现'], warnings: [] }
    await writeFile(join(directory, 'check-report.json'), JSON.stringify(report))
    assert.equal((await planDetail(root, 'sample-plan')).report?.ok, false)
    assert.throws(() => parseCheck({ ok: true }), /格式无效/)
    await writeFile(join(directory, 'check-report.json'), '{}')
    await assert.rejects(planDetail(root, 'sample-plan'), /格式无效/)
    await assert.rejects(planDetail(root, '../outside'), /slug/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('空图布局仍有可用视口且保持确定性', () => {
  const data = { scope: 'global' as const, focus: '', nodes: [], edges: [], clusters: [], total: { files: 0, nodes: 0, relations: 0, clusters: 0, hiddenClusters: 0 } }
  const first = layoutGraph(data)
  assert.deepEqual(first, layoutGraph(data))
  assert.ok(first.bounds.x2 > first.bounds.x1)
})

test('规范检查拒绝模板类型断言和下划线方法名', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eng-conventions-'))
  try {
    await writeFile(join(root, 'Invalid.vue'), '<script setup lang="ts">function invalid_name() { return 1 }</script><template><div>{{ value as string }}</div></template>\n')
    assert.throws(() => execFileSync(process.execPath, ['scripts/check-code.mjs', root], { encoding: 'utf8', stdio: 'pipe' }), error => error instanceof Error && 'stderr' in error && /模板中禁止/.test(String(error.stderr)) && /camelCase/.test(String(error.stderr)))
  } finally { await rm(root, { recursive: true, force: true }) }
})
