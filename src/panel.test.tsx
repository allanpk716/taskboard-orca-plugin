import { assert, mockHost, mount, test } from 'orca/testing'
import { createMockSnapshot } from './mock'
import * as panel from './panel'
import type { TaskboardSnapshot } from './protocol'

async function mountState(state: TaskboardSnapshot['state']) {
  const snapshot = await createMockSnapshot(state)
  const host = mockHost({
    requests: {
      'taskboard.getState': () => snapshot,
      'config.save': ({ platformUrl }) => ({
        ...snapshot,
        state: platformUrl === '' ? 'unconfigured' : 'disconnected',
        platformUrl,
        overview: null,
        notifications: [],
        latestNotificationId: null
      }),
      'connection.connect': () => snapshot,
      'connection.disconnect': () => ({ ...snapshot, state: 'disconnected', overview: null }),
      'notifications.markRead': ({ ids }) => ({
        ...snapshot,
        notifications: snapshot.notifications.map((item) =>
          ids.includes(item.id) ? { ...item, read_at: '2026-01-01T00:00:00Z' } : item
        )
      }),
      'notifications.markAllRead': () => snapshot
    }
  })
  return await mount(panel, { host })
}

test('renders the overview, notifications, and inbox when connected', async () => {
  const current = await mountState('connected')

  assert.ok(current.find({ text: '概览' }))
  assert.ok(current.find({ text: '通知' }))
  assert.ok(current.find({ text: '收件箱' }))
  assert.ok(current.find({ text: /20261120-001 · 财务系统登录页偶发白屏/ }))
  assert.ok(current.find({ text: /20261120-002 · 月度报表导出格式错乱/ }))
  assert.ok(current.find({ label: '工单板菜单' }))
  assert.deepEqual(current.errors, [])
  assert.deepEqual(current.refusals, [])
  await current.unmount()
})

test('opens a notification in the browser and marks only it read after success', async () => {
  const snapshot = await createMockSnapshot('connected')
  const openedUrls: string[] = []
  const marked: number[][] = []
  const host = mockHost({
    requests: {
      'taskboard.getState': () => snapshot,
      'notifications.markRead': ({ ids }) => {
        marked.push(ids)
        return snapshot
      }
    },
    results: {
      'shell.openExternal': (params: { url: string }) => {
        openedUrls.push(params.url)
        return { opened: true }
      }
    }
  })
  const current = await mount(panel, { host })

  await current.press({ testId: 'open-notification-9012' })
  assert.deepEqual(openedUrls, ['https://taskboard.example.com/t/20261120-001'])
  assert.deepEqual(marked, [[9012]])
  assert.deepEqual(current.refusals, [])
  await current.unmount()
})

test('opens an inbox ticket without changing notification read state', async () => {
  const snapshot = await createMockSnapshot('connected')
  const openedUrls: string[] = []
  let markReadCalls = 0
  const host = mockHost({
    requests: {
      'taskboard.getState': () => snapshot,
      'notifications.markRead': () => {
        markReadCalls += 1
        return snapshot
      }
    },
    results: {
      'shell.openExternal': (params: { url: string }) => {
        openedUrls.push(params.url)
        return { opened: true }
      }
    }
  })
  const current = await mount(panel, { host })

  await current.press({ testId: 'open-inbox-20261120-002' })
  assert.deepEqual(openedUrls, ['https://taskboard.example.com/t/20261120-002'])
  assert.equal(markReadCalls, 0)
  assert.deepEqual(current.refusals, [])
  await current.unmount()
})

test('renders the unconfigured address form', async () => {
  const current = await mountState('unconfigured')
  assert.ok(current.find({ label: '平台地址' }))
  assert.ok(current.find({ text: '保存' }))

  await current.type({ label: '平台地址' }, 'https://taskboard.example.com')
  await current.press({ text: '保存' })
  assert.ok(current.find({ text: '连接账号' }))
  assert.deepEqual(current.errors, [])
  assert.deepEqual(current.refusals, [])
  await current.unmount()
})

test('renders disconnected and expired connection states', async () => {
  const disconnected = await mountState('disconnected')
  assert.ok(disconnected.find({ text: '连接账号' }))
  assert.ok(disconnected.find({ text: '尚未连接' }))
  assert.deepEqual(disconnected.errors, [])
  await disconnected.unmount()

  const expired = await mountState('expired')
  assert.ok(expired.find({ text: '连接已失效，请重新连接' }))
  assert.ok(expired.find({ text: '连接账号' }))
  assert.deepEqual(expired.errors, [])
  assert.deepEqual(expired.refusals, [])
  await expired.unmount()
})
