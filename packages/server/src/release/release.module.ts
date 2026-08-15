import { Module } from "@nestjs/common";
import { ReleaseController } from "./release.controller.js";
import { ReleaseService } from "./release.service.js";
import { ReleaseOrchestrator } from "./release.orchestrator.js";
import { GatewayUpdateChannel } from "./update-channel.js";
import { LauncherHttpClient } from "./launcher-client.js";
import { StatusController } from "./status.controller.js";
import { JobModule } from "../job/job.module.js";
import { ClientModule } from "../client/client.module.js";

@Module({
	imports: [JobModule, ClientModule],
	controllers: [ReleaseController, StatusController],
	providers: [
		ReleaseService,
		ReleaseOrchestrator,
		GatewayUpdateChannel,
		LauncherHttpClient,
	],
	exports: [ReleaseService, ReleaseOrchestrator, GatewayUpdateChannel],
})
export class ReleaseModule {}
