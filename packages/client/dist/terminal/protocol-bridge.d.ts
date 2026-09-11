import type { Socket } from "socket.io-client";
import type { createTerminalManager } from "./terminal-manager.js";
/** 终端桥依赖。 */
export interface TerminalBridgeDeps {
    clientId: string;
    manager: ReturnType<typeof createTerminalManager>;
}
/** 将 Manager 输出/结束回调接入 socket（由 connect() 组装）。 */
export declare function wireManagerToSocket(socket: Socket, manager: ReturnType<typeof createTerminalManager>): void;
/**
 * 绑定终端 Socket 桥：请求响应、输出/退出转发、注册后状态对账。
 * - 所有入站消息先 parse；
 * - 高频动作（input/resize）仍等待业务完成，错误安全上报；
 * - 断线不关闭 TerminalManager（由 30 分钟保留计时兜底）。
 */
export declare function attachTerminalBridge(socket: Socket, deps: TerminalBridgeDeps): void;
