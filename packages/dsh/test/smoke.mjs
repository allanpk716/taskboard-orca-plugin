// host 冒烟:假 ctx + 假 webServer + stub fetch(假平台),验证 MVP 状态机:
// 探针全链路(disconnected boot / connect / 404)+ Overview 刷新 + 标已读 + 断开 + 401 过期。
// 跑法:HOME=$(mktemp -d) node packages/dsh/test/smoke.mjs
// (HOME 隔离:状态文件写在临时 HOME/.dsh/taskboard-plugin.json,不碰真实 ~/.dsh)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../host/index.ts'

const STATE_FILE = join(homedir(), '.dsh', 'taskboard-plugin.json')
mkdirSync(join(homedir(), '.dsh'), { recursive: true })

// ---- 假平台(stub fetch 按 URL 分发;mode 切换 401 场景) ----
let readCalled = false
let mode = 'ok'
const fetchCalls = []
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

const PLATFORM = {
  inbox: {
    member: 'smoke-member', count: 2,
    items: [
      { number: 'T-101', title: '访客回复的工单', role: 'assignee', reason: '访客回复了', reason_code: 'guest_replied', trigger: { type: 'guest', name: '访客Z' }, counterpart: { type: 'guest', name: '访客Z' }, read_new: true, last_reply_at: '2026-11-20T09:00:00Z', created_at: '2026-11-19T08:00:00Z' },
      { number: 'T-102', title: '新指派的工单', role: 'assignee', reason: '新指派给你', reason_code: 'new', trigger: { type: 'member', name: '成员A', action: 'assigned' }, counterpart: { type: 'member', name: '成员A' }, read_new: false, last_reply_at: null, created_at: '2026-11-20T07:30:00Z' }
    ]
  },
  waiting: {
    member: 'smoke-member', count: 1,
    items: [
      { number: 'T-101', title: '访客回复的工单', role: 'assignee', reason: 'x', reason_code: 'x', trigger: { type: 'guest', name: '访客Z' }, counterpart: { type: 'guest', name: '访客Z' }, read_new: false, last_reply_at: null, created_at: '2026-11-18T08:00:00Z' }
    ]
  },
  collaborating: {
    total: 2, count: 2,
    items: [
      { number: 'T-201', url: '/t/T-201', title: '协作工单一', unread: true, waiting_on: { text: '张三' } },
      { number: 'T-202', url: '/t/T-202', title: '协作工单二', unread: false, waiting_on: { text: '张三' } }
    ],
    next: null, cursor: 0, filters: {}
  },
  unread: { unread_count: 2, latest_id: 265, client_online: true },
  notifications: () => ({
    items: [
      { id: 265, ticket: { number: 'T-101', title: '访客回复的工单', url: '/t/T-101' }, url: '/n/265', kind: 'turn', reason: 'guest_replied', text: '', summary: '', created_at: '2026-11-20T09:00:00Z', read_at: readCalled ? '2026-11-20T10:00:00Z' : null }
    ],
    cursor: 265, unread_count: readCalled ? 1 : 2, next: null
  })
}

globalThis.fetch = async (url, init = {}) => {
  const target = String(url)
  const method = init.method ?? 'GET'
  const path = target.replace('https://taskboard.example.com', '')
  fetchCalls.push({ method, path })
  if (path === '/api/v1/notifications/stream') {
    return new Promise(() => {}) // SSE 永挂:冒烟进程退出时一起走
  }
  if (path === '/api/v1/client/token') {
    return json({ token: 'tbc_smoke_issued' })
  }
  if (path === '/api/v1/notifications/read') {
    readCalled = true
    return json({})
  }
  if (path === '/api/v1/me/clients/self') {
    return new Response(null, { status: 200 })
  }
  if (mode === 'unauthorized' && path === '/api/v1/inbox') {
    return json({ error: { code: 'unauthenticated', message: '凭证无效' } }, 401)
  }
  if (path === '/api/v1/inbox') return json(PLATFORM.inbox)
  if (path === '/api/v1/inbox/waiting-on-counterparts') return json(PLATFORM.waiting)
  if (path.startsWith('/api/v1/tickets')) return json(PLATFORM.collaborating)
  if (path === '/api/v1/notifications/unread') return json(PLATFORM.unread)
  if (path.startsWith('/api/v1/notifications')) return json(PLATFORM.notifications())
  return json({ error: { code: 'not_found' } }, 404)
}

// ---- 假宿主 ----
const routes = []
const logs = []
const fakeCtx = {
  logger: {
    info: (m) => logs.push(['info', m]),
    warn: (m) => logs.push(['warn', m]),
    error: (m) => logs.push(['error', m])
  },
  get: (name) => {
    if (name === 'webServer') {
      return {
        register(route) {
          routes.push(route)
          return () => {}
        }
      }
    }
    return undefined
  },
  effects: [],
  effect(fn) {
    this.effects.push(fn)
    return () => {}
  }
}
const eventHandlers = []
fakeCtx.on = (event, handler) => {
  eventHandlers.push({ event, handler })
  return () => {}
}

const assert = (cond, label) => {
  if (!cond) {
    console.error('FAIL:', label)
    console.error(logs)
    process.exit(1)
  }
  console.log('ok:', label)
}

const res = () => ({
  statusCode: 0, body: null,
  writeHead(code) { this.statusCode = code },
  end(b) { this.body = b }
})
const fakePost = (url, body) => ({
  method: 'POST', url,
  on(event, cb) {
    if (event === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)))
    if (event === 'end') cb()
    return this
  }
})
const getState = async () => {
  const r = res()
  await routes[routes.length - 1].handler({ method: 'GET', url: '/api/taskboard/state' }, r)
  return JSON.parse(r.body)
}
const post = async (route, body) => {
  const r = res()
  await routes[routes.length - 1].handler(fakePost(`/api/taskboard/${route}`, body), r)
  return JSON.parse(r.body)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 阶段 1:未配置 boot + connect 流程(探针原有断言) ----
const dispose1 = apply(fakeCtx, { platformUrl: 'https://taskboard.example.com' })
assert(eventHandlers.some((e) => e.event === 'app-boot/config-reload'), 'apply 挂了 ctx.on 事件监听(fiber 保活资源)')
await sleep(200)

assert(routes.length === 1 && routes[0].path === '/api/taskboard', 'webServer 路由已注册 /api/taskboard')

{
  const state = await getState()
  assert(state.state === 'disconnected', 'boot 后 state=disconnected(不自动发起连接)')
  assert(state.connectUrl === null, 'boot 后 connectUrl 为空')
  assert(state.overview === null && state.notifications.length === 0, 'boot 后无概览数据')
}
{
  const body = await post('connect')
  assert(typeof body.url === 'string' && body.url.includes('/client/connect?'), 'connect 返回授权 URL')
  await sleep(200)
  const state = await getState()
  assert(state.state === 'waiting', 'connect 后 state=waiting')
  assert(typeof state.connectUrl === 'string' && state.connectUrl.includes('/client/connect?'), 'connectUrl 已生成')
}
assert(logs.some(([, m]) => m.includes('[taskboard-dsh] 连接账号:在浏览器打开 http')), '确认 URL 已打到 logger.warn')
{
  const r = res()
  await routes[0].handler({ method: 'GET', url: '/api/taskboard/nope' }, r)
  assert(r.statusCode === 404, '未知路由 → 404')
}
dispose1()

// ---- 阶段 2:带凭证 boot → 自动刷新拉 Overview ----
writeFileSync(STATE_FILE, JSON.stringify({
  platformUrl: 'https://taskboard.example.com',
  clientToken: 'tbc_smoke_alive',
  lastEventId: 260
}), 'utf8')

const dispose2 = apply(fakeCtx, { platformUrl: 'https://taskboard.example.com' })
await sleep(300) // boot refreshQuietly 是异步的

{
  const state = await getState()
  assert(state.state === 'connected', '带凭证 boot → state=connected')
  assert(state.overview !== null, 'overview 已拉取')
  assert(state.overview.inbox.items.length === 2, 'inbox 两条工单')
  assert(state.overview.inbox.items[0].url === 'https://taskboard.example.com/t/T-101', '工单 URL 已绝对化')
  assert(state.overview.waiting.by_counterpart['guest:访客Z'] === 1, 'waiting 按 counterpart 分组')
  assert(state.overview.collaborating.total === 2 && state.overview.collaborating.unread === 1, '协作中 total=2 unread=1')
  assert(state.notifications.length === 1 && state.notifications[0].url === 'https://taskboard.example.com/n/265', '通知列表已拉取并绝对化')
  assert(state.unread === 2, '未读数来自 unread 接口')
  assert(state.refreshError === null, '无刷新错误')
}

// ---- 阶段 3:标已读 + 断开 ----
{
  const state = await post('read', { ids: [265] })
  assert(fetchCalls.some((c) => c.method === 'POST' && c.path === '/api/v1/notifications/read'), '标已读已调平台接口')
  assert(state.notifications[0].read_at !== null, '标已读后通知列表刷新为已读')
}
{
  const state = await post('disconnect', {})
  assert(fetchCalls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/me/clients/self'), '断开已调平台撤销接口')
  assert(state.state === 'disconnected', '断开后 state=disconnected')
  assert(state.overview === null && state.notifications.length === 0, '断开后概览已清空')
  const stored = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  assert(stored.clientToken === null, '断开后凭证已从状态文件清除')
}
dispose2()

// ---- 阶段 4:401 → expired(清凭证回连接触发态) ----
writeFileSync(STATE_FILE, JSON.stringify({
  platformUrl: 'https://taskboard.example.com',
  clientToken: 'tbc_smoke_stale',
  lastEventId: 260
}), 'utf8')
mode = 'unauthorized'

const dispose3 = apply(fakeCtx, { platformUrl: 'https://taskboard.example.com' })
await sleep(300)

{
  const state = await getState()
  assert(state.state === 'expired', 'inbox 401 → state=expired')
  assert(state.overview === null, '过期后概览已清空')
  const stored = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  assert(stored.clientToken === null, '过期后凭证已从状态文件清除')
}
dispose3()

console.log('\nhost 冒烟全过;日志:')
for (const [level, msg] of logs) console.log(` [${level}] ${msg}`)
process.exit(0) // SSE 永挂的 fetch 与回调 server 会 hold 事件循环,冒烟完显式退
