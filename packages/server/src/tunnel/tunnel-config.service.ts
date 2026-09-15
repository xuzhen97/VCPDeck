import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Inject, Injectable } from "@nestjs/common";
import {
	parseTunnelConfigInfo,
	parseTunnelConfigUpdate,
	type TunnelConfigInfo,
	type TunnelIceServer,
} from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";

const CONFIG_ID = "default";
/** coturn TURN REST 临时凭据固定有效期：24 小时（秒）。 */
const TURN_TTL_SECONDS = 24 * 60 * 60;

/** 隧道配置领域错误；code 稳定，statusCode 映射 HTTP。 */
export class TunnelConfigError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly statusCode: number,
	) {
		super(message);
	}
}

interface TunnelConfigRow {
	id: string;
	stunUrls: string;
	turnUrls: string;
	realm: string;
	updatedAt: Date;
}

/** 管理 P2P 隧道 ICE/coturn 配置并签发短期 TURN 凭据（secret 不落库、不外泄）。 */
@Injectable()
export class TunnelConfigService {
	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
	) {}

	/** 返回脱敏后的 ICE/coturn 配置摘要（不含 shared secret 内容）。 */
	async get(): Promise<TunnelConfigInfo> {
		const row = await this.ensureRow();
		return parseTunnelConfigInfo({
			stunUrls: parseJsonArray(row.stunUrls, "stunUrls"),
			turnUrls: parseJsonArray(row.turnUrls, "turnUrls"),
			realm: row.realm ?? "",
			turnSecretConfigured: await this.secretConfigured(),
			updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
		});
	}

	/** 保存非秘密配置字段；secret 不接受 REST 写入。 */
	async update(raw: unknown): Promise<TunnelConfigInfo> {
		const parsed = parseTunnelConfigUpdate(raw);
		await this.ensureRow();
		await this.prisma.$executeRawUnsafe(
			`UPDATE TunnelConfig
			 SET stunUrls = ?, turnUrls = ?, realm = ?, updatedAt = CURRENT_TIMESTAMP
			 WHERE id = ?`,
			JSON.stringify(parsed.stunUrls),
			JSON.stringify(parsed.turnUrls),
			parsed.realm,
			CONFIG_ID,
		);
		return this.get();
	}

	/**
	 * 为本次 Session 签发短期 ICE 服务器：STUN（无凭据）+ 每个 TURN URL 一份 24h 凭据。
	 * 缺少 TURN URL、realm 或 shared secret 时以 TUNNEL_TURN_NOT_CONFIGURED 失败。
	 */
	async issueIceServers(
		sessionId: string,
		now: Date = new Date(),
	): Promise<TunnelIceServer[]> {
		// 首次调用即保证默认行存在：全新部署未配置 coturn 时也能签发空 ICE 列表
		// （仅主机候选），使直连 P2P 可用；TURN 仅在显式配置后才加入。
		const row = await this.ensureRow();
		const stunUrls = parseJsonArray(row.stunUrls, "stunUrls");
		const turnUrls = parseJsonArray(row.turnUrls, "turnUrls");

		const result: TunnelIceServer[] = [];
		if (stunUrls.length > 0) result.push({ urls: stunUrls });
		if (turnUrls.length === 0) return result;

		const secret = await this.requireSecret();
		const username = `${Math.floor(now.getTime() / 1000) + TURN_TTL_SECONDS}:${sessionId}`;
		const credential = createHmac("sha1", secret).update(username).digest("base64");
		for (const url of turnUrls) {
			result.push({ urls: [url], username, credential });
		}
		return result;
	}

	private async ensureRow(): Promise<TunnelConfigRow> {
		let row = await this.prisma.tunnelConfig.findUnique({
			where: { id: CONFIG_ID },
		});
		if (!row) {
			row = await this.prisma.tunnelConfig.create({
				data: {
					id: CONFIG_ID,
					stunUrls: "[]",
					turnUrls: "[]",
					realm: "",
					updatedAt: new Date(),
				},
			});
		}
		return row as TunnelConfigRow;
	}

	/** 读取 shared secret 文件；env 未设置、文件缺失或不可读时返回 null（视为未配置）。 */
	private async readSecretFile(): Promise<string | null> {
		const file = process.env.VCPDECK_TURN_SECRET_FILE;
		if (!file) return null;
		try {
			return await readFile(file, "utf8");
		} catch {
			return null;
		}
	}

	private async secretConfigured(): Promise<boolean> {
		const raw = await this.readSecretFile();
		return raw !== null && raw.trim().length > 0;
	}

	private async requireSecret(): Promise<string> {
		const raw = await this.readSecretFile();
		if (raw === null) {
			throw new TunnelConfigError(
				"TUNNEL_TURN_NOT_CONFIGURED",
				"coturn shared secret 未就绪",
				503,
			);
		}
		const secret = raw.trim();
		if (secret.length === 0) {
			throw new TunnelConfigError(
				"TUNNEL_TURN_NOT_CONFIGURED",
				"coturn shared secret 为空",
				503,
			);
		}
		return secret;
	}
}

/** 安全解析 JSON 字符串数组；损坏时回退为空数组，不宽松猜测。 */
function parseJsonArray(json: string, field: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json || "[]");
	} catch {
		return [];
	}
	if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
		return [];
	}
	return parsed as string[];
}
