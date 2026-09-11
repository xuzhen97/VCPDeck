import { type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { Server, Socket } from "socket.io";
import { ClientService } from "../client/client.service.js";
import { JobService } from "../job/job.service.js";
import { FileService } from "../file/file.service.js";
import { FrpService } from "../frp/frp.service.js";
import { FrpReconciliationService } from "../frp/frp-reconciliation.service.js";
import { PiRequestBroker } from "../pi/pi-request-broker.js";
import { PiEventBroker } from "../pi/pi-event-broker.js";
import { PiRunService } from "../pi/pi-run.service.js";
import { TerminalService } from "../terminal/terminal.service.js";
import { TerminalRequestBroker } from "../terminal/terminal-request-broker.js";
import { ReleaseOrchestrator } from "../release/release.orchestrator.js";
import { GatewayUpdateChannel } from "../release/update-channel.js";
import { type JobProgress } from "@vcpdeck/shared";
import type { Heartbeat, JobOutput, JobDone, JobCancelled, JobCancelFailed, StatusReport, DispatchPayload, PiEvent, PiResponse, PiStateReport, TerminalClientResponse, TerminalOutputChunk, TerminalExitReport, TerminalStateReport, UpdateReady, UpdateFailed, FrpRuntimeStateAck } from "@vcpdeck/shared";
export declare class ClientGateway implements OnModuleInit, OnModuleDestroy {
    private readonly clientService;
    private readonly jobService;
    private readonly fileService;
    private readonly frpService;
    private readonly piRequests;
    private readonly piEvents;
    private readonly piRuns;
    private readonly terminalService;
    private readonly terminalBroker;
    private readonly orchestrator;
    private readonly updateChannel;
    private readonly frpReconciliation?;
    server: Server;
    private staleClientTimer;
    constructor(clientService: ClientService, jobService: JobService, fileService: FileService, frpService: FrpService, piRequests: PiRequestBroker, piEvents: PiEventBroker, piRuns: PiRunService, terminalService: TerminalService, terminalBroker: TerminalRequestBroker, orchestrator: ReleaseOrchestrator, updateChannel: GatewayUpdateChannel, frpReconciliation?: FrpReconciliationService | undefined);
    onModuleInit(): void;
    onModuleDestroy(): void;
    afterInit(): void;
    handleConnection(client: Socket): void;
    handleDisconnect(client: Socket): Promise<void>;
    /** 扫描并收敛停止心跳的 Client；数据库先以 socket lease 原子摘除，避免误伤新连接。 */
    sweepStaleClients(): Promise<void>;
    private cleanupClientConnection;
    handleRegister(client: Socket, data: unknown): Promise<{
        ok: boolean;
    }>;
    handleFrpState(client: Socket, data: unknown): Promise<FrpRuntimeStateAck>;
    /** reconcile 派发：精确发往 socketId（lease 信任边界），并广播 Job 更新。 */
    private sendReconcileDispatch;
    handleUpdateReady(data: UpdateReady): void;
    handleUpdateFailed(data: UpdateFailed): void;
    handlePiResponse(client: Socket, data: PiResponse): Promise<void>;
    handlePiEvent(client: Socket, data: PiEvent): Promise<void>;
    handlePiState(client: Socket, data: PiStateReport): Promise<import("@vcpdeck/shared").PiStateAck | undefined>;
    handleHeartbeat(data: Heartbeat): Promise<void>;
    handleTerminalResponse(client: Socket, data: TerminalClientResponse): Promise<void>;
    handleTerminalOutput(client: Socket, data: TerminalOutputChunk): Promise<void>;
    handleTerminalExit(client: Socket, data: TerminalExitReport): Promise<void>;
    handleTerminalState(client: Socket, data: TerminalStateReport): Promise<import("@vcpdeck/shared").TerminalStateAck | undefined>;
    handleStatusReport(client: Socket, data: StatusReport): Promise<void>;
    handleJobStdout(data: JobOutput): Promise<void>;
    handleJobStderr(data: JobOutput): Promise<void>;
    handleJobProgress(data: JobProgress & {
        jobId: string;
    }): Promise<void>;
    handleJobDone(data: JobDone): Promise<void>;
    handleJobCancelled(data: JobCancelled): Promise<void>;
    handleJobCancelFailed(data: JobCancelFailed): void;
    sendDispatch(d: DispatchPayload): void;
    sendCancel(clientId: string, jobId: string): void;
}
