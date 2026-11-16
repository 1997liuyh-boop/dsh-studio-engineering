/** 路径层面的判断：测试文件、按目录约定的入口与模块归属。查询与全局视图共用。 */

/** 测试文件：tests / __tests__ / spec / e2e 目录，或 .test / .spec 后缀。 */
export const isTest = (file: string) => /(^|\/)(tests?|__tests__|specs?|e2e)\//.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)

/** 按目录约定判断的入口：页面、路由、服务端接口，以及 main / app 这类启动文件。路由表识别出的页面另行合并。 */
export const isEntryPath = (file: string) => !/(^|\/)components\//.test(file) && (/(^|\/)(pages|routes|views)\//.test(file) || /(^|\/)server\/(api|routes|middleware)\//.test(file) || isBootPath(file))

/** 启动文件：main、App、根目录或 src 下的 index、router。 */
export const isBootPath = (file: string) => /(^|\/)(app\.vue|App\.vue|main\.[jt]sx?|router\.[jt]s)$/.test(file) && !/\/(components|lib|utils)\//.test(file) || /^(src\/)?index\.[jt]sx?$/.test(file)

/** 目录模块：取路径前两级目录；根目录下的文件归到「(根目录)」。 */
export const moduleOf = (file: string) => { const parts = file.split('/'); return parts.length === 1 ? '(根目录)' : parts.slice(0, Math.min(2, parts.length - 1)).join('/') }
