import { Module } from "@nestjs/common";
import { FileService } from "./file.service.js";
import { FileCleanupService } from "./file-cleanup.service.js";
import { StorageModule } from "../storage/storage.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { StorageDeleteController } from "./storage-delete.controller.js";

@Module({
	imports: [PrismaModule, StorageModule],
	providers: [FileService, FileCleanupService],
	controllers: [StorageDeleteController],
	exports: [FileService],
})
export class FileModule {}
