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
import { TerminalService } from "../terminal/terminal.service.js";
import { TerminalRequestBroker } from "../terminal/terminal-request-broker.js";
import { ReleaseOrchestrator } from "../release/release.orchestrator.js";
import { GatewayUpdateChannel } from "../release/update-channel.js";
import {
  Events,
  JobStatus,
  parseGitSshAck,
  parseJobLogLine,
  parseTerminalClientResponse,
  parseTerminalExitReport,
  parseTerminalOutputChunk,
  parseMachineRegister,
  parseTerminalStateReport,
  type JobLogLine,
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
  TerminalClientResponse,
  TerminalOutputChunk,
  TerminalExitReport,
  TerminalStateReport,
  UpdateReady,
  UpdateFailed,
  FrpRuntimeStateAck,
} from "@vcpdeck/shared";
import { clientPsk } from "../client/client-psk.js";
import { GitSshService } from "../git-ssh/git-ssh.service.js";
import { JobLogService } from "../job/job-log.service.js";

const CLIENT_LIVENESS_SWEEP_INTERVAL_MS = 5_000;

// CORS 由引擎级的 FrontendOriginIoAdapter 统一判定(ADR-0013):socket.io 的 CORS 只在
// Server/Engine 层生效,命名空间级 cors 配置不参与握手,写在这里会被误导为「/client 受
// VCPDECK_CORS_ORIGIN 限制」。可信 Origin 白名单见 auth/trusted-origins.ts。
@WebSocketGateway({ namespace: "/client" })
export class ClientGateway implements OnModuleInit, OnModuleDestroy {
  @WebSocketServer()
  server!: Server;
  private staleClientTimer: ReturnType<typeof setInterval> | null = null;
  /** clientId → 已 REGISTER 的存活 socket（同一 Client 重复连接时逐个记账）。 */
  private readonly trackedSockets = new Map<string, Set<string>>();
  /**
   * 已记录 output_first 的 Job。首块去重依赖内存：Server 重启后可能重复记一条，
   * 内容相同、可接受；集合超过阈值后整体清空，避免长期运行无界增长。
   */
  private readonly outputSeen = new Set<string>();
  /**
   * 每 Job 的输出落盘队列：同 Job 的 chunk 串行写入，结算前 flush，
   * 保证事件链顺序（output_first 先于 settled）与 spoolBytes 准确。
   */
  private readonly outputQueues = new Map<string, Promise<void>>();

  constructor(
    @Inject(ClientService) private readonly clientService: ClientService,
    @Inject(JobService) private readonly jobService: JobService,
    @Inject(FileService) private readonly fileService: FileService,
    @Inject(FrpService) private readonly frpService: FrpService,
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
    // Git SSH 共享密钥分发（可选注入：旧测试构造保持兼容）
    @Optional()
    @Inject(GitSshService)
    private readonly gitSsh?: GitSshService,
    // Job 诊断事件链（ADR-0054）；测试可省略
    @Optional()
    @Inject(JobLogService)
    private readonly jobLog?: JobLogService,
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

  afterInit() {
    this.frpReconciliation?.bindDispatcher((socketId, dispatch) =>
      this.sendReconcileDispatch(socketId, dispatch),
    );
    // Git SSH 指令按 socketId 精准发送（绝不向 clientId room 广播私钥）。
    this.gitSsh?.bindSender((socketId, command) => {
      this.server.to(socketId).emit(Events.GIT_SSH_COMMAND, command);
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
      // 同一 Client 可能仍有其它存活连接（残留/重复 Client 进程）：此时不能把 Client
      // 标记离线，只把存储的 socket lease 切给存活连接，否则界面会看不到在线的 Client。
      const survivor = this.survivingSocketId(clientId);
      if (survivor) {
        await this.clientService.bindSocket(clientId, survivor);
        console.log(`[ws] duplicate connection kept online: ${clientId}`);
        return;
      }
      // 确认无存活连接（Client 真的离线）后才收敛业务状态：
      // 重复/残留 socket 断开不得把在跑的 Job 与 FRP 映射判死。
      await this.convergeOfflineClient(clientId);
    } else {
      // 未完成 REGISTER 的 socket 也可能持有 broker pending request。
      this.terminalBroker.disconnect(client.id);
    }
    await this.clientService.markOfflineBySocketId(client.id);
    console.log(`[ws] disconnected: ${clientId ?? client.id}`);
  }

  /** 记录已 REGISTER 的连接（同一 Client 的重复连接需分别记账）。 */
  private trackSocket(clientId: string, socketId: string): void {
    const sockets = this.trackedSockets.get(clientId) ?? new Set<string>();
    sockets.add(socketId);
    this.trackedSockets.set(clientId, sockets);
  }

  private untrackSocket(clientId: string, socketId: string): void {
    const sockets = this.trackedSockets.get(clientId);
    if (!sockets) return;
    sockets.delete(socketId);
    if (sockets.size === 0) this.trackedSockets.delete(clientId);
  }

  /** 该 Client 仍在线的其它 socket；没有则返回 null。 */
  private survivingSocketId(clientId: string): string | null {
    const sockets = this.trackedSockets.get(clientId);
    return sockets && sockets.size > 0 ? ([...sockets][0] ?? null) : null;
  }

  /** 扫描并收敛停止心跳的 Client；数据库先以 socket lease 原子摘除，避免误伤新连接。 */
  async sweepStaleClients(): Promise<void> {
    const expired = await this.clientService.expireStaleClients();
    for (const client of expired) {
      if (client.socketId) await this.cleanupClientConnection(client.clientId, client.socketId);
      // 心跳超时已由 expireStaleClients 原子置为离线，可安全收敛。
      await this.convergeOfflineClient(client.clientId);
      console.log(`[ws] heartbeat timeout: ${client.clientId}`);
    }
  }

  private async cleanupClientConnection(clientId: string, socketId: string): Promise<void> {
    this.untrackSocket(clientId, socketId);
    // 该 socket 上的 REST lease 全部失败（防串线）。
    this.terminalBroker.disconnect(socketId);
    // FRP 恢复周期只回收匹配 socket 的租约（service 内部判断）。
    void this.frpReconciliation?.disconnect(clientId, socketId);
    await this.gitSsh?.onDisconnected(clientId, socketId);
    await this.terminalService.handleClientDisconnect(clientId, socketId);
  }

  /**
   * 客户端确认离线后的业务收敛：在跑的 Job 置 disconnected、FRP 映射置 inactive。
   * 只允许在「无存活连接」或「心跳超时已判离线」时调用。
   */
  private async convergeOfflineClient(clientId: string): Promise<void> {
    await this.jobService.markDisconnected(clientId);
    await this.frpService.markInactiveByClientId(clientId);
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
      // 加固（2026-10-12 事故）：非法注册载荷**不断开连接**。
      // PSK 已在握手阶段把关（handleConnection 对错误 PSK 仍 fail closed 断开），
      // 此处只是“载荷不被接受”：断开会让旧客户端（如 0.18.2 带已退役 pi 字段）
      // 连上即被踢且 socket.io 不会自动重连 → 永久静默。
      // 保留连接 + 稳定错误码，客户端按退避重试 REGISTER，服务端修复/升级后自动恢复。
      client.emit("error", { code: "REGISTER_INVALID", message: "invalid register" });
      return { ok: false };
    }
    await this.clientService.register(register, client.id);
    client.data.clientId = register.clientId;
    this.trackSocket(register.clientId, client.id);
    client.join(register.clientId);
    await this.terminalService.handleClientRegistered(register.clientId, client.id);
    this.orchestrator.onClientRegistered(register.clientId, register.clientVersion);
    // 必须先回 REGISTER ack 再下发：Client 的 Git SSH 桥只处理 ack 之后的指令（fail closed），
    // 顺序颠倒会让本次 install 被静默丢弃、永不产生回执，目标状态永久卡在 pending。
    client.emit("ack", { event: Events.REGISTER });
    // Git SSH 分发对账：能力缺失视为未上报，由分发服务 fail closed 不下发。
    await this.gitSsh?.onRegistered(
      register.clientId,
      client.id,
      register.capabilityDetails?.gitSsh,
    );
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
  /**
   * Git SSH 安装/清理回执。
   *
   * 只表示 Client 本地受管副本状态，不代表 Git 服务已授权或已撤销；
   * 非法回执一律忽略，不改变任何状态（fail closed）。
   */
  @SubscribeMessage(Events.GIT_SSH_ACK)
  async handleGitSshAck(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ) {
    const clientId = client.data.clientId as string | undefined;
    if (!clientId || !this.gitSsh) return { ok: false };
    try {
      const ack = parseGitSshAck(data);
      await this.gitSsh.applyAck(clientId, client.id, ack);
      return { ok: true };
    } catch {
      return { ok: false };
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
    await this.enqueueOutput(data.jobId, "stdout", data.text);
    this.server.emit(Events.JOB_STDOUT, data);
  }

  @SubscribeMessage(Events.JOB_STDERR)
  async handleJobStderr(@MessageBody() data: JobOutput) {
    await this.enqueueOutput(data.jobId, "stderr", data.text);
    this.server.emit(Events.JOB_STDERR, data);
  }

  /**
   * 按 Job 串行化输出落盘：同一 Job 的 chunk 顺序写 spool 并只记一次 output_first。
   *
   * 返回该 chunk 的落盘 Promise；`handleJobDone` 在结算前 flush 队列，
   * 使事件链保持 output_first → settled 的因果顺序，`settled.spoolBytes` 也不会偏小。
   */
  private enqueueOutput(
    jobId: string,
    channel: "stdout" | "stderr",
    text: string,
  ): Promise<void> {
    const previous = this.outputQueues.get(jobId) ?? Promise.resolve();
    const next = previous
      .then(() => this.persistOutput(jobId, channel, text))
      .catch((error: unknown) => {
        // 落盘失败不能中断后续 chunk；只留一行可检索的现场。
        console.error(
          `[job-output] job=${jobId} 输出落盘失败: ${(error as { message?: string })?.message ?? "unknown"}`,
        );
      });
    this.outputQueues.set(jobId, next);
    void next.then(() => {
      if (this.outputQueues.get(jobId) === next) this.outputQueues.delete(jobId);
    });
    return next;
  }

  private async persistOutput(
    jobId: string,
    channel: "stdout" | "stderr",
    text: string,
  ): Promise<void> {
    // 先记"首块已到达"（到达即事实），再落盘：即使 spool 写入失败，这条事件仍然成立。
    await this.recordFirstOutput(jobId, channel, text);
    await this.jobService.appendOutputRaw(jobId, text);
  }

  /** 结算前冲掉该 Job 在途输出落盘；socket.io 按序投递，队列已含 done 之前的所有 chunk。 */
  private async flushOutput(jobId: string): Promise<void> {
    const pending = this.outputQueues.get(jobId);
    if (pending) await pending;
  }

  /** 只为每个 Job 记一次首块输出：用来区分"派发后一直没输出"和"有输出后卡住"。 */
  private async recordFirstOutput(
    jobId: string,
    channel: "stdout" | "stderr",
    text: string,
  ): Promise<void> {
    if (!this.jobLog || this.outputSeen.has(jobId)) return;
    if (this.outputSeen.size > 10_000) this.outputSeen.clear();
    this.outputSeen.add(jobId);
    await this.jobLog.record({
      jobId,
      event: "output_first",
      source: "server",
      data: { channel, bytes: Buffer.byteLength(text) },
    });
  }

  /** Client → Server 的 Job 生命周期相位（ADR-0054）：校验归属与限流后落库。 */
  @SubscribeMessage(Events.JOB_LOG)
  async handleJobLog(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ) {
    const clientId = client.data.clientId as string | undefined;
    if (!clientId || !this.jobLog) return { ok: false };

    let line: JobLogLine;
    try {
      line = parseJobLogLine(data);
    } catch {
      // 非法相位一律丢弃，不影响连接与 Job 本身
      return { ok: false };
    }
    if (!(await this.jobLog.allowClientEvent(clientId, line.jobId))) {
      return { ok: false };
    }
    const owner = await this.jobService.findOwnerClientId(line.jobId);
    if (!owner || owner !== clientId) return { ok: false };

    const data_: Record<string, string | number | boolean> = {
      ...(line.data ?? {}),
    };
    // clientAt 只用于和客户端本地日志对时；超出 data 键数上限时宁可不存。
    if (line.clientAt && Object.keys(data_).length < 8) {
      data_.clientAt = line.clientAt;
    }

    await this.jobLog.record({
      jobId: line.jobId,
      event: line.event,
      source: "client",
      ...(line.level ? { level: line.level } : {}),
      ...(line.code ? { code: line.code } : {}),
      ...(line.message ? { message: line.message } : {}),
      ...(Object.keys(data_).length > 0 ? { data: data_ } : {}),
    });
    return { ok: true };
  }

  @SubscribeMessage(Events.JOB_PROGRESS)
  async handleJobProgress(@MessageBody() data: JobProgress & { jobId: string }) {
    await this.jobService.updateProgress(data.jobId, data.loaded, data.total);
  }

  @SubscribeMessage(Events.JOB_DONE)
  async handleJobDone(@MessageBody() data: JobDone) {
    // 先冲掉该 Job 在途输出，再结算：保证 output_first 落在 settled 之前且 spoolBytes 准确。
    await this.flushOutput(data.jobId);
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
  async handleJobCancelFailed(@MessageBody() data: JobCancelFailed) {
    console.error(`[ws] cancel failed: ${data.jobId} - ${data.reason}`);
    await this.jobLog?.record({
      jobId: data.jobId,
      event: "cancel_failed",
      source: "server",
      level: "warn",
      message: data.reason.slice(0, 200),
    });
    // 客户端明确回答“没有这个 Job” → 它不可能再收敛。若留在 running/disconnected，会永久
    // 占住该 Client 的并发槽并让发布 drain 等不到收敛（2026-10-10 生产事故），因此收尾。
    const next = await this.jobService.failOrphaned(data.jobId, data.reason);
    const job = await this.jobService.findById(data.jobId);
    this.server.emit(Events.JOB_UPDATE, {
      jobId: data.jobId,
      type: job?.type ?? "exec",
      status: JobStatus.ERROR,
    } satisfies JobUpdate);
    this.server.emit(Events.JOB_CANCEL_FAILED, data);
    if (next) this.sendDispatch(next);
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
