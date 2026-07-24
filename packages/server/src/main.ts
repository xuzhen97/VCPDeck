import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import cookieParser from "cookie-parser";
import { PrismaService } from "./prisma/prisma.service.js";
import { randomUUID } from "node:crypto";
import * as bcrypt from "bcryptjs";

const FRONTEND_ORIGIN =
	process.env.VCPDECK_FRONTEND_ORIGIN || "http://localhost:5173";

async function bootstrapAdmin(prisma: PrismaService) {
	const count = await prisma.identity.count({ where: { isAdmin: true } });
	if (count > 0) return;

	const username = process.env.VCPDECK_ADMIN_USERNAME || "admin";
	const password = process.env.VCPDECK_ADMIN_PASSWORD;
	if (!password) {
		console.error(
			"[bootstrap] VCPDECK_ADMIN_PASSWORD is required for first boot",
		);
		process.exit(1);
	}

	await prisma.identity.create({
		data: {
			id: randomUUID(),
			username,
			displayName: username,
			passwordHash: await bcrypt.hash(password, 10),
			isAdmin: true,
		},
	});
	console.log(`[bootstrap] admin identity created: ${username}`);
}

async function bootstrap() {
	const app = await NestFactory.create(AppModule);

	app.use(cookieParser());
	app.enableCors({ origin: FRONTEND_ORIGIN, credentials: true });

	await bootstrapAdmin(app.get(PrismaService));

	await app.listen(3001);
	console.log("VCPDeck server listening on http://localhost:3001");
}

bootstrap();
