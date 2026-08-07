import { Module, forwardRef } from "@nestjs/common";
import { ClientGateway } from "./client.gateway.js";
import { AppGateway } from "./app.gateway.js";
import { EventsController } from "./events.controller.js";
import { ClientModule } from "../client/client.module.js";
import { JobModule } from "../job/job.module.js";
import { FileModule } from "../file/file.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { FrpModule } from "../frp/frp.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { PiModule } from "../pi/pi.module.js";

@Module({
	imports: [
		ClientModule,
		JobModule,
		FileModule,
		PrismaModule,
		StorageModule,
		forwardRef(() => FrpModule),
		PiModule,
	],
	providers: [ClientGateway, AppGateway],
	exports: [ClientGateway],
	controllers: [EventsController],
})
export class EventsModule {}
