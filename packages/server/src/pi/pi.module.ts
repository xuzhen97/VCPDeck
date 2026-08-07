import { Module } from "@nestjs/common";
import { ClientModule } from "../client/client.module.js";
import { PiController } from "./pi.controller.js";
import { PiEventBroker } from "./pi-event-broker.js";
import { PiRequestBroker } from "./pi-request-broker.js";
import { PiRunService } from "./pi-run.service.js";

/** 远程 Pi 模块：broker/run 状态机 + REST/SSE Controller */
@Module({
	imports: [ClientModule],
	controllers: [PiController],
	providers: [PiRequestBroker, PiEventBroker, PiRunService],
	exports: [PiRequestBroker, PiEventBroker, PiRunService],
})
export class PiModule {}
