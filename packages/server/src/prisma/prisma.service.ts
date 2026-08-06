import { Injectable, type OnModuleInit } from "@nestjs/common";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../../generated/client/index.js";
import { resolveDatabaseUrl } from "./database-url.js";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
	constructor() {
		const factory = new PrismaLibSql({ url: resolveDatabaseUrl() }, {});
		super({ adapter: factory });
	}

	async onModuleInit() {
		await this.$connect();
	}
}
