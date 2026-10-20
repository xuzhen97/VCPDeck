# 远程 DSH WebUI（远程开发台）

> Current。对应 [ADR-0059](../adr/0059-remote-dsh-webui-channel.md)。与 [remote-dev-session.md](./remote-dev-session.md)（RDS）并存，职责不同。

## 1. 要解决的问题

RDS 用 ACP 驱动目标机 agent，界面是自建的对话流。ACP 的定位是自动化协议（`@deepseek-ai/dsh-acp` 自述 "automation-only"），而 DSH 的界面能力分布在四十多个 `dsh-client-ui-*` 包与 Slots 体系里——用 ACP 复刻 WebUI 是结构性落后。

同时实测确认：RDS 的 ACP 会话与 `dsh web` 会话虽然同处 `$DSH_HOME/sessions`，但内置 WebUI **不列出** ACP 创建的会话，因此"嵌 WebUI 看同一条会话"不可达。

于是把两件事分开：

| 场景 | 用什么 |
| --- | --- |
| 批量、脚本、远程冒烟、需要审计与程序化取消 | **RDS（ACP）** |
| 人坐下来写代码，要看 diff / 产物 / 计划 / 审批 | **远程 DSH（本页）** |

入口有两处，指向同一份状态：跨机器落地页 `/develop`（一屏列出所有机器，直接启动/打开/停止）与机器详情页的「开发」tab。RDS 的对话式 UI 已随之删除，只保留只读运行记录。

## 2. 形态

```
你的浏览器 ──▶ VCPDeck 面板（DSH 插件）──▶ 点机器 ──▶ 新标签打开目标机完整 DSH
                     ▲ 读 /api/vcpdeck/clients            ▲ 经 FRP / 内网
                     └──── VCPDeck Server（/api/clients） │
                                                          └─ 目标机 dsh --profile web
```

- **入口**：DSH 里的 VCPDeck 插件（`sidebar.panellist` 图标 + `main` 面板）。它只做**目录与入口**，不承载开发流量。
- **数据**：插件 Host 半在本机服务端代发 `GET /api/clients`（带 API token），浏览器半只访问同源 `/api/vcpdeck/clients`——这样绕开跨站 Cookie 与 CORS。
- **地址**：VCPDeck 的 `Client.dshWebUrl` 由操作者登记（`PUT /api/clients/:clientId/dsh-web`），或在前端机器详情页的「远程 DSH」卡片里填。
- **通道**：直接经 FRP / 内网访问目标机 `dsh web`，**VCPDeck 不做反向代理**（反代是 v2，见 ADR-0059 决策 6）。

## 2.1 受管生命周期（一键启动 / 一键停止）

```
按钮「一键启动」
  → POST /api/clients/:id/dsh-web/start
    → Server 分配 loopback 端口（30000–40000 随机）
    → /client 下发 dshweb:command{action:"start",port}
    → Client 起 `dsh --profile web --host 127.0.0.1 --port <p> --no-open`，从 stdout 抓 token
    → Server 为该端口建 FRP TCP 映射，**并把返回的 dispatch 下发到 Client**（只落库建不了代理）
    → 落库 dshWebUrl = http://<publicUrl>/?token=<token>，state=running
按钮「停止并清理」
  → POST .../dsh-web/stop → 停进程（端口兜底）→ 删 FRP 映射并下发 dispatch → 清空地址/端口/状态
```

- **失败回滚**：建映射失败就立刻停掉刚起的进程，并把状态标 `failed`，避免留下"没人能访问的 dsh web"。
- **Client 重启不等于进程退出**：Client 掉线时只标 `failed` 并清空地址，**保留 `dshWebPort` 与 `dshWebFrpMappingId`**——`dsh web` 是独立进程，句柄随 Client 进程消失，端口是唯一还能定位它的线索。
- **停止以端口为准**：Client 先杀句柄，再按端口兜底——Windows 用 `netstat -ano` + `taskkill /T /F`；Linux 读 `/proc/net/tcp{,6}` 拿监听 inode、扫 `/proc/*/fd` 反查 PID（**不依赖 lsof**，精简发行版也能用），仅在 `/proc` 不可读时才退回 `lsof`；Linux 侧还会按 `/proc/<pid>/cmdline` 校验确实含 `--profile` + `web` 才杀，避免端口被复用时误伤。随后轮询确认端口释放；仍占用则报 `DSH_WEB_STOP_INCOMPLETE`，不假装成功。
- **离线时不动映射**：`deleteMapping` 需要 Client 在线确认，离线删只会留下永远 `deleting` 的记录，因此留到重连后的停止流程一起清。
- **前提**：Client 需声明 `dsh-web` 能力；Server 需有可用 `FrpsInstance`。缺任一都返回稳定错误码（`DSH_WEB_UNSUPPORTED` / `DSH_WEB_FRP_UNAVAILABLE`），不静默降级。
- 手工登记地址的路径保留：不想要受管生命周期时，仍可直接填 URL。
## 2.2 归属模式（managed / external）

同一台机器上的 `dsh web` 可能不归 VCPDeck 起。两种归属必须显式区分，否则"一键启动"会在 systemd 常驻服务旁边再起一个实例，并把操作者登记的入口覆盖掉。

| | `managed`（默认） | `external` |
|---|---|---|
| 谁起的 | VCPDeck 代起 | 目标机（systemd / docker / 手工 / 自有反代） |
| VCPDeck 做什么 | 启动、停止、建删 FRP 映射 | 只维护入口地址 |
| 点「一键启动」 | 正常代起 | **409 `DSH_WEB_EXTERNAL_MANAGED`**，并提示先停常驻实例 |
| 点「停止并清理」 | 停进程 + 删映射 + 清地址 | 等价于**解除登记**，不向 Client 发任何命令 |
| 显式解除 | — | `DELETE /api/clients/:id/dsh-web` |
| 状态值 | stopped / starting / running / failed | `external` |

- **登记即外部托管**：`PUT /dsh-web` 写地址时同时置 `dshWebMode=external`、`dshWebState=external`；清空地址则交还 `managed`。
- **入口复用注解**：表单预填与「用公网地址」快捷填入直接读 `annotations.publicAddress`（host 优先，其次 IPv4），不另造一套外网地址字段。
- **公网 + external**：实例长期在线、token 长期有效，VCPDeck 不承诺任何保护；反代必须自带 basic auth 或 mTLS。
## 3. 启动契约（不可省）

```bash
dsh --profile web \
  --host 127.0.0.1 --port <端口> \
  --public-url <对外的 URL> \
  --trusted-host <对外的 authority> \
  --no-open
```

- 缺 `--trusted-host` 时该实例的 `/api` 会被 browser-trust 门禁拒绝（403）：页面能开，但登录/会话全部不可用。
- 反代/隧道层必须固定 `Host`、不透传客户端 Host，并设置 `X-Forwarded-For` / `X-Forwarded-Proto`。社区已发生过"用 Host 判断来自本机"导致的认证绕过。
- 端口只绑 `127.0.0.1`，对外一律经 FRP 或内网。

## 4. 安全边界

- `dsh web` 等价于**一台开发机的完整 shell 能力**，鉴权只有 URL token ⇒ **只允许私网访问**；确需公网时在 FRP 前置 basic auth 或 mTLS。
- token 不写入 VCPDeck 日志、审计正文与文档；前端默认打码展示，只在点击「打开」时使用。
- Server **不探测** `dshWebUrl` 的可达性（探测会形成 SSRF 面），可达性由操作者打开时判断。
- RDS 与远程 DSH 不对同一会话双写。

## 5. 已知偏移

- 每台目标机需安装一次 DSH 插件；DSH 预览版 slot 契约变化时需要逐机适配。
- 多机时是"每台一个 URL"，靠插件面板收敛；超过 5 台或出现第二操作者时按 ADR-0059 决策 6 切反代。
- 插件面板只做展示与打开，不含日志/会话管理；这些仍以 VCPDeck 与 DSH 各自的界面为准。
- Windows 侧的端口兜底清理尚未校验进程命令行（Linux 已校验）：理论上可能误杀新占用同端口的进程，端口区间 30000–40000 与常驻实例错开的概率极低，但仍是已知风险。
- Linux 的 `/proc` 反查与命令行校验只有单元测试覆盖，**尚未在真实 Linux 目标机上验证**（含权限受限容器、`hidepid` 挂载等情况）。
- `external` 只维护"入口地址"，不含健康检查：常驻实例挂了 VCPDeck 不会知道，靠操作者打开时发现。
