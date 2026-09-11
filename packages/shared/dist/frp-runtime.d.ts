/** FRP runtime reconciliation 协议版本。 */
export declare const FRP_RECONCILE_PROTOCOL_VERSION: 1;
/** FRP runtime 进程状态。 */
export type FrpRuntimeStatus = "stopped" | "starting" | "running" | "retrying" | "failed";
/** FRP 恢复所有者。 */
export type FrpRecoveryOwner = "client" | "server" | null;
/** Client 上报的 FRP 能力摘要。 */
export interface FrpCapabilityStatus {
    available: boolean;
    reconcileProtocolVersion?: typeof FRP_RECONCILE_PROTOCOL_VERSION;
    code?: "FRPC_NOT_FOUND";
    message?: string;
}
/** FRP runtime 映射快照（安全投影，不含 Token）。 */
export interface FrpRuntimeMappingSnapshot {
    mappingId: string;
    name: string;
    proxyType: "tcp" | "http" | "https";
    localIp: string;
    localPort: number;
    remotePort: number | null;
    customDomain: string | null;
}
/** Client → Server 的 FRP runtime 状态上报。 */
export interface FrpRuntimeStateReport {
    clientId: string;
    connectionGeneration: string;
    runtimeGeneration: number;
    status: FrpRuntimeStatus;
    processRunning: boolean;
    recoveryOwner: FrpRecoveryOwner;
    attempt: 0 | 1 | 2;
    frpsEndpoint: {
        serverAddr: string;
        serverPort: number;
    } | null;
    mappings: FrpRuntimeMappingSnapshot[];
    errorCode?: string;
    errorMessage?: string;
}
/** Server → Client 的 FRP 状态确认。 */
export interface FrpRuntimeStateAck {
    connectionGeneration: string;
    accepted: boolean;
    action: "none" | "client-retrying" | "server-reconciling" | "stale";
}
/** Server → Client 的批量 reconcile payload。 */
export interface FrpReconcilePayload {
    connectionGeneration: string;
    expectedRuntimeGeneration: number;
    attempt: 0 | 1 | 2;
    timeoutSeconds: number;
    frpsInfo: {
        serverAddr: string;
        serverPort: number;
        authToken: string;
    };
    mappings: FrpRuntimeMappingSnapshot[];
    preservedMappings: FrpRuntimeMappingSnapshot[];
}
/** Client → Server 的 reconcile 结果。 */
export interface FrpReconcileResult {
    connectionGeneration: string;
    runtimeGeneration: number;
    status: "running" | "failed";
    loadedMappingIds: string[];
}
/** 严格解析 Client 上报的 FRP 能力摘要。 */
export declare function parseFrpCapabilityStatus(value: unknown): FrpCapabilityStatus;
/** 严格解析 Client → Server 的 FRP runtime 状态上报。 */
export declare function parseFrpRuntimeStateReport(value: unknown): FrpRuntimeStateReport;
/** 严格解析 Server → Client 的批量 reconcile payload。 */
export declare function parseFrpReconcilePayload(value: unknown): FrpReconcilePayload;
/** 严格解析 Server → Client 的 FRP 状态确认。 */
export declare function parseFrpRuntimeStateAck(value: unknown): FrpRuntimeStateAck;
/** 严格解析 Client → Server 的 reconcile 结果。 */
export declare function parseFrpReconcileResult(value: unknown): FrpReconcileResult;
