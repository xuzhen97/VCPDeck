# ADR-0061：退役远程 DSH WebUI 通道

- 状态：Accepted
- 日期：2026-10-29
- 决策者：项目维护者
- 关联：[ADR-0059](./0059-remote-dsh-webui-channel.md)（本 ADR 使其 Superseded）、[ADR-0060](./0060-retire-rds-consolidate-a2a.md)（RDS 退役）、[ADR-0049](./0049-retire-pi-dsh-integrations-and-focus-on-core-capabilities.md)（Pi／DSH 专用集成退役）

## 背景

ADR-0059 把「远程 DSH WebUI」做成 VCPDeck 的一条跨机开发通道：`Client.dshWebUrl` 登记入口、机器页「开发」tab 与全局 `/develop` 页做目录、`POST /api/clients/:id/dsh-web/start` 由 Server 分配 loopback 端口并命令 Client 代起 `dsh web`、自动建 FRP 映射、`dshweb:command`/`dshweb:result` 事件对、`plugins/dsh-vcpdeck`（`@vcpdeck/dsh-panel`）在 DSH 侧栏列出机器并一键打开。

实际使用中这条通道没有产生价值，原因有三：

1. **前提不成立**：整条链依赖目标机已装 `dsh` 且版本兼容——未装即报「目标机启动 dsh web 失败（检查本机是否装了 dsh）」，机器卡片上直接显示红色失败。能在目标机上装并跑 `dsh web` 的操作者，本来就能在那台机器上直接打开 DSH，不需要 VCPDeck 转一道手。
2. **维护成本高于收益**：为了「登记一个 URL + 代起一个进程」，牵扯 Client capability（`dsh-web`）、5 个 Client 字段（`dshWebUrl/dshWebState/dshWebMode/dshWebPort/dshWebFrpMappingId`）、一套跨运行时命令/回执协议、4 个 REST 端点、一个前端页面 + 一个机器 tab + 一个 DSH 侧栏插件，以及它们各自的测试与文档；而它承载的唯一价值是「把链接放到另一个窗口里」。
3. **与 ADR-0049 的方向相悖**：ADR-0049 已决定 VCPDeck 不再承担 Pi／DSH 专用集成托管。0060 退役 RDS 后，ADR-0059 把「人工开发」作为最后一块 DSH 专用面保留；本次认定这块面同样应当退出。

## 决策

1. **整条通道退役**，一次性删除：

   | 层 | 删除内容 |
   | --- | --- |
   | Shared | `dsh-web.ts`／`client-dsh-web.ts` 及其测试、`DSH_WEB_URL_MAX_LENGTH`、`parseClientDshWebUrl`、`parseDshWebCommand(Result)`、`DshWebState`／`DshWebMode`、`Events.DSH_WEB_COMMAND`／`DSH_WEB_RESULT`、`ClientInfo` 上的 `dshWebUrl/dshWebState/dshWebMode/dshWebPort` |
   | Server | `src/dsh-web/`（`DshWebService` 及其测试）、Events 里的 5 个 `/dsh-web` 端点、`DshWebService` 注入与离线收敛调用、`ClientService.setDshWebUrl`、`INVALID_DSH_WEB_URL` |
   | Client | `src/dsh-web/`（`dsh-web-host` 及其测试）、`dshweb:command` 处理器、`dsh-web` capability 声明 |
   | SDK／Frontend | `clients.setDshWebUrl/startDshWeb/stopDshWeb/detachDshWeb` 与 `DshWebStatus`；`/develop` 页、机器「开发」tab、侧栏「开发」模块、卡片快捷入口 |
   | DSH 插件 | `plugins/dsh-vcpdeck/`（`@vcpdeck/dsh-panel`，其唯一职责就是读 `dshWebUrl` 并打开远程 WebUI） |
   | 数据 | `Client` 的 5 个 `dshWeb*` 列（迁移 `20261029000000_client_drop_dsh_web`） |

2. **不提供替代品**。跨机人工开发回到「操作者直接连到目标机跑 DSH」：VCPDeck 的职责是执行、文件、终端、FRP 与 agent 任务，不代理另一个产品的前端。需要把目标机端口暴露出来时，用已有的 FRP 映射（ADR-0060 决策 3 的同一理由）。

3. **不保留兼容层**。`dshWebUrl` 登记值随列一起丢弃。旧 Client 升级后不再上报 `dsh-web` capability；旧 Client 若仍声明该 capability，Server 只把它当未知能力字符串保留在 `capabilities` 里，不解析、不消费。`dshweb:*` 事件常量已删，Socket.IO 对未注册事件的投递会被忽略，不会让旧 Client 断连。

4. **保留 ACP 相关的 `dsh`**。本 ADR 只退役「远程 DSH WebUI 通道」；`dsh` 作为 **A2A/ACP agent 的 `agentId`** 及其启动链路（agent command、windows-launcher、acp-bridge、agent-registry）是另一套东西，属于 ADR-0057 的范畴，继续保留。

## 后果

- 正面：删除前端一个模块页与一个机器 tab、Server 一个服务与 5 个端点、Client 一个宿主与一组事件、SDK 4 个方法、DSH 侧一个插件包，以及 `Client` 5 个列；`Client` 重新只承载「执行／文件／终端／FRP／ACP 宿主」这些被真实使用的能力，与 ADR-0049／ADR-0060 的方向一致。
- 负面：失去「在一个页面里看到所有机器并能直接跳到各自的 DSH」的便利。该便利的前提是机器都装了 dsh，而实际环境并不满足；操作者改为直接访问目标机。
- 风险：曾登记过 `dshWebUrl` 的操作者升级后会失去该链接。地址本身可以从历史配置或目标机重新取得，且迁移只删列、不动其他数据。

## 迁移

1. 升级路径：`prisma migrate`／`db push` 会执行 `ALTER TABLE "Client" DROP COLUMN` 删除 5 个 `dshWeb*` 列。SQLite 侧不做回填——这些列没有需要保留的事实。
2. 前端：`/develop` 路由与机器 `develop` tab 消失；旧链接命中通配路由，回到 `/dashboard`。
3. DSH 插件：不再随仓库提供。已安装 `@vcpdeck/dsh-panel` 的用户应自行卸载（`dsh plugin --profile web remove @vcpdeck/dsh-panel`）；它保有调用 VCPDeck API 的 token，退役后该 token 应由操作者撤销。
4. 回退：需要恢复时必须回到本 ADR 之前的提交；数据面不回滚（列已删），重新登记即可。

## 验证

- 构建：`pnpm -r build` 通过（含 `prisma generate`）。
- 测试：`pnpm -r test` 全绿——shared 177、sdk 63、server 671（2 skipped）、client 237、frontend 216、cli 114、launcher 73、vcp-plugin 38。
- 残留检查：`grep -rn "dsh-web\|dshWeb\|DshWeb\|DSH_WEB"` 在 `packages/*/src`、`plugins/`、`docs/`（ADR 历史文件除外）无命中。
- 未执行：GitNexus `impact`／`detect_changes`（本会话不可用），改以构建、全量测试与关键字残留检查替代。
