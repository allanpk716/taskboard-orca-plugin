// host 冒烟:假 ctx + 假 webServer,验证 apply 状态机骨架。
// 跑法:HOME=$(mktemp -d) node packages/dsh/test/smoke.mjs
// (HOME 隔离:状态文件写在临时 HOME/.dsh/taskboard-plugin.json,不碰真实 ~/.dsh)
import { apply } from '../host/index.ts'

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

const assert = (cond, label) => {
  if (!cond) {
    console.error('FAIL:', label)
    console.error(logs)
    process.exit(1)
  }
  console.log('ok:', label)
}

const eventHandlers = []
fakeCtx.on = (event, handler) => {
  eventHandlers.push({ event, handler })
  return () => {}
}

apply(fakeCtx, { platformUrl: 'https://taskboard.example.com' })
assert(eventHandlers.some((e) => e.event === 'app-boot/config-reload'), 'apply 挂了 ctx.on 事件监听(fiber 保活资源)')
await new Promise((r) => setTimeout(r, 200)) // 让异步 listen 等微任务生效

assert(routes.length === 1 && routes[0].path === '/api/taskboard', 'webServer 路由已注册 /api/taskboard')

// GET state(boot 后不自动连接:state=disconnected、connectUrl 为空)
{
  const res = { statusCode: 0, body: null,
    writeHead(code) { this.statusCode = code },
    end(b) { this.body = b } }
  await routes[0].handler({ method: 'GET', url: '/api/taskboard/state' }, res)
  const state = JSON.parse(res.body)
  assert(res.statusCode === 200, 'GET state → 200')
  assert(state.state === 'disconnected', 'boot 后 state=disconnected(不自动发起连接)')
  assert(state.connectUrl === null, 'boot 后 connectUrl 为空')
  assert(state.recentEvents.some((e) => e.kind === 'boot'), 'boot 事件已记录')
}

// POST connect → 返回授权 URL,异步 listen 生效后 state=waiting
{
  const res = { statusCode: 0, body: null,
    writeHead(code) { this.statusCode = code },
    end(b) { this.body = b } }
  await routes[0].handler({ method: 'POST', url: '/api/taskboard/connect' }, res)
  const body = JSON.parse(res.body)
  assert(res.statusCode === 200, 'POST connect → 200')
  assert(typeof body.url === 'string' && body.url.includes('/client/connect?'), 'connect 返回授权 URL')
  await new Promise((r) => setTimeout(r, 200))
  const res2 = { statusCode: 0, body: null,
    writeHead(code) { this.statusCode = code },
    end(b) { this.body = b } }
  await routes[0].handler({ method: 'GET', url: '/api/taskboard/state' }, res2)
  const state2 = JSON.parse(res2.body)
  assert(state2.state === 'waiting', 'connect 后 state=waiting')
  assert(typeof state2.connectUrl === 'string' && state2.connectUrl.includes('/client/connect?'), 'connectUrl 已生成')
}

// 日志里打了确认 URL
assert(logs.some(([, m]) => m.includes('[taskboard-dsh] 连接账号：在浏览器打开 http')), '确认 URL 已打到 logger.warn')

// 404
{
  const res = { statusCode: 0,
    writeHead(code) { this.statusCode = code },
    end() {} }
  await routes[0].handler({ method: 'GET', url: '/api/taskboard/nope' }, res)
  assert(res.statusCode === 404, '未知路由 → 404')
}

console.log('\nhost 冒烟全过;日志:')
for (const [level, msg] of logs) console.log(` [${level}] ${msg}`)
process.exit(0) // PKCE 回调 server 会 hold 事件循环直到超时,冒烟完显式退
