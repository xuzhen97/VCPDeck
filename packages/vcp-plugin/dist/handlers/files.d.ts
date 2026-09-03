import type { VcpdeckClient } from "@vcpdeck/sdk";
import type { VcpResponse } from "../types.js";
export declare function handleListRoots(client: VcpdeckClient, params: Record<string, unknown>): Promise<VcpResponse>;
export declare function handleListDirectory(client: VcpdeckClient, params: Record<string, unknown>): Promise<VcpResponse>;
export declare function handleReadFile(client: VcpdeckClient, params: Record<string, unknown>): Promise<VcpResponse>;
export declare function handleWriteFile(client: VcpdeckClient, params: Record<string, unknown>): Promise<VcpResponse>;
export declare function handleDeleteFile(client: VcpdeckClient, params: Record<string, unknown>): Promise<VcpResponse>;
export declare function handleMoveFile(client: VcpdeckClient, params: Record<string, unknown>): Promise<VcpResponse>;
