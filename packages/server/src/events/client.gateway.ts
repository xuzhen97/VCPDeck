import { Inject, Optional, forwardRef, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
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
import {
  Events,
  JobStatus,
  parsePiEvent,
  parsePiResponse,
  parsePiStateReport,
  parseTerminalClientResponse,
  parseTerminalExitReport,
  parseTerminalOutputChunk,
  parseMachineRegister,
  parseTerminalStateReport,
  type JobProgress,
} from "@vcpdeck/shared";
import type {
  MachineRegister,
  Heartbeat,
  JobOutput,
  JobDone,
  JobCancelled,
  JobCancelFailed,
  StatusReport,
  JobUpdate,
  JobDispatch,
  DispatchPayload,
  PiEvent,
  PiResponse,
  PiStateReport,
  TerminalClientResponse,
  TerminalOutputChunk,
  TerminalExitReport,
  TerminalStateReport,
  UpdateReady,
  UpdateFailed,
  FrpRuntimeStateAck,
} from "@vcpdeck/shared";
import { clientPsk } from "../client/client-psk.js";

const CLIENT_LIVENESS_SWEEP_INTERVAL_MS = 5_000;

@WebSocketGateway({ namespace: "/client", cors: { origin: process.env.VCPDECK_CORS_ORIGIN || "http://localhost:5173" } })
export class ClientGateway implements OnModuleInit, OnModuleDestroy {
  @WebSocketServer()
  server!: Server;
  private staleClientTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(ClientService) private readonly clientService: ClientService,
    @Inject(JobService) private readonly jobService: JobService,
    @Inject(FileService) private readonly fileService: FileService,
    @Inject(FrpService) private readonly frpService: FrpService,
    @Inject(PiRequestBroker) private readonly piRequests: PiRequestBroker,
    @Inject(PiEventBroker) private readonly piEvents: PiEventBroker,
    @Inject(PiRunService) private readonly piRuns: PiRunService,
  	@Inject(TerminalService) private readonly terminalService: TerminalService,
    @Inject(TerminalRequestBroker) private readonly terminalBroker: TerminalRequestBroker,
    // 更新编排（forwardRef 解开 ReleaseModule ↔ EventsModule 循环）
  	@Inject(forwardRef(() => ReleaseOrchestrator))
    private readonly orchestrator: ReleaseOrchestrator,
    // 更新事件发送通道（bindEmitters 模式，避免 provider 循环）
	@Inject(forwardRef(() => GatewayUpdateChannel))
    private readonly updateChannel: GatewayUpdateChannel,
    // FRP 恢复编排（可选注入：旧测试两参构造时跳过）
    @Optional()
    @Inject(FrpReconciliationService)
    private readonly frpReconciliation?: FrpReconciliationService,
  ) {}

  onModuleInit() {
    this.staleClientTimer = setInterval(() => {
      void this.sweepStaleClients().catch((error: unknown) => {
        console.error("[client] heartbeat sweep failed:", (error as { message?: string })?.message);
      });
    }, CLIENT_LIVENESS_SWEEP_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.staleClientTimer) clearInterval(this.staleClientTimer);
    this.staleClientTimer = null;
  }

  // ── Pi request 发送通道（避免与 PiModule 循环依赖） ──
  afterInit() {
    this.frpReconciliation?.bindDispatcher((socketId, dispatch) =>
      this.sendReconcileDispatch(socketId, dispatch),
    );
    this.piRequests.bindEmitter((socketId, request) => {
      this.server.to(socketId).emit(Events.PI_REQUEST, request);
    });
    this.terminalBroker.bindEmitter((socketId, request) => {
      this.server.to(socketId).emit(Events.TERMINAL_REQUEST, request);
    });
    this.updateChannel.bindEmitters({
      sendUpdateRequest: (clientId, request) => {
        this.server.to(clientId).emit(Events.UPDATE_REQUEST, request);
      },
      broadcastShutdown: (notice) => {
        this.server.emit(Events.SERVER_SHUTDOWN, notice);
      },
    });
  }

  // ── Connection lifecycle ──
  handleConnection(client: Socket) {
    const psk = client.handshake.auth?.psk;
    if (psk !== clientPsk()) {
      client.emit("error", "invalid PSK");
      client.disconnect();
      return;
    }
    console.log(`[ws] connected: ${client.id}`);
  }

  async handleDisconnect(client: Socket) {
    const clientId = client.data.clientId as string | undefined;
    if (clientId) {
      await this.cleanupClientConnection(clientId, client.id);
    } else {
      // 未完成 REGISTER 的 socket 也可能持有 broker pending request。
      this.piRequests.disconnect(client.id);
      this.terminalBroker.disconnect(client.id);
    }
    await this.clientService.markOfflineBySocketId(client.id);
    console.log(`[ws] disconnected: ${clientId ?? client.id}`);
  }

  /** 扫描并收敛停止心跳的 Client；数据库先以 socket lease 原子摘除，避免误伤新连接。 */
  async sweepStaleClients(): Promise<void> {
    const expired = await this.clientService.expireStaleClients();
    for (const client of expired) {
      if (client.socketId) await this.cleanupClientConnection(client.clientId, client.socketId);
      console.log(`[ws] heartbeat timeout: ${client.clientId}`);
    }
  }

  private async cleanupClientConnection(clientId: string, socketId: string): Promise<void> {
    // 必须在 generation 队列外先释放等待 response 的 REST lease，避免断线死锁。
    this.piRequests.disconnect(socketId);
    this.terminalBroker.disconnect(socketId);
    // FRP 恢复周期只回收匹配 socket 的租约（service 内部判断）。
    void this.frpReconciliation?.disconnect(clientId, socketId);
    if (await this.piRuns.disconnectGeneration(clientId, socketId)) {
      await this.jobService.markDisconnected(clientId);
      await this.frpService.markInactiveByClientId(clientId);
    }
    await this.terminalService.handleClientDisconnect(clientId, socketId);
  }

  // ── Client events ──
  @SubscribeMessage(Events.REGISTER)
  async handleRegister(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ) {
    let register: MachineRegister;
    try {
      // 信任边界：跨信任边界输入必须运行时校验；非法消息不持久化、不进入任何状态机。
      register = parseMachineRegister(data);
    } catch {
      client.emit("error", "invalid register");
      client.disconnect();
      return { ok: false };
    }
    await this.clientService.register(register, client.id);
    client.data.clientId = register.clientId;
    client.join(register.clientId);
    await this.piRuns.markReconcilePending(register.clientId, client.id);
    await this.terminalService.handleClientRegistered(register.clientId, client.id);
    this.orchestrator.onClientRegistered(register.clientId, register.clientVersion);
    client.emit("ack", { event: Events.REGISTER });
    console.log(`[ws] registered: ${register.clientId} (${register.hostname})`);
    return { ok: true };
  }

	// ── FRP runtime 状态上报（socket lease 信任边界；严格解析在 service 内） ──
	@SubscribeMessage(Events.FRP_STATE)
	async handleFrpState(
		@ConnectedSocket() client: Socket,
		@MessageBody() data: unknown,
	): Promise<FrpRuntimeStateAck> {
		const clientId = client.data.clientId as string | undefined;
		if (typeof clientId !== "string" || !this.frpReconciliation) {
			// 未注册 socket 或 service 缺失：失败关闭，不触发任何恢复。
			return {
				connectionGeneration: "",
				accepted: false,
				action: "stale",
			};
		}
		const ack = await this.frpReconciliation.handleState(clientId, client.id, data);
		// 兼容无 callback 的桥接：同步广播 ack 事件（Client 只接受本代 ack）。
		client.emit(Events.FRP_STATE_ACK, ack);
		return ack;
	}

	/** reconcile 派发：精确发往 socketId（lease 信任边界），并广播 Job 更新。 */
	private sendReconcileDispatch(socketId: string, d: DispatchPayload) {
		this.server.to(socketId).emit(Events.JOB_DISPATCH, {
			jobId: d.jobId,
			type: d.type,
			payload: d.payload,
			timeout: d.timeout,
		} satisfies JobDispatch);
		this.server.emit(Events.JOB_UPDATE, {
			jobId: d.jobId,
			type: d.type,
			status: JobStatus.RUNNING,
		} satisfies JobUpdate);
	}

	// ── 自更新事件 ──
	@SubscribeMessage(Events.UPDATE_READY)
	handleUpdateReady(@MessageBody() data: UpdateReady) {
		this.orchestrator.onUpdateReady(data.clientId, data.releaseVersion);
	}

	@SubscribeMessage(Events.UPDATE_FAILED)
	handleUpdateFailed(@MessageBody() data: UpdateFailed) {
		this.orchestrator.onUpdateFailed(data.clientId, data.releaseVersion, data.reason);
	}

  // ── Pi 事件（复用现有 PSK 连接） ──

  @SubscribeMessage(Events.PI_RESPONSE)
  async handlePiResponse(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: PiResponse,
  ) {
    if (typeof client.data.clientId !== "string") return;
    try {
      const parsed = parsePiResponse(data);
      // response 不进入 generation queue；pending lease 直接校验 socketId。
      this.piRequests.resolve(client.id, parsed);
    } catch {
      // 非法响应忽略
    }
  }

  @SubscribeMessage(Events.PI_EVENT)
  async handlePiEvent(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: PiEvent,
  ) {
    const clientId = client.data.clientId as string | undefined;
    if (!clientId) return;
    try {
      const parsed = parsePiEvent(data);
      if (parsed.clientId !== clientId) return; // 身份绑定：禁止伪造其他 Client 事件
      await this.piRuns.withReconciledSocket(clientId, client.id, () =>
        this.piEvents.publish(parsed),
      );
    } catch {
      // 非法事件忽略
    }
  }

  @SubscribeMessage(Events.PI_STATE)
  async handlePiState(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: PiStateReport,
  ) {
    const clientId = client.data.clientId as string | undefined;
    if (!clientId) return;
    try {
      const parsed = parsePiStateReport(data);
      if (parsed.clientId !== clientId) return; // 身份绑定
      const result = await this.piRuns.reconcileGeneration(clientId, client.id, parsed);
      return result;
    } catch {
      // 非法报告忽略
      return { acceptedRunIds: [], closedRunIds: [], reportAgain: false };
    }
  }

  @SubscribeMessage(Events.HEARTBEAT)
  async handleHeartbeat(@MessageBody() data: Heartbeat) {
    await this.clientService.heartbeat(data);
  }

  // ── 终端事件（复用现有 PSK 连接；身份来自 socket 绑定） ──

  @SubscribeMessage(Events.TERMINAL_RESPONSE)
  async handleTerminalResponse(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: TerminalClientResponse,
  ) {
    const clientId = client.data.clientId as string | undefined;
    if (!clientId) return;
    try {
      const parsed = parseTerminalClientResponse(data);
      // 响应由 broker 关联；service 仅做防御性校验
      this.terminalBroker.resolve(client.id, parsed);
      await this.terminalService.handleClientResponse(clientId, client.id, parsed);
    } catch {
      // 非法响应忽略
    }
  }

  @SubscribeMessage(Events.TERMINAL_OUTPUT)
  async handleTerminalOutput(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: TerminalOutputChunk,
  ) {
    const clientId = client.data.clientId as string | undefined;
    if (!clientId) return;
    try {
      const parsed = parseTerminalOutputChunk(data);
      await this.terminalService.handleClientOutput(clientId, parsed);
    } catch {
      // 非法块忽略
    }
  }

  @SubscribeMessage(Events.TERMINAL_EXIT)
  async handleTerminalExit(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: TerminalExitReport,
  ) {
    const clientId = client.data.clientId as string | undefined;
    if (!clientId) return;
    try {
      const parsed = parseTerminalExitReport(data);
      await this.terminalService.handleClientExit(clientId, parsed);
    } catch {
      // 非法报告忽略
    }
  }

  @SubscribeMessage(Events.TERMINAL_STATE)
  async handleTerminalState(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: TerminalStateReport,
  ) {
    const clientId = client.data.clientId as string | undefined;
    if (!clientId) return;
    try {
      const parsed = parseTerminalStateReport(data);
      if (parsed.clientId !== clientId) return; // 身份绑定
      const result = await this.terminalService.handleClientState(clientId, client.id, parsed);
      return result;
    } catch {
      // 非法报告忽略
      return { acceptedSessionIds: [], closeSessionIds: [] };
    }
  }

  @SubscribeMessage(Events.STATUS_REPORT)
  async handleStatusReport(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: StatusReport,
  ) {
    await this.clientService.bindSocket(data.clientId, client.id);
    client.join(data.clientId);

    const dispatches = await this.jobService.reconcileOnReconnect(
      data.clientId,
      data,
    );

    for (const r of data.jobs) {
      const status =
        r.status === "running"
          ? JobStatus.RUNNING
          : r.status === "waiting_input"
            ? JobStatus.WAITING_INPUT
            : r.status === "done"
              ? JobStatus.DONE
              : JobStatus.ERROR;

      // Fetch job to get type (best-effort, might be null during reconnect)
      const job = await this.jobService.findById(r.jobId);

      this.server.emit(Events.JOB_UPDATE, {
        jobId: r.jobId,
        type: job?.type ?? "exec",
        status,
        result: r.exitCode != null ? { exitCode: r.exitCode } : undefined,
      } satisfies JobUpdate);
    }

    for (const d of dispatches) {
      this.sendDispatch(d);
    }
  }

  // ── Job output ──
  @SubscribeMessage(Events.JOB_STDOUT)
  async handleJobStdout(@MessageBody() data: JobOutput) {
    await this.jobService.appendOutputRaw(data.jobId, data.text);
    this.server.emit(Events.JOB_STDOUT, data);
  }

  @SubscribeMessage(Events.JOB_STDERR)
  async handleJobStderr(@MessageBody() data: JobOutput) {
    await this.jobService.appendOutputRaw(data.jobId, data.text);
    this.server.emit(Events.JOB_STDERR, data);
  }

  @SubscribeMessage(Events.JOB_PROGRESS)
  async handleJobProgress(@MessageBody() data: JobProgress & { jobId: string }) {
    await this.jobService.updateProgress(data.jobId, data.loaded, data.total);
  }

  @SubscribeMessage(Events.JOB_DONE)
  async handleJobDone(@MessageBody() data: JobDone) {
    const raw = data as any;
    const type: string = raw.type;

    // ── FRP reconcile：system Job 由 reconciliation service 直接终结，不走 create/delete 收敛 ──
    if (type === "frp.reconcile") {
      if (raw.error) {
        await this.frpReconciliation?.handleLocalFailure(
          data.jobId,
          typeof raw.error.code === "string" ? raw.error.code : "FRP_RECONCILE_FAILED",
        );
      } else {
        await this.frpReconciliation?.handleLocalResult(data.jobId, raw.result);
      }
      return;
    }

    if (type === "exec") {
      // ── Exec error 终态（基础设施失败） ──
      if (raw.error) {
        const errorCode: string = raw.error.code || "EXEC_FAILED";
        const errorMessage: string = raw.error.message || "";
        const result: Record<string, unknown> = { errorCode, errorMessage };
        if (raw.stdout) result.stdout = raw.stdout;
        if (raw.stderr) result.stderr = raw.stderr;
        const next = await this.jobService.markDone(data.jobId, type, result);
        this.server.emit(Events.JOB_UPDATE, {
          jobId: data.jobId,
          type,
          status: JobStatus.ERROR,
          errorCode,
          errorMessage,
          result: undefined,
        } satisfies JobUpdate);
        if (next) this.sendDispatch(next);
        return;
      }

      // ── Exec 正常退出 ──
      const exitCode = raw.exitCode ?? 1;
      const result: Record<string, unknown> = { exitCode };
      if (raw.stdout) result.stdout = raw.stdout;
      if (raw.stderr) result.stderr = raw.stderr;
      const status = exitCode === 0 ? JobStatus.DONE : JobStatus.ERROR;
      const next = await this.jobService.markDone(data.jobId, type, result);

      this.server.emit(Events.JOB_UPDATE, {
        jobId: data.jobId,
        type,
        status,
        result,
      } satisfies JobUpdate);

      if (next) this.sendDispatch(next);
      return;
    }

    // ── FRP 回调：Client 只完成本地动作，Server 再以 Dashboard 收敛 ──
    if (type === "frp.create" || type === "frp.delete") {
      const outcome = raw.error
        ? await this.frpService.failClientOperation(
            data.jobId,
            type,
            raw.error.code || "IO_ERROR",
            raw.error.message || "",
          )
        : await this.frpService.settleClientOperation(data.jobId, type);
      if (!outcome.terminal) {
        this.sendDispatch(outcome.dispatch);
        return;
      }
      const result = {
        ...outcome.result,
        ...(outcome.errorCode
          ? {
              errorCode: outcome.errorCode,
              errorMessage: outcome.errorMessage,
            }
          : {}),
      };
      const next = await this.jobService.markDone(data.jobId, type, result);
      this.server.emit(Events.JOB_UPDATE, {
        jobId: data.jobId,
        type,
        status: outcome.errorCode ? JobStatus.ERROR : JobStatus.DONE,
        errorCode: outcome.errorCode,
        errorMessage: outcome.errorMessage,
        result: outcome.result,
      } satisfies JobUpdate);
      if (outcome.relatedJob) {
        const relatedNext = await this.jobService.markDone(
          outcome.relatedJob.jobId,
          "frp.create",
          {
            errorCode: outcome.relatedJob.errorCode,
            errorMessage: outcome.relatedJob.errorMessage,
          },
        );
        this.server.emit(Events.JOB_UPDATE, {
          jobId: outcome.relatedJob.jobId,
          type: "frp.create",
          status: JobStatus.ERROR,
          errorCode: outcome.relatedJob.errorCode,
          errorMessage: outcome.relatedJob.errorMessage,
        } satisfies JobUpdate);
        if (relatedNext) this.sendDispatch(relatedNext);
      }
      if (next) this.sendDispatch(next);
      return;
    }

    // ── 其他 Job 类型 ──
    // ── 非 exec error 终态 ──
    if (raw.error) {
      const errorCode: string = raw.error.code || "IO_ERROR";
      const errorMessage: string = raw.error.message || "";
      await this.jobService.markDone(data.jobId, type, { errorCode, errorMessage });
      this.server.emit(Events.JOB_UPDATE, {
        jobId: data.jobId,
        type,
        status: JobStatus.ERROR,
        errorCode,
        errorMessage,
        result: undefined,
      } satisfies JobUpdate);
      return;
    }

    let result: Record<string, unknown> = raw.result;

    if (type === "frp.list") {
      const next = await this.jobService.markDone(data.jobId, type, result ?? {});
      this.server.emit(Events.JOB_UPDATE, {
        jobId: data.jobId,
        type,
        status: JobStatus.DONE,
        result: raw.result,
      } satisfies JobUpdate);
      if (next) this.sendDispatch(next);
      return;
    }

    // file.export 完成后确认上传，使用 File 表中上传阶段持久化的真实 key
    if (type === "file.export" && result?.fileId && result?.sha256) {
      const file = await this.fileService.confirmUpload(
        result.fileId as string,
        result.sha256 as string,
      );
      result = { ...result, key: file.key };
    }

    const next = await this.jobService.markDone(data.jobId, type, result);
    this.server.emit(Events.JOB_UPDATE, {
      jobId: data.jobId,
      type,
      status: JobStatus.DONE,
      result,
    } satisfies JobUpdate);
    if (next) this.sendDispatch(next);
  }

  @SubscribeMessage(Events.JOB_CANCELLED)
  async handleJobCancelled(@MessageBody() data: JobCancelled) {
    const next = await this.jobService.markCancelled(data.jobId);
    const job = await this.jobService.findById(data.jobId);
    this.server.emit(Events.JOB_UPDATE, {
      jobId: data.jobId,
      type: job?.type ?? "exec",
      status: JobStatus.CANCELLED,
    } satisfies JobUpdate);
    if (next) this.sendDispatch(next);
  }

  @SubscribeMessage(Events.JOB_CANCEL_FAILED)
  handleJobCancelFailed(@MessageBody() data: JobCancelFailed) {
    console.error(`[ws] cancel failed: ${data.jobId} - ${data.reason}`);
    this.server.emit(Events.JOB_CANCEL_FAILED, data);
  }

  // ── Public API (called by controller) ──
  sendDispatch(d: DispatchPayload) {
    if (d.type === "exec") {
      const p = d.payload as Record<string, unknown>;
      if (p.mode === "script") {
        this.server.to(d.clientId).emit(Events.JOB_DISPATCH, {
          jobId: d.jobId,
          type: "exec" as const,
          mode: "script" as const,
          executable: p.executable as string,
          args: p.args as string[],
          script: p.script as string,
          cwd: p.cwd as string | undefined,
          timeout: d.timeout,
        } satisfies JobDispatch);
      } else {
        this.server.to(d.clientId).emit(Events.JOB_DISPATCH, {
          jobId: d.jobId,
          type: "exec" as const,
          mode: "command" as const,
          command: ((p as any).command ?? "") as string,
          cwd: p.cwd as string | undefined,
          timeout: d.timeout,
        } satisfies JobDispatch);
      }
    } else {
      this.server.to(d.clientId).emit(Events.JOB_DISPATCH, {
        jobId: d.jobId,
        type: d.type,
        payload: d.payload,
        timeout: d.timeout,
      } satisfies JobDispatch);
    }

    this.server.emit(Events.JOB_UPDATE, {
      jobId: d.jobId,
      type: d.type,
      status: JobStatus.RUNNING,
    } satisfies JobUpdate);
  }

  sendCancel(clientId: string, jobId: string) {
    this.server.to(clientId).emit(Events.JOB_CANCEL, { jobId });
  }
}
