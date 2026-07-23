import { Module } from "@nestjs/common";
import { JobService } from "./job.service.js";
import { JobScheduler } from "./job.scheduler.js";

@Module({
  providers: [JobService, JobScheduler],
  exports: [JobService, JobScheduler],
})
export class JobModule {}
