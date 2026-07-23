import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module.js";
import { EventsModule } from "./events/events.module.js";

@Module({
  imports: [PrismaModule, EventsModule],
})
export class AppModule {}
