# Taskboard Orca 插件

「工单板」的 Orca 侧边栏插件：提供提醒未读数、收件箱和协作概览；工单详情不在插件内展示，一律在浏览器打开。

当前是 **mock 阶段**：`src/mock.ts` 按平台 API 的响应形状提供中文示例数据，不发起网络请求，也未实现连接账号、SSE 或真实标已读 HTTP 调用。面板与 worker 的契约在 `src/protocol.ts`，聚合转换在 `src/overview.ts`，数据源边界在 `src/source.ts`。

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
