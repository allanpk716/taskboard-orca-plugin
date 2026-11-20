export type InboxReasonCode =
  | 'new'
  | 'delivered'
  | 'assignee_replied'
  | 'sent_back'
  | 'creator_replied'
  | 'agent_replied'
  | 'guest_replied'
  | 'guest_completed'
  | 'guest_revised'
  | 'guest_not_completed'
  | 'pending_triage'

export const INBOX_REASON_CODES: readonly InboxReasonCode[] = [
  'new',
  'delivered',
  'assignee_replied',
  'sent_back',
  'creator_replied',
  'agent_replied',
  'guest_replied',
  'guest_completed',
  'guest_revised',
  'guest_not_completed',
  'pending_triage'
]

export const INBOX_REASON_LABELS: Record<InboxReasonCode, string> = {
  new: '新指派给你',
  delivered: '已交付，待你验收',
  assignee_replied: '指派人回复了，待你答复',
  sent_back: '发起人退回修改',
  creator_replied: '发起人回复了',
  agent_replied: '你的 Agent 回复了',
  guest_replied: '访客回复了',
  guest_completed: '访客补全了说明',
  guest_revised: '访客修订了说明',
  guest_not_completed: '访客未补全说明',
  pending_triage: '待初筛'
}

export interface InboxActor {
  type: 'member' | 'guest' | 'member_agent' | (string & {})
  name: string
  action?: 'assigned' | 'reassigned' | (string & {})
}

export interface RawInboxItem {
  number: string
  title: string
  role: 'assignee' | 'creator' | 'triager' | (string & {})
  reason: string
  reason_code: InboxReasonCode | (string & {})
  trigger: InboxActor
  last_reply_at: string | null
  created_at: string
}

export interface RawInboxResponse {
  member: string
  count: number
  items: readonly RawInboxItem[]
}

export interface RawTicketItem {
  number: string
  url: string
  title: string
  unread: boolean
}

export interface RawTicketListResponse {
  total: number
  count: number
  items: readonly RawTicketItem[]
  next: string | null
  cursor: number
  filters: Record<string, unknown>
}

export interface RawNotificationTicket {
  number: string
  title: string
  url: string
}

export interface RawNotificationItem {
  id: number
  ticket: RawNotificationTicket | null
  url: string
  kind: 'turn' | 'fyi' | (string & {})
  reason: string
  text: string
  summary: string
  created_at: string
  read_at: string | null
}

export interface RawNotificationsResponse {
  items: readonly RawNotificationItem[]
  cursor: number
  unread_count: number
  next: string | null
}

export interface RawUnreadNotificationsResponse {
  unread_count: number
  latest_id: number
  client_online: boolean
}

export interface OverviewInboxItem {
  number: string
  title: string
  url: string
  reason: string
  reason_code: InboxReasonCode
  trigger: InboxActor
  last_reply_at: string | null
  created_at: string
}

export interface Overview {
  inbox: {
    by_reason: Record<InboxReasonCode, number>
    items: OverviewInboxItem[]
  } | null
  collaborating: { total: number; unread: number } | null
  waiting: { total: number } | null
  unread_notifications: number
}

export interface TaskboardNotification extends RawNotificationItem {
  url: string
}

export interface OverviewInput {
  platformUrl: string
  inbox: RawInboxResponse | null
  waiting: RawInboxResponse | null
  collaborating: RawTicketListResponse | null
  unreadNotifications: RawUnreadNotificationsResponse
}

export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

export function absoluteUrl(platformUrl: string, url: string): string {
  if (/^https?:\/\//i.test(url)) return url
  const path = url.startsWith('/') ? url : `/${url}`
  return `${normalizeBaseUrl(platformUrl)}${path}`
}

function ticketUrl(platformUrl: string, number: string): string {
  return `${normalizeBaseUrl(platformUrl)}/t/${number}`
}

export function inboxReason(code: string): InboxReasonCode {
  return (INBOX_REASON_CODES as readonly string[]).includes(code)
    ? (code as InboxReasonCode)
    : 'pending_triage'
}

export function buildOverview(input: OverviewInput): Overview {
  const byReason =
    input.inbox === null
      ? null
      : (Object.fromEntries(
          INBOX_REASON_CODES.map((code) => [code, 0])
        ) as Record<InboxReasonCode, number>)

  if (byReason !== null && input.inbox !== null) {
    for (const item of input.inbox.items) {
      byReason[inboxReason(item.reason_code)] += 1
    }
  }

  return {
    inbox:
      input.inbox === null || byReason === null
        ? null
        : {
            by_reason: byReason,
            items: input.inbox.items.map((item) => ({
              number: item.number,
              title: item.title,
              url: ticketUrl(input.platformUrl, item.number),
              reason: item.reason,
              reason_code: inboxReason(item.reason_code),
              trigger: item.trigger,
              last_reply_at: item.last_reply_at,
              created_at: item.created_at
            }))
          },
    collaborating:
      input.collaborating === null
        ? null
        : {
            total: input.collaborating.total,
            unread: input.collaborating.items.filter((item) => item.unread)
              .length
          },
    waiting: input.waiting === null ? null : { total: input.waiting.count },
    unread_notifications: input.unreadNotifications.unread_count
  }
}

export function buildNotifications(
  platformUrl: string,
  response: RawNotificationsResponse,
  limit = 50
): TaskboardNotification[] {
  return response.items.slice(0, limit).map((item) => ({
    ...item,
    url: absoluteUrl(platformUrl, item.url)
  }))
}
