import {
  BadRequestException,
  Controller,
  Inject,
  Post,
  Get,
  Body,
  Param,
} from "@nestjs/common";
import { JobService } from "../job/job.service.js";
import { ClientService } from "../client/client.service.js";
import { EventsGateway } from "./events.gateway.js";
import type { JobCreate } from "@vcpdeck/shared";

@Controller("api")
export class EventsController {
  constructor(
    @Inject(JobService) private readonly jobService: JobService,
    @Inject(ClientService) private readonly clientService: ClientService,
    @Inject(EventsGateway) private readonly gateway: EventsGateway,
  ) {}

  @Post("jobs")
  async createJob(@Body() body: JobCreate) {
    let jobStatus: { jobId: string; status: string } | null = null;
    let dispatch: any = null;
    try {
      const r = await this.jobService.create(
        body.clientId,
        body.command,
        body.timeout,
      );
      jobStatus = r.result;
      dispatch = r.dispatch;
    } catch (e: any) {
      throw new BadRequestException(e.message);
    }
    if (dispatch) {
      this.gateway.sendDispatch(dispatch);
    }
    return jobStatus;
  }

  @Post("jobs/:jobId/cancel")
  async cancelJob(@Param("jobId") jobId: string) {
    const { cancelled, needsDispatch, clientId } =
      await this.jobService.cancel(jobId);
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
}
