import { randomUUID } from 'node:crypto'
import type {
  RawInboxResponse,
  RawNotificationsResponse,
  RawTicketListResponse,
  RawUnreadNotificationsResponse
} from './overview'
import type { TaskboardDataSource } from './source'

export interface PlatformErrorBody {
  error?: {
    code?: unknown
    message?: unknown
    hint?: unknown
  }
}

export class TaskboardHttpError extends Error {
  readonly status: number
  readonly code: string
  readonly hint: string

  constructor(status: number, code: string, message: string, hint = '') {
    super(message || `HTTP ${status}${code ? ` (${code})` : ''}`)
    this.name = 'TaskboardHttpError'
    this.status = status
    this.code = code
    this.hint = hint
  }
}

export class UnauthorizedTaskboardError extends TaskboardHttpError {
  constructor(message = '连接已失效，请重新连接') {
    super(401, 'unauthenticated', message)
    this.name = 'UnauthorizedTaskboardError'
  }
}

export function isTaskboardHttpError(
  error: unknown
): error is TaskboardHttpError {
  return error instanceof TaskboardHttpError
}

export function isUnauthorizedTaskboardError(error: unknown): boolean {
  return isTaskboardHttpError(error) && error.status === 401
}

async function decodeHttpError(response: Response): Promise<TaskboardHttpError> {
  let code = ''
  let message = ''
  let hint = ''
  try {
    const body = (await response.json()) as PlatformErrorBody
    if (typeof body.error?.code === 'string') code = body.error.code
    if (typeof body.error?.message === 'string') message = body.error.message
    if (typeof body.error?.hint === 'string') hint = body.error.hint
  } catch {
    // Keep the HTTP status as the useful part of the error.
  }
  return new TaskboardHttpError(response.status, code, message, hint)
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
  token?: string
): Promise<T> {
  const headers = new Headers(init.headers)
  if (token !== undefined) headers.set('Authorization', `Bearer ${token}`)

  let response: Response
  try {
    response = await fetch(url, { ...init, headers })
  } catch (error) {
    throw new TaskboardHttpError(
      0,
      'network',
      `连不上工单板平台：${error instanceof Error ? error.message : String(error)}`
    )
  }

  if (response.status === 401) throw new UnauthorizedTaskboardError()
  if (!response.ok) throw await decodeHttpError(response)
  try {
    return (await response.json()) as T
  } catch {
    throw new TaskboardHttpError(
      response.status,
      'invalid_json',
      '工单板平台返回的不是有效 JSON'
    )
  }
}

function postInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID()
    },
    body: JSON.stringify(body)
  }
}

export function normalizePlatformUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (trimmed === '') return ''
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return withScheme
  } catch {
    return ''
  }
}

export interface PlatformHealthResult {
  platformUrl: string | null
  error: string | null
}

export async function checkPlatformHealth(
  rawUrl: string
): Promise<PlatformHealthResult> {
  const platformUrl = normalizePlatformUrl(rawUrl)
  if (platformUrl === '') {
    return { platformUrl: null, error: '平台地址无效，请填写 http(s) 地址' }
  }

  let response: Response
  try {
    response = await fetch(`${platformUrl}/api/v1/health`, {
      headers: { Accept: 'application/json' }
    })
  } catch (error) {
    return {
      platformUrl: null,
      error: `连不上工单板平台：${error instanceof Error ? error.message : String(error)}`
    }
  }

  if (response.status !== 200) {
    return {
      platformUrl: null,
      error: `不是工单板平台：健康检查返回 HTTP ${response.status}`
    }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { platformUrl: null, error: '不是工单板平台：健康检查返回的不是 JSON' }
  }
  const version = (body as { server_version?: unknown } | null)?.server_version
  if (typeof version !== 'string' || version === '') {
    return {
      platformUrl: null,
      error: '不是工单板平台：健康检查缺少非空 server_version'
    }
  }
  return { platformUrl, error: null }
}

export interface ClientTokenResponse {
  token: string
}

export async function exchangeClientToken(
  platformUrl: string,
  code: string,
  codeVerifier: string
): Promise<ClientTokenResponse> {
  const body = await requestJson<ClientTokenResponse>(
    `${platformUrl}/api/v1/client/token`,
    postInit({ code, code_verifier: codeVerifier })
  )
  if (typeof body.token !== 'string' || body.token === '') {
    throw new TaskboardHttpError(0, 'invalid_response', '平台没有返回客户端凭证')
  }
  return body
}

export async function revokeClientCredential(
  platformUrl: string,
  token: string
): Promise<void> {
  try {
    const response = await fetch(`${platformUrl}/api/v1/me/clients/self`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    })
    if (response.body) await response.body.cancel().catch(() => undefined)
  } catch {
    // Revocation is best effort; local credentials are still removed.
  }
}

export function createHttpDataSource(
  platformUrl: string,
  token: string
): TaskboardDataSource {
  const get = <T>(path: string): Promise<T> =>
    requestJson<T>(`${platformUrl}${path}`, { headers: { Accept: 'application/json' } }, token)
  const post = (path: string, body: unknown): Promise<void> =>
    requestJson<unknown>(
      `${platformUrl}${path}`,
      postInit(body),
      token
    ).then(() => undefined)

  return {
    inbox: () => get<RawInboxResponse>('/api/v1/inbox'),
    waitingOnCounterparts: () =>
      get<RawInboxResponse>('/api/v1/inbox/waiting-on-counterparts'),
    collaboratingTickets: () =>
      get<RawTicketListResponse>(
        '/api/v1/tickets?collaborator=me&status=open&limit=200'
      ),
    unreadNotifications: () =>
      get<RawUnreadNotificationsResponse>('/api/v1/notifications/unread'),
    notifications: () =>
      get<RawNotificationsResponse>('/api/v1/notifications?limit=50'),
    markNotificationsRead: (ids) =>
      post('/api/v1/notifications/read', { ids }),
    markAllNotificationsRead: (upTo) =>
      post('/api/v1/notifications/read', { up_to: upTo })
  }
}
