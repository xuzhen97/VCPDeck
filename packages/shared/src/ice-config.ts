import { RemoteDesktopProtocolError } from "./remote-desktop.js";
import type {
	RemoteDesktopIceConfig,
	RemoteDesktopIcePolicy,
	RemoteDesktopIceServer,
} from "./remote-desktop.js";

/**
 * ICE 部署配置的上限；与 Server 环境变量和 coturn 模板共享同一组约束。
 */
export const RemoteDesktopIceLimits = {
	maxUrls: 8,
	maxUrlLength: 256,
	maxTurnTtlSeconds: 600,
	minTurnTtlSeconds: 60,
	defaultTurnTtlSeconds: 600,
	minTurnSharedSecretLength: 16,
} as const;

export interface RemoteDesktopIceDeployment {
	policy: RemoteDesktopIcePolicy;
	stunUrls: string[];
	turnUrls: string[];
	turnSharedSecret: string | null;
	turnTtlSeconds: number;
}

export interface RemoteDesktopTurnCredentials {
	username: string;
	credential: string;
	expiresAt: string;
}

const SUPPORTED_POLICIES: readonly RemoteDesktopIcePolicy[] = ["p2p-only", "relay-allowed"];
const STUN_SCHEMES = ["stun:", "stuns:"];
const TURN_SCHEMES = ["turn:", "turns:"];

function hasScheme(url: string, schemes: readonly string[]): boolean {
	return schemes.some((scheme) => url.startsWith(scheme));
}

/** 校验单个 STUN/TURN URL 的形状；不接受任意 URL 或未知 scheme。 */
export function parseIceUrl(value: unknown, allowTurn: boolean): string {
	if (typeof value !== "string" || value.length === 0 || value.length > RemoteDesktopIceLimits.maxUrlLength) {
		throw new RemoteDesktopProtocolError("ICE URL 无效");
	}
	if (hasScheme(value, STUN_SCHEMES)) return value;
	if (allowTurn && hasScheme(value, TURN_SCHEMES)) return value;
	throw new RemoteDesktopProtocolError("ICE URL scheme 不受支持");
}

function parseUrlList(value: unknown, allowTurn: boolean): string[] {
	const raw = typeof value === "string" ? value.split(/[\s,]+/).filter((entry) => entry.length > 0) : [];
	if (raw.length > RemoteDesktopIceLimits.maxUrls) {
		throw new RemoteDesktopProtocolError("ICE URL 数量超限");
	}
	return raw.map((entry) => parseIceUrl(entry, allowTurn));
}

/**
 * 严格解析 ICE 部署环境；`p2p-only` 不接受 TURN 配置，避免误开中继。
 */
export function parseRemoteDesktopIceDeployment(
	env: Record<string, string | undefined>,
): RemoteDesktopIceDeployment {
	const policyValue = env.VCPDECK_ICE_POLICY?.trim() || "p2p-only";
	if (!(SUPPORTED_POLICIES as readonly string[]).includes(policyValue)) {
		throw new RemoteDesktopProtocolError("VCPDECK_ICE_POLICY 不受支持");
	}
	const policy = policyValue as RemoteDesktopIcePolicy;
	const stunUrls = parseUrlList(env.VCPDECK_STUN_URLS, false);
	const turnUrls = parseUrlList(env.VCPDECK_TURN_URLS, true);

	const rawTtl = env.VCPDECK_TURN_TTL_SECONDS?.trim();
	let turnTtlSeconds: number = RemoteDesktopIceLimits.defaultTurnTtlSeconds;
	if (rawTtl) {
		const parsed = Number.parseInt(rawTtl, 10);
		if (!Number.isInteger(parsed)) {
			throw new RemoteDesktopProtocolError("VCPDECK_TURN_TTL_SECONDS 无效");
		}
		turnTtlSeconds = Math.min(
			Math.max(parsed, RemoteDesktopIceLimits.minTurnTtlSeconds),
			RemoteDesktopIceLimits.maxTurnTtlSeconds,
		);
	}

	const secret = env.VCPDECK_TURN_SHARED_SECRET?.trim() || null;
	if (secret && secret.length < RemoteDesktopIceLimits.minTurnSharedSecretLength) {
		throw new RemoteDesktopProtocolError("VCPDECK_TURN_SHARED_SECRET 长度不足");
	}

	if (policy === "relay-allowed") {
		// 外部 TURN 必须同时具备 URL 和短期凭据密钥，否则无法安全地发放凭据。
		if (turnUrls.length === 0 || !secret) {
			throw new RemoteDesktopProtocolError("relay-allowed 需要 TURN URL 与共享密钥");
		}
	} else if (turnUrls.length > 0 || secret) {
		throw new RemoteDesktopProtocolError("p2p-only 不得配置 TURN");
	}

	return { policy, stunUrls, turnUrls, turnSharedSecret: secret, turnTtlSeconds };
}

/**
 * 组装下发给 Browser 的 ICE 配置。
 *
 * `p2p-only` 只产出 STUN，且绝不携带用户名或凭据；这是默认打包模式，
 * 防止 Server 无意间承担媒体中继。
 */
export function buildRemoteDesktopIceConfig(
	deployment: RemoteDesktopIceDeployment,
	turn?: RemoteDesktopTurnCredentials,
): RemoteDesktopIceConfig {
	const iceServers: RemoteDesktopIceServer[] = [];
	if (deployment.stunUrls.length > 0) {
		iceServers.push({ urls: deployment.stunUrls });
	}
	if (deployment.policy === "relay-allowed") {
		if (!turn) {
			throw new RemoteDesktopProtocolError("relay-allowed 需要 TURN 凭据");
		}
		if (deployment.turnUrls.length === 0) {
			throw new RemoteDesktopProtocolError("relay-allowed 需要 TURN URL");
		}
		iceServers.push({
			urls: deployment.turnUrls,
			username: turn.username,
			credential: turn.credential,
		});
	} else if (iceServers.some((server) => server.username !== undefined || server.credential !== undefined)) {
		// 防御性检查：p2p-only 下出现凭据意味着配置被篡改。
		throw new RemoteDesktopProtocolError("p2p-only 不得携带 TURN 凭据");
	}
	return {
		policy: deployment.policy,
		iceServers,
		expiresAt: deployment.policy === "relay-allowed" ? (turn?.expiresAt ?? null) : null,
	};
}
