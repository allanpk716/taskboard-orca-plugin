# Taskboard Orca 插件：设计决定

来源：2026-11-20 在 agent-taskboard 仓库的 grill 讨论。术语以 agent-taskboard 的 `GLOSSARY.md` 为准（「Orca 插件」「客户端凭证」「收件箱」「协作中」「往来对象」「通知」等）。

## 定位

- Orca 插件**接替已下线的 Windows 桌面客户端**，成为工单板唯一的常驻提醒通道。
- 只做提醒和概览，具体工单内容一律跳浏览器打开工单页。
- 面向部门所有用 Orca 的成员：每人连接自己的账号，平台地址不写死；第一版先在 mini6 上验证。

## 已拍板

1. **概览内容**：收件箱数（按原因分组）、协作中未读数、在等他数、通知未读数；外加收件箱列表（编号、标题、原因、等了多久、「在浏览器打开」按钮）。不显示说明、回复、附件。
2. **通知行为**：
   - 新通知弹出 Orca 桌面通知（标题 = 工单编号 + 标题，正文 = 原因）。Orca 的 `notifications.show` 不支持点击跳转。
   - 状态栏常驻显示未读数：已连接时用 `bell` 图标加未读数，0 条为 neutral，有未读用 `accent`；未连接时用 `plug` 图标加「工单板 未连接」。
   - 状态栏点击：Orca 没有「打开某个插件面板」的命令或 host API，状态栏项只能运行本插件的命令。先用声明式 action `sidebar.right.toggle`，搭骨架时实测右侧栏会不会停在本插件面板上；不会的话，再在「worker 调用 `orca plugin open`」和「点击不做事」之间选（2026-11-20 定）。
   - 面板里的通知列表显示最近 50 条，已读的弱化显示。点「打开」时先 `shell.openExternal`，返回 `opened: true` 才把这一条标为已读（第一次打开某个域名时 Orca 会问用户，用户拒绝就不标）；「全部已读」用 `{"up_to": latest_id}`。已读状态与网页共用。收件箱行的「在浏览器打开」只开网页，不动通知的已读状态。
   - 重连补发：worker 把 `Last-Event-ID` 存进 storage。补发阶段（收到 `hello` 之前）只有 1 条就照常弹；2 条及以上合成一条「离线期间有 N 条新通知」；第一次启动、没有 `Last-Event-ID` 时一条都不弹。
3. **网页避让**：插件持有通知流连接时算作「客户端在线」，网页铃铛不再弹浏览器提醒。
4. **凭证**：沿用工单板的客户端凭证（`tbc_`）。服务端不新做聚合接口，而是把现有只读接口放开给 `client_scope`（agent-taskboard #348）：`GET /inbox`、`GET /inbox/waiting-on-counterparts`、`GET /tickets?collaborator=me&status=open`（只放行这个精确组合）、`GET /notifications/unread`。概览由插件 worker 拉这 4 个接口拼出来。仍然不能读说明、回复、附件，不能改任何东西。
5. **仓库**：单独建仓库（本仓库，公开，带 `orca-plugin` topic），独立打 `vX.Y.Z` tag，通过 `orca plugin install allanpk716/taskboard-orca-plugin` 安装。
6. **连接账号**：沿用桌面客户端的「网页确认 + 本机回环 + PKCE」（见 agent-taskboard ADR 0004、`docs/api.md` 的 `/client/connect`、`/client/token`）：
   1. 首次打开面板时填写平台地址，用 `GET /api/v1/health` 校验（200 JSON 且 `server_version` 非空）后保存。
   2. 点「连接账号」，worker 在 `127.0.0.1` 上临时监听一个端口，面板用 `openExternal` 打开网页确认页。
   3. 浏览器回调到本机端口，worker 用 code + verifier 换取 `tbc_` 凭证，存进 `secrets`。
   4. 网页上这台设备显示为「Orca · <主机名>」。
   - **已验证可行（2026-11-20，Orca 1.4.263，worker Node v24.22.1）**：最小探针插件的 worker 用 `node:http` 在 `127.0.0.1` 上监听（随机端口 `listen(0)` 和固定端口都行），worker 内部 fetch 和外部进程（curl，模拟浏览器）发来的 `/callback?code=…&state=…` 都能收到。所以走回环 PKCE，不需要粘贴码方案，服务端也不用加接口。
7. **概览刷新**：通知流（SSE `/notifications/stream`）每来一条事件就重新拉一次概览；打开面板时拉一次；后台每 5 分钟兜底拉一次。不做秒级轮询。
8. **面板布局与状态**（2026-11-20 定）：单列滚动，从上到下是概览计数卡（收件箱按原因分组、协作中未读、在等他、通知未读）、通知列表（有未读时带「全部已读」）、收件箱列表；顶部右侧是平台地址和断开连接的菜单。没填平台地址时显示地址表单；填了但没连接时显示「连接账号」；接口返回 401 时清掉凭证，回到「连接账号」，并提示「连接已失效，请重新连接」。
9. **概览数据形状**（按第 4 条拼装）：worker 拉 4 个接口，经转换函数拼成插件内部的 `Overview`：`inbox{by_reason, items[number,title,url,reason,reason_code,trigger,last_reply_at,created_at]}`（`by_reason` 由 worker 按 `reason_code` 分组计数）、`collaborating{total,unread}`（`total` 取列表响应的 `total`，`unread` 是 `unread=true` 的条数，`limit=200`）、`waiting{total}`（取 `count`）、`unread_notifications`（取 `unread_count`）。收件箱条目不带工单页地址，插件按 `<平台地址>/t/<编号>` 拼。#348 上线前，mock 直接用这 4 个接口的真实响应形状，这样接真接口时只是把 mock 换成 HTTP。「等了多久」取 `last_reply_at`，为空时用 `created_at`。

## 技术约束（Orca 1.4.263）

- 面板沙箱不能联网，联网走 `trusted-worker` 的 Node worker；面板通过 `plugin.request` 向 worker 取数据，worker 用 `orca.panels.post` 推送更新。
- 带 `statusBarItems` 的插件，worker 在启用期间常驻，可以随时调用 `statusBar.update`。
- `shell.openExternal` 只能由面板里用户亲手点击触发。
- 凭证存放在 `secrets:own`（加密存储）。

## 服务端配套（在 agent-taskboard 仓库做）

- #348：把上述 4 个只读接口放开给 `client_scope`。
- #349 下线桌面客户端：删 `cmd/taskboard-client` 及 Windows 相关代码，Release 不再产出 exe，`latest.json` 去掉 `client` 条目，去掉网页和文档里的下载入口。客户端凭证的签发、撤销和通知流接口保留。已安装的旧 exe 不主动作废。

## 相关决定记录

agent-taskboard `docs/adr/0020-orca-plugin-replaces-desktop-client.md`。
