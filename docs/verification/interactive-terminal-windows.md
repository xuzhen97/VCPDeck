# 交互式终端 Windows 端到端验收记录

> 日期：2026-08-13
> 环境：Windows 11 x64，Node v24.18.0，pnpm 11.21.0
> 版本：node-pty@1.1.0（ConPTY）、@xterm/headless@6.0.0、@xterm/addon-serialize@0.14.0

## 环境准备

- 使用独立 smoke 数据库（`prisma db push` 初始化，与开发库隔离）
- Server：`node dist/main.js`（`VCPDECK_ADMIN_PASSWORD`/`VCPDECK_PSK` 独立配置）
- Client：`node dist/index.js`（真实 node-pty，`VCPDECK_CLIENT_ID=smoke-client`）
- 驱动：`scripts/terminal-smoke.cjs`（登录 → shells → create → attach → input → resize → close → audit）
- 恢复验证：`scripts/terminal-recovery-test.cjs`（断开重连 + token 恢复 + 快照比对）

## 验收结果

| 项目 | 结果 | 说明 |
| --- | --- | --- |
| Shell 探测 | ✅ | 返回 `powershell*`（默认）+ `cmd`；本机无 pwsh 7，未验证（16.1 部分） |
| 会话创建 | ✅ | REST POST → Client 真实 ConPTY spawn，状态 detached |
| attach 单写多读 | ✅ | 首个浏览器为 operator；ack 正常返回 |
| 快照恢复 | ✅ | attach 收到 ANSI snapshot（seq 对齐） |
| 输入/回显 | ✅ | cmd：`echo HELLO_123` 完整回显，中文横幅正常（“保留所有权利”） |
| 中文输出 | ✅ | cmd 启动横幅中文完整，无乱码 |
| resize | ✅ | 100x40 下发成功（Client PTY 同步） |
| 手动关闭 | ✅ | DELETE → Client 清理 PTY，审计 closed |
| 最小审计 | ✅ | 审计事件：created → attached → closed（无正文） |
| 刷新恢复（断开重连） | ✅ | 带 token 重连恢复 operator；快照含断开前命令输出（RECOVERY_MARKER_42）；恢复后继续输入有效（AFTER_RECOVERY_99） |

## 重要发现与修复（影响全链路）

1. **NestJS 10.4.22 的 `@Ack()` 装饰器不可用**：注入的是对象而非 ack 函数
   （`WsParamsFactory` 对 `WsParamtype.ACK` 返回 null；实测 `typeof ack === "object"`）。
   已全部改为 **handler 返回值自动 ack** 模式（官方推荐路径，实测工作正常），
   涉及：`app.gateway.ts` 全部终端 handler、`client.gateway.ts` 的
   `handleRegister`/`handlePiState`/`handleTerminalState`。
   该问题此前也影响 Pi 状态对账的 ack 回调（有 "ack" 事件兜底，未暴露）。

2. **Client 终端桥响应协议**：Server 的 `TerminalRequestBroker` 通过事件关联响应，
   Client 侧必须发 `TERMINAL_RESPONSE` 事件（不能依赖 socket ack 回调）。

3. **`listShells()` 读取构造时快照而非 `setShells` 后的 registry**：已修复
   （探测完成后 Shell 列表不生效的问题）。

4. **Windows PATH 兼容**：MSYS/Git Bash 环境 PATH 为 `:` 分隔 + 虚拟路径，
   探测增加分隔符自适应 + 正斜杠尝试 + `where.exe` 兜底。

## 未验证项（留待真实人工验收）

- pwsh 7（本机未安装）
- PowerShell 交互（Tab 补全、历史、`Ctrl+C` 中断前台命令）
- `vim`/`top` 等全屏 TUI（ConPTY 语义，需人工验证）
- 复制粘贴、30 分钟自动过期、进程树清理（`taskkill /T /F`）
- Linux 平台（需真实 Linux 环境，含 node-gyp 构建验证）

## 结论

Windows 端到端核心链路（创建/输入/输出/恢复/关闭/审计）验收通过；
剩余项为需要真实交互的人工验收项，按设计文档 Task 16 跟踪。
