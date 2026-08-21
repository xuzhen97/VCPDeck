import { Module } from "@nestjs/common";
import { ReleaseController } from "./release.controller.js";
import { ReleaseService } from "./release.service.js";
import { ReleaseOrchestrator } from "./release.orchestrator.js";
import { GatewayUpdateChannel } from "./update-channel.js";
import { LauncherHttpClient } from "./launcher-client.js";
import { StatusController } from "./status.controller.js";
import { JobModule } from "../job/job.module.js";
import { ClientModule } from "../client/client.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { ReleaseUploadController } from "./release-upload.controller.js";
import { ReleaseUploadService } from "./release-upload.service.js";

@Module({
	imports: [JobModule, ClientModule, StorageModule],
	controllers: [ReleaseController, ReleaseUploadController, StatusController],
	providers: [
		ReleaseService,
		ReleaseUploadService,
		ReleaseOrchestrator,
		GatewayUpdateChannel,
		LauncherHttpClient,
	],
	exports: [ReleaseService, ReleaseOrchestrator, GatewayUpdateChannel],
})
export class ReleaseModule {}
