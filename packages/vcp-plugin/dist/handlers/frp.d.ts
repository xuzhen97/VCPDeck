import type { VcpdeckClient } from "@vcpdeck/sdk";
import type { VcpResponse } from "../types.js";
export declare function handleListFrpMappings(client: VcpdeckClient): Promise<VcpResponse>;
export declare function handleCreateFrpMapping(client: VcpdeckClient, params: Record<string, unknown>): Promise<VcpResponse>;
export declare function handleDeleteFrpMapping(client: VcpdeckClient, params: Record<string, unknown>): Promise<VcpResponse>;
