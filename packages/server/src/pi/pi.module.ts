import { Module } from "@nestjs/common";
import { ClientModule } from "../client/client.module.js";
import { PiController } from "./pi.controller.js";
import { PiAdminController } from "./pi-admin.controller.js";
import { PiAttachmentService } from "./pi-attachment.service.js";
import { PiCredentialService } from "./pi-credential.service.js";
import { PiProfileService } from "./pi-profile.service.js";
import { PiProviderService } from "./pi-provider.service.js";
import { PiRuntimeRegistry } from "./pi-runtime-registry.service.js";
import { PiRuntimeService } from "./pi-runtime.service.js";
import { PiEventBroker } from "./pi-event-broker.js";
import { PiRequestBroker } from "./pi-request-broker.js";
import { PiRunService } from "./pi-run.service.js";
import { FileModule } from "../file/file.module.js";
import { StorageModule } from "../storage/storage.module.js";

/** 远程 Pi 模块：broker/run 状态机 + REST/SSE Controller */
@Module({
	imports: [ClientModule, FileModule, StorageModule],
	controllers: [PiController, PiAdminController],
	providers: [
		PiRequestBroker,
		PiEventBroker,
		PiRunService,
		PiAttachmentService,
		PiProfileService,
		PiCredentialService,
		PiProviderService,
		PiRuntimeRegistry,
		PiRuntimeService,
	],
	exports: [
		PiRequestBroker,
		PiEventBroker,
		PiRunService,
		PiProfileService,
		PiCredentialService,
		PiProviderService,
		PiRuntimeRegistry,
		PiRuntimeService,
	],
})
export class PiModule {}
