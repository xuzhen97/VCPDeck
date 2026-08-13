# 交互式终端 PTY 与 xterm 恢复能力 Spike 验证记录

> 日期：2026-08-12
> 目标：验证 `node-pty` + `@xterm/headless` + `@xterm/addon-serialize` 技术选型可落地。

## 环境

- OS：Windows 11 x64（验证机）；Linux x64 待 Task 16 真实平台验收
- Node.js：v24.18.0
- pnpm：v11.21.0
- 包版本：
  - `node-pty@1.1.0`
  - `@xterm/headless@6.0.0`
  - `@xterm/addon-serialize@0.14.0`

## 安装与构建验证

| 项目 | 结果 |
| --- | --- |
| pnpm 安装 `node-pty` | ✅ 通过（`pnpm-workspace.yaml` 需批准 `node-pty: true` 构建脚本） |
| Windows x64 预编译产物 | ✅ `prebuilds/win32-x64/pty.node`、`conpty.node`、`conpty_console_list.node`，无需本机编译器 |
| ConPTY 运行时 | ✅ postinstall 自动拷贝 `conpty.dll` + `OpenConsole.exe`（版本 1.23.251008001） |
| darwin 预编译产物 | ✅ `prebuilds/darwin-{arm64,x64}/pty.node` 存在 |
| Linux x64 预编译产物 | ⚠️ **npm 包内无 linux-x64 prebuild**，安装时走 `node-gyp rebuild`，需 python3 + make + g++；部署文档必须注明构建依赖，Task 16 在真实 Linux 验证 |

## PTY 运行验证（Windows cmd）

- ✅ spawn 成功，`onData` 收到正常终端输出（含 ANSI 序列）
- ✅ `write()` 输入生效（echo 命令回显）
- ✅ `kill()` + `onExit` 事件触发，exitCode=0xC000013A（STATUS_CONTROL_C_EXIT，ConPTY 正常关闭码）
- ✅ 中文 UTF-8 输出完整

## 已知限制

- Windows 无控制台环境（CI/守护进程）：`kill()` 时 `conpty_console_list_agent.js` 输出
  `AttachConsole failed` stderr 噪音，不影响父进程；**进程树清理的可靠路径应使用
  `taskkill /PID <pid> /T /F` 兜底**（见设计文档 9.6）。
- `@xterm/headless` 的 `buffer` 与 `SerializeAddon.serialize()` 属于 proposed API，
  构造 `Terminal` 时必须传 `allowProposedApi: true`。
- xterm `write()` 异步解析：读 buffer/序列化必须在 write callback 之后执行。

## xterm headless 快照恢复验证

| 场景 | 结果 |
| --- | --- |
| 普通屏文本 + ANSI 颜色 + 中文 | ✅ serialize 后新 Terminal write 恢复，逐行内容一致 |
| 多行 + 光标位置 | ✅ 恢复行内容与写入一致 |
| resize（40x8 → 20x5） | ✅ 恢复后 resize 正常 |
| alternate screen（`\x1b[?1049h`） | ✅ 序列化后恢复 alternate buffer 内容 |
| scrollback（1000 行） | ✅ 构造参数生效（含行数由 Task 6 单元测试覆盖） |

## 延迟加载降级验证

- ✅ 动态 `import('node-pty')` 成功
- ✅ 动态 import 不存在的模块可捕获，返回稳定降级结果
- ✅ CJS `require('node-pty')` 在 try/catch 中可安全降级
- 结论：Client 顶层不得静态加载 node-pty；capability probe 动态 import 失败时仅禁用
  Terminal Tab，不影响 exec/files/FRP/Pi。

## 结论

- **Windows x64 可落地**，无需编译工具链。
- **Linux x64 需 node-gyp 编译环境**，Task 16 真实验收前需在目标 Linux 环境
  验证 `pnpm install` 完整流程。
- xterm headless 快照方案满足设计 6.2 的恢复要求（颜色、中文、alternate screen、resize）。
- 无阻塞项。相关依赖版本已锁定：`node-pty@1.1.0`、`@xterm/headless@6.0.0`、
  `@xterm/addon-serialize@0.14.0`。
