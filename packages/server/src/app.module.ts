import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module.js";
import { EventsModule } from "./events/events.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { IdentityModule } from "./identity/identity.module.js";
import { StorageModule } from "./storage/storage.module.js";
import { FileModule } from "./file/file.module.js";
import { FrpModule } from "./frp/frp.module.js";
import { PiModule } from "./pi/pi.module.js";
import { ReleaseModule } from "./release/release.module.js";

@Module({
	imports: [
		PrismaModule,
		AuthModule,
		IdentityModule,
		EventsModule,
		StorageModule,
		FileModule,
		FrpModule,
		PiModule,
		ReleaseModule,
	],
})
export class AppModule {}
