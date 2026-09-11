import type { ClientInfo } from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";
/** 创建在线 Client API。 */
export declare function createClientsApi(client: Pick<VcpDeckClient, "request">): {
    list: (signal?: AbortSignal) => Promise<ClientInfo[]>;
    /** 修改客户端别名（全局唯一；重名返回 409）。 */
    rename: (clientId: string, name: string, signal?: AbortSignal) => Promise<ClientInfo>;
};
