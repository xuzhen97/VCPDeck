/** 快照终端的最小接口（生产用 @xterm/headless，测试可注入）。 */
export interface SnapshotTerminal {
    write(data: string, cb?: () => void): void;
    resize(cols: number, rows: number): void;
    serialize(): string;
    dispose(): void;
}
/** 快照器环境抽象（生产/测试注入）。 */
export interface SnapshotterEnv {
    createTerminal(opts: {
        cols: number;
        rows: number;
        scrollback: number;
    }): SnapshotTerminal;
    maxSnapshotBytes: number;
    scrollback: number;
}
/** 快照结果（snapshot 为 ANSI 序列，可写入浏览器 xterm 恢复画面）。 */
export interface TerminalSnapshotResult {
    snapshot: string;
    snapshotSeq: number;
    cols: number;
    rows: number;
    historyTruncated: boolean;
}
/**
 * 每会话 headless 终端快照器。
 * - 所有 write/resize/snapshot 经单一串行队列处理，保证 snapshotSeq 与画面内容原子一致；
 * - snapshot 编码超过上限时回退为有界原始输出并标记 historyTruncated；
 * - 不持久化快照内容。
 */
export declare function createSnapshotter(env: SnapshotterEnv, opts: {
    cols: number;
    rows: number;
}): {
    /** 写入输出（headless 处理完成后推进 seq）。 */
    write(data: string, cb?: () => void): void;
    /** 同步调整 headless 终端尺寸。 */
    resize(newCols: number, newRows: number): void;
    /** 生成快照（串行队列内执行，保证与 seq 一致）。 */
    snapshot(): Promise<TerminalSnapshotResult>;
    /** 释放资源（串行队列内执行）。 */
    dispose(): void;
};
