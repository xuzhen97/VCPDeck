import type { TerminalCapabilityStatus } from "@vcpdeck/shared";
/** 终端能力探测环境抽象（测试注入）。 */
export interface TerminalCapabilityEnv {
    platform: NodeJS.Platform;
    loadPty: () => Promise<{
        spawn: unknown;
    } | null>;
}
/**
 * 延迟探测 node-pty 后端。
 * - 动态 import：加载失败只禁用终端能力，不影响 exec/files/FRP/Pi；
 * - 错误消息安全化：不包含本地路径或 stack。
 */
export declare function probeTerminalCapability(env?: TerminalCapabilityEnv): Promise<TerminalCapabilityStatus>;
/** 生成真实探测环境（node-pty 动态 import）。 */
export declare function createTerminalCapabilityEnv(): TerminalCapabilityEnv;
