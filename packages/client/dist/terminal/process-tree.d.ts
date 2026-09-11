/** 平台进程树清理（Windows：taskkill /T /F；POSIX：进程组信号）。 */
export interface ProcessTreeKiller {
    killTree(pid: number): Promise<void>;
}
/** 平台抽象（测试注入）。 */
export interface ProcessTreeKillerEnv {
    platform: NodeJS.Platform;
    killGroupSignal: (pid: number, signal: NodeJS.Signals) => boolean;
    runTaskkill: (pid: number) => Promise<number>;
}
/**
 * 终止进程树。
 * - POSIX：先 SIGTERM 进程组（-pid），兜底 kill(-pid, SIGKILL)；
 * - Windows：taskkill /T /F 结束进程树（ConPTY 关闭后仍可能残留子进程）。
 * 幂等：进程已退出时静默成功。
 */
export declare function killProcessTree(pid: number, env?: ProcessTreeKillerEnv): Promise<void>;
