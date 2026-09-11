import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { ConfigPaths } from "./config.js";
/** 按 CLI 环境解析配置，把机器名称或 clientId 解析为权威 clientId。 */
export declare function resolveClientId(clientFilter: string, paths?: ConfigPaths, processEnv?: NodeJS.ProcessEnv, client?: VcpDeckClient): Promise<string>;
/**
 * 通过在线 Client 列表定位目标 Client（SDK 无单个 get）；未找到返回 null。
 * 供执行前 root 等价风险提示读取 capabilityDetails（ADR-0023）。
 */
export declare function findClientByClientId(client: VcpDeckClient, clientId: string): Promise<import("@vcpdeck/shared").ClientInfo | null>;
/** 探测目标机可用授权根（file.roots）。 */
export declare function fetchClientRoots(client: VcpDeckClient, clientId: string): Promise<string[]>;
