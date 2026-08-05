import { Module } from "@nestjs/common";
import { JobService } from "./job.service.js";
import { JobScheduler } from "./job.scheduler.js";
import { FileModule } from "../file/file.module.js";
import { StorageModule } from "../storage/storage.module.js";

@Module({
	imports: [FileModule, StorageModule],
	providers: [JobService, JobScheduler],
	exports: [JobService, JobScheduler],
})
export class JobModule {}
