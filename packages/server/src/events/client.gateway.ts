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

@WebSocketGateway({ namespace: "/client", cors: { origin: "*" } })
export class ClientGateway {
  @WebSocketServer()
  server!: Server;

  constructor(
    @Inject(ClientService) private readonly clientService: ClientService,
    @Inject(JobService) private readonly jobService: JobService,
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
    const result: Record<string, unknown> =
      type === "exec" ? { exitCode: raw.exitCode } : raw.result;

    const next = await this.jobService.markDone(data.jobId, type, result);

    const status =
      type === "exec" && (result as any).exitCode !== 0
        ? JobStatus.ERROR
        : JobStatus.DONE;

    this.server.emit(Events.JOB_UPDATE, {
      jobId: data.jobId,
      type,
      status,
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
      const execPayload = d.payload as { command: string };
      this.server.to(d.clientId).emit(Events.JOB_DISPATCH, {
        jobId: d.jobId,
        type: "exec" as const,
        command: execPayload.command,
        timeout: d.timeout,
      } satisfies JobDispatch);
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
