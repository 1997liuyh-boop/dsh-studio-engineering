import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** 测试用的小型 Nuxt 风格项目：覆盖别名、转导出、类继承、自动导入、Vue 组件与构建产物。 */
export const files: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'shop', dependencies: { nuxt: '4.0.0', vue: '3.5.0' }, scripts: { test: 'vitest run' } }),
  'nuxt.config.ts': 'export default defineNuxtConfig({})\n',
  'tsconfig.json': '{\n  // 路径别名\n  "compilerOptions": { "paths": { "#shared/*": ["./shared/*"], }, },\n}\n',
  'AGENTS.md': '# 约定\n注释使用中文。\n',
  'shared/money.ts': '/** 把分转成带两位小数的元。 */\nexport function formatPrice(cents: number, currency = "CNY"): string {\n  return currency + " " + (cents / 100).toFixed(2)\n}\nexport const TAX_RATE = 0.13\n',
  'shared/index.ts': 'export * from "./money"\nexport { Cart as ShoppingCart } from "./cart"\n',
  'shared/cart.ts': 'import { formatPrice, TAX_RATE } from "./money"\nexport interface CartItem { id: string; cents: number }\nexport class Base { protected items: CartItem[] = [] }\nexport class Cart extends Base {\n  add(item: CartItem): void { this.items.push(item); this.touch() }\n  total(): string { return formatPrice(this.items.reduce((sum, item) => sum + item.cents, 0) * (1 + TAX_RATE)) }\n  private touch(): void {}\n}\n',
  'app/composables/useCart.ts': 'import { ShoppingCart } from "#shared/index"\nimport type { CartItem } from "#shared/cart"\nexport function useCart() {\n  const cart = new ShoppingCart()\n  const add = (item: CartItem) => cart.add(item)\n  return { cart, add }\n}\n',
  'app/components/PriceTag.vue': '<script setup lang="ts">\nimport { formatPrice } from "~~/shared/money"\ninterface Props {\n  /** 金额，单位分 */\n  cents: number\n  currency?: string\n}\nconst props = defineProps<Props>()\nconst emit = defineEmits<{ select: [cents: number] }>()\nconst label = () => formatPrice(props.cents, props.currency)\n</script>\n<template>\n  <button @click="emit(\'select\', cents)">{{ label() }}</button>\n</template>\n',
  'app/components/cart/CartPanel.vue': '<script setup lang="ts">\nconst { cart, add } = useCart()\nconst model = defineModel<boolean>("open")\n</script>\n<template>\n  <section>\n    <price-tag :cents="100" @select="add({ id: \'a\', cents: 100 })" />\n    <span>{{ cart.total() }}</span>\n  </section>\n</template>\n',
  'app/pages/index.vue': '<script setup lang="ts">\nimport CartPanel from "~/components/cart/CartPanel.vue"\n</script>\n<template>\n  <CartPanel />\n</template>\n',
  'tests/money.test.ts': 'import { formatPrice } from "../shared/money"\nformatPrice(100)\n',
  // 构建产物：同包里有 src 时 lib 下的脚本不进图谱。
  'packages/ui/package.json': JSON.stringify({ name: '@shop/ui', main: 'lib/index.js' }),
  'packages/ui/src/index.ts': 'export function badge(text: string): string { return "[" + text + "]" }\n',
  'packages/ui/lib/index.js': 'export function badge(text) { return "[" + text + "]" }\n',
  'app/utils/label.ts': 'import { badge } from "@shop/ui"\nexport const label = (text: string) => badge(text)\n',
}

/**
 * 在临时目录生成测试项目并初始化 Git 仓库（含一次提交）。
 * @returns 项目根目录的真实路径。
 */
export async function createProject(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'eng-fixture-')))
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'add', '-A')
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init')
  return root
}
