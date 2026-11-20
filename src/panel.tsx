import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  Heading,
  IconButton,
  Input,
  KeyValue,
  List,
  ListItem,
  plugin,
  read,
  RelativeTime,
  Row,
  set,
  shell,
  Spinner,
  Stack,
  Text,
  update,
  type PanelContext
} from 'orca'
import {
  INBOX_REASON_LABELS,
  type Overview,
  type OverviewInboxItem,
  type TaskboardNotification
} from './overview'
import './protocol'
import type { TaskboardSnapshot } from './protocol'

const snapshot = atom<TaskboardSnapshot | null>(null)
const addressDraft = atom('')
const addressEditing = atom(false)
const menuOpen = atom(false)

const NOTIFICATION_REASON_LABELS: Record<string, string> = {
  assigned: '新指派',
  delivered: '已交付',
  assignee_replied: '指派人回复',
  returned: '退回修改',
  creator_replied: '发起人回复',
  agent_replied: 'Agent 回复',
  guest_replied: '访客回复',
  guest_completed: '访客补全说明',
  guest_revised: '访客修订说明',
  department: '轮到部门',
  collaborator_added: '加入协作',
  collaborator_removed: '移出协作',
  collaborator_replied: '协作者回复',
  closed: '已关闭',
  reopened: '重新打开',
  backup_failing: '备份失败',
  backup_recovered: '备份恢复'
}

const OVERVIEW_UNAVAILABLE = '概览接口尚未开放（等平台升级）'

function notificationTitle(item: TaskboardNotification): string {
  return item.ticket
    ? `${item.ticket.number} · ${item.ticket.title}`
    : item.text || item.summary
}

function notificationReason(item: TaskboardNotification): string {
  return NOTIFICATION_REASON_LABELS[item.reason] ?? item.reason
}

function inboxTotal(overview: Overview): number {
  if (overview.inbox === null) return 0
  return Object.values(overview.inbox.by_reason).reduce(
    (total, count) => total + count,
    0
  )
}

function overviewCard(overview: Overview) {
  const reasons =
    overview.inbox === null
      ? []
      : Object.entries(overview.inbox.by_reason).filter(([, count]) => count > 0)

  return (
    <Card>
      <Stack gap="sm">
        <Heading level={3}>概览</Heading>
        <KeyValue
          label="概览计数"
          items={[
            {
              label: '收件箱',
              value: overview.inbox === null ? OVERVIEW_UNAVAILABLE : inboxTotal(overview)
            },
            {
              label: '协作中',
              value:
                overview.collaborating === null
                  ? OVERVIEW_UNAVAILABLE
                  : `${overview.collaborating.unread} 未读 / ${overview.collaborating.total}`
            },
            {
              label: '在等他',
              value: overview.waiting === null ? OVERVIEW_UNAVAILABLE : overview.waiting.total
            },
            {
              label: '通知未读',
              value: overview.unread_notifications,
              tone: overview.unread_notifications > 0 ? 'accent' : 'neutral'
            }
          ]}
        />
        <Stack gap="xs">
          {reasons.map(([code, count]) => (
            <Row key={`inbox-reason-${code}`} justify="between" align="center">
              <Text size="sm">
                {INBOX_REASON_LABELS[code as keyof typeof INBOX_REASON_LABELS]}
              </Text>
              <Badge tone={count > 0 ? 'accent' : 'neutral'}>{count}</Badge>
            </Row>
          ))}
        </Stack>
      </Stack>
    </Card>
  )
}

async function openNotification(item: TaskboardNotification): Promise<void> {
  const result = await shell.openExternal(item.url)
  if (result.opened) {
    await plugin.request('notifications.markRead', { ids: [item.id] })
  }
}

function notificationRow(item: TaskboardNotification) {
  const unread = item.read_at === null
  return (
    <ListItem
      key={`notification-${item.id}`}
      title={notificationTitle(item)}
      description={notificationReason(item)}
      icon={unread ? 'bell' : 'check'}
      current={unread}
    >
      <Row justify="between" align="center">
        <Text muted={!unread} size="xs">
          <RelativeTime at={Date.parse(item.created_at)} />
          {unread ? ' · 未读' : ' · 已读'}
        </Text>
        <Button
          key={`open-notification-${item.id}`}
          size="sm"
          variant="ghost"
          icon="open-external"
          onPress={() => openNotification(item)}
        >
          打开
        </Button>
      </Row>
    </ListItem>
  )
}

async function openInboxTicket(item: OverviewInboxItem): Promise<void> {
  await shell.openExternal(item.url)
}

function inboxRow(item: OverviewInboxItem) {
  const waitedSince = item.last_reply_at ?? item.created_at
  return (
    <ListItem
      key={`inbox-${item.number}`}
      title={`${item.number} · ${item.title}`}
      description={`${INBOX_REASON_LABELS[item.reason_code]} · ${item.trigger.name}`}
      icon="file-text"
    >
      <Row justify="between" align="center">
        <Text muted size="xs">
          等了 <RelativeTime at={Date.parse(waitedSince)} />
        </Text>
        <Button
          key={`open-inbox-${item.number}`}
          size="sm"
          variant="ghost"
          icon="open-external"
          onPress={() => openInboxTicket(item)}
        >
          在浏览器打开
        </Button>
      </Row>
    </ListItem>
  )
}

async function markAllRead(current: TaskboardSnapshot): Promise<void> {
  if (current.latestNotificationId === null) return
  await plugin.request('notifications.markAllRead', {
    up_to: current.latestNotificationId
  })
}

function Header({ platformUrl }: { platformUrl: string }) {
  return (
    <Row justify="between" align="center">
      <Stack gap="none">
        <Heading level={2}>工单板</Heading>
        {platformUrl === '' ? (
          <Text muted size="xs">
            未填写平台地址
          </Text>
        ) : (
          <Text muted size="xs" truncate>
            {platformUrl}
          </Text>
        )}
      </Stack>
      <IconButton
        key="taskboard-menu"
        icon="more"
        label="工单板菜单"
        onPress={() => update(menuOpen, (open) => !open)}
      />
    </Row>
  )
}

function SecretsWarning({ current }: { current: TaskboardSnapshot }) {
  if (current.secretsAvailable) return null
  return (
    <Callout tone="warning" icon="warning">
      这台电脑没有可用的密钥存储，无法保存凭证
    </Callout>
  )
}

function AddressCard({ current }: { current: TaskboardSnapshot }) {
  return (
    <Card title="配置平台地址">
      <Stack gap="sm">
        <Input
          key="platform-url"
          label="平台地址"
          value={read(addressDraft)}
          placeholder="https://taskboard.example.com"
          onChange={(value) => set(addressDraft, value)}
          onSubmit={() => saveAddress()}
        />
        {current.addressError !== null ? (
          <Text key="platform-address-error" tone="danger">
            {current.addressError}
          </Text>
        ) : null}
        <Row justify="end">
          <Button
            key="save-platform-url"
            onPress={() => saveAddress()}
            disabled={read(addressDraft).trim() === ''}
          >
            保存
          </Button>
        </Row>
      </Stack>
    </Card>
  )
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('taskboard.changed', ({ snapshot: next }) => {
      set(snapshot, next)
    })
  )
  void plugin.request('taskboard.getState').then((next) => set(snapshot, next))
}

async function saveAddress(): Promise<void> {
  const next = await plugin.request('config.save', {
    platformUrl: read(addressDraft)
  })
  set(snapshot, next)
  if (next.state !== 'unconfigured') set(addressEditing, false)
}

async function connect(): Promise<void> {
  const result = await plugin.request('connection.begin')
  set(snapshot, result.snapshot)
  if (result.authorizationUrl === null) return

  const opened = await shell.openExternal(result.authorizationUrl)
  if (!opened.opened) {
    set(snapshot, await plugin.request('connection.cancel'))
  }
}

async function cancelConnection(): Promise<void> {
  set(snapshot, await plugin.request('connection.cancel'))
}

async function disconnect(): Promise<void> {
  set(menuOpen, false)
  set(snapshot, await plugin.request('connection.disconnect'))
}

function ConnectionPanel({
  snapshot: current,
  reconnect
}: {
  snapshot: TaskboardSnapshot
  reconnect: boolean
}) {
  const waiting = current.connection.phase === 'waiting'
  return (
    <Card>
      <Stack gap="sm">
        <Heading level={3}>{reconnect ? '重新连接账号' : '连接账号'}</Heading>
        {waiting ? (
          <>
            <Text>等待浏览器确认…</Text>
            <Row justify="end">
              <Button key="cancel-connection" variant="ghost" onPress={() => cancelConnection()}>
                取消
              </Button>
            </Row>
          </>
        ) : (
          <>
            <Text>将在浏览器里确认这台电脑。</Text>
            <Row justify="end">
              <Button
                key={reconnect ? 'reconnect-account' : 'connect-account'}
                onPress={() => connect()}
                disabled={!current.secretsAvailable}
              >
                {reconnect ? '重新连接' : '连接账号'}
              </Button>
            </Row>
          </>
        )}
        {current.connection.phase === 'failed' && current.connection.message !== null ? (
          <Text tone="danger">{current.connection.message}</Text>
        ) : null}
        {current.connection.phase === 'cancelled' && current.connection.message !== null ? (
          <Text muted>{current.connection.message}</Text>
        ) : null}
        {current.connection.phase === 'timeout' && current.connection.message !== null ? (
          <Text tone="danger">{current.connection.message}</Text>
        ) : null}
      </Stack>
    </Card>
  )
}

function UnconfiguredPanel() {
  const current = read(snapshot)
  if (current === null) return null
  return (
    <Stack gap="md">
      <Header platformUrl="" />
      <SecretsWarning current={current} />
      <AddressCard current={current} />
    </Stack>
  )
}

function DisconnectedPanel({ snapshot: current }: { snapshot: TaskboardSnapshot }) {
  return (
    <Stack gap="md">
      <Header platformUrl={current.platformUrl} />
      {read(addressEditing) ? (
        <AddressCard current={current} />
      ) : (
        <>
          <SecretsWarning current={current} />
          <ConnectionPanel snapshot={current} reconnect={false} />
        </>
      )}
    </Stack>
  )
}

function ExpiredPanel({ snapshot: current }: { snapshot: TaskboardSnapshot }) {
  return (
    <Stack gap="md">
      <Header platformUrl={current.platformUrl} />
      {read(addressEditing) ? (
        <AddressCard current={current} />
      ) : (
        <>
          <SecretsWarning current={current} />
          <Callout tone="warning" icon="warning">
            <Stack gap="sm">
              <Heading level={3}>连接已失效，请重新连接</Heading>
              <Text>需要重新连接账号后才能刷新提醒和概览。</Text>
            </Stack>
          </Callout>
          <ConnectionPanel snapshot={current} reconnect />
        </>
      )}
    </Stack>
  )
}

function ConnectedPanel({ snapshot: current }: { snapshot: TaskboardSnapshot }) {
  return (
    <Stack gap="md">
      <Header platformUrl={current.platformUrl} />
      {read(menuOpen) ? (
        <Card title="菜单">
          <Stack gap="sm">
            <Button
              key="change-platform-url"
              variant="ghost"
              onPress={() => {
                set(menuOpen, false)
                set(addressDraft, current.platformUrl)
                set(addressEditing, true)
              }}
            >
              更改平台地址
            </Button>
            <Button key="disconnect-account" variant="ghost" onPress={() => disconnect()}>
              断开连接
            </Button>
          </Stack>
        </Card>
      ) : null}
      {read(addressEditing) ? (
        <AddressCard current={current} />
      ) : (
        <>
          {current.refreshError !== null ? (
            <Callout tone="warning" icon="warning">
              {current.refreshError}
            </Callout>
          ) : null}
          {current.overview === null ? (
            current.refreshError === null ? (
              <Spinner label="正在加载工单板" />
            ) : null
          ) : (
            <>
              {overviewCard(current.overview)}
              <Card>
                <Stack gap="sm">
                  <Heading level={3}>通知</Heading>
                  {current.notifications.some((item) => item.read_at === null) ? (
                    <Row justify="end">
                      <Button
                        key="mark-all-notifications-read"
                        size="sm"
                        variant="ghost"
                        onPress={() => markAllRead(current)}
                      >
                        全部已读
                      </Button>
                    </Row>
                  ) : null}
                  <List label="最近通知">
                    {current.notifications.map((item) => notificationRow(item))}
                  </List>
                </Stack>
              </Card>
              <Card>
                <Heading level={3}>收件箱</Heading>
                {current.overview.inbox === null ? (
                  <Text muted>{OVERVIEW_UNAVAILABLE}</Text>
                ) : (
                  <List label="收件箱工单">
                    {current.overview.inbox.items.map((item) => inboxRow(item))}
                  </List>
                )}
              </Card>
            </>
          )}
        </>
      )}
    </Stack>
  )
}

export default function Panel() {
  const current = read(snapshot)
  if (current === null) return <Spinner label="正在加载工单板" />
  if (current.state === 'unconfigured') return <UnconfiguredPanel />
  if (current.state === 'disconnected') return <DisconnectedPanel snapshot={current} />
  if (current.state === 'expired') return <ExpiredPanel snapshot={current} />
  return <ConnectedPanel snapshot={current} />
}
