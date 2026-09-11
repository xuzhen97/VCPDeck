import { type PiCapabilityStatus } from "@vcpdeck/shared";
/** probe-worker 的结果（不含路径/凭据） */
export interface ProbeWorkerResult {
    sdkVersion: string;
    modelCount: number;
    error: {
        code: "PI_RUNTIME_UNAVAILABLE" | "PI_AUTH_UNAVAILABLE";
        message: string;
    } | null;
}
/** 探测环境抽象（测试注入） */
export interface ProbeEnv {
    nodeVersion: string;
    platform: NodeJS.Platform;
    homedir: string;
    readSettingsShellPath: () => Promise<string | null>;
    existsGitBash: () => Promise<boolean>;
    findBashInPath: () => Promise<boolean>;
    forkProbeWorker: () => Promise<ProbeWorkerResult>;
    readAgentDir: () => Promise<boolean>;
}
/** 生成真实探测环境（生产路径） */
export declare function createProbeEnv(): ProbeEnv;
/** fork 探测 Worker 并收集结果（进程内缓存） */
export declare function forkProbeWorkerOnce(): Promise<ProbeWorkerResult>;
/**
 * 轻量能力探测：Node 版本 → Bash（Windows 按 Pi 官方顺序）→ Agent 目录 → SDK Worker。
 * 探测失败只禁用 Pi 功能，不影响 exec/files/FRP。结果不含路径与凭据。
 */
export declare function probePiCapability(env?: ProbeEnv): Promise<PiCapabilityStatus>;
