# taskboard-dsh（探针）

工单板的 DSH 插件——探针阶段:连接账号(回环 PKCE)+ SSE 未读 + 左栏面板计数 + renderer 系统通知验证。设计决定见 `docs/dsh-design.md`。

## 结构

- `index.mjs` — host 入口垫片(cordis loader 不吃 `.ts` main)
- `host/index.ts` — host 半边:PKCE + SSE 状态机 + webServer 路由(`/api/taskboard/*`),存储 = `~/.dsh/taskboard-plugin.json`(探针直接 JSON 文件,零 API 风险)
- `client.js` — 浏览器半边(零构建链):`sidebar.panellist` 图标行(未读角标画在图标上,0.2.2-rc.5 无 `.trailing` 槽)+ `main` keyed 面板主体 + 轮询 host + `new Notification` 系统通知
- `cordis.patch.yml` — bundle 激活声明(`platformUrl` 在 config 里改)

## 安装(train3060,desktop profile)

```powershell
# 仓库先 clone/pull 到本地,然后:
dsh plugin --profile desktop add <仓库>\packages\dsh
# 重启 DSH 桌面端(或等 patchReload)
```

安装后 profile 的 `package.json` 会长出 `"taskboard-dsh": "link:<路径>"` 并追加 `dsh.profile.bundles`。更新 = `git pull` + 重启 DSH。

## 验收(docs/dsh-design.md 探针标准)

1. 插件清单 active:`dsh plugin --profile desktop list`(或插件页看到工单板面板行)
2. 左栏出现「工单板」面板行,铃铛角标随 SSE 事件变化(展开/折叠两种状态都看)
3. 连接账号:面板点「连接账号」(浏览器开确认页,回调回本机随机端口)→ 已连接;断网/杀流后重连,补发不重复(Last-Event-ID 持久在状态文件)
4. headless/acp 宿主未加载(只装了 desktop profile;`dsh plugin --profile web add` 装一次验证 web 不报错后可移除)
5. 新通知来时 Windows 弹出系统通知(renderer HTML5 Notification,点击聚焦窗口)
6. 回滚:插件页移除 bundle(或 profile package.json 删行 + bundles 去名 + 重启),DSH 界面恢复正常

## 本地冒烟(mini6,不依赖 DSH)

```sh
node packages/dsh/test/smoke.mjs          # host:假 ctx + 假 webServer,验状态面/连接流程骨架
node --check packages/dsh/client.js       # client 语法
node packages/dsh/test/client-smoke.mjs   # client:假 ModuleLoader + 假 react,验 factory/组件
```
