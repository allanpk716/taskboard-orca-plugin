import {
  buildNotifications,
  buildOverview,
  type Counterpart,
  type RawInboxItem,
  type RawInboxResponse,
  type RawNotificationItem,
  type RawNotificationsResponse,
  type RawTicketItem,
  type RawTicketListResponse,
  type RawUnreadNotificationsResponse,
  type TaskboardNotification
} from './overview'
import type { TaskboardDataSource } from './source'
import type { ConnectionState, TaskboardSnapshot } from './protocol'

export const MOCK_PLATFORM_URL = 'https://taskboard.example.com'

function minutesAgo(now: number, minutes: number): string {
  return new Date(now - minutes * 60_000).toISOString()
}

const memberCounterpart = (name: string): Counterpart => ({
  type: 'member',
  name
})
const guestCounterpart = (name: string): Counterpart => ({ type: 'guest', name })

const COUNTERPART_SELF: Counterpart = { type: 'self', name: '陈工' }
const COUNTERPART_PENDING_TRIAGE: Counterpart = {
  type: 'pending_triage',
  name: null
}

function inboxItem(
  number: string,
  title: string,
  reason: string,
  reasonCode: RawInboxItem['reason_code'],
  triggerName: string,
  counterpart: Counterpart,
  lastReplyMinutes: number | null,
  createdMinutes: number,
  now: number,
  readNew = false
): RawInboxItem {
  return {
    number,
    title,
    role: 'assignee',
    reason,
    reason_code: reasonCode,
    trigger: { type: 'member', name: triggerName },
    counterpart,
    read_new: readNew,
    last_reply_at:
      lastReplyMinutes === null ? null : minutesAgo(now, lastReplyMinutes),
    created_at: minutesAgo(now, createdMinutes)
  }
}

function ticketItem(
  number: string,
  title: string,
  unread: boolean,
  waitingOnText: string
): RawTicketItem {
  return {
    number,
    url: `/t/${number}`,
    title,
    unread,
    waiting_on: { text: waitingOnText }
  }
}

function notificationItem(
  id: number,
  number: string | null,
  title: string,
  reason: string,
  text: string,
  createdMinutes: number,
  read: boolean,
  now: number
): RawNotificationItem {
  const url = number === null ? '/admin#backups' : `/t/${number}`
  return {
    id,
    ticket: number === null ? null : { number, title, url },
    url,
    kind: number === null ? 'fyi' : 'turn',
    reason,
    text,
    summary: text,
    created_at: minutesAgo(now, createdMinutes),
    read_at: read ? minutesAgo(now, createdMinutes - 1) : null
  }
}

export function createMockDataSource(now = Date.now()): TaskboardDataSource {
  const inboxItems: RawInboxItem[] = [
    inboxItem(
      '20261120-001',
      '财务系统登录页偶发白屏',
      '新指派给你',
      'new',
      '李经理',
      memberCounterpart('李经理'),
      null,
      36,
      now,
      true
    ),
    inboxItem(
      'T-106',
      '机房巡检异常项整改',
      '新指派给你',
      'new',
      '李经理',
      memberCounterpart('李经理'),
      2_880,
      2_940,
      now
    ),
    inboxItem(
      '20261120-005',
      '移动端审批列表无法滚动',
      '新指派给你',
      'new',
      '周经理',
      memberCounterpart('周经理'),
      320,
      610,
      now
    ),
    inboxItem(
      '20261120-002',
      '月度报表导出格式错乱',
      '已交付，待你验收',
      'delivered',
      '王工',
      memberCounterpart('王工'),
      18,
      290,
      now,
      true
    ),
    inboxItem(
      '20261120-004',
      '新同事入职账号初始化',
      '已交付，待你验收',
      'delivered',
      '赵专员',
      memberCounterpart('赵专员'),
      null,
      1_440,
      now
    ),
    inboxItem(
      '20261120-003',
      '客户资料同步失败告警',
      '指派人回复了，待你答复',
      'assignee_replied',
      '陈工',
      memberCounterpart('陈工'),
      95,
      430,
      now
    ),
    inboxItem(
      'T-101',
      '检验设备周期校准反馈',
      '访客回复了',
      'guest_replied',
      '检验科-张三',
      guestCounterpart('检验科-张三'),
      26,
      500,
      now,
      true
    ),
    inboxItem(
      'T-102',
      '检验报告模板字段补全',
      '访客补全了说明',
      'guest_completed',
      '检验科-张三',
      guestCounterpart('检验科-张三'),
      400,
      800,
      now
    ),
    inboxItem(
      'T-103',
      '供应商资质文件更新',
      '访客修订了说明',
      'guest_revised',
      '供应商-周敏',
      guestCounterpart('供应商-周敏'),
      1_500,
      2_100,
      now
    ),
    inboxItem(
      'T-104',
      '内部知识库条目整理',
      '你的 Agent 回复了',
      'agent_replied',
      '陈工的 Agent',
      COUNTERPART_SELF,
      8,
      120,
      now,
      true
    ),
    inboxItem(
      'T-105',
      '新反馈待分流',
      '待初筛',
      'pending_triage',
      '反馈入口',
      COUNTERPART_PENDING_TRIAGE,
      42,
      42,
      now
    )
  ]

  const waitingItems: RawInboxItem[] = [
    inboxItem(
      'T-201',
      '库存预测模型参数复核',
      '发起人回复了',
      'creator_replied',
      '钱分析师',
      memberCounterpart('李经理'),
      55,
      760,
      now
    ),
    inboxItem(
      'T-202',
      '供应商门户证书更新',
      '访客回复了',
      'guest_replied',
      '孙供应商',
      memberCounterpart('周经理'),
      210,
      980,
      now
    ),
    inboxItem(
      'T-203',
      '检验耗材领用登记反馈',
      '访客回复了',
      'guest_replied',
      '检验科-张三',
      guestCounterpart('检验科-张三'),
      120,
      390,
      now
    )
  ]

  const collaboratingItems: RawTicketItem[] = [
    ticketItem('T-301', '客服工作台搜索优化', true, '李工（指派人）'),
    ticketItem('T-303', '数据看板权限说明补全', true, '访客'),
    ticketItem('T-302', '审批流性能压测报告', false, '王工（发起人）'),
    ticketItem('T-304', '值班表同步脚本改造', false, '李工（指派人）')
  ]

  const notificationItems: RawNotificationItem[] = [
    notificationItem(
      9012,
      '20261120-001',
      '财务系统登录页偶发白屏',
      'assigned',
      '李经理指派给你',
      12,
      false,
      now
    ),
    notificationItem(
      9011,
      '20261120-002',
      '月度报表导出格式错乱',
      'delivered',
      '王工交付，等待验收',
      45,
      false,
      now
    ),
    notificationItem(
      9010,
      null,
      '备份任务连续失败',
      'backup_failing',
      '昨晚的数据库备份失败，请检查管理后台备份区。',
      90,
      false,
      now
    ),
    notificationItem(
      9009,
      '20261120-003',
      '客户资料同步失败告警',
      'assignee_replied',
      '陈工回复：同步脚本已在测试环境重跑。',
      140,
      true,
      now
    ),
    notificationItem(
      9008,
      '20261120-005',
      '移动端审批列表无法滚动',
      'returned',
      '周经理退回修改：请兼容旧版浏览器。',
      260,
      true,
      now
    ),
    notificationItem(
      9007,
      'T-301',
      '客服工作台搜索优化',
      'collaborator_replied',
      '吴工回复：搜索索引重建方案已更新。',
      380,
      true,
      now
    ),
    notificationItem(
      9006,
      'T-302',
      '审批流性能压测报告',
      'collaborator_added',
      '郑工把你加入协作。',
      520,
      true,
      now
    )
  ]

  const notifications = (): RawNotificationsResponse => ({
    items: [...notificationItems],
    cursor: 9006,
    unread_count: notificationItems.filter((item) => item.read_at === null).length,
    next: null
  })

  const unread = (): RawUnreadNotificationsResponse => ({
    unread_count: notificationItems.filter((item) => item.read_at === null).length,
    latest_id: Math.max(...notificationItems.map((item) => item.id)),
    client_online: true
  })

  return {
    async inbox(): Promise<RawInboxResponse> {
      return { member: '陈工', count: inboxItems.length, items: [...inboxItems] }
    },
    async waitingOnCounterparts(): Promise<RawInboxResponse> {
      return { member: '陈工', count: waitingItems.length, items: [...waitingItems] }
    },
    async collaboratingTickets(): Promise<RawTicketListResponse> {
      return {
        total: collaboratingItems.length,
        count: collaboratingItems.length,
        items: [...collaboratingItems],
        next: null,
        cursor: 0,
        filters: { status: 'open', collaborator: 'me', sort: '-updated' }
      }
    },
    async notifications(): Promise<RawNotificationsResponse> {
      return notifications()
    },
    async unreadNotifications(): Promise<RawUnreadNotificationsResponse> {
      return unread()
    },
    async markNotificationsRead(ids: readonly number[]): Promise<void> {
      const idSet = new Set(ids)
      for (const item of notificationItems) {
        if (idSet.has(item.id) && item.read_at === null) {
          item.read_at = new Date().toISOString()
        }
      }
    },
    async markAllNotificationsRead(_upTo: number): Promise<void> {
      const readAt = new Date().toISOString()
      for (const item of notificationItems) item.read_at = readAt
    }
  }
}

export async function createMockSnapshot(
  state: ConnectionState = 'connected',
  now = Date.now()
): Promise<TaskboardSnapshot> {
  if (state !== 'connected') {
    return {
      state,
      platformUrl: state === 'unconfigured' ? '' : MOCK_PLATFORM_URL,
      overview: null,
      notifications: [],
      latestNotificationId: null,
      unreadNotificationCount: null,
      secretsAvailable: true,
      addressError: null,
      connection: { phase: 'idle', message: null },
      refreshError: null
    }
  }

  const source = createMockDataSource(now)
  const [inbox, waiting, collaborating, unread, notificationList] =
    await Promise.all([
      source.inbox(),
      source.waitingOnCounterparts(),
      source.collaboratingTickets(),
      source.unreadNotifications(),
      source.notifications()
    ])
  return {
    state,
    platformUrl: MOCK_PLATFORM_URL,
    overview: buildOverview({
      platformUrl: MOCK_PLATFORM_URL,
      inbox,
      waiting,
      collaborating,
      unreadNotifications: unread
    }),
    notifications: buildNotifications(MOCK_PLATFORM_URL, notificationList),
    latestNotificationId: unread.latest_id,
    unreadNotificationCount: unread.unread_count,
    secretsAvailable: true,
    addressError: null,
    connection: { phase: 'idle', message: null },
    refreshError: null
  }
}
