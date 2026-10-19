import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module.js";
import { EventsModule } from "./events/events.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { IdentityModule } from "./identity/identity.module.js";
import { StorageModule } from "./storage/storage.module.js";
import { FileModule } from "./file/file.module.js";
import { FrpModule } from "./frp/frp.module.js";
import { ReleaseModule } from "./release/release.module.js";
import { ClientInstallerModule } from "./client-installer/client-installer.module.js";
import { GitSshModule } from "./git-ssh/git-ssh.module.js";
import { FeatureModule } from "./feature/feature.module.js";
import { AgentRegistryModule } from "./agent-registry/agent-registry.module.js";
import { TaskModule } from "./task/task.module.js";
import { A2aModule } from "./a2a/a2a.module.js";
import { RemoteDevModule } from "./remote-dev/remote-dev.module.js";

@Module({
	imports: [
		PrismaModule,
		AuthModule,
		IdentityModule,
		EventsModule,
		StorageModule,
		FileModule,
		FrpModule,
		ReleaseModule,
		ClientInstallerModule,
		GitSshModule,
		FeatureModule,
		AgentRegistryModule,
		TaskModule,
		A2aModule,
		RemoteDevModule,
	],
})
export class AppModule {}
