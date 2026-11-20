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

apply(fakeCtx, { platformUrl: 'https://taskboard.example.com' })
await new Promise((r) => setTimeout(r, 200)) // 让自动 beginConnection 的异步 listen 生效

const assert = (cond, label) => {
  if (!cond) {
    console.error('FAIL:', label)
    console.error(logs)
    process.exit(1)
  }
  console.log('ok:', label)
}

assert(routes.length === 1 && routes[0].path === '/api/taskboard', 'webServer 路由已注册 /api/taskboard')

// GET state
{
  const res = { statusCode: 0, body: null,
    writeHead(code) { this.statusCode = code },
    end(b) { this.body = b } }
  await routes[0].handler({ method: 'GET', url: '/api/taskboard/state' }, res)
  const state = JSON.parse(res.body)
  assert(res.statusCode === 200, 'GET state → 200')
  assert(state.state === 'waiting' || state.state === 'disconnected', `state=${state.state}(自动发起了连接)`)
  assert(typeof state.connectUrl === 'string' && state.connectUrl.includes('/client/connect?'), 'connectUrl 已生成')
  assert(state.recentEvents.some((e) => e.kind === 'boot'), 'boot 事件已记录')
}

// POST connect(已在等待中,再点一次返回新 URL 或 null)
{
  const res = { statusCode: 0, body: null,
    writeHead(code) { this.statusCode = code },
    end(b) { this.body = b } }
  await routes[0].handler({ method: 'POST', url: '/api/taskboard/connect' }, res)
  assert(res.statusCode === 200, 'POST connect → 200')
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
