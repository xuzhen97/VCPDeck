import type { VcpdeckClient } from "@vcpdeck/sdk";
import type { VcpResponse } from "../types.js";
/**
 * 列出所有机器及其状态
 */
export declare function handleListClients(client: VcpdeckClient): Promise<VcpResponse>;
