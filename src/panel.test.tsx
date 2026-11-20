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
        latestNotificationId: null,
        unreadNotificationCount: null,
        addressError: null,
        refreshError: null
      }),
      'connection.begin': () => ({
        authorizationUrl: 'https://taskboard.example.com/client/connect?port=1',
        snapshot: { ...snapshot, connection: { phase: 'waiting', message: '等待浏览器确认…' } }
      }),
      'connection.cancel': () => ({
        ...snapshot,
        connection: { phase: 'cancelled', message: '已取消连接' }
      }),
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

test('renders the filters, counterpart groups, and collapsed notifications when connected', async () => {
  const current = await mountState('connected')

  assert.ok(current.find({ text: /等我处理/ }))
  assert.ok(current.find({ text: /访客新回复/ }))
  assert.ok(current.find({ text: /协作中/ }))
  assert.ok(current.find({ text: '已连接' }))
  assert.ok(current.find({ text: /20261120-001 · 财务系统登录页偶发白屏/ }))
  assert.ok(current.find({ text: /20261120-002 · 月度报表导出格式错乱/ }))
  assert.ok(current.find({ text: /王工 ×1/ }))
  assert.ok(current.find({ text: /另等他 1/ }))
  assert.ok(current.find({ text: /3 条通知未读/ }))
  assert.ok(current.find({ label: '展开通知列表' }))
  assert.ok(current.find({ label: '工单板菜单' }))
  assert.deepEqual(current.errors, [])
  assert.deepEqual(current.refusals, [])
  await current.unmount()
})

test('switches to the guest and collaborating filters', async () => {
  const current = await mountState('connected')

  await current.press({ text: /访客新回复/ })
  assert.ok(current.find({ text: /访客 · 检验科-张三 ×2/ }))
  assert.ok(current.find({ text: /T-101 · 检验设备周期校准反馈/ }))
  assert.ok(!current.find({ text: /20261120-001 · 财务系统登录页偶发白屏/ }))

  await current.press({ text: /协作中/ })
  assert.ok(current.find({ text: /轮到 李工（指派人） ×2/ }))
  assert.ok(current.find({ text: /客服工作台搜索优化/ }))
  assert.deepEqual(current.errors, [])
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

  await current.press({ label: '展开通知列表' })
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
  assert.ok(disconnected.find({ text: '将在浏览器里确认这台电脑。' }))
  assert.deepEqual(disconnected.errors, [])
  await disconnected.unmount()

  const expired = await mountState('expired')
  assert.ok(expired.find({ text: '连接已失效，请重新连接' }))
  assert.ok(expired.find({ text: '重新连接' }))
  assert.deepEqual(expired.errors, [])
  assert.deepEqual(expired.refusals, [])
  await expired.unmount()
})

test('opens the browser confirmation from the same connect click', async () => {
  const snapshot = await createMockSnapshot('disconnected')
  const openedUrls: string[] = []
  const host = mockHost({
    requests: {
      'taskboard.getState': () => snapshot,
      'connection.begin': () => ({
        authorizationUrl: 'https://taskboard.example.com/client/connect?port=49161',
        snapshot: {
          ...snapshot,
          connection: { phase: 'waiting', message: '等待浏览器确认…' }
        }
      }),
      'connection.cancel': () => ({
        ...snapshot,
        connection: { phase: 'cancelled', message: '已取消连接' }
      })
    },
    results: {
      'shell.openExternal': (params: { url: string }) => {
        openedUrls.push(params.url)
        return { opened: true }
      }
    }
  })
  const current = await mount(panel, { host })

  await current.press({ role: 'button', text: '连接账号' })
  assert.deepEqual(openedUrls, [
    'https://taskboard.example.com/client/connect?port=49161'
  ])
  assert.ok(current.find({ text: '等待浏览器确认…' }))
  assert.ok(current.find({ text: '取消' }))
  assert.deepEqual(current.refusals, [])
  await current.unmount()
})

test('cancels the browser flow when openExternal does not open', async () => {
  const snapshot = await createMockSnapshot('disconnected')
  const host = mockHost({
    requests: {
      'taskboard.getState': () => snapshot,
      'connection.begin': () => ({
        authorizationUrl: 'https://taskboard.example.com/client/connect?port=49161',
        snapshot: {
          ...snapshot,
          connection: { phase: 'waiting', message: '等待浏览器确认…' }
        }
      }),
      'connection.cancel': () => ({
        ...snapshot,
        connection: { phase: 'cancelled', message: '已取消连接' }
      })
    },
    results: {
      'shell.openExternal': () => ({ opened: false, reason: 'cancelled' })
    }
  })
  const current = await mount(panel, { host })
  await current.press({ role: 'button', text: '连接账号' })
  assert.ok(current.find({ text: '已取消连接' }))
  assert.deepEqual(current.refusals, [])
  await current.unmount()
})

test('renders address, connection, keychain, refresh, and overview-unavailable states', async () => {
  const addressError = await createMockSnapshot('unconfigured')
  addressError.addressError = '不是工单板平台：健康检查返回的不是 JSON'
  const addressHost = mockHost({
    requests: { 'taskboard.getState': () => addressError }
  })
  const addressPanel = await mount(panel, { host: addressHost })
  assert.ok(addressPanel.find({ text: /健康检查返回的不是 JSON/ }))
  assert.deepEqual(addressPanel.errors, [])
  await addressPanel.unmount()

  const failed = await createMockSnapshot('disconnected')
  failed.connection = {
    phase: 'failed',
    message: '连接失败：回调端口不可用'
  }
  const failedHost = mockHost({
    requests: { 'taskboard.getState': () => failed }
  })
  const failedPanel = await mount(panel, { host: failedHost })
  assert.ok(failedPanel.find({ text: '连接失败：回调端口不可用' }))
  await failedPanel.unmount()

  const noKeychain = await createMockSnapshot('disconnected')
  noKeychain.secretsAvailable = false
  const noKeychainHost = mockHost({
    requests: { 'taskboard.getState': () => noKeychain }
  })
  const noKeychainPanel = await mount(panel, { host: noKeychainHost })
  assert.ok(noKeychainPanel.find({ text: '这台电脑没有可用的密钥存储，无法保存凭证' }))
  assert.deepEqual(noKeychainPanel.refusals, [])
  await noKeychainPanel.unmount()

  const connected = await createMockSnapshot('connected')
  assert.ok(connected.overview)
  connected.overview = {
    ...connected.overview,
    inbox: null,
    collaborating: null,
    waiting: null
  }
  connected.refreshError = '刷新失败：连接超时'
  const connectedHost = mockHost({
    requests: { 'taskboard.getState': () => connected }
  })
  const connectedPanel = await mount(panel, { host: connectedHost })
  assert.ok(connectedPanel.find({ text: /刷新失败：连接超时/ }))
  assert.ok(
    connectedPanel.findAll({ text: /概览接口尚未开放（等平台升级）/ }).length >= 1
  )
  assert.deepEqual(connectedPanel.errors, [])
  await connectedPanel.unmount()
})

test('shows the address-change and disconnect menu actions', async () => {
  const snapshot = await createMockSnapshot('connected')
  const host = mockHost({
    requests: {
      'taskboard.getState': () => snapshot,
      'connection.disconnect': () => ({
        ...snapshot,
        state: 'disconnected',
        overview: null,
        notifications: []
      })
    }
  })
  const current = await mount(panel, { host })
  await current.press({ label: '工单板菜单' })
  assert.ok(current.find({ text: '更改平台地址' }))
  assert.ok(current.find({ text: '断开连接' }))
  await current.press({ text: '更改平台地址' })
  assert.ok(current.find({ label: '平台地址' }))
  assert.deepEqual(current.errors, [])
  await current.unmount()
})
