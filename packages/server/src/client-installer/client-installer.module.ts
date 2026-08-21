import { Module } from "@nestjs/common";
import { ClientModule } from "../client/client.module.js";
import { ReleaseModule } from "../release/release.module.js";
import { ClientInstallerController } from "./client-installer.controller.js";
import { ClientInstallerService } from "./client-installer.service.js";

/** 注册 Client 一键安装配置、公开引导与验收接口。 */
@Module({
	imports: [ClientModule, ReleaseModule],
	controllers: [ClientInstallerController],
	providers: [ClientInstallerService],
})
export class ClientInstallerModule {}
