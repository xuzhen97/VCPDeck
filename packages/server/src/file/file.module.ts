import { Module } from "@nestjs/common";
import { FileService } from "./file.service.js";
import { StorageModule } from "../storage/storage.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";

@Module({
	imports: [PrismaModule, StorageModule],
	providers: [FileService],
	exports: [FileService],
})
export class FileModule {}
