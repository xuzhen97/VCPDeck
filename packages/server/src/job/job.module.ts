import { Module } from "@nestjs/common";
import { JobService } from "./job.service.js";
import { JobScheduler } from "./job.scheduler.js";
import { JobLogService } from "./job-log.service.js";
import { ServerDrain } from "./server-drain.js";
import { FileModule } from "../file/file.module.js";
import { StorageModule } from "../storage/storage.module.js";

@Module({
	imports: [FileModule, StorageModule],
	providers: [JobService, JobScheduler, JobLogService, ServerDrain],
	exports: [JobService, JobScheduler, JobLogService, ServerDrain],
})
export class JobModule {}
