import { Module } from "@nestjs/common";
import { ReleaseController } from "./release.controller.js";
import { ReleaseService } from "./release.service.js";

@Module({
	controllers: [ReleaseController],
	providers: [ReleaseService],
	exports: [ReleaseService],
})
export class ReleaseModule {}
