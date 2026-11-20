# Taskboard Orca 插件

「工单板」的 Orca 侧边栏插件：提供提醒未读数、收件箱和协作概览；工单详情不在插件内展示，一律在浏览器打开。

已接真实平台：地址校验、回环 PKCE 连接账号、SSE 通知流与桌面通知、标已读、断开连接。面板与 worker 的契约在 `src/protocol.ts`，聚合转换在 `src/overview.ts`，数据源边界在 `src/source.ts`；`src/mock.ts` 只给测试和截图场景用。

## 安装与更新

在 Orca 主机上执行（远程使用时装在被连接的那台主机上，目前是 train3060）：

```sh
orca plugin install allanpk716/taskboard-orca-plugin   # 首次，按提示带 --approve <fingerprint> 重跑
orca plugin update allanpk716.taskboard                # 之后取最新的 vX.Y.Z tag
```

发版：改 `orca-plugin.json` 的 `version`，提交后打 `v<version>` tag 并 push。

「连接账号」要在主机本机上操作：worker 在主机的 127.0.0.1 上接浏览器回调，远程客户端打开的浏览器回不到主机。

## 开发

```sh
orca plugin types . --json
npx tsc -p .
orca plugin test . --json
orca plugin validate . --json
orca plugin check . --json
```

可用场景截图：

```sh
orca plugin shot . --scenario connected --panel taskboard
orca plugin shot . --scenario unconfigured --panel taskboard
orca plugin shot . --scenario disconnected --panel taskboard
orca plugin shot . --scenario expired --panel taskboard
```

如果插件尚未获得本机授权，Orca 会返回 `approval_required`（退出码 3）。不要自动批准，由使用者确认后再处理。
