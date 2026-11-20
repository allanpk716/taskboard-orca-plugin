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
   - 状态栏常驻显示未读数，有未读时变色，点击打开插件面板。
   - 面板里有通知列表，点「打开」后用 `shell.openExternal` 打开工单并把该条标为已读；另有「全部已读」。已读状态与网页共用。
3. **网页避让**：插件持有通知流连接时算作「客户端在线」，网页铃铛不再弹浏览器提醒。
4. **凭证**：沿用工单板的客户端凭证（`tbc_`），服务端把 `client_scope` 扩大到新增的只读「我的概览」（收件箱、协作中、在等他三份清单和计数），仍然不能读说明、回复、附件，不能改任何东西。
5. **仓库**：单独建仓库（本仓库），独立打 `vX.Y.Z` tag，通过 `orca plugin install allanpk716/taskboard-orca-plugin` 安装。

## 技术约束（Orca 1.4.263）

- 面板沙箱不能联网，联网走 `trusted-worker` 的 Node worker；面板通过 `plugin.request` 向 worker 取数据，worker 用 `orca.panels.post` 推送更新。
- 带 `statusBarItems` 的插件，worker 在启用期间常驻，可以随时调用 `statusBar.update`。
- `shell.openExternal` 只能由面板里用户亲手点击触发。
- 凭证存放在 `secrets:own`（加密存储）。

## 服务端配套（在 agent-taskboard 仓库做）

- 新增「我的概览」只读接口，并把它加进 `client_scope`。
- 下线桌面客户端：删 `cmd/taskboard-client` 及 Windows 相关代码，Release 不再产出 exe，`latest.json` 去掉 `client` 条目，去掉网页和文档里的下载入口。客户端凭证的签发、撤销和通知流接口保留。已安装的旧 exe 不主动作废。

## 待定

见 grill 后续轮次，结论补到这里。
