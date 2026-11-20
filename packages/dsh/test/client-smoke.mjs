// client 冒烟:假 __ModuleLoader__ + 假 react + stub fetch,验证:
// 插件形状、注册调用面、已连接面板渲染(三类筛选/按往来对象分组/通知卡)。
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

// stub host 轮询面:apply 的 ensurePolling 会立即 pollOnce 一次
const FAKE_STATE = {
  state: 'connected',
  platformUrl: 'https://taskboard.example.com',
  unread: 2,
  connectUrl: null,
  connectPhase: 'idle',
  connectMessage: '',
  latestNotificationId: 265,
  overview: {
    inbox: {
      by_reason: { new: 1, guest_replied: 1 },
      items: [
        { number: 'T-101', title: '访客回复的工单', url: 'https://taskboard.example.com/t/T-101', reason: '访客回复了', reason_code: 'guest_replied', trigger: { type: 'guest', name: '访客Z' }, counterpart: { type: 'guest', name: '访客Z' }, read_new: true, waited_since: '2026-11-20T09:00:00Z', last_reply_at: '2026-11-20T09:00:00Z', created_at: '2026-11-19T08:00:00Z' },
        { number: 'T-102', title: '新指派的工单', url: 'https://taskboard.example.com/t/T-102', reason: '新指派给你', reason_code: 'new', trigger: { type: 'member', name: '成员A' }, counterpart: { type: 'member', name: '成员A' }, read_new: false, waited_since: '2026-11-20T07:30:00Z', last_reply_at: null, created_at: '2026-11-20T07:30:00Z' }
      ]
    },
    collaborating: {
      total: 2, unread: 1,
      items: [
        { number: 'T-201', title: '协作工单一', url: 'https://taskboard.example.com/t/T-201', unread: true, waiting_on_text: '张三' },
        { number: 'T-202', title: '协作工单二', url: 'https://taskboard.example.com/t/T-202', unread: false, waiting_on_text: '张三' }
      ]
    },
    waiting: { total: 1, by_counterpart: { 'guest:访客Z': 1 } },
    unread_notifications: 2
  },
  notifications: [
    { id: 265, ticket: { number: 'T-101', title: '访客回复的工单', url: '/t/T-101' }, url: 'https://taskboard.example.com/n/265', kind: 'turn', reason: 'guest_replied', text: '', summary: '', created_at: '2026-11-20T09:00:00Z', read_at: null }
  ],
  refreshError: null,
  pendingNotifications: [],
  recentEvents: [{ at: '2026-11-20T12:00:00Z', kind: 'boot', detail: '冒烟' }]
}
globalThis.fetch = async (url) => {
  if (String(url).includes('/api/taskboard/state')) {
    return new Response(JSON.stringify(FAKE_STATE), { status: 200 })
  }
  return new Response(JSON.stringify({}), { status: 404 })
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
let probedSidebarRight = null
plugin.apply({
  effect(fn) {
    fn()
    return () => {}
  },
  get(name) {
    if (name === 'sidebarRight') {
      probedSidebarRight = { openTab: (kind, opts) => ({ kind, opts }) }
      return probedSidebarRight
    }
    return undefined
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

// 树遍历:收集全部文本节点;函数型组件就地调用展开(假 react 不自动渲染子组件)
function texts(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out)
    return out
  }
  if (node.props) {
    if (typeof node.type === 'function') {
      texts(node.type(node.props), out)
      return out
    }
    texts(node.children, out)
  }
  return out
}
const joined = (node) => texts(node).join('|')

// 等 ensurePolling 的首次 pollOnce 落地
await new Promise((r) => setTimeout(r, 100))

const panel = panelBody.comp()
const all = joined(panel)
assert(all.includes('工单板'), '面板标题渲染')
assert(all.includes('已连接'), '已连接徽章渲染')
assert(all.includes('2 等我处理') && all.includes('1 访客新回复') && all.includes('1 协作中'), '三类筛选计数正确(mine=2/guest=1/collab unread=1)')
assert(all.includes('访客 · 访客Z ×1') && all.includes('成员A ×1'), '等我处理按往来对象分组')
assert(all.includes('另等他 1'), 'waiting 计数附注渲染')
assert(all.includes('T-101 · 访客回复的工单') && all.includes('访客回复了 · 已等'), '收件箱行渲染(标题+原因+等待时长)')
assert(all.includes('T-102 · 新指派的工单'), '第二条收件箱行渲染')
assert(all.includes('1 条未读 · 最近 1 条'), '通知卡收起态摘要')
assert(all.includes('事件流') && all.includes('boot'), '事件流诊断区保留')
assert(!all.includes('断开连接'), '菜单收起时不渲染断开按钮')

console.log('\nclient 冒烟全过')
process.exit(0) // ensurePolling 的 setInterval 挂着,显式退出
