import { Injectable, Optional } from "@nestjs/common";
import { createHmac } from "node:crypto";
import {
	buildRemoteDesktopIceConfig,
	parseRemoteDesktopIceDeployment,
	type RemoteDesktopIceConfig,
	type RemoteDesktopIceDeployment,
} from "@vcpdeck/shared";

/**
 * 远程桌面 ICE 配置服务。
 *
 * 默认打包模式只启用 STUN 且绝不下发凭据；只有显式配置外部 TURN 时才使用
 * coturn REST 短期凭据。返回的凭据不写入数据库、不写审计、不进日志。
 */
@Injectable()
export class RemoteDesktopIceConfigService {
	private readonly deployment: RemoteDesktopIceDeployment;
	private readonly now: () => number;

	// `@Optional()` 不可省略：`env` 与 `now` 的元数据类型分别是 `Object` 与
	// `Function`，Nest 会把它们当成待注入的 provider 而解析失败。加 `@Optional()`
	// 后 Nest 注入 `undefined`，构造参数的默认值随即生效。
	constructor(
		@Optional() env: Record<string, string | undefined> = process.env,
		@Optional() now: () => number = Date.now,
	) {
		this.deployment = parseRemoteDesktopIceDeployment(env);
		this.now = now;
	}

	/** 当前生效的 ICE 策略；供健康检查和诊断使用。 */
	policy(): RemoteDesktopIceDeployment["policy"] {
		return this.deployment.policy;
	}

	/**
	 * 为一个 attachment 生成 ICE 配置。
	 *
	 * `attachmentId` 只用于构造 coturn REST 用户名，不参与密钥派生；
	 * 凭据本身完全由共享密钥和时间窗决定。
	 */
	forAttachment(attachmentId: string, actorName: string): RemoteDesktopIceConfig {
		if (this.deployment.policy === "p2p-only") {
			return buildRemoteDesktopIceConfig(this.deployment);
		}
		const secret = this.deployment.turnSharedSecret;
		if (!secret) {
			// 理论上 parseRemoteDesktopIceDeployment 已经拦截；这里保持 fail closed。
			throw new Error("TURN 共享密钥缺失");
		}
		const expiresAtMs = this.now() + this.deployment.turnTtlSeconds * 1000;
		const username = `${Math.floor(expiresAtMs / 1000)}:${sanitizeUser(attachmentId)}:${sanitizeUser(actorName)}`;
		const credential = createHmac("sha1", secret).update(username).digest("base64");
		return buildRemoteDesktopIceConfig(this.deployment, {
			username,
			credential,
			expiresAt: new Date(expiresAtMs).toISOString(),
		});
	}
}

/** coturn REST 用户名是 `expiry:user` 形态，因此不允许冒号。 */
function sanitizeUser(value: string): string {
	const cleaned = value.replaceAll(":", "_").slice(0, 64);
	return cleaned.length > 0 ? cleaned : "attachment";
}
