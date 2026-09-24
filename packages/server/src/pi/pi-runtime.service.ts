/**
 * Pi RuntimeSpec 下发编排（Server → Client）。
 *
 * 设计来源：docs/design/remote-pi-control-plane.md §8、§19。
 * - 只由 Server 决定下发内容；Client 不做补齐；
 * - 无绑定 / Profile 未启用时登记 desired = null（Pi 不可用），不下发空 Spec；
 * - 凭据明文只在本服务的下发窗口内存在，不落日志、不写库。
 */
import { Inject, Injectable, Logger } from "@nestjs/common";
import {
	PI_BUNDLE_PROTOCOL_VERSION,
	PI_RUNTIME_SPEC_PROTOCOL_VERSION,
	type PiCapabilityStatus,
	type PiCredentialLeaseV2,
	type PiProviderInfo,
	type PiRuntimeAck,
	type PiRuntimeSpecMessageV3,
	type PiRuntimeStatus,
} from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { PiCredentialService } from "./pi-credential.service.js";
import { PiProviderService } from "./pi-provider.service.js";
import { PiProfileService } from "./pi-profile.service.js";
import { PiRuntimeRegistry } from "./pi-runtime-registry.service.js";
import {
	buildPiRuntimeSpecV3,
	type PiCredentialMeta,
} from "./pi-runtime-spec.js";

/** Server → Client 的 Spec 发送通道（由 ClientGateway.afterInit 绑定）。 */
export type PiRuntimeSender = (
	clientId: string,
	message: PiRuntimeSpecMessageV3 | null,
) => void;

@Injectable()
export class PiRuntimeService {
	private readonly logger = new Logger(PiRuntimeService.name);
	private sender: PiRuntimeSender | null = null;

	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		@Inject(PiProfileService) private readonly profiles: PiProfileService,
		@Inject(PiProviderService) private readonly providers: PiProviderService,
		@Inject(PiCredentialService)
		private readonly credentials: PiCredentialService,
		@Inject(PiRuntimeRegistry) private readonly registry: PiRuntimeRegistry,
	) {}

	/** 由 ClientGateway.afterInit 绑定真实发送通道（同 PiRequestBroker 模式）。 */
	bindSender(sender: PiRuntimeSender): void {
		this.sender = sender;
	}

	/** Client 注册后：登记 capability 安全摘要并下发当前 Spec。 */
	async onClientRegistered(
		clientId: string,
		capability?: PiCapabilityStatus,
		socketId?: string,
	): Promise<void> {
		this.registry.clear(clientId);
		if (socketId) this.registry.bindSocket(clientId, socketId);
		const supported = capability;
		if (
			!supported ||
			supported.available !== true ||
			supported.runtimeSpecProtocolVersion !== PI_RUNTIME_SPEC_PROTOCOL_VERSION ||
			supported.configMode !== "server-authoritative"
		) {
			this.registry.setUnavailable(clientId, "PI_CLIENT_UNSUPPORTED");
			return;
		}
		this.registry.setCapability(clientId, {
			piSdkVersion: supported.sdkVersion,
			runtimeSpecProtocolVersion: supported.runtimeSpecProtocolVersion,
			configMode: supported.configMode,
		});
		if (supported.modelCatalog) {
			this.registry.setModelCatalog(clientId, supported.modelCatalog);
		}
		if (supported.bundle) {
			this.registry.setBundle(clientId, supported.bundle);
		}
		await this.pushTo(clientId);
	}

	/** Client 回执；过期 specId 或旧 Socket 一律忽略。 */
	applyAck(ack: PiRuntimeAck, socketId?: string): void {
		this.registry.applyAck(ack, socketId);
	}

	/** Client PI_STATE 对账：更新 active revision 与 configState。 */
	onState(
		clientId: string,
		report: {
			runtimeRevision: string | null;
			configState: PiRuntimeStatus["configState"];
		},
		socketId?: string,
	): void {
		this.registry.applyState(clientId, report, socketId);
	}

	/**
	 * Client 断开：清除状态；重连后必须重新协商。
	 * 同一 Client 仍有存活连接时保留登记：切换绑定、恢复存活连接自身的能力并重新下发。
	 */
	async onDisconnected(clientId: string, socketId?: string): Promise<void> {
		if (!socketId) {
			this.registry.forget(clientId);
			return;
		}
		const survivor = this.registry.clearSocket(clientId, socketId);
		if (!survivor) return;
		this.logger.warn(
			`Pi 运行时：Client ${clientId} 存在重复连接，已把运行时绑定切换到存活 socket 并重新下发`,
		);
		await this.pushTo(clientId);
	}

	status(clientId: string): PiRuntimeStatus {
		return this.registry.status(clientId);
	}

	/** 未就绪时抛 PI_CONFIG_UNAVAILABLE。 */
	assertReady(clientId: string): void {
		this.registry.assertReady(clientId);
	}

	/** 任何 Pi action 都必须来自支持隔离 RuntimeSpec 的 Client。 */
	assertCompatible(clientId: string): void {
		this.registry.assertCompatible(clientId);
	}

	/**
	 * 为单个 Client 构建并下发 RuntimeSpec。
	 * 无绑定或 Profile 已禁用 → 登记 desired = null 并返回（Pi 不可用）。
	 */
	async pushTo(clientId: string): Promise<void> {
		// 不兼容（协议版本不足 / 非隔离运行时）的 Client 既不下发也不登记 desired：
		// 保留注册时写入的 incompatible 原因，避免界面把「协议版本不足」显示成「等待下发配置」。
		if (!this.registry.isCompatible(clientId)) return;

		const profile = await this.profiles.resolveBoundProfile(clientId);
		if (!profile || !profile.enabled || profile.allowedModels.length === 0) {
			this.registry.setDesired(clientId, null);
			this.emit(clientId, null);
			return;
		}

		const bundlePolicy = this.bundleGate(profile, clientId);
		if (bundlePolicy === null) {
			this.registry.setDesired(clientId, null);
			// 明确登记原因：否则界面只能显示「等待 Server 下发配置」，无法看出是目标机缺 Bundle。
			this.registry.setReason(clientId, "PI_BUNDLE_UNAVAILABLE");
			this.emit(clientId, null);
			return;
		}

		const providerIds = [...new Set(profile.allowedModels.map((model) => model.provider))];
		const providers = [...(await this.providers.getRuntimeSnapshot(providerIds))];
		const metas = await this.credentialMetas(profile.credentialIds);
		const entries = await this.credentials.resolveSecrets(profile.id);
		const requiredProviderIds = new Set(providers.map((provider) => provider.runtimeProviderId));
		const resolvedProviderIds = new Set(entries.map((entry) => entry.providerId));
		if (
			profile.credentialIds.length !== metas.length ||
			resolvedProviderIds.size !== requiredProviderIds.size ||
			[...requiredProviderIds].some((providerId) => !resolvedProviderIds.has(providerId)) ||
			entries.some((entry) => !requiredProviderIds.has(entry.providerId))
		) {
			this.registry.setDesired(clientId, null);
			this.registry.setReason(clientId, "PI_CREDENTIAL_UNAVAILABLE");
			this.emit(clientId, null);
			return;
		}
		const spec = buildPiRuntimeSpecV3(
			profile,
			providers,
			metas,
			bundlePolicy.bundleVersion,
		);

		this.registry.setDesired(clientId, {
			specId: spec.specId,
			runtimeRevision: spec.runtimeRevision,
		});
		// setDesired 会清空 providers，因此摘要必须在它之后登记，否则状态永远显示 providers: []。
		this.registry.setProviders(clientId, providers.map((provider) => ({
			providerId: provider.runtimeProviderId,
			name: provider.name,
			runtimeProviderId: provider.runtimeProviderId,
			protocol: provider.protocol as Exclude<typeof provider.protocol, null>,
			modelCount: provider.models.length,
		})));
		this.emit(clientId, {
			spec,
			credentials: { issuedAt: new Date().toISOString(), entries },
		});
	}

	/**
	 * Bundle 门控（fail closed）：Profile 需要资源时，目标 Client 必须上报兼容的 Bundle，
	 * 且资源 ID 完全覆盖 Profile 需求；否则不下发 Spec（返回 null）。
	 */
	private bundleGate(
		profile: { enabledResourceIds: string[] },
		clientId: string,
	): { bundleVersion?: string } | null {
		if (profile.enabledResourceIds.length === 0) return {};
		const bundle = this.registry.bundleFor(clientId);
		if (!bundle || bundle.protocolVersion !== PI_BUNDLE_PROTOCOL_VERSION) return null;
		if (
			!profile.enabledResourceIds.every((id) => bundle.resourceIds.includes(id))
		) {
			return null;
		}
		return { bundleVersion: bundle.bundleVersion };
	}

	/** Profile / Credential / 绑定变化后，对所有绑定该 Profile 的在线 Client 重新下发。 */
	async pushToBoundClients(profileId: string): Promise<void> {
		const bindings = await this.prisma.piClientBinding.findMany({
			where: { profileId },
		});
		for (const binding of bindings) {
			await this.pushTo(binding.clientId);
		}
	}

	/** Credential 轮换/撤销后，对所有引用该凭据的 Profile 的绑定 Client 重新下发。 */
	async pushToCredentialBoundClients(credentialId: string): Promise<void> {
		const links = await this.prisma.piProfileCredential.findMany({
			where: { credentialId },
		});
		for (const link of links) {
			await this.pushToBoundClients(link.profileId);
		}
	}

	private emit(clientId: string, message: PiRuntimeSpecMessageV3 | null): void {
		if (!this.sender) return;
		const socketId = this.registry.socketFor(clientId);
		if (!socketId || !this.registry.isCompatible(clientId)) return;
		this.sender(socketId, message);
	}

	/** 只取 id 与 updatedAt 作为 revision 输入；不读取密文。 */
	private async credentialMetas(
		credentialIds: string[],
	): Promise<PiCredentialMeta[]> {
		if (credentialIds.length === 0) return [];
		const rows = await this.prisma.piCredential.findMany({
			where: { id: { in: credentialIds } },
		});
		return rows
			.filter((row) => row.revokedAt === null && row.providerConfigId !== null)
			.map((row) => ({ id: row.id, updatedAt: row.updatedAt }));
	}
}
