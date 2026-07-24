import { Module } from "@nestjs/common";
import { IdentityService } from "./identity.service.js";
import { IdentityController } from "./identity.controller.js";
import { PrismaModule } from "../prisma/prisma.module.js";

@Module({
	imports: [PrismaModule],
	providers: [IdentityService],
	controllers: [IdentityController],
})
export class IdentityModule {}
