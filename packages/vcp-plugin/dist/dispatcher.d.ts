import type { VcpdeckClient } from "@vcpdeck/sdk";
import type { VcpRequest, VcpResponse } from "./types.js";
/**
 * 分发执行 VCP 指令
 */
export declare function dispatchCommand(client: VcpdeckClient, req: VcpRequest): Promise<VcpResponse>;
