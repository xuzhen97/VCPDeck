import type { TerminalOutputChunk, TerminalStateReport } from "@vcpdeck/shared";
import type { ShellRegistryEntry } from "./shell-discovery.js";
import type { TerminalShellInfo } from "@vcpdeck/shared";
import { createSnapshotter, type TerminalSnapshotResult } from "./terminal-snapshot.js";
/** PTY 适配器（node-pty 的最小可测试面）。 */
export interface PtyAdapter {
    pid: number;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
    onData(cb: (data: string) => void): void;
    onExit(cb: (exitCode: number) => void): void;
}
/** PTY 创建参数（固定参数，浏览器不可注入）。 */
export interface PtySpawnOptions {
    file: string;
    args: string[];
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
    name: string;
}
export interface TerminalManagerOptions {
    shells: ShellRegistryEntry[];
    cwd: string;
    generationId: string;
    onOutput: (chunk: TerminalOutputChunk) => void;
    onSessionEnded: (info: {
        sessionId: string;
        reason: "exited" | "closed" | "expired" | "error";
        exitCode?: number;
        errorCode?: string;
    }) => void;
    spawnPty: (opts: PtySpawnOptions) => PtyAdapter;
    killTree: (pid: number) => Promise<void>;
    /** 快照器工厂（默认真实 xterm headless）。 */
    createSnapshotter?: (opts: {
        cols: number;
        rows: number;
    }) => ReturnType<typeof createSnapshotter>;
    maxSessions?: number;
    detachedTtlMs?: number;
    flushWindowMs?: number;
}
/** 单个终端会话管理器：registry、上限、输出流、headless 快照、保留计时与进程清理。 */
export declare function createTerminalManager(options: TerminalManagerOptions): {
    /** 创建 PTY 会话（Server 下发 sessionId；缺失时本地生成）。 */
    create(request: {
        sessionId?: string;
        shellId: string;
        cols: number;
        rows: number;
    }): Promise<{
        sessionId: string;
    }>;
    /** 浏览器 attach：取消保留计时，标记 live。 */
    attach(sessionId: string): Promise<void>;
    /** 最后一个浏览器离开：启动保留计时（Server 断线同样适用）。 */
    detach(sessionId: string): Promise<void>;
    /** Server Socket 断线：所有会话视为暂时 detached。 */
    handleServerDisconnect(): void;
    /** 写入输入（校验 UTF-8 字节上限）。 */
    input(sessionId: string, data: string): Promise<void>;
    /** 调整 PTY 尺寸（协议范围校验）。 */
    resize(sessionId: string, cols: number, rows: number): Promise<void>;
    /** 可用 Shell 列表（安全 DTO）。 */
    listShells(): TerminalShellInfo[];
    /** 设置可用 Shell（探测完成后调用，幂等）。 */
    setShells(shells: ShellRegistryEntry[]): void;
    /** 替换输出转发回调（桥接层使用）。 */
    setOutputSink: (fn: typeof options.onOutput) => void;
    /** 替换会话结束回调（桥接层使用）。 */
    setSessionEndedSink: (fn: typeof options.onSessionEnded) => void;
    /** 取会话快照（headless 画面 + snapshotSeq）。 */
    getSnapshot(sessionId: string): Promise<TerminalSnapshotResult>;
    /** 手动关闭 / 过期清理（幂等）。 */
    close(sessionId: string, reason: "closed" | "expired"): Promise<void>;
    /** 全部关闭（进程退出）。 */
    shutdown(): Promise<void>;
    /** 生成状态对账报告（不含敏感字段）。 */
    getStateReport(): TerminalStateReport;
};
