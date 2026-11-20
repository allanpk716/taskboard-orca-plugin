// client.js — taskboard-dsh 的浏览器半面（零依赖手写，不引构建链；ferryman-dsh 同款形态）。
// 协议事实钉点（0.2.2-rc.5 app.asar 源码 + ferryman-dsh client.js 先例）：
//   - 分发：package.json 声明 dsh.client{platform:'web'} + exports["./client"]（本文件）
//     → 宿主扫描器编入浏览器 roster；本文件被拼进 combo 脚本，加载时自调
//     window.__ModuleLoader__.load({id, factory})——懒 CJS 模型。
//   - factory(require) 收模块表：require('react') 走平台共享模块；返回 {name, inject, apply}。
//   - 左栏面板：ctx.slots.register({name:'sidebar.panellist', id, order, label}, 组件)
//     （ui-sidebar/src/client/index.ts syncPanels：list 条目 {id→MainPanelId, order, label}；
//     PanelIcon 经 renderSlot('sidebar.panellist', {size, active}, {only: id}) 渲染本组件）。
//   - 面板主体：main 槽 keyed（AppFrame.tsx:51 renderSlot('main', {}, {entryKey: panelId})），
//     注册 {name:'main', key:'taskboard'}；点击面板行由 SidebarRoot 自调 ctx.layout.selectPanel(id)。
//   - host 数据面：同源 fetch('/api/taskboard/state')（host 半边 webServer.register 前缀路由）。
//   - 系统通知（探针验收 5）：Desktop 权限处理器除麦克风外一律放行
//     （apps/desktop/src/microphone-permissions.ts:17-24），renderer 直接 new Notification()。
// 0.2.2-rc.5 已知事实：sidebar.panellist.trailing 不存在（master 才有）——未读计数
// 画在面板图标组件自己身上（本组件即图标渲染体，完全可控）。
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
    var useRef = React.useRef

    // ---- host 状态轮询（单例 store，所有组件共享一次轮询） ----
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
        // host 路由不可达时保留上次状态；面板显示错误态
        lastState = lastState && lastState.__ok !== false
          ? lastState
          : { state: 'unreachable', platformUrl: '', unread: null, connectUrl: null, connectPhase: 'idle', connectMessage: String(e), latestNotificationId: null, recentEvents: [] }
      }
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

    // ---- 系统通知（验收 5）：未读数增加时弹一次 ----
    var notifiedFor = null
    function maybeNotify(state) {
      if (state === null || state.unread === null || state.unread <= 0) return
      var marker = state.latestNotificationId + ':' + state.unread
      if (notifiedFor === marker) return
      if (notifiedFor !== null && typeof global.Notification === 'function') {
        try {
          var permission = Notification.permission
          if (permission === 'default') void Notification.requestPermission()
          if (Notification.permission === 'granted') {
            var n = new Notification('工单板', { body: '有 ' + state.unread + ' 条未读通知' })
            n.onclick = function () { global.focus() }
          } else {
            console.warn('[taskboard-dsh] 通知权限：', permission)
          }
        } catch (e) {
          console.warn('[taskboard-dsh] Notification 失败：', e)
        }
      }
      notifiedFor = marker
    }

    // ---- 图标：铃铛 + 未读角标（panellist 组件即图标渲染体） ----
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

    // ---- 主体面板（main keyed） ----
    var S = {
      wrap: { padding: '20px', maxWidth: '560px', margin: '0 auto', fontFamily: 'system-ui, sans-serif' },
      card: {
        background: 'var(--dsw-alias-bg-layer-2, #1d2030)',
        border: '1px solid var(--dsw-alias-border-l2, #3a4160)',
        borderRadius: '14px', padding: '16px', marginBottom: '12px',
      },
      title: { fontSize: '15px', fontWeight: 600, margin: '0 0 10px', color: 'var(--dsw-alias-label-primary, #e8eaf2)' },
      line: { fontSize: '13px', lineHeight: '1.7', color: 'var(--dsw-alias-label-secondary, #9aa0b5)', wordBreak: 'break-all' },
      strong: { color: 'var(--dsw-alias-label-primary, #e8eaf2)', fontWeight: 600 },
      badge: {
        display: 'inline-block', padding: '1px 10px', borderRadius: '10px', fontSize: '12px', fontWeight: 600,
        background: 'var(--dsw-alias-accent-soft, rgba(229,72,77,.15))', color: 'var(--dsw-alias-accent, #e5484d)',
      },
      button: {
        padding: '8px 16px', borderRadius: '10px', border: 'none', cursor: 'pointer',
        fontSize: '13.5px', fontWeight: 600, marginTop: '6px',
        background: 'var(--dsw-alias-accent, #4f6bff)', color: '#fff',
      },
      link: { color: 'var(--dsw-alias-accent, #4f6bff)', wordBreak: 'break-all' },
      events: { margin: '4px 0 0', padding: '0', listStyle: 'none', fontSize: '12px', lineHeight: '1.9', color: 'var(--dsw-alias-label-tertiary, #6b7280)' },
      evTime: { marginRight: '6px', fontVariantNumeric: 'tabular-nums' },
    }

    function StateBadge(props) {
      var state = props && props.state ? props.state : ''
      var text = { connected: '已连接', waiting: '等待浏览器确认', disconnected: '未连接', expired: '连接已失效', unconfigured: '未配置', unreachable: '面板取不到 host' }[state] || state
      return h('span', { style: S.badge }, text)
    }

    function TaskboardPanel() {
      var state = useTaskboardState()
      useEffect(function () { maybeNotify(state) }, [state])
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
          console.warn('[taskboard-dsh] connect 失败：', e)
        }
      }

      return h('div', { style: S.wrap },
        h('div', { style: S.card },
          h('h2', { style: S.title }, '工单板探针 ', h(StateBadge, { state: state.state })),
          h('p', { style: S.line },
            '平台：', h('span', { style: S.strong }, state.platformUrl || '(未配置)'),
            '　未读：', h('span', { style: S.strong }, state.unread === null ? '?' : String(state.unread))),
          state.state !== 'connected'
            ? h('div', null,
                h('button', { style: S.button, onClick: onConnect, disabled: connectBusy },
                  connectBusy ? '等待浏览器确认…' : '连接账号'),
                state.connectUrl
                  ? h('p', { style: S.line }, '若浏览器没打开，手动访问：',
                      h('a', { href: state.connectUrl, target: '_blank', rel: 'noopener', style: S.link }, state.connectUrl))
                  : null,
                state.connectMessage ? h('p', { style: S.line }, state.connectMessage) : null)
            : null),
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
        // 向别人的槽贡献组件必须走 slots.inject（ferryman-dsh 实证形态;
        // 直接 register 主区不渲染,2026-11-20 train3060 实测空白）
        var slots = ctx && ctx.slots
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          console.warn('[taskboard-dsh] 宿主缺 slots 面,客户端半边自降级')
          return
        }
        function registerAll() {
          var stopEntry = slots.inject('sidebar.panellist', function () {
            // 左栏面板行（id 即 MainPanelId；点击由 SidebarRoot → ctx.layout.selectPanel）
            return slots.register({
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 500,
              label: '工单板',
            }, PanelEntry)
          })
          var stopBody = slots.inject('main', function () {
            // 主区面板主体（main keyed by panelId;AppFrame renderSlot entryKey）
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
