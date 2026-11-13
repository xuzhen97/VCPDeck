import { Module } from "@nestjs/common";
import { JobService } from "./job.service.js";
import { JobScheduler } from "./job.scheduler.js";
import { JobLogService } from "./job-log.service.js";
import { ServerDrain } from "./server-drain.js";
import { FileModule } from "../file/file.module.js";
import { StorageModule } from "../storage/storage.module.js";
// Tailnet Job 需要 TailnetKeyService；不导入则该依赖被 @Optional 吞成 undefined，
// 机器页「加入 Tailnet」会一律以 TAILNET_KEY_UNAVAILABLE 失败。
import { TailnetModule } from "../tailnet/tailnet.module.js";

@Module({
	imports: [FileModule, StorageModule, TailnetModule],
	providers: [JobService, JobScheduler, JobLogService, ServerDrain],
	exports: [JobService, JobScheduler, JobLogService, ServerDrain],
})
export class JobModule {}
