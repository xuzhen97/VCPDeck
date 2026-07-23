import { Injectable, type OnModuleInit } from "@nestjs/common";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../../generated/client/index.js";
import * as path from "node:path";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  constructor() {
    const dbPath = path.resolve("./prisma/dev.db").replace(/\\/g, "/");
    const fileUrl = "file:///" + dbPath;
    const factory = new PrismaLibSql({ url: fileUrl }, {});
    super({ adapter: factory });
  }

  async onModuleInit() {
    await this.$connect();
  }
}
