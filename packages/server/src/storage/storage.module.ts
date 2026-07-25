import { Module } from "@nestjs/common";
import { StorageService } from "./storage.service.js";
import { StorageController } from "./storage.controller.js";

@Module({
	providers: [StorageService],
	controllers: [StorageController],
	exports: [StorageService],
})
export class StorageModule {}
