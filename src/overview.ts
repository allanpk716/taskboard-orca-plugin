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

/** 平台术语「往来对象」：一张工单在当前成员看来的另一方。 */
export interface Counterpart {
  type: 'member' | 'guest' | 'self' | 'pending_triage' | (string & {})
  name: string | null
}

export interface RawInboxItem {
  number: string
  title: string
  role: 'assignee' | 'creator' | 'triager' | (string & {})
  reason: string
  reason_code: InboxReasonCode | (string & {})
  trigger: InboxActor
  counterpart: Counterpart
  read_new: boolean
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
  waiting_on?: { text?: string } | null
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
  counterpart: Counterpart
  read_new: boolean
  waited_since: string
  last_reply_at: string | null
  created_at: string
}

export interface OverviewCollaboratingItem {
  number: string
  title: string
  url: string
  unread: boolean
  waiting_on_text: string | null
}

export interface Overview {
  inbox: {
    by_reason: Record<InboxReasonCode, number>
    items: OverviewInboxItem[]
  } | null
  collaborating: {
    total: number
    unread: number
    items: OverviewCollaboratingItem[]
  } | null
  /** key 见 counterpartKey，组名见 counterpartLabel。 */
  waiting: {
    total: number
    by_counterpart: Record<string, number>
  } | null
  unread_notifications: number
}

/** 收件箱里「访客动了、轮到我」的原因码。 */
export const GUEST_TURN_REASON_CODES: readonly InboxReasonCode[] = [
  'guest_replied',
  'guest_completed',
  'guest_revised',
  'guest_not_completed'
]

export function counterpartKey(counterpart: Counterpart): string {
  return `${counterpart.type}:${counterpart.name ?? ''}`
}

export function counterpartLabel(counterpart: Counterpart): string {
  if (counterpart.type === 'guest') {
    return `访客 · ${counterpart.name ?? '未署名'}`
  }
  if (counterpart.type === 'self') return '我自己'
  if (counterpart.type === 'pending_triage') return '待初筛'
  return counterpart.name ?? '其他成员'
}

export interface InboxCounterpartGroup {
  key: string
  label: string
  items: OverviewInboxItem[]
  /** 该往来对象名下轮到对方的工单数，仅参考，不计入收件箱。 */
  waitingCount: number
}

export function groupInboxByCounterpart(
  items: readonly OverviewInboxItem[],
  waitingByCounterpart: Record<string, number> = {}
): InboxCounterpartGroup[] {
  const groups = new Map<string, OverviewInboxItem[]>()
  for (const item of items) {
    const key = counterpartKey(item.counterpart)
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [item])
    else bucket.push(item)
  }
  return [...groups.entries()].map(([key, groupItems]) => ({
    key,
    label: counterpartLabel(groupItems[0].counterpart),
    items: [...groupItems].sort(
      (a, b) => Date.parse(a.waited_since) - Date.parse(b.waited_since)
    ),
    waitingCount: waitingByCounterpart[key] ?? 0
  }))
}

export function waitingCountsByCounterpart(
  items: readonly RawInboxItem[]
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) {
    const key = counterpartKey(item.counterpart)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
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
              counterpart: item.counterpart,
              read_new: item.read_new,
              waited_since: item.last_reply_at ?? item.created_at,
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
              .length,
            items: input.collaborating.items.map((item) => ({
              number: item.number,
              title: item.title,
              url: absoluteUrl(input.platformUrl, item.url),
              unread: item.unread,
              waiting_on_text: item.waiting_on?.text ?? null
            }))
          },
    waiting:
      input.waiting === null
        ? null
        : {
            total: input.waiting.count,
            by_counterpart: waitingCountsByCounterpart(input.waiting.items)
          },
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
