/** Pi 运行时状态登记表（Server 内存权威，不持久化）。 */
import { Injectable } from "@nestjs/common";
import {
	PI_RUNTIME_SPEC_PROTOCOL_VERSION,
	type PiBundleCapability,
	type PiConfigState,
	type PiErrorCode,
	type PiModelCatalogStatus,
	type PiProviderProtocol,
	type PiRuntimeAck,
	type PiRuntimeStatus,
} from "@vcpdeck/shared";

function piError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

type ProviderSummary = {
	providerId: string;
	name: string;
	runtimeProviderId: string;
	protocol: PiProviderProtocol;
	modelCount: number;
};

interface Entry {
	specId: string | null;
	desiredRuntimeRevision: string | null;
	activeRuntimeRevision: string | null;
	configState: PiConfigState;
	reasonCode: PiErrorCode | null;
	piSdkVersion: string | null;
	runtimeSpecProtocolVersion: number | null;
	socketId: string | null;
	isolatedRuntime: boolean;
	ackReady: boolean;
	providers: ProviderSummary[];
	unavailableModels: Array<{ provider: string; modelId: string; reason: string }>;
}

/** 单个 socket 登记过的能力快照；存活 socket 接管注册表时用于恢复自身能力。 */
interface SocketCapability {
	piSdkVersion: string | null;
	runtimeSpecProtocolVersion: number | null;
	isolatedRuntime: boolean;
	bundle: PiBundleCapability | null;
	catalog: PiModelCatalogStatus | null;
}

function emptyEntry(): Entry {
	return {
		specId: null,
		desiredRuntimeRevision: null,
		activeRuntimeRevision: null,
		configState: "pending",
		reasonCode: null,
		piSdkVersion: null,
		runtimeSpecProtocolVersion: null,
		socketId: null,
		isolatedRuntime: false,
		ackReady: false,
		providers: [],
		unavailableModels: [],
	};
}

@Injectable()
export class PiRuntimeRegistry {
	private readonly entries = new Map<string, Entry>();
	/** clientId → 已登记过的存活 socket 集合（同一 Client 重复连接/重连时用于保留登记）。 */
	private readonly sockets = new Map<string, Set<string>>();
	/** clientId → socketId → 能力快照（接管时恢复存活连接自己的能力，而非被杀连接的）。 */
	private readonly capabilities = new Map<string, Map<string, SocketCapability>>();
	/** Client 上报的内置 Provider ID（仅用于模型发现时建议元数据来源）。 */
	private readonly catalogs = new Map<string, PiModelCatalogStatus>();
	/** Client 上报的已校验 Bundle 能力（缺失 = 无可用 Bundle）。 */
	private readonly bundles = new Map<string, PiBundleCapability>();

	/**
	 * 登记 Client 上报的 Bundle 能力（仅版本事实与资源 ID）。
	 * Server 据此门控需要 Bundle 资源的 Profile 能否下发。
	 */
	setBundle(clientId: string, capability: PiBundleCapability): void {
		this.bundles.set(clientId, {
			protocolVersion: capability.protocolVersion,
			bundleVersion: capability.bundleVersion,
			piSdkVersion: capability.piSdkVersion,
			resourceIds: [...capability.resourceIds],
		});
		this.captureSocketCapability(clientId);
	}

	/** 该 Client 当前可用的 Bundle 能力；未上报返回 null。 */
	bundleFor(clientId: string): PiBundleCapability | null {
		const bundle = this.bundles.get(clientId);
		return bundle ? { ...bundle, resourceIds: [...bundle.resourceIds] } : null;
	}

	/** 所有已上报 Bundle 的资源 ID 并集（供配置面选择与校验）。 */
	reportedResourceIds(): Set<string> {
		const ids = new Set<string>();
		for (const bundle of this.bundles.values()) {
			for (const id of bundle.resourceIds) ids.add(id);
		}
		return ids;
	}

	/**
	 * 登记 Client 上报的内置模型目录摘要。
	 * 不构成配置权威，仅用于让发现接口给出建议来源。
	 */
	setModelCatalog(clientId: string, catalog: PiModelCatalogStatus): void {
		this.catalogs.set(clientId, {
			sdkVersion: catalog.sdkVersion,
			providerIds: [...catalog.providerIds],
		});
		this.captureSocketCapability(clientId);
	}

	/**
	 * 查找声称支持该 providerId 的在线隔离运行时 Client。
	 * 未报告目录、或该 Client 尚未进入兼容状态的，一律视为未命中。
	 */
	findCatalogProvider(
		providerId: string,
	): { clientId: string; sdkVersion: string } | null {
		for (const [clientId, catalog] of this.catalogs) {
			if (!this.isCompatible(clientId)) continue;
			if (catalog.providerIds.includes(providerId)) {
				return { clientId, sdkVersion: catalog.sdkVersion };
			}
		}
		return null;
	}

	private entryFor(clientId: string): Entry {
		let entry = this.entries.get(clientId);
		if (!entry) {
			entry = emptyEntry();
			this.entries.set(clientId, entry);
		}
		return entry;
	}

	setCapability(
		clientId: string,
		capability: {
			piSdkVersion: string;
			runtimeSpecProtocolVersion: number;
			configMode?: "server-authoritative";
		},
	): void {
		const entry = this.entryFor(clientId);
		entry.piSdkVersion = capability.piSdkVersion;
		entry.runtimeSpecProtocolVersion = capability.runtimeSpecProtocolVersion;
		entry.isolatedRuntime = capability.configMode === "server-authoritative";
		this.captureSocketCapability(clientId);
	}

	bindSocket(clientId: string, socketId: string): void {
		this.entryFor(clientId).socketId = socketId;
		const sockets = this.sockets.get(clientId) ?? new Set<string>();
		sockets.add(socketId);
		this.sockets.set(clientId, sockets);
		// 快照当前已登记的能力，使能力设置与 bindSocket 的先后顺序不影响接管恢复。
		this.captureSocketCapability(clientId);
	}

	socketFor(clientId: string): string | null {
		return this.entries.get(clientId)?.socketId ?? null;
	}

	/**
	 * 关闭某个 socket：只有当前绑定 socket 关闭时才改动登记。
	 * 同一 clientId 仍有其它存活 socket（重复连接的 Client 进程）时保留登记并把绑定
	 * 切到存活者，避免存活 Client 的 Pi 状态被幽灵连接的断开清空。
	 * @returns 切换后的存活 socket；无存活者且登记已清除时返回 null。
	 */
	clearSocket(clientId: string, socketId: string): string | null {
		const sockets = this.sockets.get(clientId);
		sockets?.delete(socketId);
		this.capabilities.get(clientId)?.delete(socketId);
		const entry = this.entries.get(clientId);
		if (entry?.socketId !== socketId) {
			if (sockets?.size === 0) this.sockets.delete(clientId);
			return null;
		}
		const survivor = sockets && sockets.size > 0 ? ([...sockets].pop() ?? null) : null;
		if (survivor) {
			// 切换绑定并恢复存活连接自己的能力快照；否则存活 Client 会继承被断连接的能力
			// （例如无 Bundle 的幽灵连接）并永久停在 pending。
			entry.socketId = survivor;
			this.applySocketCapability(clientId, survivor);
			return survivor;
		}
		this.sockets.delete(clientId);
		this.capabilities.delete(clientId);
		this.entries.delete(clientId);
		this.catalogs.delete(clientId);
		this.bundles.delete(clientId);
		return null;
	}

	/** 记录当前绑定 socket 的能力快照（由 setCapability / setBundle / setModelCatalog 触发）。 */
	private captureSocketCapability(clientId: string): void {
		const socketId = this.entries.get(clientId)?.socketId;
		if (!socketId) return;
		const entry = this.entryFor(clientId);
		const bundle = this.bundles.get(clientId) ?? null;
		const catalog = this.catalogs.get(clientId) ?? null;
		const perSocket = this.capabilities.get(clientId) ?? new Map<string, SocketCapability>();
		perSocket.set(socketId, {
			piSdkVersion: entry.piSdkVersion,
			runtimeSpecProtocolVersion: entry.runtimeSpecProtocolVersion,
			isolatedRuntime: entry.isolatedRuntime,
			bundle: bundle ? { ...bundle, resourceIds: [...bundle.resourceIds] } : null,
			catalog: catalog ? { ...catalog, providerIds: [...catalog.providerIds] } : null,
		});
		this.capabilities.set(clientId, perSocket);
	}

	/** 用存活 socket 的快照重建登记中的能力字段；无快照则视为未上报能力。 */
	private applySocketCapability(clientId: string, socketId: string): void {
		const snapshot = this.capabilities.get(clientId)?.get(socketId) ?? null;
		const entry = this.entryFor(clientId);
		entry.piSdkVersion = snapshot?.piSdkVersion ?? null;
		entry.runtimeSpecProtocolVersion = snapshot?.runtimeSpecProtocolVersion ?? null;
		entry.isolatedRuntime = snapshot?.isolatedRuntime ?? false;
		if (snapshot?.bundle) this.bundles.set(clientId, snapshot.bundle);
		else this.bundles.delete(clientId);
		if (snapshot?.catalog) this.catalogs.set(clientId, snapshot.catalog);
		else this.catalogs.delete(clientId);
	}

	/** 只改写 reasonCode（不动 desired/configState），用于登记 Server 侧 fail-closed 原因。 */
	setReason(clientId: string, reasonCode: PiErrorCode | null): void {
		this.entryFor(clientId).reasonCode = reasonCode;
	}

	setUnavailable(clientId: string, reasonCode: PiErrorCode): void {
		const entry = this.entryFor(clientId);
		entry.configState = "incompatible";
		entry.reasonCode = reasonCode;
		entry.isolatedRuntime = false;
		entry.ackReady = false;
		entry.socketId = null;
		entry.specId = null;
		entry.desiredRuntimeRevision = null;
		entry.activeRuntimeRevision = null;
		entry.providers = [];
		entry.unavailableModels = [];
	}

	isCompatible(clientId: string): boolean {
		const entry = this.entries.get(clientId);
		return (
			entry?.isolatedRuntime === true &&
			entry.runtimeSpecProtocolVersion === PI_RUNTIME_SPEC_PROTOCOL_VERSION
		);
	}

	setDesired(
		clientId: string,
		desired: { specId: string; runtimeRevision: string } | null,
	): void {
		const entry = this.entryFor(clientId);
		if (!desired) {
			entry.specId = null;
			entry.desiredRuntimeRevision = null;
			entry.activeRuntimeRevision = null;
			entry.configState = "pending";
			entry.reasonCode = null;
			entry.ackReady = false;
			entry.providers = [];
			entry.unavailableModels = [];
			return;
		}
		entry.specId = desired.specId;
		entry.desiredRuntimeRevision = desired.runtimeRevision;
		entry.configState = "pending";
		entry.reasonCode = null;
		entry.ackReady = false;
		entry.providers = [];
		entry.unavailableModels = [];
		entry.activeRuntimeRevision = null;
	}

	setProviders(clientId: string, providers: ProviderSummary[]): void {
		this.entryFor(clientId).providers = providers.map((provider) => ({ ...provider }));
	}

	applyAck(ack: PiRuntimeAck, socketId?: string): void {
		const entry = this.entryFor(ack.clientId);
		if (socketId !== undefined && entry.socketId !== socketId) return;
		if (!entry.specId || entry.specId !== ack.specId) return;
		if (ack.runtimeRevision !== entry.desiredRuntimeRevision) return;
		entry.configState = ack.configState;
		entry.reasonCode = ack.reasonCode ?? null;
		entry.unavailableModels = ack.unavailableModels ?? [];
		entry.ackReady = ack.configState === "ready";
		if (ack.activeRuntimeRevision !== undefined) entry.activeRuntimeRevision = ack.activeRuntimeRevision;
	}

	applyState(
		clientId: string,
		report: { runtimeRevision: string | null; configState: PiConfigState },
		socketId?: string,
	): void {
		const entry = this.entryFor(clientId);
		if (socketId !== undefined && entry.socketId !== socketId) return;
		if (
			report.configState === "ready" &&
			report.runtimeRevision === entry.desiredRuntimeRevision &&
			entry.ackReady
		) {
			entry.configState = "ready";
			entry.activeRuntimeRevision = report.runtimeRevision;
		} else if (report.configState === "ready") {
			return;
		} else {
			entry.configState = report.configState;
			entry.activeRuntimeRevision = report.runtimeRevision;
		}
	}

	status(clientId: string): PiRuntimeStatus {
		const entry = this.entryFor(clientId);
		const bundle = this.bundleFor(clientId);
		return {
			clientId,
			specId: entry.specId,
			desiredRuntimeRevision: entry.desiredRuntimeRevision,
			activeRuntimeRevision: entry.activeRuntimeRevision,
			configState: entry.configState,
			reasonCode: entry.reasonCode,
			piSdkVersion: entry.piSdkVersion,
			runtimeSpecProtocolVersion: entry.runtimeSpecProtocolVersion,
			...(bundle ? { bundle } : {}),
			providers: entry.providers.map((provider) => ({ ...provider })),
			unavailableModels: entry.unavailableModels.map((item) => ({ ...item })),
		};
	}

	assertCompatible(clientId: string): void {
		const entry = this.entries.get(clientId);
		if (
			!entry?.isolatedRuntime ||
			entry.runtimeSpecProtocolVersion !== PI_RUNTIME_SPEC_PROTOCOL_VERSION
		) {
			throw piError("PI_CLIENT_UNSUPPORTED", "Pi Client 不支持隔离运行时");
		}
	}

	assertReady(clientId: string): void {
		const entry = this.entries.get(clientId);
		if (
			!entry ||
			!entry.isolatedRuntime ||
			!entry.ackReady ||
			entry.configState !== "ready" ||
			entry.activeRuntimeRevision === null ||
			entry.activeRuntimeRevision !== entry.desiredRuntimeRevision
		) {
			throw piError("PI_CONFIG_UNAVAILABLE", "Pi 配置不可用或尚未就绪");
		}
	}

	isReady(clientId: string): boolean {
		return this.entries.get(clientId)?.configState === "ready";
	}

	/**
	 * 注册时重置登记：清空条目与当前能力。
	 * 保留各存活 socket 的事实（sockets / capabilities），供重复连接接管时恢复。
	 */
	clear(clientId: string): void {
		this.entries.delete(clientId);
		this.catalogs.delete(clientId);
		this.bundles.delete(clientId);
	}

	/** 彻底遗忘该 Client（全部连接已断开或 socket 身份不明时使用）。 */
	forget(clientId: string): void {
		this.sockets.delete(clientId);
		this.capabilities.delete(clientId);
		this.clear(clientId);
	}
}
