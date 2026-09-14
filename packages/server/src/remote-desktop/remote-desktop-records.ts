import {
	isRemoteDesktopAuditEventName,
	isRemoteDesktopErrorCode,
	isRemoteDesktopSessionStatus,
	type RemoteDesktopAuditInfo,
	type RemoteDesktopAuditEventName,
	type RemoteDesktopClipboardMode,
	type RemoteDesktopDisplayInfo,
	type RemoteDesktopQualityProfile,
	type RemoteDesktopRole,
	type RemoteDesktopSessionInfo,
	type RemoteDesktopSessionStatus,
} from "@vcpdeck/shared";

/** RemoteDesktopSession 行；内部字段可包含 capability hash，但不会进入 REST 投影。 */
export interface RemoteDesktopSessionRecord {
	id: string;
	clientId: string;
	createdByIdentityId: string;
	createdByName: string;
	status: string;
	selectedDisplayId: string | null;
	displaysJson: string;
	qualityProfile: string;
	clipboardMode: string;
	protocolVersion: number;
	hostGeneration: string | null;
	createdAt: Date;
	connectedAt: Date | null;
	detachedAt: Date | null;
	endedAt: Date | null;
	safeErrorCode: string | null;
	safeErrorMessage: string | null;
	/** 仅用于证明内部敏感字段不会被投影。 */
	attachmentSecretHash?: string | null;
}

/** RemoteDesktopAuditEvent 行；只允许映射已批准的生命周期元数据。 */
export interface RemoteDesktopAuditRecord {
	id: string;
	sessionId: string;
	clientId: string;
	event: string;
	identityId: string | null;
	actorName: string | null;
	attachmentId: string | null;
	role: string | null;
	result: string;
	reason: string | null;
	createdAt: Date;
}

const QUALITY_PROFILES = new Set<RemoteDesktopQualityProfile>([
	"low-bandwidth",
	"balanced",
	"high-quality",
]);
const CLIPBOARD_MODES = new Set<RemoteDesktopClipboardMode>([
	"off",
	"browser-to-remote",
	"bidirectional",
]);
const ROLES = new Set<RemoteDesktopRole>(["operator", "viewer"]);
const ROTATIONS = new Set([0, 90, 180, 270]);
const DISPLAY_KEYS = new Set([
	"id",
	"label",
	"width",
	"height",
	"physical",
	"virtual",
	"primary",
	"rotation",
	"scalePercent",
]);

function assertValue(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function assertRecordValue(
	value: unknown,
	field: string,
): asserts value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${field} 必须是对象`);
	}
}

function assertBoundedInteger(
	value: unknown,
	field: string,
	min: number,
	max: number,
): asserts value is number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		throw new Error(`${field} 无效`);
	}
}

function parseDisplay(value: unknown, index: number): RemoteDesktopDisplayInfo {
	assertRecordValue(value, `displays[${index}]`);
	const input = value;
	for (const key of Object.keys(input)) {
		assertValue(DISPLAY_KEYS.has(key), `displays[${index}] 含未知字段 ${key}`);
	}
	assertValue(typeof input.id === "string" && input.id.length > 0 && input.id.length <= 128, `displays[${index}].id 无效`);
	assertValue(typeof input.label === "string" && input.label.length > 0 && input.label.length <= 128, `displays[${index}].label 无效`);
	assertBoundedInteger(input.width, `displays[${index}].width`, 1, 16_384);
	assertBoundedInteger(input.height, `displays[${index}].height`, 1, 16_384);
	assertValue(typeof input.physical === "boolean", `displays[${index}].physical 无效`);
	assertValue(typeof input.virtual === "boolean", `displays[${index}].virtual 无效`);
	assertValue(typeof input.primary === "boolean", `displays[${index}].primary 无效`);
	assertValue(typeof input.rotation === "number" && ROTATIONS.has(input.rotation), `displays[${index}].rotation 无效`);
	assertBoundedInteger(input.scalePercent, `displays[${index}].scalePercent`, 50, 400);
	assertValue(!(input.physical && input.virtual), `displays[${index}] 不能同时为 physical 和 virtual`);
	return {
		id: input.id as string,
		label: input.label as string,
		width: input.width as number,
		height: input.height as number,
		physical: input.physical as boolean,
		virtual: input.virtual as boolean,
		primary: input.primary as boolean,
		rotation: input.rotation as 0 | 90 | 180 | 270,
		scalePercent: input.scalePercent as number,
	};
}

function parseDisplays(json: string): RemoteDesktopDisplayInfo[] {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		throw new Error("displaysJson 不是合法 JSON");
	}
	assertValue(Array.isArray(value) && value.length <= 16, "displaysJson 必须是长度不超过 16 的数组");
	const displays = value.map(parseDisplay);
	const ids = new Set<string>();
	for (const display of displays) {
		assertValue(!ids.has(display.id), `displaysJson 含重复 display id ${display.id}`);
		ids.add(display.id);
	}
	return displays;
}

function parseSessionStatus(value: string): RemoteDesktopSessionStatus {
	assertValue(isRemoteDesktopSessionStatus(value), `status 不受支持: ${value}`);
	return value;
}

function parseQualityProfile(value: string): RemoteDesktopQualityProfile {
	assertValue(QUALITY_PROFILES.has(value as RemoteDesktopQualityProfile), `qualityProfile 不受支持: ${value}`);
	return value as RemoteDesktopQualityProfile;
}

function parseClipboardMode(value: string): RemoteDesktopClipboardMode {
	assertValue(CLIPBOARD_MODES.has(value as RemoteDesktopClipboardMode), `clipboardMode 不受支持: ${value}`);
	return value as RemoteDesktopClipboardMode;
}

function parseErrorCode(value: string | null): RemoteDesktopSessionInfo["safeErrorCode"] {
	if (value === null) return null;
	assertValue(isRemoteDesktopErrorCode(value), `safeErrorCode 不受支持: ${value}`);
	return value;
}

/** 映射会话记录到安全 REST DTO；不会输出 attachment secret、SDP、ICE 或其他内部字段。 */
export function toRemoteDesktopSessionInfo(
	record: RemoteDesktopSessionRecord,
): RemoteDesktopSessionInfo {
	const displays = parseDisplays(record.displaysJson);
	const status = parseSessionStatus(record.status);
	const selectedDisplayId = record.selectedDisplayId;
	if (selectedDisplayId !== null) {
		assertValue(displays.some((display) => display.id === selectedDisplayId), "selectedDisplayId 不存在于 displays");
	}
	assertValue(Number.isInteger(record.protocolVersion) && record.protocolVersion === 1, "protocolVersion 不受支持");
	return {
		id: record.id,
		clientId: record.clientId,
		createdByIdentityId: record.createdByIdentityId,
		createdByName: record.createdByName,
		status,
		selectedDisplayId,
		displays,
		qualityProfile: parseQualityProfile(record.qualityProfile),
		clipboardMode: parseClipboardMode(record.clipboardMode),
		protocolVersion: 1,
		hostGeneration: record.hostGeneration,
		createdAt: record.createdAt.toISOString(),
		connectedAt: record.connectedAt?.toISOString() ?? null,
		detachedAt: record.detachedAt?.toISOString() ?? null,
		endedAt: record.endedAt?.toISOString() ?? null,
		safeErrorCode: parseErrorCode(record.safeErrorCode),
		safeErrorMessage: record.safeErrorMessage,
	};
}

function parseAuditEvent(value: string): RemoteDesktopAuditEventName {
	assertValue(isRemoteDesktopAuditEventName(value), `event 不受支持: ${value}`);
	return value;
}

function parseRole(value: string | null): RemoteDesktopRole | null {
	if (value === null) return null;
	assertValue(ROLES.has(value as RemoteDesktopRole), `role 不受支持: ${value}`);
	return value as RemoteDesktopRole;
}

/** 映射审计记录到安全 DTO；审计只包含生命周期元数据。 */
export function toRemoteDesktopAuditInfo(
	record: RemoteDesktopAuditRecord,
): RemoteDesktopAuditInfo {
	assertValue(record.result === "ok" || record.result === "error", "audit result 不受支持");
	return {
		id: record.id,
		sessionId: record.sessionId,
		clientId: record.clientId,
		event: parseAuditEvent(record.event),
		identityId: record.identityId,
		actorName: record.actorName,
		attachmentId: record.attachmentId,
		role: parseRole(record.role),
		result: record.result,
		reason: record.reason,
		createdAt: record.createdAt.toISOString(),
	};
}
