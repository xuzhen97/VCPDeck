# 远程 Pi Tab 模型与思考深度切换设计

## 目标

在机器级 Pi Tab 的右侧“运行详情”面板中支持：

- 查看并切换当前 Session 使用的模型；
- 查看并切换当前 Session 的思考深度；
- 切换只影响当前 Session，不写入项目级或全局 Pi 配置。

## 已批准的交互

### 控件位置

模型选择器和思考深度选择器均位于右侧“运行详情”面板，和当前状态、队列、Session/Run 标识放在同一处。

### 模型展示

模型列表复用现有 `models.list` 接口，显示 `provider / modelId`。不新增友好名称映射，也不暴露认证信息。

### 思考深度选项

固定提供 Pi SDK 的完整选项：

`auto`、`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`

当前版本不在前端自行推断模型能力；不支持的级别由现有 Client/SDK 行为处理，并通过稳定错误返回。

### 运行中行为

模型与思考深度控件在 Agent 运行、压缩或等待扩展输入时禁用。Server 继续执行最终的空闲校验；如果发生竞态导致 `PI_PROJECT_BUSY`，前端保留旧值并显示错误。

### 保存范围

切换只作用于当前打开的 Session。不会新增项目配置、全局配置、数据库字段或持久化偏好。

## 数据流

```text
选择项目目录
  -> GET /api/clients/:clientId/pi/models?rootDir&relativePath
  -> 右栏展示可用模型

打开 Session
  -> GET /api/clients/:clientId/pi/agent/:sessionId?rootDir&relativePath
  -> agent.state 返回当前 model 与 thinkingLevel

选择模型
  -> POST /api/clients/:clientId/pi/agent/:sessionId/model
  -> Server resolve project + assert idle
  -> Client supervisor model.set
  -> Worker SDK setModel
  -> 前端刷新 agent.state

选择思考深度
  -> POST /api/clients/:clientId/pi/agent/:sessionId/thinking
  -> Server resolve project + assert idle
  -> Client supervisor thinking.set
  -> Worker SDK setThinkingLevel
  -> 前端刷新 agent.state
```

## 代码范围

### Shared

扩展 `PiAgentState`，增加当前思考深度字段 `thinkingLevel`，使用 Pi SDK 兼容的字符串值。

### Client

- `PiAgentSessionWrapperImpl.getState()` 返回当前 Session 的 `thinkingLevel`；
- 保留现有 `models.list`、`model.set`、`thinking.set` 行为；
- 不改变主 Client 静态加载 Pi SDK 的约束。

### Frontend

- `usePiSession` 暴露模型列表、模型切换、思考深度切换所需状态和动作；
- 进入项目/打开 Session 时加载模型列表和 Agent state；
- `PiRunDetails` 增加两个选择器；
- `PiPanel` 连接 SDK API、传递空闲状态、处理成功刷新与失败提示；
- 桌面右栏与窄屏详情抽屉复用同一控件。

### Server / SDK

现有接口和 API 方法已存在，默认只补充必要的类型约束或测试，不新增 Endpoint。

## 错误处理

- `PI_PROJECT_BUSY`：控件禁用为主；若发生竞态，显示错误且不更新选择值；
- `PI_MODEL_NOT_FOUND`：恢复旧模型并显示错误；
- `PI_CLIENT_DISCONNECTED`、`PI_REQUEST_TIMEOUT`：保留当前显示值并提示；
- 不把模型凭据、Prompt、响应正文、路径写入 Job、日志或数据库。

## 测试

- Shared：`PiAgentState.thinkingLevel` 运行时结构/类型覆盖；
- Client：`getState()` 返回 thinking level；模型和思考深度动作调用 SDK；
- Frontend：模型加载、模型切换、思考深度切换、运行中禁用、失败恢复；桌面和抽屉复用同一控件；
- Server/SDK：已有接口参数和错误路径回归；
- 最终运行 Client、Server、SDK、Frontend 测试与构建。

## 约束

- 不新增配置层、状态管理库或模型元数据服务；
- 不实现项目级/全局持久化；
- 不允许运行中切换；
- 保持现有 Owner/Observer、项目锁、隐私和错误码语义；
- 遵循 TDD：每个生产行为先有会失败的测试。
