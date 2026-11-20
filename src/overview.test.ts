import { assert, test } from 'orca/testing'
import {
  buildNotifications,
  buildOverview,
  type RawInboxItem,
  type RawInboxResponse,
  type RawNotificationItem,
  type RawNotificationsResponse,
  type RawTicketListResponse,
  type RawUnreadNotificationsResponse
} from './overview'

const inboxItem = (
  number: string,
  reasonCode: RawInboxItem['reason_code'],
  lastReplyAt: string | null
): RawInboxItem => ({
  number,
  title: `工单 ${number}`,
  role: 'assignee',
  reason: '测试原因',
  reason_code: reasonCode,
  trigger: { type: 'member', name: '王工' },
  last_reply_at: lastReplyAt,
  created_at: '2026-01-02T03:00:00Z'
})

const inbox: RawInboxResponse = {
  member: '陈工',
  count: 3,
  items: [
    inboxItem('T-1', 'new', null),
    inboxItem('T-2', 'delivered', '2026-01-03T04:00:00Z'),
    inboxItem('T-3', 'delivered', '2026-01-04T05:00:00Z')
  ]
}

const waiting: RawInboxResponse = {
  member: '陈工',
  count: 4,
  items: [inboxItem('T-9', 'creator_replied', null)]
}

const collaborating: RawTicketListResponse = {
  total: 5,
  count: 3,
  items: [
    { number: 'T-11', url: '/t/T-11', title: '协作一', unread: true },
    { number: 'T-12', url: '/t/T-12', title: '协作二', unread: false },
    { number: 'T-13', url: '/t/T-13', title: '协作三', unread: true }
  ],
  next: null,
  cursor: 0,
  filters: {}
}

const unread: RawUnreadNotificationsResponse = {
  unread_count: 3,
  latest_id: 99,
  client_online: true
}

test('builds the overview from the four aggregate API responses', () => {
  const overview = buildOverview({
    platformUrl: 'https://taskboard.example.com/',
    inbox,
    waiting,
    collaborating,
    unreadNotifications: unread
  })

  assert.ok(overview.inbox)
  assert.ok(overview.collaborating)
  assert.ok(overview.waiting)
  assert.equal(overview.inbox.by_reason.new, 1)
  assert.equal(overview.inbox.by_reason.delivered, 2)
  assert.equal(overview.inbox.by_reason.assignee_replied, 0)
  assert.deepEqual(overview.inbox.items.map((item) => item.number), [
    'T-1',
    'T-2',
    'T-3'
  ])
  assert.equal(overview.inbox.items[0].url, 'https://taskboard.example.com/t/T-1')
  assert.equal(overview.inbox.items[0].last_reply_at, null)
  assert.equal(overview.collaborating.total, 5)
  assert.equal(overview.collaborating.unread, 2)
  assert.equal(overview.waiting.total, 4)
  assert.equal(overview.unread_notifications, 3)
})

test('keeps overview parts unavailable when the client scope gets 403', () => {
  const overview = buildOverview({
    platformUrl: 'https://taskboard.example.com',
    inbox: null,
    waiting: null,
    collaborating: null,
    unreadNotifications: unread
  })

  assert.equal(overview.inbox, null)
  assert.equal(overview.collaborating, null)
  assert.equal(overview.waiting, null)
  assert.equal(overview.unread_notifications, 3)
})

test('keeps the latest fifty notifications and makes their URLs absolute', () => {
  const items: RawNotificationItem[] = Array.from({ length: 52 }, (_, index) => {
    const id = 52 - index
    return {
      id,
      ticket: { number: `T-${id}`, title: `通知 ${id}`, url: `/t/T-${id}` },
      url: `/t/T-${id}`,
      kind: 'turn',
      reason: 'assigned',
      text: `通知 ${id}`,
      summary: `通知 ${id}`,
      created_at: '2026-01-05T06:00:00Z',
      read_at: null
    }
  })
  const response: RawNotificationsResponse = {
    items,
    cursor: 1,
    unread_count: 52,
    next: null
  }

  const notifications = buildNotifications(
    'https://taskboard.example.com/',
    response
  )

  assert.equal(notifications.length, 50)
  assert.equal(notifications[0].id, 52)
  assert.equal(notifications[0].url, 'https://taskboard.example.com/t/T-52')
  assert.equal(notifications.at(-1)?.id, 3)
})
