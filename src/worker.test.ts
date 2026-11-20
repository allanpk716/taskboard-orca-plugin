import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import {
  afterEach,
  assert,
  mockHost,
  mountWorker,
  test,
  type MockHost,
  type TestWorker
} from 'orca/testing'
import type { RawNotificationItem } from './overview'
import * as main from './worker'

interface WritableResponse {
  writeHead(statusCode: number, headers?: Record<string, string>): unknown
  write(chunk: string | Uint8Array): boolean
  end(chunk?: string | Uint8Array): unknown
  destroy?(error?: Error): void
  socket?: {
    destroy(): void
    on(event: string, listener: () => void): void
  }
}

interface FakeRequest {
  url?: string
  method?: string
  headers: Record<string, string>
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>
}

type HealthMode = 'ok' | 'non-json' | 'empty-version' | 'http-error'

function notification(id: number): RawNotificationItem {
  const number = `T-${id}`
  return {
    id,
    ticket: { number, title: `通知 ${number}`, url: `/t/${number}` },
    url: `/t/${number}`,
    kind: 'turn',
    reason: 'assigned',
    text: `通知 ${number} 正文`,
    summary: `通知 ${number} 摘要`,
    created_at: '2026-11-20T05:00:00Z',
    read_at: null
  }
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

async function requestBody(request: FakeRequest): Promise<string> {
  let body = ''
  const decoder = new TextDecoder()
  for await (const chunk of request) body += decoder.decode(chunk)
  return body
}

class FakeTaskboardPlatform {
  url = ''
  healthMode: HealthMode = 'ok'
  failAuth = false
  expectedChallenge = ''
  replayWithoutHeader = false
  notifications: RawNotificationItem[] = []
  tokenRequests: { body: { code: string; code_verifier: string }; idempotencyKey: string }[] = []
  readRequests: {
    body: { ids?: number[]; up_to?: number }
    idempotencyKey: string | null
  }[] = []
  deleteSelfCount = 0
  streamConnections = 0
  streamHellos = 0
  lastEventIds: string[] = []
  private activeStreams: WritableResponse[] = []

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      void this.handle(
        request as unknown as FakeRequest,
        response as unknown as WritableResponse
      )
    })
    const sockets = new Set<{ destroy(): void }>()
    server.on('error', () => undefined)
    server.on(
      'connection',
      (socket: { destroy(): void; on(event: string, listener: () => void): void }) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
      }
    )
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('fake platform did not get a port')
    }
    this.url = `http://127.0.0.1:${address.port}`
    this.close = async () => {
      for (const stream of this.activeStreams) stream.destroy?.()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  async close(): Promise<void> {
    // Replaced by start().
  }

  private authorized(request: FakeRequest): boolean {
    return request.headers.authorization === 'Bearer tbc_test'
  }

  private error(
    response: WritableResponse,
    status: number,
    code: string,
    message: string
  ): void {
    response.writeHead(status, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { code, message } }))
  }

  private json(response: WritableResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(body))
  }

  private unreadCount(): number {
    return this.notifications.filter((item) => item.read_at === null).length
  }

  private latestId(): number {
    return this.notifications.reduce((max, item) => Math.max(max, item.id), 0)
  }

  private sseWrite(
    response: WritableResponse,
    event: string,
    data: unknown,
    id?: number
  ): void {
    if (id !== undefined) response.write(`id: ${id}\n`)
    response.write(`event: ${event}\n`)
    response.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  private async handle(request: FakeRequest, response: WritableResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')

    if (url.pathname === '/api/v1/health') {
      if (this.healthMode === 'http-error') {
        this.error(response, 503, 'unavailable', '服务暂不可用')
        return
      }
      if (this.healthMode === 'non-json') {
        response.writeHead(200, { 'Content-Type': 'text/plain' })
        response.end('not json')
        return
      }
      const version = this.healthMode === 'empty-version' ? '' : '1.2.3'
      this.json(response, 200, { status: 'ok', server_version: version })
      return
    }

    if (url.pathname === '/api/v1/client/token' && request.method === 'POST') {
      const raw = JSON.parse(await requestBody(request)) as {
        code: string
        code_verifier: string
      }
      this.tokenRequests.push({
        body: raw,
        idempotencyKey: request.headers['idempotency-key'] ?? ''
      })
      const digest = createHash('sha256').update(raw.code_verifier).digest()
      if (base64Url(digest) !== this.expectedChallenge) {
        this.error(response, 401, 'invalid_client_code', 'verifier 不匹配')
        return
      }
      this.json(response, 201, { token: 'tbc_test', created_at: '2026-11-20T05:00:00Z' })
      return
    }

    if (this.failAuth || !this.authorized(request)) {
      this.error(response, 401, 'unauthenticated', '凭证无效')
      return
    }

    if (
      url.pathname === '/api/v1/inbox' ||
      url.pathname === '/api/v1/inbox/waiting-on-counterparts' ||
      (url.pathname === '/api/v1/tickets' &&
        url.searchParams.get('collaborator') === 'me' &&
        url.searchParams.get('status') === 'open')
    ) {
      this.error(response, 403, 'client_scope', '客户端凭证还不能访问概览接口')
      return
    }

    if (url.pathname === '/api/v1/notifications/unread') {
      this.json(response, 200, {
        unread_count: this.unreadCount(),
        latest_id: this.latestId(),
        client_online: true
      })
      return
    }

    if (url.pathname === '/api/v1/notifications') {
      this.json(response, 200, {
        items: [...this.notifications].sort((a, b) => b.id - a.id),
        cursor: this.latestId(),
        unread_count: this.unreadCount(),
        next: null
      })
      return
    }

    if (url.pathname === '/api/v1/notifications/read' && request.method === 'POST') {
      const raw = JSON.parse(await requestBody(request)) as {
        ids?: number[]
        up_to?: number
      }
      this.readRequests.push({
        body: raw,
        idempotencyKey: request.headers['idempotency-key'] ?? null
      })
      if (raw.ids !== undefined) {
        const ids = new Set(raw.ids)
        for (const item of this.notifications) {
          if (ids.has(item.id)) item.read_at = '2026-11-20T06:00:00Z'
        }
      } else if (typeof raw.up_to === 'number') {
        for (const item of this.notifications) {
          if (item.id <= raw.up_to) item.read_at = '2026-11-20T06:00:00Z'
        }
      }
      this.json(response, 200, {
        marked: this.notifications.length,
        unread_count: this.unreadCount()
      })
      return
    }

    if (url.pathname === '/api/v1/notifications/stream') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache'
      })
      this.streamConnections += 1
      this.activeStreams.push(response)
      const header = request.headers['last-event-id']
      if (header !== undefined) this.lastEventIds.push(header)
      const after = header === undefined ? 0 : Number(header)
      if (header !== undefined || this.replayWithoutHeader) {
        for (const item of this.notifications) {
          if (item.id > after) {
            this.sseWrite(response, 'notification', item, item.id)
          }
        }
      }
      this.sseWrite(response, 'hello', {
        unread_count: this.unreadCount(),
        latest_id: this.latestId()
      })
      this.streamHellos += 1
      response.socket?.on('close', () => {
        this.activeStreams = this.activeStreams.filter((item) => item !== response)
      })
      return
    }

    if (url.pathname === '/api/v1/me/clients/self' && request.method === 'DELETE') {
      this.deleteSelfCount += 1
      response.writeHead(204)
      response.end()
      return
    }

    this.error(response, 404, 'not_found', 'fake platform has no such endpoint')
  }

  sendNotification(item: RawNotificationItem): void {
    this.notifications.push(item)
    for (const response of [...this.activeStreams]) {
      this.sseWrite(response, 'notification', item, item.id)
    }
  }

  closeActiveStreams(): void {
    for (const response of [...this.activeStreams]) response.destroy?.()
    this.activeStreams = []
  }
}

const workers: TestWorker[] = []
const platforms: FakeTaskboardPlatform[] = []

afterEach(async () => {
  while (workers.length > 0) await workers.pop()?.deactivate()
  while (platforms.length > 0) await platforms.pop()?.close()
  main.setTaskboardDataSourceFactoryForTests(null)
  main.setTaskboardTimingsForTests(null)
})

async function until(
  predicate: () => boolean,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.ok(predicate(), 'condition was not met before timeout')
}

async function startPlatform(
  notifications: number[] = [11, 12]
): Promise<FakeTaskboardPlatform> {
  const platform = new FakeTaskboardPlatform()
  platform.notifications = notifications.map(notification)
  await platform.start()
  platforms.push(platform)
  return platform
}

async function mountWorkerWithPlatform(
  platform: FakeTaskboardPlatform,
  options: { lastEventId?: number; token?: string } = {}
): Promise<{ worker: TestWorker; host: MockHost }> {
  const desktopNotifications: { title: string; body?: string }[] = []
  const host = mockHost({
    storage: {
      'taskboard.platformUrl': platform.url,
      ...(options.lastEventId === undefined
        ? {}
        : { 'taskboard.lastNotificationId': options.lastEventId })
    },
    secrets:
      options.token === undefined ? {} : { 'taskboard.clientToken': options.token },
    results: {
      'notifications.show': (params: { title: string; body?: string }) => {
        desktopNotifications.push(params)
        return { delivered: true }
      }
    }
  })
  const worker = await mountWorker(main, { host })
  workers.push(worker)
  return { worker, host }
}

function desktopNotifications(host: MockHost): { title: string; body?: string }[] {
  return host.callsOf('notifications.show').map(
    (call) => call as { title: string; body?: string }
  )
}

async function connectAccount(
  worker: TestWorker,
  platform: FakeTaskboardPlatform
): Promise<{ authorizationUrl: URL; callbackBase: string }> {
  const result = await worker.request('connection.begin')
  assert.equal(result.authorizationUrl !== null, true)
  const authorizationUrl = new URL(result.authorizationUrl ?? 'about:blank')
  platform.expectedChallenge = authorizationUrl.searchParams.get('code_challenge') ?? ''

  const wrongState = await fetch(
    `${callbackBase(authorizationUrl)}?code=fake-code&state=wrong`
  )
  assert.equal(wrongState.status, 400)
  assert.ok((await wrongState.text()).includes('state 不匹配'))

  const good = await fetch(
    `${callbackBase(authorizationUrl)}?code=fake-code&state=${authorizationUrl.searchParams.get('state')}`
  )
  assert.equal(good.status, 200)
  assert.ok((await good.text()).includes('已连接，可以关闭此页回到 Orca'))
  await until(() => worker.host.data().secrets['taskboard.clientToken'] !== undefined)
  return { authorizationUrl, callbackBase: callbackBase(authorizationUrl) }
}

function callbackBase(authorizationUrl: URL): string {
  return `http://127.0.0.1:${authorizationUrl.searchParams.get('port')}/cb`
}

test('validates health, rejects bad addresses, and only saves a real platform', async () => {
  main.setTaskboardTimingsForTests({
    refreshIntervalMs: 60_000,
    refreshDebounceMs: 10,
    reconnectDelaysMs: [10],
    idleTimeoutMs: 2_000
  })
  const platform = await startPlatform()
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  workers.push(worker)

  const saved = await worker.request('config.save', {
    platformUrl: `${platform.url}/`
  })
  assert.equal(saved.state, 'disconnected')
  assert.equal(saved.platformUrl, platform.url)
  assert.equal(saved.addressError, null)
  assert.equal(host.data().storage['taskboard.platformUrl'], platform.url)

  platform.healthMode = 'non-json'
  const nonJson = await worker.request('config.save', {
    platformUrl: platform.url
  })
  assert.equal(nonJson.state, 'disconnected')
  assert.equal(nonJson.platformUrl, platform.url)
  assert.match(nonJson.addressError ?? '', /不是 JSON/)

  platform.healthMode = 'http-error'
  const httpError = await worker.request('config.save', {
    platformUrl: platform.url
  })
  assert.match(httpError.addressError ?? '', /HTTP 503/)

  platform.healthMode = 'empty-version'
  const emptyVersion = await worker.request('config.save', {
    platformUrl: platform.url
  })
  assert.match(emptyVersion.addressError ?? '', /server_version/)

  const unreachable = await worker.request('config.save', {
    platformUrl: 'http://127.0.0.1:1'
  })
  assert.match(unreachable.addressError ?? '', /连不上/)
  assert.equal(host.data().storage['taskboard.platformUrl'], platform.url)
})

test('connects with loopback PKCE, stores the credential, and uses real notifications', async () => {
  main.setTaskboardTimingsForTests({
    refreshIntervalMs: 60_000,
    refreshDebounceMs: 10,
    reconnectDelaysMs: [10],
    idleTimeoutMs: 2_000
  })
  const platform = await startPlatform([11, 12, 13])
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  workers.push(worker)
  await worker.request('config.save', { platformUrl: platform.url })
  const { authorizationUrl } = await connectAccount(worker, platform)

  assert.equal(authorizationUrl.pathname, '/client/connect')
  assert.equal(authorizationUrl.searchParams.get('hostname')?.startsWith('Orca · '), true)
  assert.equal(authorizationUrl.searchParams.get('code_challenge')?.length, 43)
  assert.equal(platform.tokenRequests.length, 1)
  assert.ok(platform.tokenRequests[0]?.idempotencyKey !== '')
  const verifier = platform.tokenRequests[0]?.body.code_verifier ?? ''
  assert.equal(
    base64Url(createHash('sha256').update(verifier).digest()),
    authorizationUrl.searchParams.get('code_challenge')
  )
  assert.equal(worker.host.data().secrets['taskboard.clientToken'], 'tbc_test')

  const connected = await worker.request('taskboard.getState')
  assert.equal(connected.state, 'connected')
  assert.equal(connected.overview?.inbox, null)
  assert.equal(connected.overview?.collaborating, null)
  assert.equal(connected.overview?.waiting, null)
  assert.equal(connected.overview?.unread_notifications, 3)
  assert.equal(connected.notifications.length, 3)
  assert.deepEqual(worker.host.callsOf('statusBar.update').at(-1), {
    id: 'unread',
    icon: 'bell',
    text: '3',
    tone: 'accent',
    tooltip: '工单板：3 条未读通知'
  })
  await until(() => platform.streamConnections === 1)
})

test('shows one replay notification when exactly one arrived offline', async () => {
  main.setTaskboardTimingsForTests({
    refreshIntervalMs: 60_000,
    refreshDebounceMs: 10,
    reconnectDelaysMs: [10],
    idleTimeoutMs: 2_000
  })
  const platform = await startPlatform([11])
  const { worker, host } = await mountWorkerWithPlatform(platform, {
    lastEventId: 10,
    token: 'tbc_test'
  })
  await until(() => platform.streamHellos === 1)
  const shown = desktopNotifications(host)
  assert.equal(shown.length, 1)
  assert.equal(shown[0]?.title, 'T-11 · 通知 T-11')
  assert.equal(shown[0]?.body, 'assigned')
})

test('collapses three replay notifications into one desktop notification', async () => {
  main.setTaskboardTimingsForTests({
    refreshIntervalMs: 60_000,
    refreshDebounceMs: 10,
    reconnectDelaysMs: [10],
    idleTimeoutMs: 2_000
  })
  const platform = await startPlatform([11, 12, 13])
  const { worker, host } = await mountWorkerWithPlatform(platform, {
    lastEventId: 10,
    token: 'tbc_test'
  })
  await until(() => platform.streamHellos === 1)
  const shown = desktopNotifications(host)
  assert.equal(shown.length, 1)
  assert.equal(shown[0]?.title, '工单板')
  assert.equal(shown[0]?.body, '离线期间有 3 条新通知')
})

test('does not show replay notifications on the very first connection', async () => {
  main.setTaskboardTimingsForTests({
    refreshIntervalMs: 60_000,
    refreshDebounceMs: 10,
    reconnectDelaysMs: [10],
    idleTimeoutMs: 2_000
  })
  const platform = await startPlatform([11, 12, 13])
  platform.replayWithoutHeader = true
  const { worker, host } = await mountWorkerWithPlatform(platform, {
    token: 'tbc_test'
  })
  await until(() => platform.streamHellos === 1)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(desktopNotifications(host), [])
})

test('shows live notifications and reconnects with Last-Event-ID', async () => {
  main.setTaskboardTimingsForTests({
    refreshIntervalMs: 60_000,
    refreshDebounceMs: 10,
    reconnectDelaysMs: [10],
    idleTimeoutMs: 2_000
  })
  const platform = await startPlatform([11])
  const { worker, host } = await mountWorkerWithPlatform(platform, {
    token: 'tbc_test'
  })
  await until(() => platform.streamConnections === 1)
  platform.sendNotification(notification(12))
  await until(() => desktopNotifications(host).length === 1)
  assert.equal(desktopNotifications(host)[0]?.title, 'T-12 · 通知 T-12')
  await until(() => worker.host.data().storage['taskboard.lastNotificationId'] === 12)

  platform.closeActiveStreams()
  await until(() => platform.streamConnections === 2)
  assert.equal(platform.lastEventIds.at(-1), '12')
})

test('clears credentials and stops SSE when any API returns 401', async () => {
  main.setTaskboardTimingsForTests({
    refreshIntervalMs: 60_000,
    refreshDebounceMs: 10,
    reconnectDelaysMs: [10],
    idleTimeoutMs: 2_000
  })
  const platform = await startPlatform([11])
  platform.failAuth = true
  const { worker, host } = await mountWorkerWithPlatform(platform, {
    token: 'tbc_test'
  })
  const expired = await worker.request('taskboard.getState')
  assert.equal(expired.state, 'expired')
  assert.equal(host.data().secrets['taskboard.clientToken'], undefined)
  assert.deepEqual(host.callsOf('statusBar.update').at(-1), {
    id: 'unread',
    icon: 'plug',
    text: '工单板 未连接',
    tone: 'neutral'
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(platform.streamConnections, 0)
})

test('keeps notifications working while the three overview APIs are 403', async () => {
  main.setTaskboardTimingsForTests({
    refreshIntervalMs: 60_000,
    refreshDebounceMs: 10,
    reconnectDelaysMs: [10],
    idleTimeoutMs: 2_000
  })
  const platform = await startPlatform([11, 12])
  const { worker } = await mountWorkerWithPlatform(platform, { token: 'tbc_test' })
  const current = await worker.request('taskboard.getState')
  assert.equal(current.refreshError, null)
  assert.equal(current.overview?.inbox, null)
  assert.equal(current.overview?.collaborating, null)
  assert.equal(current.overview?.waiting, null)
  assert.equal(current.overview?.unread_notifications, 2)
  assert.equal(current.notifications.length, 2)
})

test('sends correct idempotent bodies when marking notifications read', async () => {
  main.setTaskboardTimingsForTests({
    refreshIntervalMs: 60_000,
    refreshDebounceMs: 10,
    reconnectDelaysMs: [10],
    idleTimeoutMs: 2_000
  })
  const platform = await startPlatform([11, 12])
  const { worker } = await mountWorkerWithPlatform(platform, { token: 'tbc_test' })
  const afterOne = await worker.request('notifications.markRead', { ids: [11] })
  assert.equal(afterOne.overview?.unread_notifications, 1)
  assert.equal(afterOne.notifications.find((item) => item.id === 11)?.read_at !== null, true)
  assert.deepEqual(platform.readRequests[0]?.body, { ids: [11] })
  assert.ok(platform.readRequests[0]?.idempotencyKey !== null)

  const afterAll = await worker.request('notifications.markAllRead', { up_to: 12 })
  assert.equal(afterAll.overview?.unread_notifications, 0)
  assert.deepEqual(platform.readRequests[1]?.body, { up_to: 12 })
  assert.ok(platform.readRequests[1]?.idempotencyKey !== null)
})

test('revokes the platform credential and clears the local secret on disconnect', async () => {
  main.setTaskboardTimingsForTests({
    refreshIntervalMs: 60_000,
    refreshDebounceMs: 10,
    reconnectDelaysMs: [10],
    idleTimeoutMs: 2_000
  })
  const platform = await startPlatform([11])
  const { worker, host } = await mountWorkerWithPlatform(platform, { token: 'tbc_test' })
  const disconnected = await worker.request('connection.disconnect')
  assert.equal(disconnected.state, 'disconnected')
  assert.equal(platform.deleteSelfCount, 1)
  assert.equal(host.data().secrets['taskboard.clientToken'], undefined)
})

test('allows tests to inject the retained mock data source', async () => {
  main.useMockDataSourceForTests()
  main.setTaskboardTimingsForTests({
    refreshIntervalMs: 60_000,
    refreshDebounceMs: 10,
    reconnectDelaysMs: [10],
    idleTimeoutMs: 2_000
  })
  const platform = await startPlatform([11])
  const { worker } = await mountWorkerWithPlatform(platform, { token: 'tbc_test' })
  const current = await worker.request('taskboard.getState')
  assert.equal(current.overview?.collaborating?.total, 3)
  assert.equal(current.notifications.length, 7)
})
