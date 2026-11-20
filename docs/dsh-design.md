# Taskboard DSH 插件:设计决定

日期:2026-11-20,由 `/grill-with-docs` 拍板,同日经官方订阅原生 CC 独立审核修订(报告 `/tmp/dsh-review/review-report.md`,证据已并入下列条目)。可行性评估见 `dsh-port-assessment.md`,Orca 版决定见 `design.md`。术语沿用 agent-taskboard `GLOSSARY.md`。

## 定位

- 把本插件(Orca 版)的工单提醒与概览在 **DSH(DeepSeek Harness)** 上重现,复用同一批平台只读接口与聚合逻辑。
- 第一版**只在 train3060 上给本人验证**(Orca 版同路径);部门推广后置。train3060:DSH 桌面端 + dsh-web 双形态常驻(自启已配好),DSH CLI v0.2.2-rc.5。
- 与 Orca 版**双端并存**:平台 SSE 在线判定按成员引用计数(`internal/httpapi/notifications_stream.go`),多客户端同时持流无障碍,任一在线即「客户端在线」。**联动风险(审核 P1-1)**:DSH 持流会让平台判「客户端在线」、网页停止弹提醒——若 DSH 侧提醒能力弱于网页,装了反而更安静。这使「DSH 侧系统通知」从锦上添花变为接近必需(见拍板 6)。

## 已拍板(2026-11-20,含审核修订)

1. **插件路线:静态持久 bundle,不用动态插件**。动态插件(DynamicCordisRunner)跑 `node:vm` 沙箱、session-scoped、重启即失、`ctx.web` 仅非流式 fetch——审核确认无持久化口子(cordis-host-runner README)。官方标准路线本就是 Plugin Manager 装持久 bundle(「Standard and Creator modes install persistent plugins」),动态卡片已被官方称为 historical——此决定与官方路线一致。
2. **仓库:同仓 monorepo**。抽 `src/core/`(overview/http/protocol/source,~630 行纯逻辑,连同单测),Orca 壳与 DSH 壳(`packages/dsh/`)并列。Orca 发版流程不变。
3. **部署形态(审核 P0-3 修订):bundle + profile 级本地路径安装**。插件做成 bundle(package.json 声明 `dsh.bundle.patch` + `engines.dsh`,客户端侧按 `dsh.client` 规范导出预构建 `exports["./client"]`,外部依赖按宿主 baseline externalize——参照 ferryman-dsh 的 `client.js` 先例),**Desktop 插件页按本地绝对路径安装**(link: 依赖,git pull + 重启即更新,这就是官方的「活树」形态);web profile 用 `dsh plugin --profile web add <路径>`。入口沿用 ferryman 的 `index.mjs` 垫片经验(cordis loader 不吃 `.ts` 的 main)。**不用** home patch(对所有 profile 生效,会让 headless/acp 也加载,见拍板 4),**不做** node_modules junction(loader 按 bundle 依赖图做不可变解析,未声明条目可能解析不到/被插件页 install 清掉)。First version 只装 desktop profile。
4. **宿主范围(审核 P1-2/P1-3 修订):只在 desktop profile 激活**。双宿主同时加载会共享状态:storageDomain 无跨进程写锁、无跨进程变更可见(storage-json/storage-domain README),Last-Event-ID 会互相覆盖、凭证各拿旧值。只装 desktop 一处,问题不存在;headless/acp 必须确认未加载(否则无界面进程持流,平台判在线、用户看不到)。web profile 的挂载验证(探针验收 4)装一次确认后卸掉或停用。
5. **PKCE:第一版自 listen 随机端口**(审核确认成立:平台 port 只校验 1~65535,回调固定 `http://127.0.0.1:<port>/cb`;Desktop 宿主以 `ELECTRON_RUN_AS_NODE` 子进程跑完整 Node,可 listen)。备选「DSH webserver 挂 `/cb`」后置,记录更正:Desktop 宿主端口是 OS 分配的、不在 3080(3080 只属 dsh-web),该方案只对 web 形态可行。
6. **OS 通知(审核 P1-1 修订):待探针定,倾向可行**。评估报告「主进程无 Notification」有事实错误(`apps/desktop/src/update-attention.ts` 有,但只服务更新提示);真正通路是 renderer 侧 HTML5 `new Notification`:Desktop 权限处理器对除麦克风外一律放行(`apps/desktop/src/microphone-permissions.ts:17-24`),窗口收托盘后 webContents 仍活着,全库无 `window.Notification` 覆盖、无 CSP——**很可能第一版就能弹系统通知**。host 半边兜底:子进程调系统通知(Windows PowerShell toast / macOS osascript)。探针必验此项;跑通则本条从「接受应用内」升级为「renderer 系统通知 + 应用内 badge」,upstream issue(拍板 10)相应取消或改诉求(如 tray badge)。
7. **重复提醒:接受**。Orca 版与 DSH 版同时在线各自呈现,不做开关(已知非目标)。
8. **点开工单:默认内嵌,但分形态(审核 P2-5 修订)**。Desktop `<webview>` 是独立会话,内嵌打开前需在 DSH 内嵌浏览器里登录一次平台(平台 cookie `SameSite=Lax`);**dsh-web 形态 iframe 载体属跨站子框架、带不上 Lax cookie,内嵌永远未登录——web 形态默认外部浏览器打开**。Desktop 形态 `openTab('browser', {params:{url}})` 内嵌打开,「外部打开」保留二级动作。
9. **面板与徽章位置(审核 P0-1/P0-2 修订):左栏全局面板**。原定的右栏 tab 是**会话级** surface(「All tabs require a foreground Session」),没开会话就看不到也打不开,不适合常驻概览;`sidebar.toggle.badge` 是 single 槽已被 DesktopUpdateBadge 占用且仅折叠时渲染。改为:`sidebar.panellist` 注册图标行(root 作用域、不依赖会话)+ `main` keyed 槽放面板主体(三类筛选复刻 Orca 拍板稿)+ `sidebar.panellist.trailing` 放未读计数(展开/折叠都显示,即 Orca 状态栏未读数等价物)。**注意:`.trailing` 在 0.2.0-rc.2 快照里不存在,动手前对照 train3060 0.2.2-rc.5 打包产物确认;不在则退化为图标行本身着色/图标角标**。右栏只保留「内嵌打开工单页」。
10. **upstream issue:视探针结果**(拍板 6 跑通则取消或改为 tray badge/插件通知 API 诉求;仍要提则英文、单一诉求)。
11. **开发-部署工作流:mini6 为主开发** → push GitHub → train3060 `git pull` + Desktop 插件页已 link 的本地路径自动生效(重启 DSH)。GitHub 直 pull 不通退 git bundle relay。

## 凭证与状态(审核 P1-2 修订)

- tbc_ 凭证:存 `ctx.credentials` 记录(owner=插件 id)——评估说它「LLM key 专用」是错的,它是开放给插件的通用 seam(`readRecord/modifyRecord/deleteRecord`),有跨进程写锁 + 文件变化自动重载;但**同样不加密**(credentials-local 是仅本用户可读的私有文件),插件 README 明示明文。
- Last-Event-ID、平台地址:storageDomain(单宿主后无跨进程问题)。

## 探针(host-only 起步,含客户端徽章)

范围:**bundle 构建链 + Desktop 插件页本地路径安装 + host 侧 PKCE(自 listen,确认 URL 打印到控制台手动复制——平台无手工签发 tbc_ 的口)+ SSE 连真实平台 + 左栏面板计数变化 + renderer HTML5 Notification 弹系统通知验证**。

验收标准(审核修订版):
1. bundle 经 Desktop 插件页按本地路径安装后,插件清单显示 active;
2. 左栏面板计数随 SSE 事件变化,左栏展开与折叠两种状态都验;
3. 断流重连补发不重复(Last-Event-ID 存 storageDomain);
4. headless、acp 宿主**未**加载插件;web profile 装一次确认挂载不报错;
5. renderer `new Notification` 在 Windows Desktop 上弹出系统通知,点击可唤起窗口(决定拍板 6/10 走向);
6. 客户端 bundle 构建、加载链跑通,并演练一次回滚(移除 bundle 后 DSH 界面恢复正常)。

工作量 **2~2.5 天**(原估 1~1.5 天漏了客户端构建链:徽章本身是客户端组件,绕不开 tsdown/externals/React 共享;且客户端包损坏会让整个 clientModules 报错、DSH 界面起不来,必须有回滚预案)。

## MVP(探针通过后)

左栏面板(三类筛选复刻 + `panellist.trailing` 计数)+ 连接账号(面板按钮触发 PKCE)+ 标已读 + 断开连接 + 401 清凭证回连接触发态(照搬 Orca 版状态机)+ 通知呈现(系统通知若探针跑通则含弹通知,否则 badge + 面板列表)。估计 3~5 天。

## MVP 实战结论(2026-11-20 深夜,train3060 web 实验场 + desktop 全链路验证后追加)

17. **内嵌打开的实做面**:`ctx.sidebarRight.openTab('browser', {params:{url}})`(ui-sidebar-right service)有无 session 版本——自解析 on-screen session;browser kind **Desktop 默认启用、Web profile 默认禁用**。client 侧不 inject 该服务(host 侧 epoch 连坐教训同源),apply 时 `ctx.get('sidebarRight')` 运行时探测 + try/catch,失败兜底 `window.open`——Web 形态自动落外部浏览器,与拍板 8 殊途同归。
18. **host/client 分工定型**:聚合在 host(5 路拉取 + buildOverview + 400ms 防抖 + 5 分钟兜底,全盘照搬 Orca worker.refresh),分组/三类过滤在 client(`src/overview.ts` 纯函数的 JS 副本,client 零构建链不引 TS)。SSE 通知→`pendingNotifications` 队列→client 轮询弹出→POST ack 清空(系统通知由 renderer 消费,host 不弹)。
19. **实验场实操**(Start-Job 的坑):PowerShell job 随 sshmgr 会话死——宿主活不过单条命令;`Start-Process` detached 同样被会话回收。**正解:`exec_background` 三件套跑宿主**(broker 维持连接),配合 `forward_port` 隧道 + 本机 Playwright 截图验证 client 半边(快照 yml 比截图更可靠:三类计数「14 等我处理/4 访客新回复/0 协作中」、分组「程宇恒 ×3 另等他 3」全部可 grep)。
20. **共享状态文件的雷**:web 实验宿主与 desktop 共用 `~/.dsh/taskboard-plugin.json`——实验场里**不能点「断开连接」**(会 revoke 平台凭证,desktop 一起失效),「标已读」也动真数据;两者只在 host 冒烟里验证。双宿主并存的 SSE 引用计数无障碍(设计已述)。

## 已知非目标

- 双端提醒去重/开关;
- 部门分发(推广期注记:master 已有实验性 plugin-market——自定义静态 JSON 索引,可放 GitLab Pages,支持 npm/Git 来源安装,「install 脚手架」届时直接换团队索引);
- 动态插件形态;
- web/headless 常驻。

## 探针实战结论(2026-11-20 深夜,train3060 全链路打通后追加)

12. **插件保活三件套(cordis fiber 存活条件,官方文档未写)**。宿主 loader 对「常驻 host 插件」的存活判定,实测排除法五轮才定案:
    - 同步 apply 返回 undefined、只挂 ctx.effect → **apply 后 1~2ms 被 Include 接管序列静默 dispose**(无诊断、无重放,任何宿主、任何挂载形态一致);
    - `inject: ['webServer']` 声明服务依赖 → 服务提供者在启动期被重组时 impl.uid 变化直接传导成 fiber `_unload()`(cordis fiber.ts `_setEpoch` 机制),同样无人 restart;
    - apply 写成挂住的 async generator(fiber inertia 常驻)→ **阻塞宿主 ready 序列,DSH 主窗口不再出现**(还连带 host crash 一次)——不可用;
    - 单挂 `ctx.on` 事件 → 仍被杀;
    - **正解(= ferryman-dsh 生产形态的完整模仿)**:`ctx.on` 挂事件 + **`ctx.provide` 注册服务(provider 身份是强存活资源)** + **apply 返回 disposer**。三件齐 → fiber 常驻、SSE 持流、不阻塞宿主。**归因二分(disposer vs provide)未做,工程优先**;素材足够提 upstream issue(publish.md 的最小三件套示例跑不通常驻插件)。
13. **宿主服务就绪时序**:webServer 服务就绪晚于插件加载(启动序),`ctx.get('webServer')` 首探 undefined 属常态——**运行时探测 + 5 秒重试**是必要形态(inject 声明会踩第 12 条的 epoch 连坐)。
14. **实际部署形态(desktop)**:`dependencies` 里 `link:` 装包(pnpm 装)+ profile patch `cordis.patch.yml` 的 insert 行激活(`name: ./node_modules/taskboard-dsh/index.mjs`)——insert 路径依赖 node_modules 的 link,两者配套,bundles 列表不进。更新 = git pull + 重启 DSH。
15. **实验场惯例**:desktop 动前先在 web profile 前台宿主(`dsh --profile web --port 3082 --no-open`,Start-Job 抓 stdout)做实验——同版本同 loader 行为,stdout 可见,不碰用户桌面。实验完卸干净(web 回归无 taskboard 状态)。
16. **Windows 踩坑两枚**:PowerShell 5.1 的 `ConvertTo-Json | Set-Content` 默认写 UTF-16 会毒化 package.json(修法:upload_content 直接写 UTF-8);sshmgr exec 的命令带 `2>&1` 偶触发 SHELL-MISMATCH 误判(简化命令即过)。

## 风险跟踪

- train3060 为 v0.2.2-rc.5,评估/审核基于 master(2e39e70)与 0.2.0-rc.2 快照:**动手前逐个对照该版本打包产物确认槽位与 API**(尤其 `sidebar.panellist.trailing`);
- cordis loader 入口解析细节(`index.mjs` 垫片照抄 ferryman 注释);
- 高频发版面:参照 ferryman ADR-0026 的验证纪律意识,插件失效可能无声,先不做自动探针。
