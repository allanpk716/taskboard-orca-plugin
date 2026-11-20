import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  Heading,
  IconButton,
  Input,
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
  GUEST_TURN_REASON_CODES,
  groupInboxByCounterpart,
  type InboxReasonCode,
  type Overview,
  type OverviewCollaboratingItem,
  type OverviewInboxItem,
  type TaskboardNotification
} from './overview'
import './protocol'
import type { TaskboardSnapshot } from './protocol'

const snapshot = atom<TaskboardSnapshot | null>(null)
const addressDraft = atom('')
const addressEditing = atom(false)
const menuOpen = atom(false)

type FilterKey = 'mine' | 'guest' | 'collaborating'

const activeFilter = atom<FilterKey>('mine')
const notificationsOpen = atom(false)

const FILTER_LABELS: Record<FilterKey, string> = {
  mine: '等我处理',
  guest: '访客新回复',
  collaborating: '协作中'
}

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
  return overview.inbox.items.length
}

function isGuestTurnReason(code: InboxReasonCode): boolean {
  return (GUEST_TURN_REASON_CODES as readonly string[]).includes(code)
}

function guestTurnItems(overview: Overview): OverviewInboxItem[] {
  if (overview.inbox === null) return []
  return overview.inbox.items.filter((item) => isGuestTurnReason(item.reason_code))
}

function collaboratingGroups(
  items: readonly OverviewCollaboratingItem[]
): { key: string; label: string; items: OverviewCollaboratingItem[] }[] {
  const groups = new Map<string, OverviewCollaboratingItem[]>()
  for (const item of items) {
    const key = item.waiting_on_text ?? '未知'
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [item])
    else bucket.push(item)
  }
  return [...groups.entries()].map(([key, groupItems]) => ({
    key,
    label: key,
    items: [...groupItems].sort((a, b) => Number(b.unread) - Number(a.unread))
  }))
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

function waitDurationLabel(since: string): string {
  const minutes = Math.max(0, (Date.now() - Date.parse(since)) / 60_000)
  if (minutes < 60) return `已等 ${Math.floor(minutes)} 分钟`
  if (minutes < 60 * 24) return `已等 ${Math.floor(minutes / 60)} 小时`
  return `已等 ${Math.floor(minutes / (60 * 24))} 天`
}

function inboxRow(item: OverviewInboxItem) {
  return (
    <ListItem
      key={`inbox-${item.number}`}
      title={`${item.number} · ${item.title}`}
      icon={item.read_new ? 'bell' : 'file-text'}
      current={item.read_new}
    >
      <Row justify="between" align="center" gap="xs">
        <Text muted size="xs" truncate>
          {item.reason}
        </Text>
        <Text muted size="xs">
          {waitDurationLabel(item.waited_since)}
        </Text>
        <Button
          key={`open-inbox-${item.number}`}
          size="sm"
          variant="ghost"
          icon="open-external"
          onPress={() => openInboxTicket(item)}
        >
          打开
        </Button>
      </Row>
    </ListItem>
  )
}

async function openCollaboratingTicket(
  item: OverviewCollaboratingItem
): Promise<void> {
  await shell.openExternal(item.url)
}

function collaboratingRow(item: OverviewCollaboratingItem) {
  return (
    <ListItem
      key={`collab-${item.number}`}
      title={item.title}
      icon={item.unread ? 'bell' : 'file-text'}
      current={item.unread}
    >
      <Row justify="between" align="center">
        <Text muted={!item.unread} size="xs">
          {item.number}
          {item.unread ? ' · 未读' : ''}
        </Text>
        <Button
          key={`open-collab-${item.number}`}
          size="sm"
          variant="ghost"
          icon="open-external"
          onPress={() => openCollaboratingTicket(item)}
        >
          打开
        </Button>
      </Row>
    </ListItem>
  )
}

function FilterBar({ overview }: { overview: Overview }) {
  const counts: Record<FilterKey, number | null> = {
    mine: overview.inbox === null ? null : inboxTotal(overview),
    guest: overview.inbox === null ? null : guestTurnItems(overview).length,
    collaborating:
      overview.collaborating === null ? null : overview.collaborating.unread
  }
  const active = read(activeFilter)
  return (
    <Row gap="xs" align="stretch">
      {(Object.keys(FILTER_LABELS) as FilterKey[]).map((key) => (
        <Button
          key={`filter-${key}`}
          variant={active === key ? 'solid' : 'ghost'}
          tone={active === key ? 'accent' : 'neutral'}
          onPress={() => set(activeFilter, key)}
        >
          {`${counts[key] === null ? '—' : counts[key]} ${FILTER_LABELS[key]}`}
        </Button>
      ))}
    </Row>
  )
}

function InboxGroups({
  overview,
  items
}: {
  overview: Overview
  items: readonly OverviewInboxItem[]
}) {
  if (overview.inbox === null) {
    return (
      <EmptyState
        title={OVERVIEW_UNAVAILABLE}
        description="平台升级后这里会按往来对象列出工单。"
        icon="info"
      />
    )
  }
  const groups = groupInboxByCounterpart(
    items,
    overview.waiting?.by_counterpart ?? {}
  )
  if (groups.length === 0) {
    return (
      <EmptyState
        title="这里没有工单"
        description="有新的进展会出现在这里。"
        icon="check"
      />
    )
  }
  return (
    <>
      {groups.map((group) => (
        <Card key={`group-${group.key}`}>
          <Stack gap="sm">
            <Row justify="between" align="center">
              <Text weight="semibold">{`${group.label} ×${group.items.length}`}</Text>
              {group.waitingCount > 0 ? (
                <Text muted size="xs">{`另等他 ${group.waitingCount}`}</Text>
              ) : null}
            </Row>
            <List label={`${group.label}的工单`}>
              {group.items.map((item) => inboxRow(item))}
            </List>
          </Stack>
        </Card>
      ))}
    </>
  )
}

function CollaboratingList({ overview }: { overview: Overview }) {
  if (overview.collaborating === null) {
    return (
      <EmptyState
        title={OVERVIEW_UNAVAILABLE}
        description="平台升级后这里会列出你协作跟进的工单。"
        icon="info"
      />
    )
  }
  const groups = collaboratingGroups(overview.collaborating.items)
  if (groups.length === 0) {
    return (
      <EmptyState
        title="没有协作中的工单"
        description="被加入协作的工单会出现在这里。"
        icon="check"
      />
    )
  }
  return (
    <>
      {groups.map((group) => (
        <Card key={`collab-group-${group.key}`}>
          <Stack gap="sm">
            <Row justify="between" align="center">
              <Text weight="semibold">{`轮到 ${group.label} ×${group.items.length}`}</Text>
            </Row>
            <List label={`轮到${group.label}的协作工单`}>
              {group.items.map((item) => collaboratingRow(item))}
            </List>
          </Stack>
        </Card>
      ))}
    </>
  )
}

function NotificationsCard({ current }: { current: TaskboardSnapshot }) {
  const open = read(notificationsOpen)
  const unreadCount = current.notifications.filter(
    (item) => item.read_at === null
  ).length
  return (
    <Card>
      <Stack gap="sm">
        <Row justify="between" align="center">
          <Heading level={3}>通知</Heading>
          <Row gap="xs" align="center">
            {unreadCount > 0 && open ? (
              <Button
                key="mark-all-notifications-read"
                size="sm"
                variant="ghost"
                onPress={() => markAllRead(current)}
              >
                全部已读
              </Button>
            ) : null}
            <IconButton
              key="toggle-notifications"
              icon={open ? 'collapse' : 'expand'}
              label={open ? '收起通知列表' : '展开通知列表'}
              variant="ghost"
              onPress={() => update(notificationsOpen, (value) => !value)}
            />
          </Row>
        </Row>
        {open ? (
          <List label="最近通知">
            {current.notifications.map((item) => notificationRow(item))}
          </List>
        ) : (
          <Text muted size="xs">{`${
            unreadCount > 0 ? `${unreadCount} 条未读 · ` : ''
          }最近 ${current.notifications.length} 条`}</Text>
        )}
      </Stack>
    </Card>
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
  const unreadNotifications =
    current.unreadNotificationCount ?? current.notifications.filter(
      (item) => item.read_at === null
    ).length
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
              <Row justify="between" align="center">
                <Badge tone="success">已连接</Badge>
                {unreadNotifications > 0 ? (
                  <Button
                    key="jump-notifications"
                    size="sm"
                    variant="ghost"
                    tone="accent"
                    icon="bell"
                    onPress={() => set(notificationsOpen, true)}
                  >
                    {unreadNotifications} 条通知未读
                  </Button>
                ) : null}
              </Row>
              <FilterBar overview={current.overview} />
              {read(activeFilter) === 'mine' ? (
                <InboxGroups
                  overview={current.overview}
                  items={current.overview.inbox?.items ?? []}
                />
              ) : null}
              {read(activeFilter) === 'guest' ? (
                <InboxGroups
                  overview={current.overview}
                  items={guestTurnItems(current.overview)}
                />
              ) : null}
              {read(activeFilter) === 'collaborating' ? (
                <CollaboratingList overview={current.overview} />
              ) : null}
              <NotificationsCard current={current} />
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
