import { Controller, Post, Get, Body, Param } from "@nestjs/common";
import type { JobService } from "../job/job.service.js";
import type { ClientService } from "../client/client.service.js";
import type { EventsGateway } from "./events.gateway.js";
import type { JobCreate } from "@vcpdeck/shared";

@Controller("api")
export class EventsController {
  constructor(
    private readonly jobService: JobService,
    private readonly clientService: ClientService,
    private readonly gateway: EventsGateway,
  ) {}

  @Post("jobs")
  async createJob(@Body() body: JobCreate) {
    const { result, dispatch } = await this.jobService.create(
      body.clientId,
      body.command,
      body.timeout,
    );
    if (dispatch) {
      this.gateway.sendDispatch(dispatch);
    }
    return result;
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
