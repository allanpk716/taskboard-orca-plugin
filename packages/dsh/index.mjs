// index.mjs — TS 源装载垫片（ferryman-dsh 同款缘由）：
// cordis loader 的入口解析不吃 ".ts" 的 main，且以目录 URL 导入会失败；
// Node 24 能直接导入 node_modules 之外的 TS（类型剥离）。
const mod = await import('./host/index.ts')

export const name = mod.name
export const apply = mod.apply
export const inject = mod.inject
