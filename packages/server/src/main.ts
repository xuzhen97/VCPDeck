import "dotenv/config";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import cookieParser from "cookie-parser";
import { PrismaService } from "./prisma/prisma.service.js";
import { FrpsInstancesService } from "./frp/frp-instances.service.js";
import { ReleaseOrchestrator } from "./release/release.orchestrator.js";
import { randomUUID } from "node:crypto";
import * as bcrypt from "bcryptjs";
import { FrontendOriginIoAdapter } from "./static/frontend-origin.adapter.js";
import {
	createFrontendFallback,
	resolveFrontendDir,
} from "./static/frontend-static.js";

const FRONTEND_ORIGIN =
	process.env.VCPDECK_FRONTEND_ORIGIN || "http://localhost:5173";

/** 监听端口：默认 3001，可用 VCPDECK_PORT 覆盖（1–65535 整数） */
function resolvePort(): number {
	const raw = process.env.VCPDECK_PORT;
	if (!raw) return 3001;
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		console.error(`[bootstrap] VCPDECK_PORT 非法: ${raw}（需要 1–65535 整数）`);
		process.exit(1);
	}
	return port;
}

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
	const app = await NestFactory.create<NestExpressApplication>(AppModule);

	// socket.io 同源 CORS（SPA 单包交付：页面与 API 同源 :3001 时 /app 也放行）；
	// 必须传入 app.getHttpServer()，否则 socket.io 会自建独立端口监听
	app.useWebSocketAdapter(new FrontendOriginIoAdapter(app.getHttpServer()));

	app.use(cookieParser());
	app.enableCors({ origin: FRONTEND_ORIGIN, credentials: true });

	// Frontend 静态资源同源托管（开发环境由 Vite 提供，找不到产物时仅 API）
	const frontendDir = resolveFrontendDir();
	if (frontendDir) {
		app.useStaticAssets(frontendDir);
		app.use(createFrontendFallback(frontendDir));
		console.log(`[frontend] 同源托管静态资源: ${frontendDir}`);
	} else {
		console.warn(
			"[frontend] 未找到 Frontend 构建产物，Server 仅提供 API（开发环境请用 Vite :5173）",
		);
	}

	await bootstrapAdmin(app.get(PrismaService));

	// seed 默认存储配置
	const prisma = app.get(PrismaService);

	// FRP 配置自动迁移（从环境变量到 DB）
	await app.get(FrpsInstancesService).migrateFromEnvIfNeeded();

	const storageCount = await prisma.storageBackendConfig.count();
	if (storageCount === 0) {
		await prisma.storageBackendConfig.create({
			data: {
				kind: "local",
				config: JSON.stringify({ baseDir: "./data/storage" }),
			},
		});
		console.log("[bootstrap] default storage backend: local");
	}

	const port = resolvePort();
	await app.listen(port);
	console.log(`VCPDeck server listening on http://localhost:${port}`);

	// 自更新编排恢复：Launcher 回退判定 / Client 阶段续跑
	void app
		.get(ReleaseOrchestrator)
		.resumeAfterStartup()
		.catch((e: unknown) => {
			console.error("[release] 恢复编排失败", e);
		});
}

bootstrap();
