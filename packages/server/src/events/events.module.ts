import { Module } from "@nestjs/common";
import { EventsGateway } from "./events.gateway.js";
import { EventsController } from "./events.controller.js";
import { ClientModule } from "../client/client.module.js";
import { JobModule } from "../job/job.module.js";

@Module({
  imports: [ClientModule, JobModule],
  providers: [EventsGateway],
  controllers: [EventsController],
})
export class EventsModule {}
