// client.js — taskboard-dsh 的浏览器半面(MVP:三类筛选面板;零依赖手写,不引构建链)。
// 协议事实钉点(0.2.2-rc.5 app.asar 源码 + ferryman-dsh client.js 先例):
//   - 分发:package.json 声明 dsh.client{platform:'web'} + exports["./client"](本文件)
//     → 宿主扫描器编入浏览器 roster;本文件被拼进 combo 脚本,加载时自调
//     window.__ModuleLoader__.load({id, factory})——懒 CJS 模型。
//   - factory(require) 收模块表:require('react') 走平台共享模块;返回 {name, inject, apply}。
//   - 左栏面板:ctx.slots.register({name:'sidebar.panellist', id, order, label}, 组件)
//     (ui-sidebar syncPanels:list 条目 {id→MainPanelId, order, label})。
//   - 面板主体:main 槽 keyed(AppFrame renderSlot('main', {}, {entryKey: panelId})),
//     注册 {name:'main', key:'taskboard'};点击面板行由 SidebarRoot 自调 ctx.layout.selectPanel(id)。
//   - host 数据面:同源 fetch('/api/taskboard/*')(host 半边 webServer.register 前缀路由)。
//   - 内嵌打开工单:ctx.get('sidebarRight').openTab('browser', {params:{url}})(ui-sidebar-right
//     service.ts openTab——自解析 on-screen session;browser kind Desktop 默认启用、Web profile
//     默认禁用)。运行时探测 + try/catch,失败兜底 window.open 外部浏览器
//     (Web 形态 iframe 载体带不上 Lax cookie,内嵌无意义,外部打开即正解——设计拍板 8)。
//   - 系统通知:Desktop 权限处理器除麦克风外一律放行,renderer 直接 new Notification()。
//     host 把 SSE 实时通知放 pendingNotifications 队列,这里逐条弹出 + POST ack。
// 0.2.2-rc.5 已知事实:sidebar.panellist.trailing 不存在(master 才有)——未读计数
// 画在面板图标组件自己身上(本组件即图标渲染体,完全可控)。
;(function (global) {
  'use strict'

  var target = global.__ModuleLoader__
  if (!target || typeof target.load !== 'function') {
    throw new Error('taskboard-dsh/client: window.__ModuleLoader__ is unavailable')
  }
  target.load({ id: 'taskboard-dsh', factory: factory })

  var POLL_MS = 5000
  var PANEL_ID = 'taskboard'

  function factory(require) {
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect

    // ---- 宿主 client 服务(apply 时运行时探测;inject 声明会踩 fiber epoch 连坐,host 侧教训) ----
    var sidebarRightService = null

    function openTicket(url) {
      try {
        if (sidebarRightService && typeof sidebarRightService.openTab === 'function') {
          sidebarRightService.openTab('browser', { params: { url: url } })
          return
        }
      } catch (e) {
        console.warn('[taskboard-dsh] 内嵌打开失败,转外部浏览器:', e)
      }
      global.open(url, '_blank', 'noopener')
    }

    // ---- host 状态轮询(单例 store,所有组件共享一次轮询) ----
    var listeners = new Set()
    var lastState = null
    var pollTimer = null

    function notify() {
      listeners.forEach(function (fn) { fn(lastState) })
    }

    async function pollOnce() {
      try {
        var res = await fetch('/api/taskboard/state', { credentials: 'same-origin' })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        lastState = await res.json()
        notify()
      } catch (e) {
        // host 路由不可达时保留上次状态;面板显示错误态
        lastState = lastState && lastState.__ok !== false
          ? lastState
          : { state: 'unreachable', platformUrl: '', unread: null, connectUrl: null, connectPhase: 'idle', connectMessage: String(e), latestNotificationId: null, overview: null, notifications: [], refreshError: null, pendingNotifications: [], recentEvents: [] }
      }
    }

    function post(path, body) {
      return fetch('/api/taskboard/' + path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
        .then(function (res) { return res.json() })
        .then(function (next) { if (next && next.state) { lastState = next; notify() } return next })
        .catch(function (e) { console.warn('[taskboard-dsh] POST ' + path + ' 失败:', e) })
    }

    function ensurePolling() {
      if (pollTimer !== null) return
      pollTimer = setInterval(pollOnce, POLL_MS)
      void pollOnce()
    }

    function useTaskboardState() {
      var snapshot = useState(lastState)
      var value = snapshot[0]
      var setValue = snapshot[1]
      useEffect(function () {
        listeners.add(setValue)
        ensurePolling()
        return function () { listeners.delete(setValue) }
      }, [setValue])
      return value
    }

    // ---- 系统通知:消费 host 的 SSE 实时通知队列,弹完 ack ----
    var shownMarkers = {}

    async function showOneNotification(item) {
      try {
        if (typeof global.Notification !== 'function') return
        if (Notification.permission === 'default') await Notification.requestPermission()
        if (Notification.permission !== 'granted') {
          console.warn('[taskboard-dsh] 通知权限:', Notification.permission)
          return
        }
        var toast = new Notification(item.title, { body: item.body, tag: 'taskboard-' + item.id })
        toast.onclick = function () {
          global.focus()
          if (item.url) openTicket(item.url)
        }
      } catch (e) {
        console.warn('[taskboard-dsh] Notification 失败:', e)
      }
    }

    function consumePendingNotifications(state) {
      if (!state || !state.pendingNotifications || state.pendingNotifications.length === 0) return
      var shownIds = []
      state.pendingNotifications.forEach(function (item) {
        var marker = item.id + ':' + item.title + ':' + item.body
        if (shownMarkers[marker]) return
        shownMarkers[marker] = true
        shownIds.push(item.id)
        void showOneNotification(item)
      })
      if (shownIds.length > 0) {
        void post('notifications/ack', { ids: shownIds })
      }
    }

    // ---- 三类筛选聚合逻辑(src/overview.ts 纯函数的 JS 副本;client 零构建链不引 TS) ----
    var GUEST_TURN_REASON_CODES = ['guest_replied', 'guest_completed', 'guest_revised', 'guest_not_completed']

    function isGuestTurnReason(code) {
      return GUEST_TURN_REASON_CODES.indexOf(code) !== -1
    }

    function guestTurnItems(overview) {
      if (!overview || !overview.inbox) return []
      return overview.inbox.items.filter(function (item) { return isGuestTurnReason(item.reason_code) })
    }

    function counterpartKey(counterpart) {
      return counterpart.type + ':' + (counterpart.name || '')
    }

    function counterpartLabel(counterpart) {
      if (counterpart.type === 'guest') return '访客 · ' + (counterpart.name || '未署名')
      if (counterpart.type === 'self') return '我自己'
      if (counterpart.type === 'pending_triage') return '待初筛'
      return counterpart.name || '其他成员'
    }

    function groupInboxByCounterpart(items, waitingByCounterpart) {
      var waiting = waitingByCounterpart || {}
      var groups = {}
      var order = []
      items.forEach(function (item) {
        var key = counterpartKey(item.counterpart)
        if (!groups[key]) { groups[key] = []; order.push({ key: key, first: item }) }
        groups[key].push(item)
      })
      return order.map(function (entry) {
        var groupItems = groups[entry.key].slice().sort(function (a, b) {
          return Date.parse(a.waited_since) - Date.parse(b.waited_since)
        })
        return {
          key: entry.key,
          label: counterpartLabel(entry.first.counterpart),
          items: groupItems,
          waitingCount: waiting[entry.key] || 0,
        }
      })
    }

    function collaboratingGroups(items) {
      var groups = {}
      var order = []
      items.forEach(function (item) {
        var key = item.waiting_on_text || '未知'
        if (!groups[key]) { groups[key] = []; order.push(key) }
        groups[key].push(item)
      })
      return order.map(function (key) {
        return {
          key: key,
          label: key,
          items: groups[key].slice().sort(function (a, b) { return Number(b.unread) - Number(a.unread) }),
        }
      })
    }

    function waitDurationLabel(since) {
      var minutes = Math.max(0, (Date.now() - Date.parse(since)) / 60000)
      if (minutes < 60) return '已等 ' + Math.floor(minutes) + ' 分钟'
      if (minutes < 60 * 24) return '已等 ' + Math.floor(minutes / 60) + ' 小时'
      return '已等 ' + Math.floor(minutes / (60 * 24)) + ' 天'
    }

    function timeLabel(iso) {
      return (iso || '').slice(11, 16)
    }

    // ---- 图标:铃铛 + 未读角标(panellist 组件即图标渲染体) ----
    function BellIcon(_props) {
      return h('svg', {
        width: '20', height: '20', viewBox: '0 0 24 24', fill: 'none',
        'aria-hidden': 'true',
      }, h('path', {
        d: 'M12 3a6 6 0 0 0-6 6v3.2c0 .5-.2 1-.5 1.4L4 15.5h16l-1.5-1.9a2.2 2.2 0 0 1-.5-1.4V9a6 6 0 0 0-6-6Z',
        stroke: 'currentColor', strokeWidth: '1.7', strokeLinejoin: 'round',
      }), h('path', {
        d: 'M9.8 18.5a2.3 2.3 0 0 0 4.4 0',
        stroke: 'currentColor', strokeWidth: '1.7', strokeLinecap: 'round',
      }))
    }

    function PanelEntry(props) {
      var state = useTaskboardState()
      var size = props && props.size ? props.size : 20
      var scale = size >= 24 ? 1.25 : 1
      var unread = state && state.unread ? state.unread : 0
      return h('span', {
        style: {
          position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: size + 'px', height: size + 'px',
          color: state && state.state === 'connected' ? 'inherit' : 'var(--dsw-alias-label-tertiary, #6b7280)',
        },
      },
        h('span', { style: { transform: 'scale(' + scale + ')', display: 'inline-flex' } }, h(BellIcon, null)),
        unread > 0 ? h('span', {
          style: {
            position: 'absolute', top: '-4px', right: '-7px',
            minWidth: '15px', height: '15px', padding: '0 4px', boxSizing: 'border-box',
            borderRadius: '8px', background: 'var(--dsw-alias-accent, #e5484d)',
            color: '#fff', fontSize: '10px', fontWeight: 700, lineHeight: '15px', textAlign: 'center',
            pointerEvents: 'none',
          },
        }, unread > 99 ? '99+' : String(unread)) : null)
    }

    // ---- 样式(Orca 拍板稿布局的零构建复刻) ----
    var S = {
      wrap: { padding: '20px', maxWidth: '620px', margin: '0 auto', fontFamily: 'system-ui, sans-serif' },
      card: {
        background: 'var(--dsw-alias-bg-layer-2, #1d2030)',
        border: '1px solid var(--dsw-alias-border-l2, #3a4160)',
        borderRadius: '14px', padding: '16px', marginBottom: '12px',
      },
      title: { fontSize: '15px', fontWeight: 600, margin: '0 0 10px', color: 'var(--dsw-alias-label-primary, #e8eaf2)' },
      h2row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '0 0 10px' },
      line: { fontSize: '13px', lineHeight: '1.7', color: 'var(--dsw-alias-label-secondary, #9aa0b5)', wordBreak: 'break-all' },
      strong: { color: 'var(--dsw-alias-label-primary, #e8eaf2)', fontWeight: 600 },
      muted: { color: 'var(--dsw-alias-label-tertiary, #6b7280)' },
      badge: {
        display: 'inline-block', padding: '1px 10px', borderRadius: '10px', fontSize: '12px', fontWeight: 600,
        background: 'var(--dsw-alias-accent-soft, rgba(79,107,255,.15))', color: 'var(--dsw-alias-accent, #4f6bff)',
      },
      badgeOk: {
        display: 'inline-block', padding: '1px 10px', borderRadius: '10px', fontSize: '12px', fontWeight: 600,
        background: 'rgba(46,160,67,.15)', color: '#2ea043',
      },
      badgeWarn: {
        display: 'inline-block', padding: '1px 10px', borderRadius: '10px', fontSize: '12px', fontWeight: 600,
        background: 'rgba(229,72,77,.15)', color: '#e5484d',
      },
      button: {
        padding: '8px 16px', borderRadius: '10px', border: 'none', cursor: 'pointer',
        fontSize: '13.5px', fontWeight: 600, marginTop: '6px',
        background: 'var(--dsw-alias-accent, #4f6bff)', color: '#fff',
      },
      buttonSmall: {
        padding: '3px 12px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l2, #3a4160)',
        cursor: 'pointer', fontSize: '12px', fontWeight: 500, flexShrink: 0,
        background: 'transparent', color: 'var(--dsw-alias-label-secondary, #9aa0b5)',
      },
      link: { color: 'var(--dsw-alias-accent, #4f6bff)', wordBreak: 'break-all' },
      events: { margin: '4px 0 0', padding: '0', listStyle: 'none', fontSize: '12px', lineHeight: '1.9', color: 'var(--dsw-alias-label-tertiary, #6b7280)' },
      evTime: { marginRight: '6px', fontVariantNumeric: 'tabular-nums' },
      filterRow: { display: 'flex', gap: '6px', marginBottom: '12px', flexWrap: 'wrap' },
      filterButton: {
        flex: '1 1 auto', padding: '8px 6px', borderRadius: '10px', cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2, #3a4160)', fontSize: '13px', fontWeight: 600,
        background: 'transparent', color: 'var(--dsw-alias-label-secondary, #9aa0b5)',
        textAlign: 'center', whiteSpace: 'nowrap',
      },
      filterButtonActive: {
        flex: '1 1 auto', padding: '8px 6px', borderRadius: '10px', cursor: 'pointer',
        border: '1px solid var(--dsw-alias-accent, #4f6bff)', fontSize: '13px', fontWeight: 600,
        background: 'var(--dsw-alias-accent, #4f6bff)', color: '#fff',
        textAlign: 'center', whiteSpace: 'nowrap',
      },
      groupHead: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        margin: '0 0 8px',
      },
      groupTitle: { fontSize: '13.5px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #e8eaf2)' },
      row: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
        padding: '8px 0', borderTop: '1px solid var(--dsw-alias-border-l2, #3a4160)',
      },
      rowFirst: { borderTop: 'none' },
      rowMain: { flex: '1 1 auto', minWidth: 0 },
      rowTitle: {
        fontSize: '13px', fontWeight: 500, color: 'var(--dsw-alias-label-primary, #e8eaf2)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      rowTitleUnread: {
        fontSize: '13px', fontWeight: 700, color: 'var(--dsw-alias-label-primary, #e8eaf2)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      rowMeta: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #6b7280)', marginTop: '2px' },
      empty: { textAlign: 'center', padding: '28px 0', color: 'var(--dsw-alias-label-tertiary, #6b7280)', fontSize: '13px' },
      warnBox: {
        padding: '8px 12px', borderRadius: '10px', marginBottom: '12px', fontSize: '12.5px',
        background: 'rgba(229,150, 5,.12)', color: '#e59605',
        border: '1px solid rgba(229,150,5,.3)',
      },
    }

    function StateBadge(props) {
      var state = props && props.state ? props.state : ''
      var style = state === 'connected' ? S.badgeOk : (state === 'expired' ? S.badgeWarn : S.badge)
      var text = { connected: '已连接', waiting: '等待浏览器确认', disconnected: '未连接', expired: '连接已失效,请重新连接', unconfigured: '未配置', unreachable: '面板取不到 host' }[state] || state
      return h('span', { style: style }, text)
    }

    // ---- 三类筛选面板(复刻 Orca 版 panel.tsx 布局与文案) ----
    var FILTERS = [
      { key: 'mine', label: '等我处理' },
      { key: 'guest', label: '访客新回复' },
      { key: 'collaborating', label: '协作中' },
    ]

    function filterCount(overview, key) {
      if (!overview) return null
      if (key === 'mine') return overview.inbox === null ? null : overview.inbox.items.length
      if (key === 'guest') return overview.inbox === null ? null : guestTurnItems(overview).length
      return overview.collaborating === null ? null : overview.collaborating.unread
    }

    function FilterBar(props) {
      var overview = props.overview
      var active = props.active
      var onSelect = props.onSelect
      return h('div', { style: S.filterRow },
        FILTERS.map(function (f) {
          var count = filterCount(overview, f.key)
          return h('button', {
            key: 'filter-' + f.key,
            style: active === f.key ? S.filterButtonActive : S.filterButton,
            onClick: function () { onSelect(f.key) },
          }, (count === null ? '—' : count) + ' ' + f.label)
        }))
    }

    function InboxGroups(props) {
      var overview = props.overview
      var items = props.items
      if (overview.inbox === null) {
        return h('div', { style: S.empty }, '概览接口尚未开放(等平台升级)')
      }
      var groups = groupInboxByCounterpart(items, overview.waiting ? overview.waiting.by_counterpart : {})
      if (groups.length === 0) {
        return h('div', { style: S.empty }, '这里没有工单,有新的进展会出现在这里。')
      }
      return groups.map(function (group) {
        return h('div', { key: 'group-' + group.key, style: S.card },
          h('div', { style: S.groupHead },
            h('span', { style: S.groupTitle }, group.label + ' ×' + group.items.length),
            group.waitingCount > 0
              ? h('span', { style: S.rowMeta }, '另等他 ' + group.waitingCount)
              : null),
          group.items.map(function (item, i) {
            return h('div', { key: 'inbox-' + item.number, style: Object.assign({}, S.row, i === 0 ? S.rowFirst : null) },
              h('div', { style: S.rowMain },
                h('div', { style: item.read_new ? S.rowTitleUnread : S.rowTitle }, item.number + ' · ' + item.title),
                h('div', { style: S.rowMeta }, item.reason + ' · ' + waitDurationLabel(item.waited_since))),
              h('button', {
                style: S.buttonSmall,
                onClick: function () { openTicket(item.url) },
              }, '打开'))
          }))
      })
    }

    function CollaboratingList(props) {
      var overview = props.overview
      if (overview.collaborating === null) {
        return h('div', { style: S.empty }, '概览接口尚未开放(等平台升级)')
      }
      var groups = collaboratingGroups(overview.collaborating.items)
      if (groups.length === 0) {
        return h('div', { style: S.empty }, '没有协作中的工单,被加入协作的工单会出现在这里。')
      }
      return groups.map(function (group) {
        return h('div', { key: 'collab-group-' + group.key, style: S.card },
          h('div', { style: S.groupHead },
            h('span', { style: S.groupTitle }, '轮到 ' + group.label + ' ×' + group.items.length)),
          group.items.map(function (item, i) {
            return h('div', { key: 'collab-' + item.number, style: Object.assign({}, S.row, i === 0 ? S.rowFirst : null) },
              h('div', { style: S.rowMain },
                h('div', { style: item.unread ? S.rowTitleUnread : S.rowTitle }, item.title),
                h('div', { style: S.rowMeta }, item.number + (item.unread ? ' · 未读' : ''))),
              h('button', {
                style: S.buttonSmall,
                onClick: function () { openTicket(item.url) },
              }, '打开'))
          }))
      })
    }

    var NOTIFICATION_REASON_LABELS = {
      assigned: '新指派', delivered: '已交付', assignee_replied: '指派人回复', returned: '退回修改',
      creator_replied: '发起人回复', agent_replied: 'Agent 回复', guest_replied: '访客回复',
      guest_completed: '访客补全说明', guest_revised: '访客修订说明', department: '轮到部门',
      collaborator_added: '加入协作', collaborator_removed: '移出协作', collaborator_replied: '协作者回复',
      closed: '已关闭', reopened: '重新打开', backup_failing: '备份失败', backup_recovered: '备份恢复',
    }

    function notificationTitle(item) {
      return item.ticket ? item.ticket.number + ' · ' + item.ticket.title : (item.text || item.summary)
    }

    function notificationReason(item) {
      return NOTIFICATION_REASON_LABELS[item.reason] || item.reason
    }

    function NotificationsCard(props) {
      var state = props.state
      var open = props.open
      var onToggle = props.onToggle
      var notifications = state.notifications || []
      var unreadCount = notifications.filter(function (item) { return item.read_at === null }).length
      return h('div', { style: S.card },
        h('div', { style: S.h2row },
          h('h3', { style: { margin: 0, fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #e8eaf2)' } }, '通知'),
          h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
            unreadCount > 0 && open
              ? h('button', {
                  style: S.buttonSmall,
                  onClick: function () {
                    if (state.latestNotificationId !== null) {
                      void post('read', { up_to: state.latestNotificationId })
                    }
                  },
                }, '全部已读')
              : null,
            h('button', { style: S.buttonSmall, onClick: onToggle }, open ? '收起' : '展开'))),
        open
          ? h('div', null,
              notifications.length === 0
                ? h('div', { style: S.empty }, '没有通知')
                : notifications.map(function (item) {
                    var unread = item.read_at === null
                    return h('div', {
                      key: 'notification-' + item.id,
                      style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '7px 0', borderTop: '1px solid var(--dsw-alias-border-l2, #3a4160)' },
                    },
                      h('div', { style: S.rowMain },
                        h('div', { style: unread ? S.rowTitleUnread : S.rowTitle }, notificationTitle(item)),
                        h('div', { style: S.rowMeta }, notificationReason(item) + ' · ' + timeLabel(item.created_at) + (unread ? ' · 未读' : ''))),
                      h('button', {
                        style: S.buttonSmall,
                        onClick: function () {
                          openTicket(item.url)
                          if (unread) void post('read', { ids: [item.id] })
                        },
                      }, '打开'))
                })
          ) : h('p', { style: S.line },
              (unreadCount > 0 ? unreadCount + ' 条未读 · ' : '') + '最近 ' + notifications.length + ' 条'))
    }

    // ---- 主体面板(main keyed) ----
    function TaskboardPanel() {
      var state = useTaskboardState()
      var activeFilter = useState('mine')
      var filter = activeFilter[0]
      var setFilter = activeFilter[1]
      var notifOpenState = useState(false)
      var notificationsOpen = notifOpenState[0]
      var setNotificationsOpen = notifOpenState[1]
      var menuOpenState = useState(false)
      var menuOpen = menuOpenState[0]
      var setMenuOpen = menuOpenState[1]

      useEffect(function () { consumePendingNotifications(state) }, [state])

      if (state === null) {
        return h('div', { style: S.wrap }, h('div', { style: S.card }, h('p', { style: S.line }, '加载中…')))
      }
      var connectBusy = state.state === 'waiting'

      async function onConnect() {
        try {
          var res = await fetch('/api/taskboard/connect', { method: 'POST', credentials: 'same-origin' })
          var body = await res.json()
          if (body && typeof body.url === 'string' && body.url) {
            global.open(body.url, '_blank', 'noopener')
          }
          setTimeout(pollOnce, 300)
        } catch (e) {
          console.warn('[taskboard-dsh] connect 失败:', e)
        }
      }

      var overview = state.overview

      return h('div', { style: S.wrap },
        h('div', { style: S.card },
          h('div', { style: S.h2row },
            h('h2', { style: { margin: 0, fontSize: '16px', fontWeight: 700, color: 'var(--dsw-alias-label-primary, #e8eaf2)' } },
              '工单板 ', h(StateBadge, { state: state.state })),
            state.state === 'connected'
              ? h('button', { style: S.buttonSmall, onClick: function () { setMenuOpen(!menuOpen) } }, '菜单')
              : null),
          state.state === 'connected'
            ? h('p', { style: S.line },
                h('span', { style: S.muted }, '未读 '), h('span', { style: S.strong }, state.unread === null ? '?' : String(state.unread)),
                h('span', { style: S.muted }, ' · 平台 '), h('span', { style: S.strong }, state.platformUrl || '(未配置)'))
            : h('p', { style: S.line },
                '平台:', h('span', { style: S.strong }, state.platformUrl || '(未配置)')),
          menuOpen && state.state === 'connected'
            ? h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px' } },
                h('button', {
                  style: S.buttonSmall,
                  onClick: function () { setMenuOpen(false); void post('disconnect', {}) },
                }, '断开连接'))
            : null,
          state.state !== 'connected'
            ? h('div', null,
                state.state === 'expired'
                  ? h('p', { style: S.warnBox }, '连接已失效,需要重新连接账号后才能刷新提醒和概览。')
                  : null,
                h('button', { style: S.button, onClick: onConnect, disabled: connectBusy },
                  connectBusy ? '等待浏览器确认…' : (state.state === 'expired' ? '重新连接' : '连接账号')),
                connectBusy
                  ? h('button', {
                      style: Object.assign({}, S.buttonSmall, { marginLeft: '8px' }),
                      onClick: function () { void post('cancel', {}) },
                    }, '取消')
                  : null,
                state.connectUrl
                  ? h('p', { style: S.line }, '若浏览器没打开,手动访问:',
                      h('a', { href: state.connectUrl, target: '_blank', rel: 'noopener', style: S.link }, state.connectUrl))
                  : null,
                state.connectMessage ? h('p', { style: S.line }, state.connectMessage) : null)
            : null),
        state.state === 'connected'
          ? (state.refreshError
              ? h('div', { style: S.warnBox }, state.refreshError)
              : null)
          : null,
        state.state === 'connected' && overview === null && !state.refreshError
          ? h('div', { style: S.card }, h('p', { style: S.line }, '正在加载工单板…'))
          : null,
        state.state === 'connected' && overview !== null
          ? h('div', null,
              h(FilterBar, { overview: overview, active: filter, onSelect: setFilter }),
              filter === 'mine' ? h(InboxGroups, { overview: overview, items: overview.inbox ? overview.inbox.items : [] }) : null,
              filter === 'guest' ? h(InboxGroups, { overview: overview, items: guestTurnItems(overview) }) : null,
              filter === 'collaborating' ? h(CollaboratingList, { overview: overview }) : null,
              h(NotificationsCard, {
                state: state,
                open: notificationsOpen,
                onToggle: function () { setNotificationsOpen(!notificationsOpen) },
              }))
          : null,
        h('div', { style: S.card },
          h('h3', { style: S.title }, '事件流'),
          h('ul', { style: S.events },
            (state.recentEvents || []).map(function (ev, i) {
              return h('li', { key: i },
                h('span', { style: S.evTime }, ev.at.slice(11, 19)),
                '[', ev.kind, '] ', ev.detail)
            }))))
    }

    return {
      name: 'taskboard-dsh',
      inject: ['slots'],
      apply: function (ctx) {
        // 向别人的槽贡献组件必须走 slots.inject(ferryman-dsh 实证形态;
        // 直接 register 主区不渲染,2026-11-20 train3060 实测空白)
        var slots = ctx && ctx.slots
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          console.warn('[taskboard-dsh] 宿主缺 slots 面,客户端半边自降级')
          return
        }
        // sidebarRight 运行时探测(host 侧 webServer 同款策略:inject 声明会踩
        // fiber epoch 连坐;探测不到 = 全部工单走外部浏览器打开)
        try {
          var sidebarRight = ctx.get && ctx.get('sidebarRight')
          if (sidebarRight && typeof sidebarRight.openTab === 'function') {
            sidebarRightService = sidebarRight
          }
        } catch (e) {
          console.warn('[taskboard-dsh] sidebarRight 探测失败:', e)
        }
        function registerAll() {
          var stopEntry = slots.inject('sidebar.panellist', function () {
            // 左栏面板行(id 即 MainPanelId;点击由 SidebarRoot → ctx.layout.selectPanel)
            return slots.register({
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 500,
              label: '工单板',
            }, PanelEntry)
          })
          var stopBody = slots.inject('main', function () {
            // 主区面板主体(main keyed by panelId;AppFrame renderSlot entryKey)
            return slots.register({ name: 'main', key: PANEL_ID }, TaskboardPanel)
          })
          return function () {
            if (typeof stopEntry === 'function') stopEntry()
            if (typeof stopBody === 'function') stopBody()
          }
        }
        if (typeof ctx.effect === 'function') {
          ctx.effect(registerAll, 'taskboard-dsh: panels')
        } else {
          registerAll()
        }
        ensurePolling()
      },
    }
  }
})(typeof window !== 'undefined' ? window : globalThis)
