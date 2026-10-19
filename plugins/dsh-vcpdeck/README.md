# @vcpdeck/dsh-panel

在 DSH（DeepSeek Harness）里查看 VCPDeck 的机器，并一键打开目标机的**远程 DSH WebUI**。
对应 [ADR-0059](../../docs/adr/0059-remote-dsh-webui-channel.md)。

## 它做什么

- 侧栏新增一个 **VCPDeck** 图标，打开一个全局面板；
- 面板经 Host 半（本机服务端）代理到 VCPDeck Server，列出机器与其在线状态；
- 对已登记 `dshWebUrl` 的机器显示「打开 DSH」，在新标签页打开该机的完整 DSH 界面。

## 前置条件

1. 目标机上跑 `dsh --profile web`（ADR-0059 决策 2 的启动契约）：
   ```bash
   dsh --profile web --host 127.0.0.1 --port <端口> \
     --public-url <对外的 URL> --trusted-host <对外的 authority> --no-open
   ```
   缺 `--trusted-host` 时该实例的 `/api` 会被 browser-trust 门禁拒绝（403）。
2. 该端口经 VCPDeck 的 FRP 或内网可达——**只允许私网**，`dsh web` 等价于一台开发机的 shell 权限。
3. 在 VCPDeck 侧登记地址：
   ```bash
   curl -X PUT http://<vcpdeck>:3001/api/clients/<clientId>/dsh-web \
     -H 'content-type: application/json' -H "authorization: Bearer <token>" \
     -d '{"url":"http://<对外地址>/?token=<dsh-token>"}'
   ```

## 安装

```bash
# 用 link: 而不是 file:：file: 会把包复制进 profile，改代码后不生效
dsh plugin --profile web add "link:<此目录的绝对路径>"
```

然后重启 DSH Web（或让它热加载）。

## 配置

Host 半从插件行 `config` 或环境变量读取：

| 配置 | 环境变量 | 默认 |
| --- | --- | --- |
| `serverUrl` | `VCPDECK_API_URL` | `http://127.0.0.1:3001` |
| `token` | `VCPDECK_API_TOKEN` | 空（必填） |

在 `cordis.patch.yml` 里写：

```yaml
- insert:
    - id: vcpdeck-panel
      name: '@vcpdeck/dsh-panel'
      config:
        serverUrl: http://127.0.0.1:3001
        token: vcp_xxxxxxxx
```

token 只在 Host 半使用，**不会进入浏览器**；接口只回传白名单字段（clientId/name/hostname/online/lastHeartbeatAt/dshWebUrl）。

## 安全边界

- 面板只做"展示 + 打开链接"，不代理开发流量，也不缓存 token；
- `dshWebUrl` 可能含一次性 token，因此只在用户点击时打开，不打印到日志；
- 插件不读取其他插件的 DOM 或样式，只注册自己的 slot。
