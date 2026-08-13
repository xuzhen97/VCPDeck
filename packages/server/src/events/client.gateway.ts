import { Inject } from "@nestjs/common";
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
import { PiRequestBroker } from "../pi/pi-request-broker.js";
import { PiEventBroker } from "../pi/pi-event-broker.js";
import { PiRunService } from "../pi/pi-run.service.js";
import { TerminalService } from "../terminal/terminal.service.js";
import { TerminalRequestBroker } from "../terminal/terminal-request-broker.js";
import {
  Events,
  JobStatus,
  parsePiEvent,
  parsePiResponse,
  parsePiStateReport,
  parseTerminalClientResponse,
  parseTerminalExitReport,
  parseTerminalOutputChunk,
  parseTerminalStateReport,
  type JobProgress,
  type PiStateAck,
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
  TerminalStateAck,
  TerminalStateReport,
} from "@vcpdeck/shared";

const PSK = process.env.VCPDECK_PSK || "vcpdeck-dev-psk";

@WebSocketGateway({ namespace: "/client", cors: { origin: process.env.VCPDECK_CORS_ORIGIN || "http://localhost:5173" } })
export class ClientGateway {
  @WebSocketServer()
  server!: Server;

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
  ) {}

  // ── Pi request 发送通道（避免与 PiModule 循环依赖） ──
  afterInit() {
    this.piRequests.bindEmitter((socketId, request) => {
      this.server.to(socketId).emit(Events.PI_REQUEST, request);
    });
    this.terminalBroker.bindEmitter((socketId, request) => {
      this.server.to(socketId).emit(Events.TERMINAL_REQUEST, request);
    });
  }

  // ── Connection lifecycle ──
  handleConnection(client: Socket) {
    const psk = client.handshake.auth?.psk;
    if (psk !== PSK) {
      client.emit("error", "invalid PSK");
      client.disconnect();
      return;
    }
    console.log(`[ws] connected: ${client.id}`);
  }

  async handleDisconnect(client: Socket) {
    const clientId = client.data.clientId as string | undefined;
    // 必须在 generation 队列外先释放等待 response 的 REST lease，避免断线死锁。
    this.piRequests.disconnect(client.id);
    this.terminalBroker.disconnect(client.id);
    if (clientId && await this.piRuns.disconnectGeneration(clientId, client.id)) {
      await this.jobService.markDisconnected(clientId);
      await this.frpService.markInactiveByClientId(clientId);
    }
    if (clientId) {
      await this.terminalService.handleClientDisconnect(clientId, client.id);
    }
    await this.clientService.markOfflineBySocketId(client.id);
    console.log(`[ws] disconnected: ${clientId ?? client.id}`);
  }

  // ── Client events ──
  @SubscribeMessage(Events.REGISTER)
  async handleRegister(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: MachineRegister,
  ) {
    await this.clientService.register(data, client.id);
    client.data.clientId = data.clientId;
    client.join(data.clientId);
    await this.piRuns.markReconcilePending(data.clientId, client.id);
    await this.terminalService.handleClientRegistered(data.clientId, client.id);
    client.emit("ack", { event: Events.REGISTER });
    console.log(`[ws] registered: ${data.clientId} (${data.hostname})`);
    return { ok: true };
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

    if (type === "exec") {
      // ── Exec error 终态（基础设施失败） ──
      if (raw.error) {
        const errorCode: string = raw.error.code || "EXEC_FAILED";
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

    // ── FRP 回调 ──
    if (type === "frp.create" || type === "frp.delete") {
      const mappingId = result?.mappingId as string | undefined;
      const status = result?.status as string ?? (raw.error ? "error" : "active");
      if (mappingId) {
        await this.frpService.updateStatus(mappingId, status);
      }
      const next = await this.jobService.markDone(data.jobId, type, result ?? {});
      this.server.emit(Events.JOB_UPDATE, {
        jobId: data.jobId,
        type,
        status: raw.error ? JobStatus.ERROR : JobStatus.DONE,
        result: raw.result,
      } satisfies JobUpdate);
      if (next) this.sendDispatch(next);
      return;
    }

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
