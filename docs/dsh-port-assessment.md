# DSH 移植评估：本插件能否在 DeepSeek Harness 上实现

日期：2026-11-20。评估对象：把本插件（taskboard-orca-plugin v0.2.0）实现的工单提醒与概览，在 DSH（DeepSeek Harness 桌面端，部门部分成员使用）上重现。

依据：deepseek-harness 官方仓库 master（docs/subsystems + apps/desktop + packages 源码，2026-11-20 拉取）、本机 dsh-desktop-runtime 0.2.0-rc.2 node_modules 快照、既有 DSH 调研（`research_things/dsh/`、`research_things/20261120_Orca调研汇总/20261111_1346_dsh能否被Orca调用_本机实测.md`）。

## 一句话结论

**大部分能力可以移植，且必须走「静态组合插件」路线（cordis.yml 挂载，hypatia 先例）；动态插件路线（vm 沙箱）重启即失、无网络流，直接排除。两个真实缺口：OS 级桌面通知没有 API（只能应用内提醒），凭证没有加密存储（明文 KV）。** 面板 UI 反而比 Orca 版更强：DSH 右侧栏有完整的插件 tab 体系 + 内嵌浏览器。

## DSH 扩展机制全景（与移植相关的部分）

DSH 是"Everything is a Plugin"的 Cordis（Koishi 系）架构，桌面端 = Electron 外壳（apps/desktop）+ 宿主 Node 进程（webserver 监听 127.0.0.1:3080）+ Web Client（React）。插件分两条路线：

| 路线 | 运行环境 | 能力 | 生命周期 | 对本插件 |
|---|---|---|---|---|
| **静态组合**（cordis.yml / profile 挂载包） | 宿主 Node 进程内，完整 Cordis ctx + 完整 Node | 无限制（可 listen 端口、持 SSE、任意 npm） | 重启仍在 | ✅ 唯一可行路线（hypatia 先例：`research_things/dsh/20261005_0140`） |
| **动态插件**（`ctx.dynamicCordisRunner`） | `node:vm` 沙箱，Node globals 被剥掉，只有 `ctx.fs`/`ctx.web`/timer | `ctx.web` 仅有非流式 fetch；无 http 监听 | **session-scoped，重启即失**（官方文档原文） | ❌ 排除：无常驻、无流、无回调监听 |

Web UI 侧统一走 **slots**（类型化 React 组合体系，`docs/subsystems/slots.md`）：插件用 `ctx.slots.register/inject` 注入组件，slot 目录全量在 `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`。

## 功能逐项映射

本插件 12 项能力 → DSH 对应物：

| # | 本插件能力（Orca 实现） | DSH 对应 | 判定 |
|---|---|---|---|
| 1 | **概览面板**：三类筛选 + 按人分组列表（panel.tsx，Orca components） | `ctx.sidebarRightTabs.register({kind, guide})` 注册 tab 类型 + `sidebar.right.pane.tab` slot 供 body（React）。extension 优先级高于 builtin；guide 页可放「工单板」入口卡。session 级 surface，docking/浮动/分栏免费获得 | ✅ 可行且更强 |
| 2 | **在浏览器打开工单**（shell.openExternal） | ①Electron `setWindowOpenHandler`：http(s) 链接默认 `shell.openExternal`；②`ctx.sidebarRight.openTab('browser', {params:{url}})`——右侧栏内嵌浏览器直接开工单页（接受回环与公网 HTTP(S)）。产品定位「详情跳浏览器」在 DSH 可以升格为「侧栏内嵌」 | ✅ 更强 |
| 3 | **常驻 worker**（trusted-worker，状态栏项保活） | 静态组合插件在宿主进程内常驻，注入 `statusBarItems` 的等价物不需要——插件本身常驻 | ✅ |
| 4 | **SSE 通知流 + 重连补发**（worker 持流，Last-Event-ID 存 storage） | 静态插件完整 Node：EventSource/裸 fetch 流均可；Last-Event-ID 存 `ctx.storageDomain`。平台「插件在线则网页避让」逻辑不变（SSE 连上即客户端在线） | ✅ 逻辑原样复用 |
| 5 | **概览拉取**（4 个只读接口拼装，overview.ts 323 行） | 纯 TS 无依赖，原样复用；host 半边 fetch | ✅ 原样复用 |
| 6 | **5 分钟兜底轮询** | cordis-plugin-timer（dsh 官方依赖里就有 `@deepseek-ai/cordis-plugin-timer`）或宿主 setInterval | ✅ |
| 7 | **连接账号（回环 PKCE）**：地址校验 → 127.0.0.1 监听回调 → code+verifier 换 tbc_ | 两条路：①静态插件自己 `node:http` listen（宿主全能力，与 Orca 版完全同构）；②更优雅——`ctx.webServer.register({kind:'exact', path:'/taskboard/callback', auth: 匿名})` 挂到 DSH 自己的 3080 端口（WebRoute handler 拿完整 IncomingMessage/ServerResponse），`POST /client/connect` 的 `port` 参数填 3080。⚠️ 平台侧需验证：connect 对 port 的校验是「仅拼接 URL」还是白名单（api.md 说「port 只允许本机回环监听」，3080 是本机端口，大概率过，需实测一次） | ✅ |
| 8 | **凭证加密存储**（secrets:own） | **没有插件可用的加密 secrets**。`ctx.storageDomain`（domain KV，json/sqlite 后端，明文文件）。dsh-credentials（CredentialRef）是 LLM API key 专用体系，不对插件开放 | ⚠️ 降级：明文 KV + 文件权限（0600 用户目录） |
| 9 | **状态栏未读数**（statusBarItems + statusBar.update） | DSH 无状态栏。最接近：`sidebar.toggle.badge`（侧栏折叠按钮上的徽章 slot）+ `sidebar.panel.trailing`；未连接态靠面板内状态行 | ⚠️ 部分等价（应用内可见，非全局常驻） |
| 10 | **OS 桌面通知**（notifications.show） | **无 API**。Electron 主进程（apps/desktop）全库无 `new Notification`；托盘（tray.ts）硬编码「打开/退出」两项，无 badge/文本接口；renderer 侧 Web Notification 无处理器（需实测确认，预期静默失败）。应用内替代：`settings.launcher.notifications` slot（账号菜单上方浮卡片，UI 形态合适但需冒充/复用该位置语义）、ui-workspace 的 Toast | ❌ 无 OS 级；应用内可做 |
| 11 | **通知列表 + 标已读**（面板内，POST /notifications/read） | 面板 tab 内照搬；「打开」动作用 #2 | ✅ |
| 12 | **401 清凭证回连接态** | 逻辑原样搬 | ✅ |

## 代码复用度

- **原样复用（~630 行平台无关纯逻辑）**：`overview.ts`（聚合/分组）、`http.ts`（平台 API 客户端 + PKCE）、`protocol.ts`（worker↔面板契约——DSH 侧 host/client 半边同样分离，契约形状直接沿用）、`source.ts`；连同单测（overview.test.ts）。
- **重写**：`worker.ts`（882 行，Orca worker 壳）→ Cordis 静态插件壳（host 半边：SSE + 轮询 + webServer 路由 + storageDomain）；`panel.tsx`（679 行，Orca components）→ React + dsh slots（client 半边）。业务状态机（连接/未连接/失效三态、补发合成规则）可对照移植。
- DSH 面板是 React 组件体系，三类筛选/按人分组的 UI 逻辑（现 mockit 拍板稿）可 1:1 重画。

## 架构草图（静态组合路线）

```
packages/taskboard-dsh-plugin/
├─ host/          # 宿主半边（静态组合，cordis.yml 挂载）
│  ├─ index.ts    # apply()：SSE 客户端、轮询 timer、webServer 回调路由、
│  │              #   storageDomain 存 Last-Event-ID/平台地址、凭证（明文+0600）
│  └─ remote.ts   # @Remote 方法：面板取 Overview、connect、disconnect、markRead
├─ client/        # Web Client 半边（React）
│  ├─ index.ts    # sidebarRightTabs.register('taskboard') + slots 注入
│  ├─ Panel.tsx   # 三类筛选面板（复刻 mockit 拍板稿）
│  └─ Badge.tsx   # sidebar.toggle.badge 未读数
└─ shared/        # overview.ts / http.ts / protocol.ts（自本仓库抽包）
```

部署：内网 git 或 npm 包 + 安装脚本写 cordis.yml（参照 hypatia 挂载记录 `research_things/dsh/20261004_1004`）。DSH 无插件市场（Plugin Manager 只管已组合条目的开关与动态插件审批）。

## 缺口、风险与缓解

1. **OS 桌面通知缺失（最大缺口）**：Orca 版的核心价值是常驻提醒；DSH 上窗口收进托盘后 badge/卡片都看不见。缓解：badge + 应用内卡片 + Toast；中期给 deepseek-harness 提 issue/PR（Electron `Notification` 是标配能力，tray badge 也是常见诉求，上游补齐成本不高）。
2. **凭证明文**：tbc_ 存 json/sqlite 明文文件。缓解：依赖宿主用户目录权限（单用户机器风险与浏览器 cookie 同级）；在插件 README 明示。
3. **分发成本**：无 `orca plugin install` 等价物，每台机器手工挂 cordis.yml。缓解：写一个 install 脚本（拷包 + 改 yml + 重启）；部门规模（个位数~十几台）可接受。
4. **connect 的 port 校验**：回调挂 DSH 3080 需平台侧实测；不行就退回自 listen 端口（与 Orca 版同构，零风险）。
5. **API 稳定性**：DSH 0.2.0-rc 系列，slots/webServer/storage 均为活跃演进面；锁定版本 + 对照本机 `.d.ts`（调研惯例：写前对照本机版本的类型声明）。
6. **平台配套不变**：#348（4 个只读接口放开 client_scope）与网页避让逻辑与客户端形态无关，DSH 版直接受益。

## 建议路线（若决定做）

1. 先做一个 host-only 探针插件（静态组合）：SSE 连上真实平台、badge 出未读数——一天内可验证最大风险项（静态组合 + SSE + badge）。
2. 第 1 步通过后：面板 tab + 三类筛选（复用 overview.ts），PKCE 用自 listen 端口（稳妥版）。
3. 最后：webServer 回调路由（替代自 listen）、应用内通知卡片、（上游可用后）OS 通知。
4. 全程沿用本仓库 mockit 拍板稿，面板 UI 不重新设计。

工作量直觉：探针 1 天，MVP（面板+badge+SSE+PKCE）3~5 天，含部署脚手架 1 周——Orca 版从零到 v0.2.0 的量级相当。
