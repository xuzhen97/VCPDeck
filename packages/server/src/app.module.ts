import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module.js";
import { EventsModule } from "./events/events.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { IdentityModule } from "./identity/identity.module.js";

@Module({
  imports: [PrismaModule, AuthModule, IdentityModule, EventsModule],
})
export class AppModule {}
