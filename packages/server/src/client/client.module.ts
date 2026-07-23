import { Module } from "@nestjs/common";
import { ClientService } from "./client.service.js";
import { PrismaModule } from "../prisma/prisma.module.js";

@Module({
  imports: [PrismaModule],
  providers: [ClientService],
  exports: [ClientService],
})
export class ClientModule {}
