/** @file FRP 映射服务 — 持久化、端口分配与 Dashboard 收敛 */
import type { DispatchPayload, FrpErrorCode, FrpMappingCreateRequest, FrpMappingInfo, FrpMappingStatus, PaginatedResult } from "@vcpdeck/shared";
type FrpMappingCreateInput = FrpMappingCreateRequest;
type FrpMappingView = FrpMappingInfo;
type FrpSettlement = {
    terminal: false;
    dispatch: DispatchPayload;
} | {
    terminal: true;
    result: Record<string, unknown>;
    errorCode?: FrpErrorCode;
    errorMessage?: string;
    relatedJob?: {
        jobId: string;
        errorCode: FrpErrorCode;
        errorMessage: string;
    };
};
import { PrismaService } from "../prisma/prisma.service.js";
import { FrpsInstancesService } from "./frp-instances.service.js";
import { FrpReconciliationService } from "./frp-reconciliation.service.js";
export declare class FrpService {
    private readonly prisma;
    private readonly instancesService;
    /** 恢复周期互斥守卫；未注入时（旧测试直接两参构造）跳过检查。 */
    private readonly reconciliation?;
    private readonly allocator;
    constructor(prisma: PrismaService, instancesService: FrpsInstancesService, 
    /** 恢复周期互斥守卫；未注入时（旧测试直接两参构造）跳过检查。 */
    reconciliation?: FrpReconciliationService | undefined);
    createMapping(dto: FrpMappingCreateInput): Promise<{
        mapping: FrpMappingView;
        dispatch: DispatchPayload;
    }>;
    deleteMapping(id: string, timeoutSeconds?: number): Promise<{
        mapping: FrpMappingInfo;
        dispatch: DispatchPayload;
    } | null>;
    /** Client 本地 FRP 动作完成后，以 Dashboard 状态收敛操作。 */
    settleClientOperation(jobId: string, type: "frp.create" | "frp.delete"): Promise<FrpSettlement>;
    /** Client 本地动作失败；创建需继续回滚，删除则保留 error。 */
    failClientOperation(jobId: string, type: "frp.create" | "frp.delete", errorCode: string, errorMessage: string): Promise<FrpSettlement>;
    getMapping(id: string): Promise<FrpMappingInfo | null>;
    listMappings(clientId?: string, page?: number, pageSize?: number): Promise<PaginatedResult<FrpMappingInfo>>;
    updateStatus(mappingId: string, status: FrpMappingStatus): Promise<void>;
    markInactiveByClientId(clientId: string): Promise<void>;
    private waitForProxy;
    private resolveName;
    private toApi;
}
export {};
