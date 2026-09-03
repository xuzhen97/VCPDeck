import type { VcpdeckClient } from "@vcpdeck/sdk";
import type { VcpResponse } from "../types.js";
export declare function handleRunShellJob(client: VcpdeckClient, params: Record<string, unknown>): Promise<VcpResponse>;
export declare function handleGetJob(client: VcpdeckClient, params: Record<string, unknown>): Promise<VcpResponse>;
export declare function handleCancelJob(client: VcpdeckClient, params: Record<string, unknown>): Promise<VcpResponse>;
