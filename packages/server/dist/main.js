"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
require("reflect-metadata");
const core_1 = require("@nestjs/core");
const app_module_js_1 = require("./app.module.js");
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const prisma_service_js_1 = require("./prisma/prisma.service.js");
const frp_instances_service_js_1 = require("./frp/frp-instances.service.js");
const frp_reconciliation_service_js_1 = require("./frp/frp-reconciliation.service.js");
const release_orchestrator_js_1 = require("./release/release.orchestrator.js");
const node_crypto_1 = require("node:crypto");
const bcrypt = __importStar(require("bcryptjs"));
const frontend_origin_adapter_js_1 = require("./static/frontend-origin.adapter.js");
const frontend_static_js_1 = require("./static/frontend-static.js");
const FRONTEND_ORIGIN = process.env.VCPDECK_FRONTEND_ORIGIN || "http://localhost:5173";
/** 监听端口：默认 3001，可用 VCPDECK_PORT 覆盖（1–65535 整数） */
function resolvePort() {
    const raw = process.env.VCPDECK_PORT;
    if (!raw)
        return 3001;
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.error(`[bootstrap] VCPDECK_PORT 非法: ${raw}（需要 1–65535 整数）`);
        process.exit(1);
    }
    return port;
}
async function bootstrapAdmin(prisma) {
    const count = await prisma.identity.count({ where: { isAdmin: true } });
    if (count > 0)
        return;
    const username = process.env.VCPDECK_ADMIN_USERNAME || "admin";
    const password = process.env.VCPDECK_ADMIN_PASSWORD;
    if (!password) {
        console.error("[bootstrap] VCPDECK_ADMIN_PASSWORD is required for first boot");
        process.exit(1);
    }
    await prisma.identity.create({
        data: {
            id: (0, node_crypto_1.randomUUID)(),
            username,
            displayName: username,
            passwordHash: await bcrypt.hash(password, 10),
            isAdmin: true,
        },
    });
    console.log(`[bootstrap] admin identity created: ${username}`);
}
async function bootstrap() {
    const app = await core_1.NestFactory.create(app_module_js_1.AppModule);
    // socket.io 同源 CORS（SPA 单包交付：页面与 API 同源 :3001 时 /app 也放行）；
    // 必须传入 app.getHttpServer()，否则 socket.io 会自建独立端口监听
    app.useWebSocketAdapter(new frontend_origin_adapter_js_1.FrontendOriginIoAdapter(app.getHttpServer()));
    app.use((0, cookie_parser_1.default)());
    app.enableCors({ origin: FRONTEND_ORIGIN, credentials: true });
    // Frontend 静态资源同源托管（开发环境由 Vite 提供，找不到产物时仅 API）
    const frontendDir = (0, frontend_static_js_1.resolveFrontendDir)();
    if (frontendDir) {
        app.useStaticAssets(frontendDir);
        app.use((0, frontend_static_js_1.createFrontendFallback)(frontendDir));
        console.log(`[frontend] 同源托管静态资源: ${frontendDir}`);
    }
    else {
        console.warn("[frontend] 未找到 Frontend 构建产物，Server 仅提供 API（开发环境请用 Vite :5173）");
    }
    await bootstrapAdmin(app.get(prisma_service_js_1.PrismaService));
    // seed 默认存储配置
    const prisma = app.get(prisma_service_js_1.PrismaService);
    // FRP 配置自动迁移（从环境变量到 DB）
    await app.get(frp_instances_service_js_1.FrpsInstancesService).migrateFromEnvIfNeeded();
    // FRP 恢复启动恢复：中断遗留的 reconciling 映射回 inactive（不对外暴露为永久 busy）
    await app
        .get(frp_reconciliation_service_js_1.FrpReconciliationService)
        .recoverInterrupted()
        .catch((e) => {
        console.error("[frp-reconcile] 启动恢复失败", e);
    });
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
        .get(release_orchestrator_js_1.ReleaseOrchestrator)
        .resumeAfterStartup()
        .catch((e) => {
        console.error("[release] 恢复编排失败", e);
    });
}
bootstrap();
