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
import { Events, JobStatus } from "@vcpdeck/shared";
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
  ) {}

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
    const clientId = await this.clientService.getClientIdBySocketId(client.id);
    if (clientId) {
      await this.jobService.markDisconnected(clientId);
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
    client.join(data.clientId);
    client.emit("ack", { event: Events.REGISTER });
    console.log(`[ws] registered: ${data.clientId} (${data.hostname})`);
  }

  @SubscribeMessage(Events.HEARTBEAT)
  async handleHeartbeat(@MessageBody() data: Heartbeat) {
    await this.clientService.heartbeat(data);
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
      const result = { exitCode };
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

    const result: Record<string, unknown> = raw.result;

    // file.export 完成后确认上传 → File 记录 completed
    if (type === "file.export" && result?.fileId && result?.sha256) {
      await this.fileService.confirmUpload(
        result.fileId as string,
        result.sha256 as string,
      );
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
