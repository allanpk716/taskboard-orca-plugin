// taskboard-dsh host 半边——探针实现。
// 协议事实钉点（0.2.2-rc.5 实测 + ferryman-dsh 先例）：
//   - 插件入口 = 包导出 name + apply(ctx, config)；export const inject 声明宿主服务。
//   - 用户可见通道 = ctx.logger.warn/error（无插件级 toast API）。
//   - webServer：ctx.get('webServer') 可选探测（desktop 宿主默认起在 OS 分配端口），
//     register({kind:'prefix', path, handler}) 挂路由；client 同源 fetch 带 cookie 鉴权
//     （ferryman-dsh client.js 实测可用面——typert 客户端面在装机宿主不可达，10-06 事故）。
//   - 凭证/状态存储：探针直接写 JSON 文件（~/.dsh/taskboard-plugin.json），
//     绕开 storageDomain/credentials 的 API 形状风险（单宿主场景文件等价；MVP 阶段再评估迁移）。
// 平台侧契约与 Orca 版共享（../../src/http.ts）：
//   - POST /api/v1/client/connect {port,state,code_challenge,hostname} → {redirect_url}
//   - 回调固定 http://127.0.0.1:<port>/cb?code=…&state=…
//   - POST /api/v1/client/token {code,code_verifier} → {token:tbc_…}
//   - GET  /api/v1/notifications/stream（SSE：hello/notification/read，Last-Event-ID 补发）
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { hostname } from 'node:os'
import { homedir } from 'node:os'
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type PlatformHealthResult,
  checkPlatformHealth,
  exchangeClientToken,
  isUnauthorizedTaskboardError
} from '../../../src/http.ts'

export const name = 'taskboard-dsh'
/**
 * 宿主服务依赖：webServer（client 轮询面的路由载体）。
 * 必须走 inject 声明而不是运行时 ctx.get 探测——启动期宿主会反复重组
 * Loader 树(compat preflight disable 行触发 recompose),重放的隔离 scope
 * 里 ctx.get 拿不到全局服务而 fiber 又被当轮 dispose(2026-11-20 train3060
 * 三轮加载全灭的实测根因);inject 让 loader 等到 provider 出现才启动插件。
 */
export const inject: string[] = ['webServer']

/** cordis Context 鸭子面（ferryman-dsh 同款：零宿主类型依赖） */
interface HostContext {
  logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void }
  config?: Record<string, unknown>
  get?(name: string): unknown
  effect?(setup: () => unknown): unknown
}

interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: { method?: string; url?: string }, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** 状态文件形状（探针存储） */
interface StoredState {
  platformUrl: string
  clientToken: string | null
  lastEventId: number
}

/** client 轮询拿到的活状态 */
export interface ProbeState {
  state: 'unconfigured' | 'disconnected' | 'waiting' | 'connected' | 'expired'
  platformUrl: string
  unread: number | null
  connectUrl: string | null
  connectPhase: 'idle' | 'waiting' | 'succeeded' | 'timeout' | 'failed'
  connectMessage: string
  latestNotificationId: number | null
  recentEvents: { at: string; kind: string; detail: string }[]
}

const STATE_FILE = join(homedir(), '.dsh', 'taskboard-plugin.json')
const LOG_FILE = join(homedir(), '.dsh', 'taskboard-plugin.log')

/** 探针文件日志(宿主 logger 用户不一定看得见;排查靠这个) */
function fileLog(kind: string, detail: string): void {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} [${kind}] ${detail}\n`, 'utf8')
  } catch {
    // 日志写不进就算了
  }
}
const CONNECT_TIMEOUT_MS = 5 * 60_000
const IDLE_TIMEOUT_MS = 90_000
const RECONNECT_DELAYS_MS = [2_000, 5_000, 15_000, 60_000]
const RECENT_EVENT_CAP = 8

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function loadStored(): StoredState {
  try {
    if (!existsSync(STATE_FILE)) throw new Error('absent')
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Partial<StoredState>
    return {
      platformUrl: typeof raw.platformUrl === 'string' ? raw.platformUrl : '',
      clientToken:
        typeof raw.clientToken === 'string' && raw.clientToken.startsWith('tbc_')
          ? raw.clientToken
          : null,
      lastEventId:
        typeof raw.lastEventId === 'number' && Number.isSafeInteger(raw.lastEventId)
          ? raw.lastEventId
          : 0
    }
  } catch {
    return { platformUrl: '', clientToken: null, lastEventId: 0 }
  }
}

function saveStored(next: StoredState): void {
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8')
}

function htmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function callbackPage(response: ServerResponse, status: number, title: string, body: string): void {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end(
    `<!doctype html><meta charset="utf-8"><title>${htmlEscape(title)}</title>` +
      `<body style="font-family:system-ui;padding:40px;text-align:center">` +
      `<h2>${htmlEscape(title)}</h2><p>${htmlEscape(body)}</p></body>`
  )
}

export function apply(ctx: HostContext, config: Record<string, unknown> = {}): void {
  const log = ctx.logger ?? console
  let closed = false
  let stored = loadStored()

  const configUrl = typeof config.platformUrl === 'string' ? config.platformUrl : ''
  if (stored.platformUrl === '' && configUrl !== '') {
    stored.platformUrl = configUrl
  }
  const platformUrl = stored.platformUrl

  // ---- 活状态（client 轮询面） ----
  const probe: ProbeState = {
    state: stored.clientToken !== null && platformUrl !== '' ? 'connected' : platformUrl !== '' ? 'disconnected' : 'unconfigured',
    platformUrl,
    unread: null,
    connectUrl: null,
    connectPhase: 'idle',
    connectMessage: '',
    latestNotificationId: null,
    recentEvents: []
  }

  function pushEvent(kind: string, detail: string): void {
    probe.recentEvents.unshift({ at: new Date().toISOString(), kind, detail })
    probe.recentEvents.length = Math.min(probe.recentEvents.length, RECENT_EVENT_CAP)
    fileLog(kind, detail)
  }

  // ---- SSE 通知流（Orca worker.ts runStream 移植，通知呈现改为 pushEvent） ----
  let streamGeneration = 0
  let streamController: AbortController | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let pendingConnectionAbort: AbortController | null = null
  let connectionCancelled = false

  function stopStream(): void {
    streamGeneration += 1
    streamController?.abort()
    streamController = null
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function expire(): void {
    stopStream()
    stored.clientToken = null
    saveStored(stored)
    probe.state = 'expired'
    probe.unread = null
    pushEvent('expired', '凭证已失效，请重新连接')
    log.warn('[taskboard-dsh] 凭证已失效（401），已回到未连接状态')
  }

  function delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(), ms)
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(new DOMException('Aborted', 'AbortError'))
        },
        { once: true }
      )
    })
  }

  async function runStream(generation: number): Promise<void> {
    const token = stored.clientToken
    if (token === null || probe.state !== 'connected') return

    let reconnectAttempt = 0
    const hadStoredLastId = stored.lastEventId > 0
    let lastEventId = stored.lastEventId

    while (probe.state === 'connected' && generation === streamGeneration && !closed) {
      const controller = new AbortController()
      streamController = controller
      try {
        const headers: Record<string, string> = {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${token}`
        }
        if (lastEventId > 0) headers['Last-Event-ID'] = String(lastEventId)

        const response = await fetch(`${platformUrl}/api/v1/notifications/stream`, {
          headers,
          signal: controller.signal
        })
        if (response.status === 401) {
          expire()
          return
        }
        if (!response.ok || response.body === null) {
          throw new Error(`通知流连接失败：HTTP ${response.status}`)
        }

        let seenHello = false
        let replayCount = 0
        let replaySample = ''
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let eventName = ''
        let dataLines: string[] = []
        let eventId: string | null = null

        async function dispatch(): Promise<void> {
          if (eventId !== null) {
            const parsedId = Number(eventId)
            if (Number.isSafeInteger(parsedId) && parsedId >= 0) {
              lastEventId = Math.max(lastEventId, parsedId)
            }
          }
          if (eventName === '' && dataLines.length === 0) return
          const data = dataLines.join('\n')

          if (eventName === 'hello') {
            const body = JSON.parse(data) as { unread_count?: unknown; latest_id?: unknown }
            const unreadCount = typeof body.unread_count === 'number' ? body.unread_count : null
            const latestId = typeof body.latest_id === 'number' ? body.latest_id : null
            if (latestId !== null && latestId > lastEventId) lastEventId = latestId
            stored.lastEventId = lastEventId
            saveStored(stored)
            probe.unread = unreadCount
            if (latestId !== null) probe.latestNotificationId = latestId
            pushEvent('hello', `unread=${unreadCount ?? '?'} latest=${latestId ?? '?'} replay=${replayCount}`)
            if (hadStoredLastId && replayCount === 1) {
              pushEvent('replay', `离线补发 1 条：${replaySample}`)
            } else if (hadStoredLastId && replayCount > 1) {
              pushEvent('replay', `离线补发 ${replayCount} 条（已合并）`)
            }
            replayCount = 0
            seenHello = true
            return
          }

          if (eventName === 'notification') {
            const body = JSON.parse(data) as { ticket?: { number?: unknown; title?: unknown }; reason?: unknown }
            const label =
              body.ticket && typeof body.ticket.number !== 'undefined'
                ? `${body.ticket.number} · ${String(body.ticket.title ?? '')}`
                : String(body.reason ?? '通知')
            if (!seenHello) {
              replayCount += 1
              replaySample = label
              return
            }
            probe.unread = (probe.unread ?? 0) + 1
            pushEvent('notification', label)
            return
          }

          if (eventName === 'read') {
            const body = JSON.parse(data) as { unread_count?: unknown }
            if (typeof body.unread_count === 'number') probe.unread = body.unread_count
            pushEvent('read', `unread=${probe.unread ?? '?'}`)
          }
        }

        async function processLine(line: string): Promise<void> {
          if (line === '') {
            await dispatch()
            eventName = ''
            dataLines = []
            eventId = null
            return
          }
          if (line.startsWith(':')) return
          const separator = line.indexOf(':')
          const field = separator === -1 ? line : line.slice(0, separator)
          let value = separator === -1 ? '' : line.slice(separator + 1)
          if (value.startsWith(' ')) value = value.slice(1)
          if (field === 'event') eventName = value
          if (field === 'data') dataLines.push(value)
          if (field === 'id') eventId = value
        }

        while (probe.state === 'connected' && generation === streamGeneration && !closed) {
          let idleTimer: ReturnType<typeof setTimeout> | null = null
          const becameIdle = new Promise<true>((resolve) => {
            idleTimer = setTimeout(() => resolve(true), IDLE_TIMEOUT_MS)
          })
          const read = await Promise.race([reader.read(), becameIdle])
          if (idleTimer !== null) clearTimeout(idleTimer)
          if (read === true) {
            controller.abort()
            await reader.cancel().catch(() => undefined)
            throw new Error('通知流超时没有数据')
          }
          if (read.done) break
          buffer += decoder.decode(read.value, { stream: true })
          const lines = buffer.split(/\r?\n/)
          buffer = lines.pop() ?? ''
          for (const line of lines) await processLine(line)
        }
        if (buffer !== '') await processLine(buffer)
        throw new Error('通知流连接断开')
      } catch (error) {
        if (closed || probe.state !== 'connected' || generation !== streamGeneration) return
        if (isUnauthorizedTaskboardError(error)) {
          expire()
          return
        }
        pushEvent('stream-error', errorMessage(error))
      } finally {
        streamController = null
      }

      if (probe.state !== 'connected' || generation !== streamGeneration || closed) return
      const nextDelay =
        RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ?? 60_000
      reconnectAttempt += 1
      try {
        await delay(Math.min(nextDelay, 60_000), controller.signal)
      } catch {
        return
      }
    }
  }

  function startStream(): void {
    if (probe.state !== 'connected' || streamController !== null || closed) return
    streamGeneration += 1
    void runStream(streamGeneration).catch((error: unknown) => {
      log.error(`[taskboard-dsh] 通知流异常退出：${errorMessage(error)}`)
    })
  }

  // ---- 连接账号（回环 PKCE，Orca worker.ts 移植；确认 URL 打印 + 状态面） ----
  interface CallbackServer {
    authorizationUrl: string
    waitForCode: Promise<string>
    close(): void
  }

  function listenForCallback(
    stateNonce: string,
    challenge: string,
    controller: AbortController
  ): Promise<CallbackServer> {
    return new Promise((resolveListening, rejectListening) => {
      let resolveCode!: (code: string) => void
      let rejectCode!: (error: unknown) => void
      let codeSettled = false
      const waitForCode = new Promise<string>((resolve, reject) => {
        resolveCode = resolve
        rejectCode = reject
      })
      // 宿主把未处理的 Promise rejection 判为 fatal load failure(2026-11-20
      // train3060 实测 crash):挂一个兜底 handler,后续消费者的 await 照常收到
      // rejection,但任何窗口期都不会以 unhandled 面目出现
      waitForCode.catch(() => {})

      const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== '/cb') {
          callbackPage(response, 404, '连接失败', '回调地址不正确。')
          return
        }
        if (url.searchParams.get('state') !== stateNonce) {
          callbackPage(response, 400, '连接失败', 'state 不匹配，已拒绝这次回调。')
          return
        }
        const code = url.searchParams.get('code') ?? ''
        if (code === '') {
          callbackPage(response, 400, '连接失败', '回调缺少 code。')
          return
        }
        if (codeSettled) {
          callbackPage(response, 400, '连接失败', '这个回调已经被使用。')
          return
        }
        codeSettled = true
        callbackPage(response, 200, '已连接', '已连接，可以关闭此页回到 DSH。')
        resolveCode(code)
      })

      const timeout = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS)
      const close = (): void => {
        clearTimeout(timeout)
        server.close()
      }
      server.on('error', (error) => {
        close()
        rejectListening(error)
        if (!codeSettled) {
          codeSettled = true
          rejectCode(error)
        }
      })
      controller.signal.addEventListener(
        'abort',
        () => {
          try {
            close()
            if (!codeSettled) {
              codeSettled = true
              rejectCode(new DOMException('Aborted', 'AbortError'))
            }
          } catch {
            // abort 回调里任何异常都不许冒泡(冒泡会被宿主记为加载失败)
          }
        },
        { once: true }
      )
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address === null || typeof address === 'string') {
          const error = new Error('无法获取本机回调端口')
          close()
          rejectListening(error)
          if (!codeSettled) {
            codeSettled = true
            rejectCode(error)
          }
          return
        }
        const query = new URLSearchParams({
          port: String(address.port),
          state: stateNonce,
          code_challenge: challenge,
          hostname: hostname()
        })
        resolveListening({
          authorizationUrl: `${platformUrl}/client/connect?${query.toString()}`,
          waitForCode,
          close
        })
      })
    })
  }

  async function beginConnection(): Promise<string | null> {
    if (platformUrl === '' || probe.state === 'connected') return null

    connectionCancelled = false
    pendingConnectionAbort?.abort()
    const controller = new AbortController()
    pendingConnectionAbort = controller
    const stateNonce = base64Url(randomBytes(16))
    const verifier = base64Url(randomBytes(32))
    const challenge = base64Url(createHash('sha256').update(verifier).digest())

    let callbackServer: CallbackServer
    try {
      callbackServer = await listenForCallback(stateNonce, challenge, controller)
    } catch (error) {
      pendingConnectionAbort = null
      probe.connectPhase = 'failed'
      probe.connectMessage = `无法启动本机回调服务：${errorMessage(error)}`
      pushEvent('connect-failed', probe.connectMessage)
      log.error(`[taskboard-dsh] ${probe.connectMessage}`)
      return null
    }

    probe.state = 'waiting'
    probe.connectPhase = 'waiting'
    probe.connectMessage = '等待浏览器确认…'
    probe.connectUrl = callbackServer.authorizationUrl
    log.warn(`[taskboard-dsh] 连接账号：在浏览器打开 ${callbackServer.authorizationUrl}`)
    void (async () => {
      try {
        const code = await callbackServer.waitForCode
        const issued = await exchangeClientToken(platformUrl, code, verifier)
        stored.clientToken = issued.token
        stored.lastEventId = 0
        saveStored(stored)
        probe.state = 'connected'
        probe.connectPhase = 'succeeded'
        probe.connectMessage = '已连接'
        probe.connectUrl = null
        pushEvent('connected', '凭证已保存，启动通知流')
        startStream()
      } catch (error) {
        if (isUnauthorizedTaskboardError(error)) {
          expire()
          return
        }
        const aborted = error instanceof DOMException && error.name === 'AbortError'
        if (aborted && connectionCancelled) return
        probe.state = platformUrl !== '' ? 'disconnected' : 'unconfigured'
        probe.connectPhase = aborted ? 'timeout' : 'failed'
        probe.connectMessage = aborted ? '等待浏览器确认超时，请重新连接' : `连接失败：${errorMessage(error)}`
        probe.connectUrl = null
        pushEvent('connect-failed', probe.connectMessage)
        log.error(`[taskboard-dsh] ${probe.connectMessage}`)
      } finally {
        callbackServer.close()
        if (pendingConnectionAbort === controller) pendingConnectionAbort = null
      }
    })().catch((error: unknown) => {
      // 兜底:宿主把未处理 rejection 判 fatal,任何漏网异常都收进日志
      log.error(`[taskboard-dsh] 连接流程异常退出：${errorMessage(error)}`)
    })

    return callbackServer.authorizationUrl
  }

  function cancelConnection(): void {
    connectionCancelled = true
    pendingConnectionAbort?.abort()
    probe.state = platformUrl !== '' ? 'disconnected' : 'unconfigured'
    probe.connectPhase = 'cancelled' as ProbeState['connectPhase']
    probe.connectMessage = '已取消连接'
    probe.connectUrl = null
  }

  // ---- webServer 路由（client 轮询面；ferryman 实测同源 cookie 可用） ----
  function handleState(response: ServerResponse): void {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(probe))
  }

  function readBody(request: { method?: string; url?: string }): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      let raw = ''
      const req = request as unknown as NodeJS.ReadableStream
      req.on('data', (chunk: Buffer | string) => {
        raw += chunk
      })
      req.on('end', () => {
        try {
          resolve(raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>))
        } catch {
          resolve({})
        }
      })
      req.on('error', () => resolve({}))
    })
  }

  // ---- webServer 路由（client 轮询面；ferryman 实测同源 cookie 可用） ----
  // 全新启动的宿主里插件可能早于 webServer 服务就绪(2026-11-20 train3060 实测:
  // 热重载态 200、重启后 404),所以探测失败要重试而不是放弃
  let routeRegistered = false
  function tryRegisterRoute(): void {
    fileLog('diag', `tryRegisterRoute enter closed=${closed} registered=${routeRegistered}`)
    if (routeRegistered || closed) return
    let webServer: WebServerLike | undefined
    try {
      webServer = ctx.get?.('webServer') as WebServerLike | undefined
    } catch (error) {
      fileLog('diag', `ctx.get('webServer') throw: ${errorMessage(error)}`)
      return
    }
    fileLog('diag', `webServer=${webServer === undefined ? 'undefined' : typeof webServer}`)
    if (webServer === undefined || typeof webServer.register !== 'function') {
      pushEvent('boot-retry', 'webServer 不可用,5 秒后重试')
      // 不挂 effect 清理(诊断期):fiber 被 dispose 时 effect 清理会吞掉重试 timer
      setTimeout(tryRegisterRoute, 5_000)
      return
    }
    routeRegistered = true
    const disposer = webServer.register({
      kind: 'prefix',
      path: '/api/taskboard',
      handler: async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        const route = url.pathname.replace(/^\/api\/taskboard\/?/, '')
        if (request.method === 'GET' && (route === '' || route === 'state')) {
          handleState(response)
          return
        }
        if (request.method === 'POST' && route === 'connect') {
          const authorizationUrl = await beginConnection()
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ url: authorizationUrl }))
          return
        }
        if (request.method === 'POST' && route === 'cancel') {
          cancelConnection()
          handleState(response)
          return
        }
        response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ error: 'not_found' }))
        void readBody(request)
      }
    })
    if (typeof disposer === 'function' && typeof ctx.effect === 'function') {
      ctx.effect(() => disposer)
    }
    pushEvent('boot', `webServer 路由已挂载（/api/taskboard）`)
  }
  tryRegisterRoute()

  // ---- 启动 ----
  pushEvent('boot', `platformUrl=${platformUrl || '(未配置)'} token=${stored.clientToken !== null ? '有' : '无'}`)
  if (probe.state === 'connected') {
    startStream()
  }
  // 无凭证时不自动发起连接(2026-11-20 train3060 实测教训:加载期挂长活资源
  // 叠加宿主 abort 会放大成 fatal load failure)。连接动作由面板「连接账号」
  // 按钮经 POST /api/taskboard/connect 触发——无人看面板就不监听端口。

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      closed = true
      stopStream()
      pendingConnectionAbort?.abort()
    })
  }
}
