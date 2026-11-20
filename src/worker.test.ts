import { assert, mountWorker, test } from 'orca/testing'
import * as main from './worker'

test('starts connected and updates the status bar through every state', async () => {
  const worker = await mountWorker(main)
  const connected = await worker.request('taskboard.getState')

  assert.equal(connected.state, 'connected')
  assert.equal(connected.overview?.unread_notifications, 3)
  assert.equal(connected.overview?.collaborating.total, 3)
  assert.equal(connected.overview?.collaborating.unread, 2)
  assert.equal(connected.overview?.waiting.total, 2)
  assert.equal(connected.notifications.length, 7)
  assert.deepEqual(worker.host.callsOf('statusBar.update').at(-1), {
    id: 'unread',
    icon: 'bell',
    text: '3',
    tone: 'accent',
    tooltip: '工单板：3 条未读通知'
  })

  const disconnected = await worker.request('debug.setState', {
    state: 'disconnected'
  })
  assert.equal(disconnected.state, 'disconnected')
  assert.equal(disconnected.overview, null)
  assert.deepEqual(worker.host.callsOf('statusBar.update').at(-1), {
    id: 'unread',
    icon: 'plug',
    text: '工单板 未连接',
    tone: 'neutral'
  })

  const expired = await worker.request('debug.setState', { state: 'expired' })
  assert.equal(expired.state, 'expired')
  assert.equal(worker.posts.at(-1)?.event, 'taskboard.changed')
  assert.equal(
    (worker.posts.at(-1)?.payload as { snapshot: { state: string } }).snapshot
      .state,
    'expired'
  )

  const restored = await worker.request('debug.setState', { state: 'connected' })
  assert.equal(restored.state, 'connected')
  assert.equal(restored.overview?.unread_notifications, 3)
  assert.deepEqual(worker.host.callsOf('statusBar.update').at(-1), {
    id: 'unread',
    icon: 'bell',
    text: '3',
    tone: 'accent',
    tooltip: '工单板：3 条未读通知'
  })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('marks one notification and then all notifications read', async () => {
  const worker = await mountWorker(main)
  const before = await worker.request('taskboard.getState')
  const unreadId = before.notifications.find(
    (item) => item.read_at === null
  )?.id
  assert.equal(unreadId, 9012)

  const afterOne = await worker.request('notifications.markRead', {
    ids: [9012]
  })
  assert.equal(afterOne.overview?.unread_notifications, 2)
  assert.notEqual(
    afterOne.notifications.find((item) => item.id === 9012)?.read_at,
    null
  )
  assert.deepEqual(worker.host.callsOf('statusBar.update').at(-1), {
    id: 'unread',
    icon: 'bell',
    text: '2',
    tone: 'accent',
    tooltip: '工单板：2 条未读通知'
  })

  const afterAll = await worker.request('notifications.markAllRead', {
    up_to: afterOne.latestNotificationId ?? 9012
  })
  assert.equal(afterAll.overview?.unread_notifications, 0)
  assert.ok(afterAll.notifications.every((item) => item.read_at !== null))
  assert.deepEqual(worker.host.callsOf('statusBar.update').at(-1), {
    id: 'unread',
    icon: 'bell',
    text: '0',
    tone: 'neutral',
    tooltip: '工单板：0 条未读通知'
  })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('saves a mock platform address without health checking, then connects', async () => {
  const worker = await mountWorker(main)
  const saved = await worker.request('config.save', {
    platformUrl: 'https://taskboard.example.com/'
  })

  assert.equal(saved.state, 'disconnected')
  assert.equal(saved.platformUrl, 'https://taskboard.example.com')
  assert.equal(worker.host.data().storage['taskboard.platformUrl'], 'https://taskboard.example.com')
  assert.equal(worker.host.data().storage['taskboard.connectionState'], 'disconnected')

  const connected = await worker.request('connection.connect')
  assert.equal(connected.state, 'connected')
  assert.equal(connected.platformUrl, 'https://taskboard.example.com')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
