// taskboard-dsh host 半边——MVP:探针全链路 + Overview 三类筛选 + 标已读 + 断开。
// 协议事实钉点(0.2.2-rc.5 实测 + ferryman-dsh 先例):
//   - 插件入口 = 包导出 name + apply(ctx, config);export const inject 声明宿主服务。
//   - 用户可见通道 = ctx.logger.warn/error(无插件级 toast API)。
//   - webServer:ctx.get('webServer') 可选探测(desktop 宿主默认起在 OS 分配端口),
//     register({kind:'prefix', path, handler}) 挂路由;client 同源 fetch 带 cookie 鉴权
//     (ferryman-dsh client.js 实测可用面——typert 客户端面在装机宿主不可达,10-06 事故)。
//   - 凭证/状态存储:JSON 文件(~/.dsh/taskboard-plugin.json),
//     绕开 storageDomain/credentials 的 API 形状风险(单宿主场景文件等价;MVP 阶段再评估迁移)。
// 平台侧契约与 Orca 版共享(../../../src/http.ts + overview.ts):
//   - PKCE:POST /api/v1/client/token;回调固定 http://127.0.0.1:<port>/cb
//   - SSE:GET /api/v1/notifications/stream(hello/notification/read,Last-Event-ID 补发)
//   - Overview 5 路:inbox / waiting-on-counterparts / tickets?collaborator=me /
//     notifications/unread / notifications;标已读 POST /notifications/read
//   - 断开:DELETE /api/v1/me/clients/self(best effort)
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { hostname, homedir } from 'node:os'
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createHttpDataSource,
  exchangeClientToken,
  isTaskboardHttpError,
  isUnauthorizedTaskboardError,
  revokeClientCredential
} from '../../../src/http.ts'
import {
  absoluteUrl,
  buildNotifications,
  buildOverview,
  type Overview,
  type RawNotificationItem,
  type TaskboardNotification
} from '../../../src/overview.ts'
import type { TaskboardDataSource } from '../../../src/source.ts'

export const name = 'taskboard-dsh'
/**
 * 宿主服务依赖:空。webServer 走运行时探测。
 * 两个实测教训(2026-11-20 train3060,根因见 apply 注释):
 *   - inject 声明服务会把服务的 impl.uid 织进 fiber epoch,宿主启动期
 *     webServer 提供者被重组时 uid 变化直接触发我们 fiber 的 _unload(),
 *     且无人 restart——插件 1~2ms 内被静默拆掉;
 *   - 空 inject + 同步 apply 同样会被 loader 的组合更新 dispose。
 * 保活三件套:ctx.on 挂事件 + ctx.provide 注册服务 + apply 返回 disposer。
 */
export const inject: string[] = []

/** cordis Context 鸭子面(ferryman-dsh 同款:零宿主类型依赖) */
interface HostContext {
  logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void }
  config?: Record<string, unknown>
  get?(name: string): unknown
  effect?(setup: () => unknown): unknown
  /** 事件挂接(fiber 保活的关键资源;官方桥 hooks-claude-code 与 ferryman-dsh 同用面) */
  on?(event: string, handler: (...args: never[]) => unknown): (() => void) | unknown
  /** 服务注册面(ferryman-dsh 同用;provider 身份是 fiber 的强存活资源) */
  provide?(name: string, value: unknown): unknown
}

interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: { method?: string; url?: string }, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** 状态文件形状 */
interface StoredState {
  platformUrl: string
  clientToken: string | null
  lastEventId: number
}

/** SSE 实时通知转交 client 弹系统通知的条目 */
export interface PendingNotification {
  id: number
  title: string
  body: string
  url: string
}

/** client 轮询拿到的活状态(探针诊断面 + Overview 数据面) */
export interface ProbeState {
  state: 'unconfigured' | 'disconnected' | 'waiting' | 'connected' | 'expired'
  platformUrl: string
  unread: number | null
  connectUrl: string | null
  connectPhase: 'idle' | 'waiting' | 'succeeded' | 'timeout' | 'failed' | 'cancelled'
  connectMessage: string
  latestNotificationId: number | null
  overview: Overview | null
  notifications: TaskboardNotification[]
  refreshError: string | null
  pendingNotifications: PendingNotification[]
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
const REFRESH_DEBOUNCE_MS = 400
const REFRESH_INTERVAL_MS = 5 * 60_000
const PENDING_NOTIFICATION_CAP = 10

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function errorMessage(error: unknown): string {
  if (isTaskboardHttpError(error)) {
    return error.code ? `${error.message}(${error.code})` : error.message
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** SSE notification 事件 data → 平台通知条目(Orca worker.ts 同款容错) */
function notificationFromJson(value: unknown): RawNotificationItem | null {
  if (!isRecord(value) || typeof value.id !== 'number') return null
  return {
    ...(value as unknown as RawNotificationItem),
    ticket: (value.ticket ?? null) as RawNotificationItem['ticket'],
    url: typeof value.url === 'string' ? value.url : '',
    reason: typeof value.reason === 'string' ? value.reason : '',
    text: typeof value.text === 'string' ? value.text : '',
    summary: typeof value.summary === 'string' ? value.summary : '',
    created_at:
      typeof value.created_at === 'string' ? value.created_at : new Date().toISOString(),
    read_at: (value.read_at ?? null) as RawNotificationItem['read_at']
  }
}

type SettledPart<T> = { ok: true; value: T } | { ok: false; error: unknown }

async function settlePart<T>(request: Promise<T>): Promise<SettledPart<T>> {
  try {
    return { ok: true, value: await request }
  } catch (error) {
    return { ok: false, error }
  }
}

function firstError(...errors: unknown[]): unknown {
  return errors.find((error) => error !== undefined)
}

/**
 * 插件形态(2026-11-20 train3060 三阶段实测定案):
 *   - 同步 apply 且不挂任何宿主资源 → fiber 在启动期组合更新中被静默 dispose;
 *   - apply 为挂住的 async generator → 阻塞宿主 ready 序列,主窗口不出现(不可用);
 *   - **同步 apply + 保活三件套(ctx.on + ctx.provide + 返回 disposer)** → 常驻且不阻塞。
 * webServer 走运行时探测 + 5 秒重试(宿主就绪晚于插件加载)。
 */
export function apply(ctx: HostContext, config: Record<string, unknown> = {}): (() => void) | void {
  const log = ctx.logger ?? console
  let closed = false
  let stored = loadStored()

  const configUrl = typeof config.platformUrl === 'string' ? config.platformUrl : ''
  if (stored.platformUrl === '' && configUrl !== '') {
    stored.platformUrl = configUrl
  }
  const platformUrl = stored.platformUrl

  // ---- 活状态(client 轮询面) ----
  const probe: ProbeState = {
    state: stored.clientToken !== null && platformUrl !== '' ? 'connected' : platformUrl !== '' ? 'disconnected' : 'unconfigured',
    platformUrl,
    unread: null,
    connectUrl: null,
    connectPhase: 'idle',
    connectMessage: '',
    latestNotificationId: null,
    overview: null,
    notifications: [],
    refreshError: null,
    pendingNotifications: [],
    recentEvents: []
  }

  function pushEvent(kind: string, detail: string): void {
    probe.recentEvents.unshift({ at: new Date().toISOString(), kind, detail })
    probe.recentEvents.length = Math.min(probe.recentEvents.length, RECENT_EVENT_CAP)
    fileLog(kind, detail)
  }

  // ---- 数据源与 Overview 刷新(Orca worker.ts refresh 移植) ----
  let source: TaskboardDataSource | null = null

  function makeSource(): void {
    source = stored.clientToken !== null && platformUrl !== ''
      ? createHttpDataSource(platformUrl, stored.clientToken)
      : null
  }
  makeSource()

  let refreshInFlight: Promise<void> | null = null
  let refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null
  let refreshIntervalTimer: ReturnType<typeof setInterval> | null = null

  async function refresh(): Promise<void> {
    if (probe.state !== 'connected' || source === null || platformUrl === '') return

    const [inbox, waiting, collaborating, unread, notificationList] = await Promise.all([
      settlePart(source.inbox()),
      settlePart(source.waitingOnCounterparts()),
      settlePart(source.collaboratingTickets()),
      settlePart(source.unreadNotifications()),
      settlePart(source.notifications())
    ])

    // 任一接口 401 → 凭证失效(Orca 版同款判定)
    if (
      [inbox, waiting, collaborating, unread, notificationList].some(
        (part) => !part.ok && isUnauthorizedTaskboardError(part.error)
      )
    ) {
      expire()
      return
    }

    // 列表接口 403 = 概览未开放,不算错误(降级为 null);其余失败记 refreshError
    const listParts = [inbox, waiting, collaborating] as const
    const listError = firstError(
      ...listParts.map((part) =>
        !part.ok && !(isTaskboardHttpError(part.error) && part.error.status === 403)
          ? part.error
          : undefined
      )
    )
    if (!unread.ok || !notificationList.ok || listError !== undefined) {
      const error = !unread.ok
        ? unread.error
        : !notificationList.ok
          ? notificationList.error
          : listError
      probe.refreshError = `刷新失败:${errorMessage(error)}`
      pushEvent('refresh-error', probe.refreshError)
      return
    }

    probe.overview = buildOverview({
      platformUrl,
      inbox: inbox.ok ? inbox.value : null,
      waiting: waiting.ok ? waiting.value : null,
      collaborating: collaborating.ok ? collaborating.value : null,
      unreadNotifications: unread.value
    })
    probe.notifications = buildNotifications(platformUrl, notificationList.value)
    probe.unread = unread.value.unread_count
    probe.latestNotificationId = unread.value.latest_id
    probe.refreshError = null
  }

  function refreshQuietly(): void {
    if (refreshInFlight !== null) return
    refreshInFlight = refresh()
      .then(() => {
        refreshInFlight = null
      })
      .catch((error: unknown) => {
        refreshInFlight = null
        fileLog('diag', `refresh 异常退出:${errorMessage(error)}`)
      })
  }

  /** SSE 事件触发的刷新:400ms 防抖合并(Orca 版同款节奏) */
  function scheduleRefresh(): void {
    if (probe.state !== 'connected' || refreshDebounceTimer !== null) return
    refreshDebounceTimer = setTimeout(
      () => {
        refreshDebounceTimer = null
        refreshQuietly()
      },
      REFRESH_DEBOUNCE_MS
    )
  }

  // ---- SSE 通知流(Orca worker.ts runStream 移植;通知呈现 = pendingNotifications 队列) ----
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

  function clearConnectionState(): void {
    stopStream()
    if (refreshDebounceTimer !== null) {
      clearTimeout(refreshDebounceTimer)
      refreshDebounceTimer = null
    }
    stored.clientToken = null
    saveStored(stored)
    source = null
    probe.unread = null
    probe.overview = null
    probe.notifications = []
    probe.pendingNotifications = []
    probe.refreshError = null
    makeSource()
  }

  function expire(): void {
    clearConnectionState()
    probe.state = 'expired'
    pushEvent('expired', '凭证已失效,请重新连接')
    log.warn('[taskboard-dsh] 凭证已失效(401),已回到未连接状态')
  }

  async function disconnect(): Promise<void> {
    const token = stored.clientToken
    if (token !== null && platformUrl !== '') {
      await revokeClientCredential(platformUrl, token)
    }
    clearConnectionState()
    probe.state = platformUrl !== '' ? 'disconnected' : 'unconfigured'
    pushEvent('disconnected', '已断开连接,凭证已撤销')
    log.warn('[taskboard-dsh] 已断开连接')
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
    fileLog('diag', `runStream enter token=${token !== null ? '有' : '无'} state=${probe.state} gen=${generation}/${streamGeneration} closed=${closed}`)
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
        fileLog('diag', `stream fetch status=${response.status} body=${response.body !== null}`)
        if (response.status === 401) {
          expire()
          return
        }
        if (!response.ok || response.body === null) {
          throw new Error(`通知流连接失败:HTTP ${response.status}`)
        }

        let seenHello = false
        let replayNotifications: RawNotificationItem[] = []
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let eventName = ''
        let dataLines: string[] = []
        let eventId: string | null = null

        function enqueueDesktopNotification(item: RawNotificationItem): void {
          probe.pendingNotifications.push({
            id: item.id,
            title: item.ticket ? `${item.ticket.number} · ${item.ticket.title}` : '工单板',
            body: item.ticket ? item.reason : item.text || item.summary,
            url: absoluteUrl(platformUrl, item.url)
          })
          if (probe.pendingNotifications.length > PENDING_NOTIFICATION_CAP) {
            probe.pendingNotifications.splice(0, probe.pendingNotifications.length - PENDING_NOTIFICATION_CAP)
          }
        }

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
            pushEvent('hello', `unread=${unreadCount ?? '?'} latest=${latestId ?? '?'} replay=${replayNotifications.length}`)
            reconnectAttempt = 0
            if (hadStoredLastId && replayNotifications.length === 1) {
              enqueueDesktopNotification(replayNotifications[0])
            } else if (hadStoredLastId && replayNotifications.length > 1) {
              probe.pendingNotifications.push({
                id: lastEventId,
                title: '工单板',
                body: `离线期间有 ${replayNotifications.length} 条新通知`,
                url: platformUrl
              })
            }
            replayNotifications = []
            seenHello = true
            scheduleRefresh()
            return
          }

          if (eventName === 'notification') {
            const item = notificationFromJson(JSON.parse(data))
            if (item === null) return
            if (!seenHello) {
              replayNotifications.push(item)
              return
            }
            enqueueDesktopNotification(item)
            probe.unread = (probe.unread ?? 0) + 1
            pushEvent('notification', item.ticket ? `${item.ticket.number} · ${item.ticket.title}` : String(item.reason ?? '通知'))
            scheduleRefresh()
            return
          }

          if (eventName === 'read') {
            const body = JSON.parse(data) as { unread_count?: unknown }
            if (typeof body.unread_count === 'number') probe.unread = body.unread_count
            pushEvent('read', `unread=${probe.unread ?? '?'}`)
            scheduleRefresh()
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
    fileLog('diag', `startStream enter state=${probe.state} controller=${streamController !== null} closed=${closed}`)
    if (probe.state !== 'connected' || streamController !== null || closed) return
    streamGeneration += 1
    void runStream(streamGeneration).catch((error: unknown) => {
      log.error(`[taskboard-dsh] 通知流异常退出:${errorMessage(error)}`)
      fileLog('diag', `runStream outer-catch ${errorMessage(error)}`)
    })
  }

  // ---- 连接账号(回环 PKCE,Orca worker.ts 移植;确认 URL 打印 + 状态面) ----
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
          callbackPage(response, 400, '连接失败', 'state 不匹配,已拒绝这次回调。')
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
        callbackPage(response, 200, '已连接', '已连接,可以关闭此页回到 DSH。')
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
      probe.connectMessage = `无法启动本机回调服务:${errorMessage(error)}`
      pushEvent('connect-failed', probe.connectMessage)
      log.error(`[taskboard-dsh] ${probe.connectMessage}`)
      return null
    }

    probe.state = 'waiting'
    probe.connectPhase = 'waiting'
    probe.connectMessage = '等待浏览器确认…'
    probe.connectUrl = callbackServer.authorizationUrl
    log.warn(`[taskboard-dsh] 连接账号:在浏览器打开 ${callbackServer.authorizationUrl}`)
    void (async () => {
      try {
        const code = await callbackServer.waitForCode
        const issued = await exchangeClientToken(platformUrl, code, verifier)
        stored.clientToken = issued.token
        stored.lastEventId = 0
        saveStored(stored)
        makeSource()
        probe.state = 'connected'
        probe.connectPhase = 'succeeded'
        probe.connectMessage = '已连接'
        probe.connectUrl = null
        pushEvent('connected', '凭证已保存,拉取概览并启动通知流')
        refreshQuietly()
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
        probe.connectMessage = aborted ? '等待浏览器确认超时,请重新连接' : `连接失败:${errorMessage(error)}`
        probe.connectUrl = null
        pushEvent('connect-failed', probe.connectMessage)
        log.error(`[taskboard-dsh] ${probe.connectMessage}`)
      } finally {
        callbackServer.close()
        if (pendingConnectionAbort === controller) pendingConnectionAbort = null
      }
    })().catch((error: unknown) => {
      // 兜底:宿主把未处理 rejection 判 fatal,任何漏网异常都收进日志
      log.error(`[taskboard-dsh] 连接流程异常退出:${errorMessage(error)}`)
    })

    return callbackServer.authorizationUrl
  }

  function cancelConnection(): void {
    connectionCancelled = true
    pendingConnectionAbort?.abort()
    probe.state = platformUrl !== '' ? 'disconnected' : 'unconfigured'
    probe.connectPhase = 'cancelled'
    probe.connectMessage = '已取消连接'
    probe.connectUrl = null
  }

  async function markRead(ids: number[] | null, upTo: number | null): Promise<void> {
    if (source === null) return
    try {
      if (ids !== null && ids.length > 0) await source.markNotificationsRead(ids)
      else if (upTo !== null && upTo > 0) await source.markAllNotificationsRead(upTo)
    } catch (error) {
      if (isUnauthorizedTaskboardError(error)) {
        expire()
        return
      }
      probe.refreshError = `标已读失败:${errorMessage(error)}`
      pushEvent('refresh-error', probe.refreshError)
      return
    }
    await refresh()
  }

  // ---- webServer 路由(client 轮询/动作面;ferryman 实测同源 cookie 可用) ----
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
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify(probe))
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
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify(probe))
          return
        }
        if (request.method === 'POST' && route === 'disconnect') {
          await disconnect()
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify(probe))
          return
        }
        if (request.method === 'POST' && route === 'read') {
          const body = await readBody(request)
          const ids = Array.isArray(body.ids)
            ? body.ids.filter((id): id is number => typeof id === 'number')
            : null
          const upTo = typeof body.up_to === 'number' ? body.up_to : null
          await markRead(ids, upTo)
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify(probe))
          return
        }
        if (request.method === 'POST' && route === 'notifications/ack') {
          const body = await readBody(request)
          const ids = Array.isArray(body.ids)
            ? body.ids.filter((id): id is number => typeof id === 'number')
            : []
          probe.pendingNotifications = probe.pendingNotifications.filter(
            (item) => !ids.includes(item.id)
          )
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify(probe))
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
    pushEvent('boot', 'webServer 路由已挂载(/api/taskboard)')
  }
  tryRegisterRoute()

  function readBody(request: { method?: string; url?: string }): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      let raw = ''
      const req = request as unknown as Partial<NodeJS.ReadableStream>
      if (typeof req.on !== 'function') {
        resolve({})
        return
      }
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

  // ---- 启动 ----
  pushEvent('boot', `platformUrl=${platformUrl || '(未配置)'} token=${stored.clientToken !== null ? '有' : '无'}`)
  if (probe.state === 'connected') {
    refreshQuietly()
    startStream()
  }
  // 5 分钟兜底刷新(SSE 断流/漏事件时数据不腐化;Orca 版同款间隔)
  refreshIntervalTimer = setInterval(() => {
    if (probe.state === 'connected') refreshQuietly()
  }, REFRESH_INTERVAL_MS)
  // 无凭证时不自动发起连接(2026-11-20 train3060 实测教训:加载期挂长活资源
  // 叠加宿主 abort 会放大成 fatal load failure)。连接动作由面板「连接账号」
  // 按钮经 POST /api/taskboard/connect 触发——无人看面板就不监听端口。

  // 诊断:cordis 在 plugin fiber dispose 时 emit 'internal/plugin'(fiber.ts
  // emitPluginDisposed)——录下宿主 loader 的每次插件生命周期事件
  if (typeof ctx.on === 'function') {
    try {
      ctx.on('internal/plugin', ((fiber: unknown) => {
        const f = fiber as { uid: number | null; runtime?: { name?: string } } | null
        fileLog('loader-event', `internal/plugin name=${f?.runtime?.name ?? '?'} uid=${String(f?.uid)}`)
      }) as unknown as (...args: never[]) => unknown)
    } catch (error) {
      fileLog('diag', `internal/plugin 监听失败:${errorMessage(error)}`)
    }
  }

  // 保活三件套(ferryman-dsh 生产形态的完整模仿):ctx.on 挂事件、
  // ctx.provide 注册服务(provider 身份)、apply 返回 disposer。
  if (typeof ctx.on === 'function') {
    ctx.on('app-boot/config-reload', () => {})
  }
  if (typeof ctx.provide === 'function') {
    ctx.provide('taskboardProbe', { getState: () => probe, version: '0.2.0-mvp' })
  }

  return () => {
    fileLog('disposed', `插件 fiber 被清理 state=${probe.state}`)
    closed = true
    stopStream()
    if (refreshDebounceTimer !== null) clearTimeout(refreshDebounceTimer)
    if (refreshIntervalTimer !== null) clearInterval(refreshIntervalTimer)
    pendingConnectionAbort?.abort()
  }
}
