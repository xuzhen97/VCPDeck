/**
 * 阿里云盘配置 & OAuth 管理端点
 *
 * 提供阿里云盘存储后端的配置、OAuth PKCE 授权流程。
 * 所有配置存储在 StorageBackendConfig 表的 config JSON 字段中。
 *
 * 流程：
 * 1. PUT /api/aliyundrive/config — 设置 clientId（可选 clientSecret）
 * 2. POST /api/aliyundrive/oauth/start — 获取授权 URL
 * 3. 用户在浏览器完成授权，拿到 code
 * 4. POST /api/aliyundrive/oauth/complete — 用 code 换取 token
 * 5. GET /api/aliyundrive/status — 检查授权状态
 * 6. 将 StorageBackendConfig.kind 改为 "alibaba" → StorageService.reload()
 */
import {
	Controller,
	Get,
	Post,
	Put,
	Body,
	Inject,
	Logger,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import type {
	AlibabaStorageConfig,
} from "./providers/alibaba-types.js";
import { DEFAULT_OPENAPI_BASE, DEFAULT_TRANSFER_FOLDER } from "./providers/alibaba-types.js";
import { AlibabaOpenApiClient } from "./providers/alibaba-openapi.client.js";
import { PrismaService } from "../prisma/prisma.service.js";

/** OAuth 会话（内存缓存，服务重启丢失） */
interface OAuthSession {
	state: string;
	verifier: string;
	config: AlibabaStorageConfig;
	expiresAt: number;
}

@Controller("api/aliyundrive")
export class AliyunDriveController {
	private readonly logger = new Logger(AliyunDriveController.name);
	private oauthSessions = new Map<string, OAuthSession>();

	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
	) {}

	/** 获取当前配置和授权状态 */
	@Get("status")
	async getStatus() {
		const config = await this.getConfig();
		const now = Date.now();
		const hasAuth = Boolean(config?.accessToken);
		const isExpired = Boolean(
			config?.expiresAt && config.expiresAt <= now + 300_000,
		);
		return {
			configured: Boolean(config?.clientId),
			authorized: Boolean(config?.accessToken && !isExpired),
			hasAuth,
			isExpired,
			clientId: config?.clientId,
			openapiBase: config?.openapiBase || DEFAULT_OPENAPI_BASE,
			transferFolder: config?.transferFolder || DEFAULT_TRANSFER_FOLDER,
			driveId: config?.driveId,
			expiresAt: config?.expiresAt,
		};
	}

	/** 通过阿里云盘 OpenAPI 验证当前授权是否仍可用。 */
	@Post("verify")
	async verify() {
		const checkedAt = new Date().toISOString();
		const config = await this.getConfig();
		if (!config?.clientId) {
			return { valid: false, checkedAt, reason: "not_configured" as const };
		}

		let working = config;
		try {
			if (
				config.refreshToken &&
				(!config.accessToken ||
					!config.expiresAt ||
					config.expiresAt <= Date.now() + 300_000)
			) {
				working = {
					...config,
					...(await this.refreshAccessToken(config)),
				};
				await this.writeConfig(working);
			}

			if (!working.accessToken) {
				return { valid: false, checkedAt, reason: "not_authorized" as const };
			}
			if (working.expiresAt && working.expiresAt <= Date.now()) {
				return { valid: false, checkedAt, reason: "expired" as const };
			}

			const client = new AlibabaOpenApiClient({
				openapiBase: working.openapiBase || DEFAULT_OPENAPI_BASE,
				accessToken: working.accessToken,
			});
			const { driveId } = await client.getDriveInfo();
			await this.writeConfig({ ...working, driveId });
			return { valid: true, checkedAt, driveId };
		} catch (error) {
			const status = getHttpStatus(error);
			const reason =
				status === 401
					? "revoked"
					: status === 403
						? "forbidden"
						: status === 400
							? "revoked"
							: "unreachable";
			return { valid: false, checkedAt, reason };
		}
	}

	/** 保存配置 */
	@Put("config")
	async saveConfig(
		@Body()
		body: {
			clientId: string;
			clientSecret?: string | null;
			openapiBase?: string;
			transferFolder?: string;
		},
	) {
		if (!body.clientId?.trim()) {
			throw Object.assign(
				new Error("clientId is required"),
				{ statusCode: 400 },
			);
		}
		const config = await this.getConfig();
		const updated: AlibabaStorageConfig = {
			...config,
			clientId: body.clientId.trim(),
			clientSecret: body.clientSecret ?? config?.clientSecret,
			openapiBase: (body.openapiBase || config?.openapiBase || DEFAULT_OPENAPI_BASE).replace(/\/+$/, ""),
			transferFolder: body.transferFolder || config?.transferFolder || DEFAULT_TRANSFER_FOLDER,
		};
		await this.writeConfig(updated);
		// 不返回 clientSecret
		const { clientSecret, ...safe } = updated;
		return safe;
	}

	/** 启动 OAuth PKCE 授权流程 */
	@Post("oauth/start")
	async startOAuth() {
		const config = await this.getConfig();
		if (!config?.clientId) {
			throw Object.assign(
				new Error("请先配置 clientId: PUT /api/aliyundrive/config"),
				{ statusCode: 400 },
			);
		}
		const openapiBase = config.openapiBase || DEFAULT_OPENAPI_BASE;

		const verifier = buildCodeVerifier();
		const state = randomBytes(16).toString("hex");
		let url: URL;
		try {
			url = new URL(`${openapiBase}/oauth/authorize`);
		} catch {
			throw Object.assign(
				new Error(`无效的 openapiBase: ${openapiBase}`),
				{ statusCode: 400 },
			);
		}
		url.searchParams.set("client_id", config.clientId);
		url.searchParams.set("redirect_uri", "oob");
		url.searchParams.set("scope", "user:base,file:all:read,file:all:write");
		url.searchParams.set("response_type", "code");
		url.searchParams.set("state", state);
		url.searchParams.set("code_challenge", verifier);
		url.searchParams.set("code_challenge_method", "plain");

		this.oauthSessions.set(state, {
			state,
			verifier,
			config,
			expiresAt: Date.now() + 10 * 60 * 1000,
		});

		this.logger.log("OAuth 授权 URL 已生成");
		return {
			state,
			authorizationUrl: url.toString(),
			expiresAt: Date.now() + 10 * 60 * 1000,
		};
	}

	/** 完成 OAuth 授权（用 code 换取 token） */
	@Post("oauth/complete")
	async completeOAuth(
		@Body() body: { state: string; code: string },
	) {
		const session = this.oauthSessions.get(body.state);
		if (!session || session.expiresAt < Date.now()) {
			throw Object.assign(
				new Error("OAuth 会话已过期，请重新发起授权"),
				{ statusCode: 400 },
			);
		}

		const openapiBase = session.config.openapiBase || DEFAULT_OPENAPI_BASE;
		const payload: Record<string, string> = {
			client_id: session.config.clientId,
			grant_type: "authorization_code",
			code: body.code.trim(),
			code_verifier: session.verifier,
		};
		if (session.config.clientSecret) {
			payload.client_secret = session.config.clientSecret;
		}

		const response = await fetch(`${openapiBase}/oauth/access_token`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		if (!response.ok) {
			throw Object.assign(
				new Error(`阿里云盘 token 交换失败: HTTP ${response.status}`),
				{ statusCode: 400 },
			);
		}

		const data = (await response.json()) as {
			access_token: string;
			refresh_token?: string;
			token_type?: string;
			expires_in: number;
		};

		const updated: AlibabaStorageConfig = {
			...session.config,
			accessToken: data.access_token,
			refreshToken: data.refresh_token ?? session.config.refreshToken,
			expiresAt: Date.now() + data.expires_in * 1000,
		};
		await this.writeConfig(updated);
		this.oauthSessions.delete(body.state);

		this.logger.log("阿里云盘 OAuth 授权成功");
		return { authorized: true, expiresAt: updated.expiresAt };
	}

	/** 撤销授权（清除 token） */
	@Post("oauth/revoke")
	async revoke() {
		const config = await this.getConfig();
		if (config) {
			const cleaned: AlibabaStorageConfig = {
				...config,
				accessToken: undefined,
				refreshToken: undefined,
				expiresAt: undefined,
				driveId: undefined,
			};
			await this.writeConfig(cleaned);
		}
		return { revoked: true };
	}

	// ── private ──

	private async getConfig(): Promise<AlibabaStorageConfig | null> {
		const row = await this.prisma.storageBackendConfig.findFirst();
		if (!row) return null;
		try {
			return JSON.parse(row.config) as AlibabaStorageConfig;
		} catch {
			return null;
		}
	}

	private async refreshAccessToken(
		config: AlibabaStorageConfig,
	): Promise<Pick<AlibabaStorageConfig, "accessToken" | "refreshToken" | "expiresAt">> {
		if (!config.refreshToken) throw new Error("缺少 refresh_token");
		const openapiBase = config.openapiBase || DEFAULT_OPENAPI_BASE;
		const payload: Record<string, string> = {
			client_id: config.clientId,
			grant_type: "refresh_token",
			refresh_token: config.refreshToken,
		};
		if (config.clientSecret) payload.client_secret = config.clientSecret;

		const response = await fetch(`${openapiBase}/oauth/access_token`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		if (!response.ok) {
			throw Object.assign(new Error("阿里云盘 token 刷新失败"), {
				statusCode: response.status,
			});
		}
		const data = (await response.json()) as {
			access_token: string;
			refresh_token?: string;
			expires_in: number;
		};
		return {
			accessToken: data.access_token,
			refreshToken: data.refresh_token ?? config.refreshToken,
			expiresAt: Date.now() + data.expires_in * 1000,
		};
	}

	private async writeConfig(config: AlibabaStorageConfig): Promise<void> {
		const json = JSON.stringify(config);
		await this.prisma.storageBackendConfig.upsert({
			where: { id: 1 },
			create: { id: 1, kind: "alibaba", config: json },
			update: { config: json },
		});
	}
}

function getHttpStatus(error: unknown): number | undefined {
	if (typeof error === "object" && error !== null) {
		const statusCode = (error as { statusCode?: unknown }).statusCode;
		if (typeof statusCode === "number") return statusCode;
	}
	if (error instanceof Error) {
		const match = error.message.match(/HTTP (\d{3})/);
		if (match) return Number(match[1]);
	}
	return undefined;
}

/** 生成 PKCE code_verifier */
function buildCodeVerifier(): string {
	const alphabet =
		"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
	const bytes = randomBytes(64);
	let result = "";
	for (const byte of bytes) result += alphabet[byte % alphabet.length];
	return result;
}
