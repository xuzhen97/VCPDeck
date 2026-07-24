import { Module } from "@nestjs/common";
import { ClientGateway } from "./client.gateway.js";
import { AppGateway } from "./app.gateway.js";
import { EventsController } from "./events.controller.js";
import { ClientModule } from "../client/client.module.js";
import { JobModule } from "../job/job.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";

@Module({
	imports: [ClientModule, JobModule, PrismaModule],
	providers: [ClientGateway, AppGateway],
	controllers: [EventsController],
})
export class EventsModule {}
