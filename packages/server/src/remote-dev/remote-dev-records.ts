import { randomUUID } from "node:crypto";
import type {
	RemoteDevAgentState,
	RemoteDevPortInfo,
	RemoteDevSessionInfo,
	RemoteDevState,
} from "@vcpdeck/shared";

export interface RemoteDevSessionRow {
	id: string;
	ownerIdentityId: string | null;
	clientId: string;
	agentPlacementId: string;
	workspaceRoot: string;
	label: string | null;
	state: string;
	generationId: string;
	agentStatus: string;
	acpSessionId: string | null;
	lastSeq: number;
	createdAt: Date;
	updatedAt: Date;
	lastAttachedAt: Date | null;
	expiresAt: Date | null;
	closedAt: Date | null;
	closeReason: string | null;
	cleanupStatus: string;
	ports?: RemoteDevPortRow[];
}

export interface RemoteDevPortRow {
	id: string;
	sessionId: string;
	remotePort: number;
	protocol: string;
	label: string | null;
	status: string;
	createdAt: Date;
	expiresAt: Date | null;
	closedAt: Date | null;
	lastErrorCode: string | null;
}

export function toRemoteDevSessionInfo(
	row: RemoteDevSessionRow,
): RemoteDevSessionInfo {
	return {
		sessionId: row.id,
		clientId: row.clientId,
		agentPlacementId: row.agentPlacementId,
		workspaceRoot: row.workspaceRoot,
		...(row.label ? { label: row.label } : {}),
		state: row.state as RemoteDevState,
		agentStatus: row.agentStatus as RemoteDevAgentState,
		generationId: row.generationId,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		...(row.lastAttachedAt
			? { lastAttachedAt: row.lastAttachedAt.toISOString() }
			: {}),
		...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
		...(row.closedAt ? { closedAt: row.closedAt.toISOString() } : {}),
		...(row.closeReason ? { closeReason: row.closeReason } : {}),
		...(row.acpSessionId ? { acpSessionId: row.acpSessionId } : {}),
		cleanupStatus: (row.cleanupStatus as RemoteDevSessionInfo["cleanupStatus"]) ?? "unknown",
	};
}

export function toRemoteDevPortInfo(row: RemoteDevPortRow): RemoteDevPortInfo {
	return {
		portId: row.id,
		sessionId: row.sessionId,
		remotePort: row.remotePort,
		protocol: "tcp",
		...(row.label ? { label: row.label } : {}),
		status: row.status as RemoteDevPortInfo["status"],
		createdAt: row.createdAt.toISOString(),
		...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
		...(row.closedAt ? { closedAt: row.closedAt.toISOString() } : {}),
		...(row.lastErrorCode ? { lastErrorCode: row.lastErrorCode } : {}),
	};
}

export function sessionId(): string {
	return `rds_${randomId()}`;
}

export function portId(): string {
	return `rdp_${randomId()}`;
}

export function randomId(): string {
	return randomUUID().replace(/-/g, "").slice(0, 16);
}

export function parseJsonArray(value: string): string[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === "string")
			: [];
	} catch {
		return [];
	}
}

export function isUnderRoot(path: string, roots: string[]): boolean {
	const normalized = normalizePath(path);
	return roots.some((root) => {
		const prefix = normalizePath(root);
		return normalized === prefix || normalized.startsWith(`${prefix}/`);
	});
}

export function normalizePath(value: string): string {
	return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function hasParentTraversal(value: string): boolean {
	return value.split(/[\\/]+/).some((segment) => segment === "..");
}
