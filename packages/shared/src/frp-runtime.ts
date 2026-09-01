/** FRP runtime reconciliation 协议版本。 */
export const FRP_RECONCILE_PROTOCOL_VERSION = 1 as const;

/** FRP runtime 进程状态。 */
export type FrpRuntimeStatus = "stopped" | "starting" | "running" | "retrying" | "failed";

/** FRP 恢复所有者。 */
export type FrpRecoveryOwner = "client" | "server" | null;

/** Client 上报的 FRP 能力摘要。 */
export interface FrpCapabilityStatus {
	available: boolean;
	reconcileProtocolVersion?: typeof FRP_RECONCILE_PROTOCOL_VERSION;
	code?: "FRPC_NOT_FOUND";
	message?: string;
}

/** FRP runtime 映射快照（安全投影，不含 Token）。 */
export interface FrpRuntimeMappingSnapshot {
	mappingId: string;
	name: string;
	proxyType: "tcp" | "http" | "https";
	localIp: string;
	localPort: number;
	remotePort: number | null;
	customDomain: string | null;
}

/** Client → Server 的 FRP runtime 状态上报。 */
export interface FrpRuntimeStateReport {
	clientId: string;
	connectionGeneration: string;
	runtimeGeneration: number;
	status: FrpRuntimeStatus;
	processRunning: boolean;
	recoveryOwner: FrpRecoveryOwner;
	attempt: 0 | 1 | 2;
	frpsEndpoint: { serverAddr: string; serverPort: number } | null;
	mappings: FrpRuntimeMappingSnapshot[];
	errorCode?: string;
	errorMessage?: string;
}

/** Server → Client 的 FRP 状态确认。 */
export interface FrpRuntimeStateAck {
	connectionGeneration: string;
	accepted: boolean;
	action: "none" | "client-retrying" | "server-reconciling" | "stale";
}

/** Server → Client 的批量 reconcile payload。 */
export interface FrpReconcilePayload {
	connectionGeneration: string;
	expectedRuntimeGeneration: number;
	attempt: 0 | 1 | 2;
	timeoutSeconds: number;
	frpsInfo: { serverAddr: string; serverPort: number; authToken: string };
	mappings: FrpRuntimeMappingSnapshot[];
	preservedMappings: FrpRuntimeMappingSnapshot[];
}

/** Client → Server 的 reconcile 结果。 */
export interface FrpReconcileResult {
	connectionGeneration: string;
	runtimeGeneration: number;
	status: "running" | "failed";
	loadedMappingIds: string[];
}

// ── 内部解析辅助 ──

function rtString(value: unknown, field: string, maxLength: number): string {
	if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
		throw new Error(`${field} 格式无效`);
	}
	return value;
}

function rtPort(value: unknown, field: string): number {
	if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65535) {
		throw new Error(`${field} 必须是 1–65535 的整数`);
	}
	return value as number;
}

function rtNonNegativeInt(value: unknown, field: string): number {
	if (!Number.isInteger(value) || (value as number) < 0) {
		throw new Error(`${field} 必须是非负整数`);
	}
	return value as number;
}

function rtAttempt(value: unknown, field: string): 0 | 1 | 2 {
	if (value !== 0 && value !== 1 && value !== 2) {
		throw new Error(`${field} 必须是 0、1 或 2`);
	}
	return value;
}

function rtBoolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${field} 必须是布尔值`);
	}
	return value;
}

function rtRecord(value: unknown, field: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${field} 必须是对象`);
	}
	return value as Record<string, unknown>;
}

function rtExactKeys(input: Record<string, unknown>, allowed: string[], field: string): void {
	for (const key of Object.keys(input)) {
		if (!allowed.includes(key)) {
			throw new Error(`${field} 含未知字段 ${key}`);
		}
	}
}

function rtParseMapping(value: unknown, field: string): FrpRuntimeMappingSnapshot {
	const input = rtRecord(value, field);
	rtExactKeys(
		input,
		["mappingId", "name", "proxyType", "localIp", "localPort", "remotePort", "customDomain"],
		field,
	);
	const proxyType = input.proxyType;
	if (proxyType !== "tcp" && proxyType !== "http" && proxyType !== "https") {
		throw new Error(`${field}.proxyType 必须是 tcp、http 或 https`);
	}
	return {
		mappingId: rtString(input.mappingId, `${field}.mappingId`, 128),
		name: rtString(input.name, `${field}.name`, 128),
		proxyType,
		localIp: rtString(input.localIp, `${field}.localIp`, 255),
		localPort: rtPort(input.localPort, `${field}.localPort`),
		remotePort:
			input.remotePort === null || input.remotePort === undefined
				? null
				: rtPort(input.remotePort, `${field}.remotePort`),
		customDomain:
			input.customDomain === null || input.customDomain === undefined
				? null
				: rtString(input.customDomain, `${field}.customDomain`, 253),
	};
}

function rtParseMappings(value: unknown, field: string): FrpRuntimeMappingSnapshot[] {
	if (!Array.isArray(value)) {
		throw new Error(`${field} 必须是数组`);
	}
	return value.map((item, i) => rtParseMapping(item, `${field}[${i}]`));
}

function rtParseEndpoint(
	value: unknown,
	field: string,
): { serverAddr: string; serverPort: number } | null {
	if (value === null || value === undefined) return null;
	const input = rtRecord(value, field);
	rtExactKeys(input, ["serverAddr", "serverPort"], field);
	return {
		serverAddr: rtString(input.serverAddr, `${field}.serverAddr`, 255),
		serverPort: rtPort(input.serverPort, `${field}.serverPort`),
	};
}

// ── 公开 parser ──

/** 严格解析 Client 上报的 FRP 能力摘要。 */
export function parseFrpCapabilityStatus(value: unknown): FrpCapabilityStatus {
	const input = rtRecord(value, "frp capability");
	rtExactKeys(input, ["available", "reconcileProtocolVersion", "code", "message"], "frp capability");
	const available = rtBoolean(input.available, "available");
	const result: FrpCapabilityStatus = { available };
	if (input.reconcileProtocolVersion !== undefined) {
		if (input.reconcileProtocolVersion !== FRP_RECONCILE_PROTOCOL_VERSION) {
			throw new Error("reconcileProtocolVersion 必须是 1");
		}
		result.reconcileProtocolVersion = FRP_RECONCILE_PROTOCOL_VERSION;
	}
	if (input.code !== undefined) {
		if (input.code !== "FRPC_NOT_FOUND") {
			throw new Error("code 必须是 FRPC_NOT_FOUND");
		}
		result.code = "FRPC_NOT_FOUND";
	}
	if (input.message !== undefined) {
		result.message = rtString(input.message, "message", 255);
	}
	return result;
}

/** 严格解析 Client → Server 的 FRP runtime 状态上报。 */
export function parseFrpRuntimeStateReport(value: unknown): FrpRuntimeStateReport {
	const input = rtRecord(value, "frp runtime state");
	rtExactKeys(
		input,
		[
			"clientId",
			"connectionGeneration",
			"runtimeGeneration",
			"status",
			"processRunning",
			"recoveryOwner",
			"attempt",
			"frpsEndpoint",
			"mappings",
			"errorCode",
			"errorMessage",
		],
		"frp runtime state",
	);
	const status = input.status;
	if (
		status !== "stopped" &&
		status !== "starting" &&
		status !== "running" &&
		status !== "retrying" &&
		status !== "failed"
	) {
		throw new Error("status 必须是 stopped、starting、running、retrying 或 failed");
	}
	const recoveryOwner = input.recoveryOwner;
	if (recoveryOwner !== null && recoveryOwner !== "client" && recoveryOwner !== "server") {
		throw new Error("recoveryOwner 必须是 null、client 或 server");
	}
	const result: FrpRuntimeStateReport = {
		clientId: rtString(input.clientId, "clientId", 128),
		connectionGeneration: rtString(input.connectionGeneration, "connectionGeneration", 128),
		runtimeGeneration: rtNonNegativeInt(input.runtimeGeneration, "runtimeGeneration"),
		status,
		processRunning: rtBoolean(input.processRunning, "processRunning"),
		recoveryOwner,
		attempt: rtAttempt(input.attempt, "attempt"),
		frpsEndpoint: rtParseEndpoint(input.frpsEndpoint, "frpsEndpoint"),
		mappings: rtParseMappings(input.mappings, "mappings"),
	};
	if (input.errorCode !== undefined) {
		result.errorCode = rtString(input.errorCode, "errorCode", 128);
	}
	if (input.errorMessage !== undefined) {
		result.errorMessage = rtString(input.errorMessage, "errorMessage", 255);
	}
	return result;
}

/** 严格解析 Server → Client 的批量 reconcile payload。 */
export function parseFrpReconcilePayload(value: unknown): FrpReconcilePayload {
	const input = rtRecord(value, "frp reconcile payload");
	rtExactKeys(
		input,
		[
			"connectionGeneration",
			"expectedRuntimeGeneration",
			"attempt",
			"timeoutSeconds",
			"frpsInfo",
			"mappings",
			"preservedMappings",
		],
		"frp reconcile payload",
	);
	const frpsInfo = rtRecord(input.frpsInfo, "frpsInfo");
	rtExactKeys(frpsInfo, ["serverAddr", "serverPort", "authToken"], "frpsInfo");
	return {
		connectionGeneration: rtString(input.connectionGeneration, "connectionGeneration", 128),
		expectedRuntimeGeneration: rtNonNegativeInt(
			input.expectedRuntimeGeneration,
			"expectedRuntimeGeneration",
		),
		attempt: rtAttempt(input.attempt, "attempt"),
		timeoutSeconds: rtPort(input.timeoutSeconds, "timeoutSeconds"),
		frpsInfo: {
			serverAddr: rtString(frpsInfo.serverAddr, "frpsInfo.serverAddr", 255),
			serverPort: rtPort(frpsInfo.serverPort, "frpsInfo.serverPort"),
			authToken: rtString(frpsInfo.authToken, "frpsInfo.authToken", 255),
		},
		mappings: rtParseMappings(input.mappings, "mappings"),
		preservedMappings: rtParseMappings(input.preservedMappings, "preservedMappings"),
	};
}

/** 严格解析 Server → Client 的 FRP 状态确认。 */
export function parseFrpRuntimeStateAck(value: unknown): FrpRuntimeStateAck {
	const input = rtRecord(value, "frp state ack");
	rtExactKeys(input, ["connectionGeneration", "accepted", "action"], "frp state ack");
	const action = input.action;
	if (
		action !== "none" &&
		action !== "client-retrying" &&
		action !== "server-reconciling" &&
		action !== "stale"
	) {
		throw new Error("action 必须是 none、client-retrying、server-reconciling 或 stale");
	}
	return {
		connectionGeneration: rtString(
			input.connectionGeneration,
			"connectionGeneration",
			128,
		),
		accepted: rtBoolean(input.accepted, "accepted"),
		action,
	};
}

/** 严格解析 Client → Server 的 reconcile 结果。 */
export function parseFrpReconcileResult(value: unknown): FrpReconcileResult {
	const input = rtRecord(value, "frp reconcile result");
	rtExactKeys(
		input,
		["connectionGeneration", "runtimeGeneration", "status", "loadedMappingIds"],
		"frp reconcile result",
	);
	const status = input.status;
	if (status !== "running" && status !== "failed") {
		throw new Error("status 必须是 running 或 failed");
	}
	if (
		!Array.isArray(input.loadedMappingIds) ||
		input.loadedMappingIds.some((id) => typeof id !== "string")
	) {
		throw new Error("loadedMappingIds 必须是字符串数组");
	}
	return {
		connectionGeneration: rtString(input.connectionGeneration, "connectionGeneration", 128),
		runtimeGeneration: rtNonNegativeInt(input.runtimeGeneration, "runtimeGeneration"),
		status,
		loadedMappingIds: input.loadedMappingIds as string[],
	};
}
