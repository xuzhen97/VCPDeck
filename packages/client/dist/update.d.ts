import type { Socket } from "socket.io-client";
import type { ClientLauncher } from "./launcher-control.js";
/** 客户端是否处于更新停机中（dispatcher 据此拒绝新任务） */
export declare function isDraining(): boolean;
export interface ClientUpdateDeps {
    socket: Socket;
    launcher: ClientLauncher;
    /** 服务端基址（相对下载 URL 解析用） */
    serverBase: string;
    /** 运行中 job 查询（测试注入） */
    getRunningJobIds?: () => string[];
    pollIntervalMs?: number;
    log?: (msg: string) => void;
    /** 就绪回执后、apply 前释放本地实时资源（如 frpc 计划内停机；失败不阻断更新）。 */
    beforeApply?: () => Promise<void>;
}
/** 注册 update:request 处理；返回解绑函数 */
export declare function attachUpdateHandler(deps: ClientUpdateDeps): () => void;
