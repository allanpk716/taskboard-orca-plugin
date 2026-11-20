// client 冒烟:假 __ModuleLoader__ + 假 react,验证 factory 返回插件形状、注册调用面成立。
// 跑法:node packages/dsh/test/client-smoke.mjs
import { readFileSync } from 'node:fs'

let loaded = null
globalThis.window = globalThis
globalThis.__ModuleLoader__ = {
  load(entry) {
    loaded = entry
  }
}

// 假 react:只实现 client.js 用到的面
const h = (type, props, ...children) => ({ type, props: props ?? {}, children })
globalThis.__fakeRequire = (name) => {
  if (name === 'react') {
    return {
      createElement: h,
      useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
      useEffect: () => {},
      useRef: () => ({ current: null })
    }
  }
  throw new Error('unexpected require: ' + name)
}

new Function(readFileSync(new URL('../client.js', import.meta.url), 'utf8'))()

const assert = (cond, label) => {
  if (!cond) {
    console.error('FAIL:', label)
    process.exit(1)
  }
  console.log('ok:', label)
}

assert(loaded !== null && loaded.id === 'taskboard-dsh', '__ModuleLoader__.load 已被调用')
assert(typeof loaded.factory === 'function', 'factory 是函数')

const plugin = loaded.factory((name) => globalThis.__fakeRequire(name))
assert(plugin.name === 'taskboard-dsh', '插件 name 正确')
assert(Array.isArray(plugin.inject) && plugin.inject.includes('slots'), 'inject 声明含 slots')

// 假 ctx 跑 apply:effect 立即执行;slots.inject 语义 = 对每个声明生命周期跑回调
const registrations = []
plugin.apply({
  effect(fn) {
    fn()
    return () => {}
  },
  slots: {
    inject(slotName, callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    register: (opts, comp) => {
      registrations.push({ opts, comp, slot: opts.name })
      return () => {}
    }
  }
})

const panelEntry = registrations.find((r) => r.opts && r.opts.name === 'sidebar.panellist')
const panelBody = registrations.find((r) => r.opts && r.opts.name === 'main')
assert(panelEntry !== undefined, 'sidebar.panellist 已注册')
assert(panelEntry.opts.id === 'taskboard' && panelEntry.opts.label === '工单板', '面板行 id/label 正确')
assert(typeof panelEntry.opts === 'object' && typeof panelEntry.comp === 'function', '面板行组件可调用')
assert(panelBody !== undefined && panelBody.opts.key === 'taskboard', 'main keyed 面板已注册')

// 组件渲染不炸(假 react)
const icon = panelEntry.comp({ size: 20 })
assert(icon && icon.type === 'span', '图标组件渲染出容器')
console.log('\nclient 冒烟全过')
process.exit(0) // ensurePolling 的 setInterval 挂着,显式退出
