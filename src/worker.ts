import { createHash, randomBytes } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { hostname } from 'node:os'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  checkPlatformHealth,
  createHttpDataSource,
  exchangeClientToken,
  isTaskboardHttpError,
  isUnauthorizedTaskboardError,
  normalizePlatformUrl,
  revokeClientCredential,
  TaskboardHttpError
} from './http'
import { createMockDataSource } from './mock'
import {
  buildNotifications,
  buildOverview,
  type Overview,
  type RawNotificationItem,
  type TaskboardNotification
} from './overview'
import './protocol'
import type {
  ConnectionPhase,
  ConnectionState,
  TaskboardSnapshot
} from './protocol'
import type { TaskboardDataSource } from './source'

const LEGACY_STATE_KEY = 'taskboard.connectionState'
const PLATFORM_URL_KEY = 'taskboard.platformUrl'
const LAST_EVENT_ID_KEY = 'taskboard.lastNotificationId'
const CLIENT_TOKEN_KEY = 'taskboard.clientToken'
const STATUS_BAR_ITEM_ID = 'unread'

export interface TaskboardWorkerTimings {
  connectTimeoutMs: number
  refreshIntervalMs: number
  refreshDebounceMs: number
  reconnectDelaysMs: readonly number[]
  idleTimeoutMs: number
}

const DEFAULT_TIMINGS: TaskboardWorkerTimings = {
  connectTimeoutMs: 300_000,
  refreshIntervalMs: 300_000,
  refreshDebounceMs: 400,
  reconnectDelaysMs: [1_000, 2_000, 5_000, 10_000, 30_000],
  idleTimeoutMs: 60_000
}

let testDataSourceFactory: (() => TaskboardDataSource) | null = null
let testTimings: Partial<TaskboardWorkerTimings> | null = null
let activeCleanup: (() => Promise<void>) | null = null

/** Test-only injection point. Production always constructs the HTTP source. */
export function setTaskboardDataSourceFactoryForTests(
  factory: (() => TaskboardDataSource) | null
): void {
  testDataSourceFactory = factory
}

export function useMockDataSourceForTests(): void {
  testDataSourceFactory = () => createMockDataSource()
}

export function setTaskboardTimingsForTests(
  timings: Partial<TaskboardWorkerTimings> | null
): void {
  testTimings = timings
}

function timing<K extends keyof TaskboardWorkerTimings>(
  key: K
): TaskboardWorkerTimings[K] {
  return testTimings?.[key] ?? DEFAULT_TIMINGS[key]
}

function emptySnapshot(
  state: ConnectionState,
  platformUrl: string,
  secretsAvailable: boolean
): TaskboardSnapshot {
  return {
    state,
    platformUrl,
    overview: null,
    notifications: [],
    latestNotificationId: null,
    unreadNotificationCount: null,
    secretsAvailable,
    addressError: null,
    connection: { phase: 'idle', message: null },
    refreshError: null
  }
}

function withConnection(
  current: TaskboardSnapshot,
  phase: ConnectionPhase,
  message: string | null = null
): TaskboardSnapshot {
  return { ...current, connection: { phase, message } }
}

function errorMessage(error: unknown): string {
  if (isTaskboardHttpError(error)) {
    return error.code ? `${error.message}（${error.code}）` : error.message
  }
  return error instanceof Error ? error.message : String(error)
}

function base64Url(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let result = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0
    const second = bytes[index + 1] ?? 0
    const third = bytes[index + 2] ?? 0
    result += alphabet[first >> 2]
    result += alphabet[((first & 0b11) << 4) | (second >> 4)]
    if (index + 1 < bytes.length) {
      result += alphabet[((second & 0b1111) << 2) | (third >> 6)]
    }
    if (index + 2 < bytes.length) result += alphabet[third & 0b111111]
  }
  return result
}

function displayHostname(): string {
  const raw = `Orca · ${hostname()}`.trim()
  const encoder = new TextEncoder()
  if (encoder.encode(raw).length <= 255) return raw
  let result = ''
  for (const character of raw) {
    if (encoder.encode(result + character).length > 255) break
    result += character
  }
  return result
}

function htmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function callbackPage(
  response: ServerResponse,
  statusCode: number,
  title: string,
  detail = ''
): void {
  response.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  response.end(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${htmlEscape(
      title
    )}</title><body style="font:15px system-ui;padding:48px;text-align:center">` +
      `<h1>${htmlEscape(title)}</h1><p>${htmlEscape(detail)}</p></body></html>`
  )
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    const abort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

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
      typeof value.created_at === 'string'
        ? value.created_at
        : new Date().toISOString(),
    read_at: (value.read_at ?? null) as RawNotificationItem['read_at']
  }
}

type SettledPart<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown }

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

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  if (activeCleanup) await activeCleanup()

  let closed = false
  let state: ConnectionState = 'unconfigured'
  let platformUrl = ''
  let clientToken: string | null = null
  let source: TaskboardDataSource | null = null
  let secretsAvailable = true
  let snapshot: TaskboardSnapshot

  let streamGeneration = 0
  let streamController: AbortController | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null
  let refreshIntervalTimer: ReturnType<typeof setInterval> | null = null
  let pendingConnectionAbort: AbortController | null = null
  let connectionCancelled = false

  const storedUrl = await orca.storage.get(PLATFORM_URL_KEY)
  platformUrl =
    typeof storedUrl === 'string' ? normalizePlatformUrl(storedUrl) : ''
  await orca.storage.delete(LEGACY_STATE_KEY)

  try {
    const protection = await orca.host.call('secrets.protection')
    secretsAvailable = protection.status === 'os-keyring'
  } catch {
    secretsAvailable = false
  }

  const storedToken = await orca.secrets.get(CLIENT_TOKEN_KEY)
  if (typeof storedToken === 'string' && storedToken.startsWith('tbc_')) {
    clientToken = storedToken
  } else if (storedToken !== null) {
    await orca.secrets.delete(CLIENT_TOKEN_KEY)
  }

  function makeSource(token: string): TaskboardDataSource {
    return testDataSourceFactory?.() ?? createHttpDataSource(platformUrl, token)
  }

  if (clientToken !== null && platformUrl !== '') {
    state = 'connected'
    source = makeSource(clientToken)
  } else if (platformUrl !== '') {
    state = 'disconnected'
    clientToken = null
  }

  snapshot = emptySnapshot(state, platformUrl, secretsAvailable)

  async function updateStatus(): Promise<void> {
    if (state === 'connected') {
      const unread =
        snapshot.overview?.unread_notifications ??
        snapshot.unreadNotificationCount
      await orca.host.call('statusBar.update', {
        id: STATUS_BAR_ITEM_ID,
        icon: 'bell',
        text: String(unread ?? 0),
        tone: unread !== null && unread > 0 ? 'accent' : 'neutral',
        tooltip: `工单板：${unread ?? 0} 条未读通知`
      })
      return
    }
    await orca.host.call('statusBar.update', {
      id: STATUS_BAR_ITEM_ID,
      icon: 'plug',
      text: '工单板 未连接',
      tone: 'neutral'
    })
  }

  async function publish(next: TaskboardSnapshot): Promise<TaskboardSnapshot> {
    snapshot = next
    orca.panels.post('taskboard.changed', { snapshot })
    await updateStatus()
    return snapshot
  }

  function stopStream(): void {
    streamGeneration += 1
    streamController?.abort()
    streamController = null
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  async function expire(): Promise<TaskboardSnapshot> {
    stopStream()
    clientToken = null
    source = null
    state = 'expired'
    if ((await orca.secrets.get(CLIENT_TOKEN_KEY)) !== null) {
      await orca.secrets.delete(CLIENT_TOKEN_KEY)
    }
    return publish(emptySnapshot(state, platformUrl, secretsAvailable))
  }

  async function disconnect(): Promise<TaskboardSnapshot> {
    stopStream()
    const token = clientToken
    if (token !== null && platformUrl !== '') {
      await revokeClientCredential(platformUrl, token)
    }
    clientToken = null
    source = null
    state = 'disconnected'
    if ((await orca.secrets.get(CLIENT_TOKEN_KEY)) !== null) {
      await orca.secrets.delete(CLIENT_TOKEN_KEY)
    }
    return publish(emptySnapshot(state, platformUrl, secretsAvailable))
  }

  async function refresh(): Promise<TaskboardSnapshot> {
    if (state !== 'connected' || source === null) {
      return emptySnapshot(state, platformUrl, secretsAvailable)
    }

    const current = snapshot
    const [inbox, waiting, collaborating, unread, notificationList] =
      await Promise.all([
        settlePart(source.inbox()),
        settlePart(source.waitingOnCounterparts()),
        settlePart(source.collaboratingTickets()),
        settlePart(source.unreadNotifications()),
        settlePart(source.notifications())
      ])

    if (
      [inbox, waiting, collaborating, unread, notificationList].some(
        (part) => !part.ok && isUnauthorizedTaskboardError(part.error)
      )
    ) {
      return expire()
    }

    const listParts = [inbox, waiting, collaborating] as const
    const listError = firstError(
      ...listParts.map((part) =>
        !part.ok &&
        !(isTaskboardHttpError(part.error) && part.error.status === 403)
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
      return { ...current, refreshError: `刷新失败：${errorMessage(error)}` }
    }

    const overview: Overview = buildOverview({
      platformUrl,
      inbox: inbox.ok ? inbox.value : null,
      waiting: waiting.ok ? waiting.value : null,
      collaborating: collaborating.ok ? collaborating.value : null,
      unreadNotifications: unread.value
    })

    return {
      state,
      platformUrl,
      overview,
      notifications: buildNotifications(platformUrl, notificationList.value),
      latestNotificationId: unread.value.latest_id,
      unreadNotificationCount: unread.value.unread_count,
      secretsAvailable,
      addressError: null,
      connection: current.connection,
      refreshError: null
    }
  }

  async function refreshAndPublish(): Promise<TaskboardSnapshot> {
    return publish(await refresh())
  }

  function scheduleRefresh(): void {
    if (state !== 'connected' || refreshDebounceTimer !== null) return
    refreshDebounceTimer = setTimeout(
      () => {
        refreshDebounceTimer = null
        void refreshAndPublish()
      },
      timing('refreshDebounceMs')
    )
  }

  async function showNotification(item: RawNotificationItem): Promise<void> {
    await orca.host.call('notifications.show', {
      title: item.ticket
        ? `${item.ticket.number} · ${item.ticket.title}`
        : '工单板',
      body: item.ticket ? item.reason : item.text || item.summary
    })
  }

  async function runStream(generation: number): Promise<void> {
    const token = clientToken
    if (token === null || state !== 'connected') return

    let reconnectAttempt = 0
    const storedLastId = await orca.storage.get(LAST_EVENT_ID_KEY)
    const hadStoredLastId = typeof storedLastId === 'number' && storedLastId > 0
    let lastEventId = typeof storedLastId === 'number' ? storedLastId : 0

    while (state === 'connected' && generation === streamGeneration && !closed) {
      const controller = new AbortController()
      streamController = controller
      try {
        const headers: Record<string, string> = {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${token}`
        }
        if (lastEventId > 0) headers['Last-Event-ID'] = String(lastEventId)

        const response = await fetch(
          `${platformUrl}/api/v1/notifications/stream`,
          { headers, signal: controller.signal }
        )
        if (response.status === 401) {
          await expire()
          return
        }
        if (!response.ok || response.body === null) {
          throw new TaskboardHttpError(
            response.status,
            'stream',
            `通知流连接失败：HTTP ${response.status}`
          )
        }

        let seenHello = false
        let replayNotifications: RawNotificationItem[] = []
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
              await orca.storage.set(LAST_EVENT_ID_KEY, lastEventId)
            }
          }
          if (eventName === '' && dataLines.length === 0) return
          const data = dataLines.join('\n')

          if (eventName === 'hello') {
            const body = JSON.parse(data) as {
              unread_count?: unknown
              latest_id?: unknown
            }
            const unreadCount =
              typeof body.unread_count === 'number' ? body.unread_count : null
            const latestId =
              typeof body.latest_id === 'number' ? body.latest_id : null
            if (latestId !== null && latestId > lastEventId) {
              lastEventId = latestId
              await orca.storage.set(LAST_EVENT_ID_KEY, lastEventId)
            }
            if (unreadCount !== null) {
              await publish({
                ...snapshot,
                unreadNotificationCount: unreadCount,
                latestNotificationId:
                  Math.max(snapshot.latestNotificationId ?? 0, latestId ?? 0) ||
                  null
              })
            }
            reconnectAttempt = 0
            if (hadStoredLastId && replayNotifications.length === 1) {
              await showNotification(replayNotifications[0])
            } else if (hadStoredLastId && replayNotifications.length > 1) {
              await orca.host.call('notifications.show', {
                title: '工单板',
                body: `离线期间有 ${replayNotifications.length} 条新通知`
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
            await showNotification(item)
            scheduleRefresh()
            return
          }

          if (eventName === 'read') scheduleRefresh()
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

        while (
          state === 'connected' &&
          generation === streamGeneration &&
          !closed
        ) {
          let idleTimer: ReturnType<typeof setTimeout> | null = null
          const becameIdle = new Promise<true>((resolve) => {
            idleTimer = setTimeout(() => resolve(true), timing('idleTimeoutMs'))
          })
          const read = await Promise.race([reader.read(), becameIdle])
          if (idleTimer !== null) clearTimeout(idleTimer)

          if (read === true) {
            controller.abort()
            await reader.cancel().catch(() => undefined)
            throw new TaskboardHttpError(0, 'idle', '通知流超时没有数据')
          }
          if (read.done) break

          buffer += decoder.decode(read.value, { stream: true })
          const lines = buffer.split(/\r?\n/)
          buffer = lines.pop() ?? ''
          for (const line of lines) await processLine(line)
        }
        if (buffer !== '') await processLine(buffer)
        throw new TaskboardHttpError(0, 'stream_closed', '通知流连接断开')
      } catch (error) {
        if (closed || state !== 'connected' || generation !== streamGeneration) {
          return
        }
        if (isUnauthorizedTaskboardError(error)) {
          await expire()
          return
        }
        orca.log(`通知流断开：${errorMessage(error)}`)
      } finally {
        streamController = null
      }

      if (state !== 'connected' || generation !== streamGeneration || closed) {
        return
      }
      const delays = timing('reconnectDelaysMs')
      const nextDelay =
        delays[Math.min(reconnectAttempt, Math.max(delays.length - 1, 0))] ??
        60_000
      reconnectAttempt += 1
      try {
        await delay(Math.min(nextDelay, 60_000), controller.signal)
      } catch {
        return
      }
    }
  }

  function startStream(): void {
    if (state !== 'connected' || streamController !== null || closed) return
    streamGeneration += 1
    void runStream(streamGeneration)
  }

  async function saveAddress(rawUrl: string): Promise<TaskboardSnapshot> {
    const health = await checkPlatformHealth(rawUrl)
    if (health.platformUrl === null || health.error !== null) {
      return publish({ ...snapshot, addressError: health.error })
    }

    await disconnect()
    platformUrl = health.platformUrl
    state = 'disconnected'
    await orca.storage.set(PLATFORM_URL_KEY, platformUrl)
    return publish(emptySnapshot(state, platformUrl, secretsAvailable))
  }

  interface CallbackServer {
    authorizationUrl: string
    waitForCode: Promise<string>
    close: () => void
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
        callbackPage(response, 200, '已连接', '已连接，可以关闭此页回到 Orca。')
        resolveCode(code)
      })

      const timeout = setTimeout(
        () => controller.abort(),
        timing('connectTimeoutMs')
      )
      const close = (): void => {
        clearTimeout(timeout)
        server.close()
      }
      const abortCode = (): void => {
        close()
        if (!codeSettled) {
          codeSettled = true
          rejectCode(new DOMException('Aborted', 'AbortError'))
        }
      }
      server.on('error', (error) => {
        close()
        rejectListening(error)
        if (!codeSettled) {
          codeSettled = true
          rejectCode(error)
        }
      })
      controller.signal.addEventListener('abort', abortCode, { once: true })
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
          hostname: displayHostname()
        })
        resolveListening({
          authorizationUrl: `${platformUrl}/client/connect?${query.toString()}`,
          waitForCode,
          close
        })
      })
    })
  }

  async function beginConnection(): Promise<{
    authorizationUrl: string | null
    snapshot: TaskboardSnapshot
  }> {
    if (!secretsAvailable) {
      const failed = withConnection(
        snapshot,
        'failed',
        '这台电脑没有可用的密钥存储，无法保存凭证'
      )
      await publish(failed)
      return { authorizationUrl: null, snapshot: failed }
    }
    if (platformUrl === '' || state === 'connected') {
      return { authorizationUrl: null, snapshot }
    }

    connectionCancelled = false
    pendingConnectionAbort?.abort()
    const controller = new AbortController()
    pendingConnectionAbort = controller
    const stateNonce = base64Url(randomBytes(16))
    const verifier = base64Url(randomBytes(32))
    const challenge = base64Url(createHash('sha256').update(verifier).digest())

    let callbackServer: CallbackServer
    try {
      callbackServer = await listenForCallback(
        stateNonce,
        challenge,
        controller
      )
    } catch (error) {
      pendingConnectionAbort = null
      return {
        authorizationUrl: null,
        snapshot: await publish(
          withConnection(
            snapshot,
            'failed',
            `无法启动本机回调服务：${errorMessage(error)}`
          )
        )
      }
    }

    await publish(withConnection(snapshot, 'waiting', '等待浏览器确认…'))
    void (async () => {
      try {
        const code = await callbackServer.waitForCode
        const issued = await exchangeClientToken(platformUrl, code, verifier)
        await orca.secrets.set(CLIENT_TOKEN_KEY, issued.token)
        clientToken = issued.token
        source = makeSource(clientToken)
        state = 'connected'
        await publish(
          withConnection(
            emptySnapshot(state, platformUrl, secretsAvailable),
            'succeeded'
          )
        )
        await refreshAndPublish()
        startStream()
      } catch (error) {
        if (isUnauthorizedTaskboardError(error)) {
          await expire()
          return
        }
        const aborted =
          error instanceof DOMException && error.name === 'AbortError'
        if (aborted && connectionCancelled) return
        await publish(
          withConnection(
            snapshot,
            aborted ? 'timeout' : 'failed',
            aborted
              ? '等待浏览器确认超时，请重新连接'
              : `连接失败：${errorMessage(error)}`
          )
        )
      } finally {
        callbackServer.close()
        if (pendingConnectionAbort === controller) pendingConnectionAbort = null
      }
    })()

    return {
      authorizationUrl: callbackServer.authorizationUrl,
      snapshot
    }
  }

  async function cancelConnection(): Promise<TaskboardSnapshot> {
    connectionCancelled = true
    pendingConnectionAbort?.abort()
    return publish(withConnection(snapshot, 'cancelled', '已取消连接'))
  }

  async function markRead(
    operation: () => Promise<void>
  ): Promise<TaskboardSnapshot> {
    try {
      await operation()
      return await refreshAndPublish()
    } catch (error) {
      if (isUnauthorizedTaskboardError(error)) return expire()
      return publish({
        ...snapshot,
        refreshError: `刷新失败：${errorMessage(error)}`
      })
    }
  }

  orca.panels.handle('taskboard.getState', async () => refreshAndPublish())
  orca.panels.handle('config.save', async ({ platformUrl: nextUrl }) =>
    saveAddress(nextUrl)
  )
  orca.panels.handle('connection.begin', beginConnection)
  orca.panels.handle('connection.cancel', cancelConnection)
  orca.panels.handle('connection.disconnect', disconnect)
  orca.panels.handle('notifications.markRead', async ({ ids }) =>
    markRead(() => {
      if (source === null) return Promise.resolve()
      return source.markNotificationsRead(ids)
    })
  )
  orca.panels.handle('notifications.markAllRead', async ({ up_to }) =>
    markRead(() => {
      if (source === null) return Promise.resolve()
      return source.markAllNotificationsRead(up_to)
    })
  )

  if (state === 'connected') {
    await refreshAndPublish()
    startStream()
  } else {
    await updateStatus()
  }

  refreshIntervalTimer = setInterval(
    () => {
      if (state === 'connected') void refreshAndPublish()
    },
    timing('refreshIntervalMs')
  )

  activeCleanup = async () => {
    closed = true
    stopStream()
    if (refreshDebounceTimer !== null) clearTimeout(refreshDebounceTimer)
    if (refreshIntervalTimer !== null) clearInterval(refreshIntervalTimer)
    pendingConnectionAbort?.abort()
    await updateStatus().catch(() => undefined)
    activeCleanup = null
  }
}

export async function deactivate(): Promise<void> {
  await activeCleanup?.()
}
