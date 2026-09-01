import { Module, forwardRef } from "@nestjs/common";
import { FrpService } from "./frp.service.js";
import { FrpController } from "./frp.controller.js";
import { FrpReconciliationService } from "./frp-reconciliation.service.js";
import { FrpsInstancesService } from "./frp-instances.service.js";
import { FrpsInstancesController } from "./frp-instances.controller.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { EventsModule } from "../events/events.module.js";

@Module({
	imports: [PrismaModule, forwardRef(() => EventsModule)],
	providers: [FrpService, FrpsInstancesService, FrpReconciliationService],
	controllers: [FrpController, FrpsInstancesController],
	exports: [FrpService, FrpReconciliationService],
})
export class FrpModule {}
