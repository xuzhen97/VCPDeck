import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module.js";
import { StorageService } from "./storage.service.js";
import { StorageController } from "./storage.controller.js";
import { AliyunDriveController } from "./aliyundrive.controller.js";
import { StorageShareService } from "./storage-share.service.js";
import { StorageShareController } from "./storage-share.controller.js";
import { PublicStorageShareController } from "./public-storage-share.controller.js";

@Module({
	imports: [PrismaModule],
	providers: [StorageService, StorageShareService],
	controllers: [
		StorageController,
		AliyunDriveController,
		StorageShareController,
		PublicStorageShareController,
	],
	exports: [StorageService, StorageShareService],
})
export class StorageModule {}
