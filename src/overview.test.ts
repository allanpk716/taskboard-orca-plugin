import { assert, test } from 'orca/testing'
import {
  buildNotifications,
  buildOverview,
  groupInboxByCounterpart,
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
  lastReplyAt: string | null,
  counterpart: RawInboxItem['counterpart'] = {
    type: 'member',
    name: '王工'
  }
): RawInboxItem => ({
  number,
  title: `工单 ${number}`,
  role: 'assignee',
  reason: '测试原因',
  reason_code: reasonCode,
  trigger: { type: 'member', name: '王工' },
  counterpart,
  read_new: false,
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
    {
      number: 'T-11',
      url: '/t/T-11',
      title: '协作一',
      unread: true,
      waiting_on: { text: '李工（指派人）' }
    },
    { number: 'T-12', url: '/t/T-12', title: '协作二', unread: false },
    {
      number: 'T-13',
      url: '/t/T-13',
      title: '协作三',
      unread: true,
      waiting_on: { text: '访客' }
    }
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
  assert.equal(overview.inbox.items[0].waited_since, '2026-01-02T03:00:00Z')
  assert.equal(overview.inbox.items[1].waited_since, '2026-01-03T04:00:00Z')
  assert.equal(overview.collaborating.total, 5)
  assert.equal(overview.collaborating.unread, 2)
  assert.deepEqual(
    overview.collaborating.items.map((item) => [
      item.number,
      item.url,
      item.waiting_on_text
    ]),
    [
      ['T-11', 'https://taskboard.example.com/t/T-11', '李工（指派人）'],
      ['T-12', 'https://taskboard.example.com/t/T-12', null],
      ['T-13', 'https://taskboard.example.com/t/T-13', '访客']
    ]
  )
  assert.equal(overview.waiting.total, 4)
  assert.deepEqual(overview.waiting.by_counterpart, { 'member:王工': 1 })
  assert.equal(overview.unread_notifications, 3)
})

test('groups inbox items by counterpart with waiting counts and oldest first', () => {
  const overview = buildOverview({
    platformUrl: 'https://taskboard.example.com',
    inbox: {
      member: '陈工',
      count: 4,
      items: [
        inboxItem('T-2', 'delivered', '2026-01-05T04:00:00Z'),
        inboxItem('T-1', 'new', null, { type: 'member', name: '李工' }),
        inboxItem('T-4', 'guest_replied', '2026-01-03T04:00:00Z', {
          type: 'guest',
          name: '检验科-张三'
        }),
        inboxItem('T-3', 'guest_completed', '2026-01-04T04:00:00Z', {
          type: 'guest',
          name: '检验科-张三'
        })
      ]
    },
    waiting: {
      member: '陈工',
      count: 2,
      items: [
        inboxItem('T-8', 'creator_replied', null, {
          type: 'guest',
          name: '检验科-张三'
        }),
        inboxItem('T-7', 'creator_replied', null, {
          type: 'member',
          name: '王工'
        })
      ]
    },
    collaborating: null,
    unreadNotifications: { unread_count: 0, latest_id: 0, client_online: true }
  })

  assert.ok(overview.inbox)
  const groups = groupInboxByCounterpart(
    overview.inbox.items,
    overview.waiting?.by_counterpart ?? {}
  )

  assert.deepEqual(
    groups.map((group) => [group.label, group.items.map((item) => item.number), group.waitingCount]),
    [
      ['王工', ['T-2'], 1],
      ['李工', ['T-1'], 0],
      ['访客 · 检验科-张三', ['T-4', 'T-3'], 1]
    ]
  )
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
