import type { ActorContext } from "@vcpdeck/shared";
import type { AgentRegistryService } from "../agent-registry/agent-registry.service.js";
import type { PrismaService } from "../prisma/prisma.service.js";
import type { TerminalService } from "../terminal/terminal.service.js";
import type { RemoteDevClientCommand } from "@vcpdeck/shared";
import type {
	RemoteDevAuditInput,
} from "./remote-dev-audit.service.js";
import { RemoteDevService } from "./remote-dev.service.js";

export const ACTOR: ActorContext = {
	identityId: "id-1",
	displayName: "tester",
	isAdmin: false,
	credentialId: null,
	sessionId: null,
	source: "cli",
	requestId: "req-1",
};

interface SessionRow {
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
	ports: PortRow[];
}

interface PortRow {
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

interface EventRow {
	id: string;
	sessionId: string;
	seq: number;
	kind: string;
	payload: string;
	createdAt: Date;
}

export function makeRemoteDevService(
	overrides: {
		clientOnline?: boolean;
		capabilities?: string[];
		placementClientId?: string;
		workspaceRoots?: string[];
		autoAck?: boolean;
		/** 这些 action 直接回失败，用于验证失败/回滚路径。 */
		failActions?: string[];
		createTimeoutMs?: number;
		closeTimeoutMs?: number;
	} = {},
) {
	let tick = 0;
	const now = () => new Date(1_700_000_000_000 + tick++ * 1_000);
	const sessions = new Map<string, SessionRow>();
	const ports = new Map<string, PortRow>();
	const events = new Map<string, EventRow>();
	let eventSeq = 0;
	const audits: Array<Record<string, unknown>> = [];

	const prisma = {
		client: {
			async findUnique({ where }: { where?: { id?: string } } = {}) {
				// 每台 Client 一个稳定 socket，便于区分"不属于该 Client 的会话"
				const id = where?.id ?? "c1";
				return {
					socketId: id === "c1" ? "socket-1" : `socket-${id}`,
					online: overrides.clientOnline ?? true,
					capabilities: JSON.stringify(overrides.capabilities ?? ["remote-dev"]),
				};
			},
		},
		remoteDevSession: {
			async create({ data }: { data: Record<string, unknown> }) {
				const at = now();
				const row: SessionRow = {
					id: data.id as string,
					ownerIdentityId: (data.ownerIdentityId as string | null) ?? null,
					clientId: data.clientId as string,
					agentPlacementId: data.agentPlacementId as string,
					workspaceRoot: data.workspaceRoot as string,
					label: (data.label as string | null) ?? null,
					state: data.state as string,
					generationId: (data.generationId as string) ?? "",
					agentStatus: (data.agentStatus as string) ?? "starting",
					acpSessionId: (data.acpSessionId as string | null) ?? null,
					lastSeq: 0,
					createdAt: at,
					updatedAt: at,
					lastAttachedAt: null,
					expiresAt: null,
					closedAt: null,
					closeReason: null,
					cleanupStatus: "unknown",
					ports: [],
				};
				sessions.set(row.id, row);
				return row;
			},
			async update({
				where,
				data,
			}: {
				where: { id: string };
				data: Record<string, unknown>;
			}) {
				const row = sessions.get(where.id);
				if (!row) throw new Error("session not found");
				Object.assign(row, data, { updatedAt: now() });
				row.ports = [...ports.values()].filter((port) => port.sessionId === row.id);
				return row;
			},
			async findUnique({ where }: { where: { id: string } }) {
				const row = sessions.get(where.id);
				if (!row) return null;
				row.ports = [...ports.values()].filter((port) => port.sessionId === row.id);
				return row;
			},
			async findMany({ where }: { where?: Record<string, unknown> } = {}) {
				let rows = [...sessions.values()];
				if (where?.clientId) {
					rows = rows.filter((row) => row.clientId === where.clientId);
				}
				const state = where?.state as
					| { notIn?: string[] }
					| string
					| undefined;
				if (typeof state === "string") {
					rows = rows.filter((row) => row.state === state);
				} else if (state?.notIn) {
					rows = rows.filter((row) => !state.notIn?.includes(row.state));
				}
				return rows;
			},
			async count() {
				return sessions.size;
			},
			async updateMany({
				where,
				data,
			}: {
				where: {
					id?: string;
					clientId?: string;
					state?: string | { notIn?: string[] };
				};
				data: Record<string, unknown>;
			}) {
				let count = 0;
				for (const row of sessions.values()) {
					if (where.id && row.id !== where.id) continue;
					if (where.clientId && row.clientId !== where.clientId) continue;
					if (typeof where.state === "string" && row.state !== where.state) {
						continue;
					}
					if (
						typeof where.state === "object" &&
						where.state?.notIn?.includes(row.state)
					) {
						continue;
					}
					Object.assign(row, data, { updatedAt: now() });
					count += 1;
				}
				return { count };
			},
		},
		remoteDevPort: {
			async create({ data }: { data: Record<string, unknown> }) {
				const row: PortRow = {
					id: data.id as string,
					sessionId: data.sessionId as string,
					remotePort: data.remotePort as number,
					protocol: "tcp",
					label: (data.label as string | null) ?? null,
					status: data.status as string,
					createdAt: now(),
					expiresAt: null,
					closedAt: null,
					lastErrorCode: null,
				};
				ports.set(row.id, row);
				return row;
			},
			async update({
				where,
				data,
			}: {
				where: { id: string };
				data: Record<string, unknown>;
			}) {
				const row = ports.get(where.id);
				if (!row) throw new Error("port not found");
				Object.assign(row, data);
				return row;
			},
			async findUnique({ where }: { where: Record<string, unknown> }) {
				if (where.id) return ports.get(where.id as string) ?? null;
				const compound = where.sessionId_remotePort as
					| { sessionId: string; remotePort: number }
					| undefined;
				if (!compound) return null;
				return (
					[...ports.values()].find(
						(port) =>
							port.sessionId === compound.sessionId &&
							port.remotePort === compound.remotePort,
					) ?? null
				);
			},
			async findMany() {
				return [...ports.values()];
			},
			async count() {
				return [...ports.values()].filter((port) => port.status !== "closed")
					.length;
			},
			async updateMany({
				where,
				data,
			}: {
				where: { sessionId: string; status?: { not: string } };
				data: Record<string, unknown>;
			}) {
				for (const port of ports.values()) {
					if (port.sessionId !== where.sessionId) continue;
					if (where.status?.not && port.status === where.status.not) continue;
					Object.assign(port, data);
				}
			},
		},
		remoteDevAuditEvent: {
			async create({ data }: { data: Record<string, unknown> }) {
				audits.push(data);
				return { id: audits.length, at: now(), ...data };
			},
			async findMany() {
				return [];
			},
		},
		remoteDevEvent: {
			async create({ data }: { data: Record<string, unknown> }) {
				eventSeq += 1;
				const row: EventRow = {
					id: `ev-${eventSeq}`,
					sessionId: data.sessionId as string,
					seq: data.seq as number,
					kind: data.kind as string,
					payload: data.payload as string,
					createdAt: now(),
				};
				events.set(row.id, row);
				return row;
			},
			async update({
				where,
				data,
			}: {
				where: { id: string };
				data: Record<string, unknown>;
			}) {
				const row = events.get(where.id);
				if (!row) throw new Error("event not found");
				Object.assign(row, data);
				return row;
			},
			async findFirst({
				where,
				orderBy,
			}: {
				where: { sessionId: string };
				orderBy?: { seq?: "asc" | "desc" };
			}) {
				const rows = [...events.values()].filter(
					(row) => row.sessionId === where.sessionId,
				);
				rows.sort((a, b) =>
					orderBy?.seq === "desc" ? b.seq - a.seq : a.seq - b.seq,
				);
				return rows[0] ?? null;
			},
			async findMany({ where }: { where: { sessionId: string } }) {
				return [...events.values()]
					.filter((row) => row.sessionId === where.sessionId)
					.sort((a, b) => a.seq - b.seq);
			},
			async deleteMany({
				where,
			}: {
				where: { sessionId: string; seq?: { lte?: number } };
			}) {
				let count = 0;
				for (const [id, row] of events) {
					if (row.sessionId !== where.sessionId) continue;
					if (where.seq?.lte !== undefined && row.seq > where.seq.lte) continue;
					events.delete(id);
					count += 1;
				}
				return { count };
			},
		},
	} as unknown as PrismaService;

	const placement = {
		id: "p1",
		agentId: "reviewer",
		adapter: "acp" as const,
		clientId: overrides.placementClientId ?? "c1",
		command: "node",
		args: ["fake-agent.mjs"],
		cwd: "/repo",
		workspaceRoots: overrides.workspaceRoots ?? ["/repo"],
		skills: [],
	};
	const agents = {
		async resolveById() {
			return placement;
		},
	} as unknown as AgentRegistryService;
	const terminals = {
		async closeByParent() {
			return { attempted: 0, closed: 0, failed: 0 };
		},
	} as unknown as TerminalService;
	const sent: RemoteDevClientCommand[] = [];
	let service: RemoteDevService;
	const audit = {
		async record(input: RemoteDevAuditInput) {
			audits.push(input as unknown as Record<string, unknown>);
		},
	};
	service = RemoteDevService.withDeps({
		prisma,
		agents,
		terminals,
		audit,
		now,
		createTimeoutMs: overrides.createTimeoutMs ?? 1_000,
		closeTimeoutMs: overrides.closeTimeoutMs ?? 1_000,
		send: (socketId, command) => {
			sent.push(command);
			if (overrides.failActions?.includes(command.action)) {
				queueMicrotask(() => {
					void service.handleCommandResult(socketId, {
						requestId: command.requestId,
						ok: false,
						error: { code: "RDS_COMMAND_FAILED", message: "boom" },
					});
				});
				return;
			}
			if (overrides.autoAck === false) return;
			queueMicrotask(() => {
				void service.handleCommandResult(socketId, {
					requestId: command.requestId,
					ok: true,
					sessionId: command.sessionId,
					generationId: "gen-1",
				});
			});
		},
	});
	return { service, prisma, agents, terminals, audit, audits, sent, sessions, ports, events };
}
