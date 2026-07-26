import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module.js";
import { StorageService } from "./storage.service.js";
import { StorageController } from "./storage.controller.js";
import { AliyunDriveController } from "./aliyundrive.controller.js";

@Module({
	imports: [PrismaModule],
	providers: [StorageService],
	controllers: [StorageController, AliyunDriveController],
	exports: [StorageService],
})
export class StorageModule {}
