import type { OrcaWorkerApi } from 'orca/worker'
import { MOCK_PLATFORM_URL, createMockDataSource } from './mock'
import {
  buildNotifications,
  buildOverview,
  type Overview,
  type TaskboardNotification
} from './overview'
import './protocol'
import type { ConnectionState, TaskboardSnapshot } from './protocol'
import type { TaskboardDataSource } from './source'

const STATE_KEY = 'taskboard.connectionState'
const PLATFORM_URL_KEY = 'taskboard.platformUrl'
const STATUS_BAR_ITEM_ID = 'unread'

function isConnectionState(value: unknown): value is ConnectionState {
  return (
    value === 'unconfigured' ||
    value === 'disconnected' ||
    value === 'expired' ||
    value === 'connected'
  )
}

function normalizePlatformUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (trimmed === '') return ''
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

function emptySnapshot(
  state: ConnectionState,
  platformUrl: string
): TaskboardSnapshot {
  return {
    state,
    platformUrl,
    overview: null,
    notifications: [],
    latestNotificationId: null
  }
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const storedState = await orca.storage.get(STATE_KEY)
  const storedUrl = await orca.storage.get(PLATFORM_URL_KEY)

  let state: ConnectionState = isConnectionState(storedState)
    ? storedState
    : 'connected'
  let platformUrl =
    state === 'unconfigured'
      ? ''
      : normalizePlatformUrl(
          typeof storedUrl === 'string' ? storedUrl : MOCK_PLATFORM_URL
        )

  // Replace this one constructor with the HTTP implementation in the next task.
  // The rest of this worker consumes the API response shapes unchanged.
  const source: TaskboardDataSource = createMockDataSource()
  let snapshot = emptySnapshot(state, platformUrl)

  async function persist(): Promise<void> {
    await orca.storage.set(STATE_KEY, state)
    await orca.storage.set(PLATFORM_URL_KEY, platformUrl)
  }

  async function updateStatus(): Promise<void> {
    if (state === 'connected' && snapshot.overview) {
      const unread = snapshot.overview.unread_notifications
      await orca.host.call('statusBar.update', {
        id: STATUS_BAR_ITEM_ID,
        icon: 'bell',
        text: String(unread),
        tone: unread > 0 ? 'accent' : 'neutral',
        tooltip: `工单板：${unread} 条未读通知`
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

  async function refresh(): Promise<TaskboardSnapshot> {
    if (state !== 'connected') {
      snapshot = emptySnapshot(state, platformUrl)
      return snapshot
    }

    const [inbox, waiting, collaborating, unread, notificationList] =
      await Promise.all([
        source.inbox(),
        source.waitingOnCounterparts(),
        source.collaboratingTickets(),
        source.unreadNotifications(),
        source.notifications()
      ])

    const overview: Overview = buildOverview({
      platformUrl,
      inbox,
      waiting,
      collaborating,
      unreadNotifications: unread
    })
    const notifications: TaskboardNotification[] = buildNotifications(
      platformUrl,
      notificationList
    )
    snapshot = {
      state,
      platformUrl,
      overview,
      notifications,
      latestNotificationId: unread.latest_id
    }
    return snapshot
  }

  async function publish(next: TaskboardSnapshot): Promise<TaskboardSnapshot> {
    snapshot = next
    orca.panels.post('taskboard.changed', { snapshot })
    await updateStatus()
    return snapshot
  }

  async function enter(nextState: ConnectionState): Promise<TaskboardSnapshot> {
    state = nextState
    if (state === 'unconfigured') platformUrl = ''
    if (state !== 'unconfigured' && platformUrl === '') {
      platformUrl = MOCK_PLATFORM_URL
    }
    await persist()
    return publish(
      state === 'connected' ? await refresh() : emptySnapshot(state, platformUrl)
    )
  }

  await refresh()
  await updateStatus()

  orca.panels.handle('taskboard.getState', async () =>
    publish(await refresh())
  )

  orca.panels.handle('config.save', async ({ platformUrl: nextUrl }) => {
    platformUrl = normalizePlatformUrl(nextUrl)
    state = platformUrl === '' ? 'unconfigured' : 'disconnected'
    await persist()
    return publish(emptySnapshot(state, platformUrl))
  })

  orca.panels.handle('connection.connect', async () => enter('connected'))
  orca.panels.handle('connection.disconnect', async () => enter('disconnected'))
  orca.panels.handle('debug.setState', async ({ state: nextState }) =>
    enter(nextState)
  )

  orca.panels.handle('notifications.markRead', async ({ ids }) => {
    await source.markNotificationsRead(ids)
    return publish(await refresh())
  })

  orca.panels.handle('notifications.markAllRead', async ({ up_to }) => {
    await source.markAllNotificationsRead(up_to)
    return publish(await refresh())
  })
}
