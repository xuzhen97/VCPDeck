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
import { TerminalModule } from "../terminal/terminal.module.js";
import { ReleaseModule } from "../release/release.module.js";
import { GitSshModule } from "../git-ssh/git-ssh.module.js";
import { TaskModule } from "../task/task.module.js";
import { RemoteDevModule } from "../remote-dev/remote-dev.module.js";
import { DshWebService } from "../dsh-web/dsh-web.service.js";

@Module({
	imports: [
		ClientModule,
		JobModule,
		FileModule,
		PrismaModule,
		StorageModule,
		forwardRef(() => FrpModule),
		forwardRef(() => ReleaseModule),
		TerminalModule,
		GitSshModule,
		TaskModule,
		RemoteDevModule,
	],
	providers: [ClientGateway, AppGateway, DshWebService],
	exports: [ClientGateway],
	controllers: [EventsController],
})
export class EventsModule {}
