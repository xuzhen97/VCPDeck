import {
  BadRequestException,
  Controller,
  Inject,
  NotFoundException,
  Post,
  Get,
  Body,
  Param,
} from "@nestjs/common";
import { JobService } from "../job/job.service.js";
import { ClientService } from "../client/client.service.js";
import { ClientGateway } from "./client.gateway.js";
import { Actor } from "../auth/actor.decorator.js";
import { Public } from "../auth/public.decorator.js";
import type { JobCreate, DispatchPayload, ActorContext } from "@vcpdeck/shared";

@Controller("api")
export class EventsController {
  constructor(
    @Inject(JobService) private readonly jobService: JobService,
    @Inject(ClientService) private readonly clientService: ClientService,
    @Inject(ClientGateway) private readonly gateway: ClientGateway,
  ) {}

  @Public()
  @Get("health")
  health() {
    return { ok: true };
  }

  @Post("jobs")
  async createJob(@Body() body: JobCreate, @Actor() actor: ActorContext) {
    let result: { jobId: string; status: string; type: string } | null = null;
    let dispatch: DispatchPayload | null = null;
    try {
      const r = await this.jobService.create(
        {
          clientId: body.clientId,
          type: body.type || "exec",
          payload: body.payload || {},
          timeout: body.timeout,
        },
        actor,
      );
      result = r.result;
      dispatch = r.dispatch;
    } catch (e: any) {
      throw new BadRequestException(e.message);
    }
    if (dispatch) {
      this.gateway.sendDispatch(dispatch);
    }
    return result;
  }

  @Post("jobs/:jobId/cancel")
  async cancelJob(@Param("jobId") jobId: string, @Actor() actor: ActorContext) {
    const { cancelled, needsDispatch, clientId } =
      await this.jobService.cancel(jobId, actor);
    if (cancelled) {
      return { jobId, status: "cancelled" };
    }
    if (needsDispatch && clientId) {
      this.gateway.sendCancel(clientId, jobId);
      return { jobId, status: "cancelling" };
    }
    throw new Error("Unexpected cancel state");
  }

  @Get("clients")
  async listClients() {
    return this.clientService.listOnline();
  }

  @Get("jobs")
  async listJobs() {
    return this.jobService.list();
  }

  @Get("jobs/:jobId")
  async getJob(@Param("jobId") jobId: string) {
    const job = await this.jobService.findById(jobId);
    if (!job) throw new NotFoundException(`Job "${jobId}" not found`);
    return job;
  }
}
