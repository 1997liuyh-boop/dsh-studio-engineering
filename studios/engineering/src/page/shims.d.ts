/** 让 TypeScript 认识 Vue 单文件组件的导入；构建时由 scripts/source-build.mjs 编译。 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}
