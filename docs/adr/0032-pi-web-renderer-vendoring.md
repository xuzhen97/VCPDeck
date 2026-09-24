# Pi Web 渲染层拷入（vendored）与 Pi UI Adapter 隔离

- Status: Proposed
- Date: 2026-09-23

## Context

VCPDeck 前端自有一套轻量 Pi 消息展示，渲染保真度（Markdown/代码 diff/工具卡/thinking 等）不足；仓库 `examples/pi-web`（MIT）已有成熟的消息渲染实现，但它是一个 Next.js + React 19 的独立本地应用，包含本地配置、凭据存储、原生会话发现等 VCPDeck 架构明确排除的面（见 `docs/design/remote-pi-control-plane.md` §18 的复用/保留/拒绝边界）。需要一个长期决策固定：复用哪部分、以什么方式复用、隔离边界在哪里，以及未来如何与上游同步。

## Decision

1. **最大化原样拷入（vendored）**：`examples/pi-web` 的消息渲染组件及其 `lib/`、`hooks/` 依赖闭包按原目录结构拷入 `packages/frontend/src/pi-web/`；文件名与内部 import 保持原样（除路径解析外零修改），以保持与上游 diff 可对账；上游更新以手动 cherry-pick 同步。
   - 唯一允许的代码例外是 `scripts/port-pi-web-render.mjs` 中**声明并校验**的注入补丁（`VCP_PATCHES`），用于把上游依赖 pi-web 本地接口的调用点交给 VCPDeck 适配层（当前仅一条：thinking 正文取数改为优先调用宿主注入点 `globalThis.__vcpdeckLoadThinking`，未注入时回退上游路径）。补丁必须写在脚本里（重跑 port 即可重现、锚点缺失即失败），不得手改 vendored 产物；新增例外需同步修改本条。
2. **Pi UI Adapter 是唯一翻译点**：Shared DTO 与渲染模型之间的映射只发生在 Adapter 模块；移植子树内禁止 import `@vcpdeck/shared`、`@vcpdeck/sdk` 或任何 `packages/*` 源码（持续性门禁）。更换 renderer 不得改变 REST/SSE/Owner/Run 与 Session Job 语义。
3. **渲染层不触达控制面**：审批等交互回调路由到 VCPDeck 既有语义；pi-web 本地功能（本地文件打开等）保留原码但不接线。Composer、会话列表、连接管理不属渲染层，保持 VCPDeck 既有实现。
4. **许可合规**：pi-web 的 MIT LICENSE 与文件级许可头随拷贝保留，并附来源说明。
5. **渲染层不可信**：消息体外包降级护栏（渲染异常回落纯文本展示），渲染层缺陷不得阻断会话。

## Consequences

- **收益**：渲染行为与 pi-web 一致，复用其沉淀的边角 case 与测试；控制面协议与展示组件被 Adapter 隔离，可独立演进或整体更换 renderer；与上游可 diff 对账，降低同步成本。
- **代价**：前端 bundle 显著变大（mermaid、KaTeX、语法高亮等）；需要维护一棵 vendored 子树；pi-web 自带 i18n 与 VCPDeck 文案体系并存。
- **约束与后续义务**："移植子树零协议 import"须由门禁长期守住；pi-web 许可状态或文件级许可变化时须重新核验；React 升级时须复核上游组件的版本耦合（当前勘察：渲染子集无 React 19 专属 API，React 18 可用）；注入补丁数量与上游对应代码在同步时必须对账（锚点失败会让 port 脚本直接报错）。

## Alternatives considered

- **对标重写**（不拷代码，以现有实现吸收 pi-web 视觉）：无 vendored 负担，但渲染保真度打折、大型消息组件的边角 case 易漏、工作量不确定 —— 否决。
- **抽独立共享渲染包**：利于长期双向同步，但当前只有单一消费方，属提前抽象，增加发布与维护面 —— 否决。
- **iframe / 每 Client 运行 Pi Web Server**：引入额外 HTTP 服务、认证、端口与第二套本地配置/Session 逻辑 —— 设计 §18 已否决。
- **裁剪式移植**（只挑个别组件、按需精简依赖）：与"最大化复用以降低出问题概率"的既定方针冲突 —— 否决。
