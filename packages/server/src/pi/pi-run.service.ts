import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
	ActorContext,
	PiAgentState,
	PiErrorCode,
	PiSessionJobSnapshot,
	PiStateAck,
	PiStateReport,
} from "@vcpdeck/shared";
import { JobStatus } from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";

interface ProjectLock {
	clientId: string;
	projectKey: string;
	jobId: string;
	runId: string;
}

interface ClientGeneration {
	socketId: string;
	ready: boolean;
}

interface RunPayload {
	runId?: string;
	deleteToken?: string;
	previousStatus?: DeletableStatus;
}

type DeletableStatus = "idle" | "done" | "error";
type JobRecord = {
	id: string;
	clientId: string;
	type: string;
	status: string;
	payload: string;
	result?: string | null;
	progress?: string | null;
	errorCode?: string | null;
	errorMessage?: string | null;
	createdByIdentityId?: string | null;
	createdByName?: string | null;
	finishedAt?: Date | null;
};

const SETTLEMENT_GRACE_MS = 30_000;
const EMPTY_SESSION_PAYLOAD = "{}";
const ACTIVE_STATUSES = [
	JobStatus.PENDING,
	JobStatus.RUNNING,
	JobStatus.WAITING_INPUT,
	JobStatus.DISCONNECTED,
] as const;

function piError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

function parsePayload(raw: string): RunPayload {
	try {
		const value: unknown = JSON.parse(raw);
		return value && typeof value === "object" && !Array.isArray(value)
			? value as RunPayload
			: {};
	} catch {
		return {};
	}
}

function runPayload(runId: string): string {
	return JSON.stringify({ runId });
}

function deletePayload(deleteToken: string, previousStatus: DeletableStatus): string {
	return JSON.stringify({ deleteToken, previousStatus });
}

function safePiErrorMessage(code: string): string {
	const messages: Record<PiErrorCode, string> = {
		PI_PROTOCOL_INVALID: "Pi protocol input was invalid",
		PI_CLIENT_UNSUPPORTED: "Pi client is unsupported",
		PI_NODE_UNSUPPORTED: "Node.js version is unsupported",
		PI_BASH_NOT_FOUND: "Bash was not found on the client",
		PI_RUNTIME_UNAVAILABLE: "Pi runtime is unavailable",
		PI_AUTH_UNAVAILABLE: "Pi authentication is unavailable",
		PI_MODEL_NOT_FOUND: "Pi model was not found",
		PI_PROJECT_NOT_ALLOWED: "Pi project is not allowed",
		PI_SESSION_NOT_FOUND: "Pi session was not found",
		PI_PROJECT_BUSY: "Pi project has an active run",
		PI_CONTROL_FORBIDDEN: "Pi session control is forbidden",
		PI_CLIENT_DISCONNECTED: "Pi client disconnected",
		PI_WORKER_EXITED: "Pi worker exited unexpectedly",
		PI_CLIENT_RESTARTED: "Client restarted before the Pi run could be recovered",
		PI_IMAGE_INVALID: "Pi image is invalid",
		PI_IMAGE_TOO_LARGE: "Pi image is too large",
		PI_REQUEST_TIMEOUT: "Pi request timed out",
		PI_STATE_PENDING: "Pi client state reconciliation is pending",
	};
	return messages[code as PiErrorCode] ?? "Pi session failed";
}

export interface CreateRunInput {
	clientId: string;
	sessionId: string;
	projectKey: string;
	imageCount?: number;
}

/** Pi Session Job 的原子状态机与短期连接代次租约。 */
@Injectable()
export class PiRunService {
	private readonly locks = new Map<string, ProjectLock>();
	private readonly settlementTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly generations = new Map<string, ClientGeneration>();
	private readonly queues = new Map<string, Promise<void>>();

	constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

	private lockKey(clientId: string, projectKey: string): string {
		return `${clientId}:${projectKey}`;
	}

	private settlementKey(jobId: string, runId: string): string {
		return `${jobId}:${runId}`;
	}

	private async serialized<T>(clientId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(clientId) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => { release = resolve; });
		const tail = previous.then(() => current);
		this.queues.set(clientId, tail);
		await previous;
		try {
			return await operation();
		} finally {
			release();
			if (this.queues.get(clientId) === tail) this.queues.delete(clientId);
		}
	}

	private requireGeneration(clientId: string, socketId?: string): ClientGeneration {
		const generation = this.generations.get(clientId);
		if (!generation?.ready || (socketId !== undefined && generation.socketId !== socketId)) {
			throw piError("PI_STATE_PENDING", safePiErrorMessage("PI_STATE_PENDING"));
		}
		return generation;
	}

	private async findSession(jobId: string): Promise<JobRecord> {
		const job = await this.prisma.job.findUnique({ where: { id: jobId } });
		if (!job || job.type !== "agent.session") {
			throw piError("PI_SESSION_NOT_FOUND", "Pi session was not found");
		}
		return job as JobRecord;
	}

	private setLock(clientId: string, projectKey: string, jobId: string, runId: string): void {
		this.locks.set(this.lockKey(clientId, projectKey), { clientId, projectKey, jobId, runId });
	}

	private releaseLock(jobId: string, runId: string): void {
		for (const [key, lock] of this.locks) {
			if (lock.jobId === jobId && lock.runId === runId) this.locks.delete(key);
		}
	}

	/** 仅供精确 run 测试与短期编排判断。 */
	hasLock(jobId: string, runId: string): boolean {
		return [...this.locks.values()].some((lock) => lock.jobId === jobId && lock.runId === runId);
	}

	async ensureSession(
		actor: ActorContext,
		input: { clientId: string; sessionId: string },
	): Promise<void> {
		const existing = await this.prisma.job.findUnique({ where: { id: input.sessionId } });
		if (existing) {
			if (existing.clientId !== input.clientId || existing.type !== "agent.session") {
				throw piError("PI_SESSION_NOT_FOUND", "Session id belongs to a different resource");
			}
			return;
		}
		try {
			await this.prisma.job.create({
				data: {
					id: input.sessionId,
					clientId: input.clientId,
					type: "agent.session",
					status: JobStatus.IDLE,
					payload: EMPTY_SESSION_PAYLOAD,
					progress: null,
					createdByIdentityId: actor.identityId,
					createdByName: actor.displayName,
					createdVia: actor.source,
				},
			});
		} catch (error) {
			if (!(error && typeof error === "object" && "code" in error && error.code === "P2002")) throw error;
			const winner = await this.prisma.job.findUnique({ where: { id: input.sessionId } });
			if (!winner || winner.clientId !== input.clientId || winner.type !== "agent.session") {
				throw piError("PI_SESSION_NOT_FOUND", "Session id belongs to a different resource");
			}
		}
	}

	async snapshot(sessionId: string, identityId: string): Promise<PiSessionJobSnapshot> {
		const job = await this.findSession(sessionId);
		const payload = parsePayload(job.payload);
		return {
			jobId: job.id,
			sessionId: job.id,
			status: job.status as PiSessionJobSnapshot["status"],
			runId: ACTIVE_STATUSES.includes(job.status as typeof ACTIVE_STATUSES[number])
				&& typeof payload.runId === "string" ? payload.runId : null,
			ownerName: job.createdByName ?? null,
			isOwner: job.createdByIdentityId === identityId,
			...(job.errorCode ? { errorCode: job.errorCode as PiErrorCode } : {}),
			...(job.errorMessage ? { errorMessage: job.errorMessage } : {}),
		};
	}

	async startRun(
		actor: ActorContext,
		input: { clientId: string; sessionId: string; projectKey: string },
	): Promise<{ jobId: string; runId: string }> {
		const runId = randomUUID();
		const key = this.lockKey(input.clientId, input.projectKey);
		if (this.locks.has(key)) throw piError("PI_PROJECT_BUSY", "Project has an active run");
		this.setLock(input.clientId, input.projectKey, input.sessionId, runId);
		try {
			const updated = await this.prisma.job.updateMany({
				where: {
					id: input.sessionId,
					clientId: input.clientId,
					type: "agent.session",
					status: { in: [JobStatus.IDLE, JobStatus.DONE] },
					payload: EMPTY_SESSION_PAYLOAD,
					createdByIdentityId: actor.identityId,
				},
				data: {
					status: JobStatus.PENDING,
					payload: runPayload(runId),
					progress: null,
					result: null,
					startedAt: null,
					finishedAt: null,
					errorCode: null,
					errorMessage: null,
				},
			});
			if (updated.count === 0) throw piError("PI_PROJECT_BUSY", "Session is not idle");
			return { jobId: input.sessionId, runId };
		} catch (error) {
			this.releaseLock(input.sessionId, runId);
			throw error;
		}
	}

	async accept(jobId: string, runId: string): Promise<boolean>;
	async accept(jobId: string): Promise<void>;
	async accept(jobId: string, runId?: string): Promise<boolean | void> {
		if (runId === undefined) return this.legacyTransition(jobId, [JobStatus.PENDING], { status: JobStatus.RUNNING, startedAt: new Date() });
		return this.runTransition(jobId, runId, [JobStatus.PENDING], { status: JobStatus.RUNNING, startedAt: new Date() });
	}

	async waitForInput(jobId: string, runId: string): Promise<boolean>;
	async waitForInput(jobId: string): Promise<void>;
	async waitForInput(jobId: string, runId?: string): Promise<boolean | void> {
		if (runId === undefined) return this.legacyTransition(jobId, [JobStatus.PENDING, JobStatus.RUNNING], { status: JobStatus.WAITING_INPUT });
		return this.runTransition(jobId, runId, [JobStatus.PENDING, JobStatus.RUNNING], { status: JobStatus.WAITING_INPUT });
	}

	async resume(jobId: string, runId: string): Promise<boolean>;
	async resume(jobId: string): Promise<void>;
	async resume(jobId: string, runId?: string): Promise<boolean | void> {
		if (runId === undefined) return this.legacyTransition(jobId, [JobStatus.WAITING_INPUT], { status: JobStatus.RUNNING });
		return this.runTransition(jobId, runId, [JobStatus.WAITING_INPUT], { status: JobStatus.RUNNING });
	}

	async finishRun(jobId: string, runId: string): Promise<boolean> {
		const updated = await this.runTransition(jobId, runId, ACTIVE_STATUSES, {
			status: JobStatus.IDLE,
			payload: EMPTY_SESSION_PAYLOAD,
			progress: null,
			finishedAt: null,
		});
		if (updated) this.releaseLock(jobId, runId);
		return updated;
	}

	async completeSession(jobId: string, runId?: string): Promise<boolean> {
		const now = new Date();
		if (runId !== undefined) {
			const updated = await this.runTransition(jobId, runId, ACTIVE_STATUSES, {
				status: JobStatus.DONE,
				payload: EMPTY_SESSION_PAYLOAD,
				progress: null,
				finishedAt: now,
			});
			if (updated) this.releaseLock(jobId, runId);
			if (updated) return true;
		}
		const done = await this.prisma.job.updateMany({
			where: { id: jobId, type: "agent.session", status: JobStatus.DONE, payload: EMPTY_SESSION_PAYLOAD },
			data: { status: JobStatus.DONE },
		});
		if (done.count > 0) return true;
		if (runId !== undefined) return false;
		const idle = await this.prisma.job.updateMany({
			where: { id: jobId, type: "agent.session", status: JobStatus.IDLE, payload: EMPTY_SESSION_PAYLOAD },
			data: { status: JobStatus.DONE, progress: null, finishedAt: now },
		});
		return idle.count > 0;
	}

	async failSession(jobId: string, runId: string, code: PiErrorCode): Promise<boolean> {
		const updated = await this.runTransition(jobId, runId, ACTIVE_STATUSES, {
			status: JobStatus.ERROR,
			payload: EMPTY_SESSION_PAYLOAD,
			progress: null,
			finishedAt: new Date(),
			errorCode: code,
			errorMessage: safePiErrorMessage(code),
		});
		if (updated) this.releaseLock(jobId, runId);
		return updated;
	}

	async reconcileOpen(jobId: string, runId: string, state: PiAgentState): Promise<boolean> {
		if (state.status === "idle" && !state.streaming && !state.prompting && !state.compacting) {
			return this.finishRun(jobId, runId);
		}
		const target = state.waitingForExtensionInput || state.status === "waiting_for_extension_input"
			? JobStatus.WAITING_INPUT
			: JobStatus.RUNNING;
		return this.runTransition(jobId, runId, [JobStatus.RUNNING, JobStatus.WAITING_INPUT, JobStatus.DISCONNECTED], { status: target });
	}

	async beginDelete(jobId: string, identityId: string): Promise<{
		deleteToken: string;
		previousStatus: DeletableStatus;
		existingReservation: boolean;
	}> {
		const job = await this.findSession(jobId);
		if (job.createdByIdentityId !== identityId) throw piError("PI_CONTROL_FORBIDDEN", "Only the session owner can delete it");
		const payload = parsePayload(job.payload);
		if (job.status === JobStatus.CANCELLED && payload.deleteToken && payload.previousStatus) {
			return { deleteToken: payload.deleteToken, previousStatus: payload.previousStatus, existingReservation: true };
		}
		if (![JobStatus.IDLE, JobStatus.DONE, JobStatus.ERROR].includes(job.status as JobStatus)) {
			throw piError("PI_PROJECT_BUSY", "Session has an active run");
		}
		const deleteToken = randomUUID();
		const previousStatus = job.status as DeletableStatus;
		const updated = await this.prisma.job.updateMany({
			where: { id: jobId, type: "agent.session", status: previousStatus, payload: EMPTY_SESSION_PAYLOAD },
			data: { status: JobStatus.CANCELLED, payload: deletePayload(deleteToken, previousStatus), progress: null, finishedAt: new Date() },
		});
		if (updated.count === 0) throw piError("PI_PROJECT_BUSY", "Session state changed during deletion");
		return { deleteToken, previousStatus, existingReservation: false };
	}

	async rollbackDelete(jobId: string, deleteToken: string): Promise<boolean> {
		const job = await this.findSession(jobId);
		const payload = parsePayload(job.payload);
		if (!payload.previousStatus || payload.deleteToken !== deleteToken) return false;
		const updated = await this.prisma.job.updateMany({
			where: { id: jobId, type: "agent.session", status: JobStatus.CANCELLED, payload: deletePayload(deleteToken, payload.previousStatus) },
			data: { status: payload.previousStatus, payload: EMPTY_SESSION_PAYLOAD, progress: null },
		});
		return updated.count > 0;
	}

	async commitDelete(jobId: string, deleteToken: string): Promise<boolean> {
		const job = await this.findSession(jobId);
		const payload = parsePayload(job.payload);
		if (!payload.previousStatus || payload.deleteToken !== deleteToken) return false;
		const updated = await this.prisma.job.updateMany({
			where: { id: jobId, type: "agent.session", status: JobStatus.CANCELLED, payload: deletePayload(deleteToken, payload.previousStatus) },
			data: { status: JobStatus.CANCELLED, payload: EMPTY_SESSION_PAYLOAD, progress: null },
		});
		return updated.count > 0;
	}

	async assertSessionOwner(jobId: string, identityId: string): Promise<void> {
		const job = await this.findSession(jobId);
		if (job.createdByIdentityId !== identityId) throw piError("PI_CONTROL_FORBIDDEN", "Only the session owner can control it");
	}

	async assertCurrentRunOwner(jobId: string, runId: string, identityId: string): Promise<void> {
		const job = await this.findSession(jobId);
		if (job.createdByIdentityId !== identityId || job.payload !== runPayload(runId) || !ACTIVE_STATUSES.includes(job.status as typeof ACTIVE_STATUSES[number])) {
			throw piError("PI_CONTROL_FORBIDDEN", "Only the current run owner can control it");
		}
	}

	async scheduleSettlement(jobId: string, runId: string, onSettle: () => Promise<void>): Promise<void>;
	async scheduleSettlement(jobId: string, onSettle: () => Promise<void>): Promise<void>;
	async scheduleSettlement(jobId: string, runIdOrSettle: string | (() => Promise<void>), onSettle?: () => Promise<void>): Promise<void> {
		const runId = typeof runIdOrSettle === "string" ? runIdOrSettle : jobId;
		const settle = typeof runIdOrSettle === "function" ? runIdOrSettle : onSettle!;
		this.cancelSettlement(jobId, runId);
		const key = this.settlementKey(jobId, runId);
		const timer = setTimeout(() => {
			this.settlementTimers.delete(key);
			void Promise.resolve(settle()).catch(() => {});
		}, SETTLEMENT_GRACE_MS);
		this.settlementTimers.set(key, timer);
	}

	cancelSettlement(jobId: string, runId?: string): void {
		const key = this.settlementKey(jobId, runId ?? jobId);
		const timer = this.settlementTimers.get(key);
		if (timer) {
			clearTimeout(timer);
			this.settlementTimers.delete(key);
		}
	}

	async markReconcilePending(clientId: string, socketId: string): Promise<void> {
		await this.serialized(clientId, async () => {
			this.generations.set(clientId, { socketId, ready: false });
		});
	}

	async withReconciledClient<T>(clientId: string, operation: (lease: { clientId: string; socketId: string }) => Promise<T>): Promise<T> {
		const generation = this.requireGeneration(clientId);
		const socketId = generation.socketId;
		return this.serialized(clientId, async () => {
			this.requireGeneration(clientId, socketId);
			return operation({ clientId, socketId });
		});
	}

	async withReconciledSocket<T>(clientId: string, socketId: string, operation: () => Promise<T>): Promise<T> {
		this.requireGeneration(clientId, socketId);
		return this.serialized(clientId, async () => {
			this.requireGeneration(clientId, socketId);
			return operation();
		});
	}

	async reconcileGeneration(clientId: string, socketId: string, report: PiStateReport): Promise<PiStateAck> {
		return this.serialized(clientId, async () => {
			const generation = this.generations.get(clientId);
			if (!generation || generation.socketId !== socketId || generation.ready) {
				throw piError("PI_STATE_PENDING", safePiErrorMessage("PI_STATE_PENDING"));
			}
			const ack = await this.reconcileReport(clientId, report);
			if (!ack.reportAgain) generation.ready = true;
			return ack;
		});
	}

	async disconnectGeneration(clientId: string, socketId: string): Promise<boolean> {
		return this.serialized(clientId, async () => {
			const generation = this.generations.get(clientId);
			if (!generation || generation.socketId !== socketId) return false;
			this.generations.delete(clientId);
			const jobs = await this.listActiveSessionJobs(clientId);
			for (const job of jobs) {
				const runId = parsePayload(job.payload).runId;
				if (!runId || ![JobStatus.PENDING, JobStatus.RUNNING, JobStatus.WAITING_INPUT].includes(job.status as JobStatus)) continue;
				await this.runTransition(job.id, runId, [JobStatus.PENDING, JobStatus.RUNNING, JobStatus.WAITING_INPUT], { status: JobStatus.DISCONNECTED });
			}
			return true;
		});
	}

	private async reconcileReport(clientId: string, report: PiStateReport): Promise<PiStateAck> {
		const acceptedRunIds: string[] = [];
		const closedRunIds: string[] = [];
		const activeReports = report.runs.filter((run) => run.status === "running" || run.status === "waiting_input");
		const duplicateKeys = new Set<string>();
		const seenKeys = new Set<string>();
		for (const run of activeReports) {
			if (!run.projectKey) continue;
			if (seenKeys.has(run.projectKey)) duplicateKeys.add(run.projectKey);
			seenKeys.add(run.projectKey);
		}
		for (const run of activeReports) {
			if (run.projectKey && duplicateKeys.has(run.projectKey)) {
				closedRunIds.push(run.runId);
				continue;
			}
			const job = await this.prisma.job.findUnique({ where: { id: run.jobId } }) as JobRecord | null;
			if (!job || job.clientId !== clientId || job.type !== "agent.session" || job.payload !== runPayload(run.runId) || !ACTIVE_STATUSES.includes(job.status as typeof ACTIVE_STATUSES[number])) {
				closedRunIds.push(run.runId);
				continue;
			}
			const status = run.status === "waiting_input" ? JobStatus.WAITING_INPUT : JobStatus.RUNNING;
			if (await this.runTransition(run.jobId, run.runId, ACTIVE_STATUSES, { status })) {
				acceptedRunIds.push(run.runId);
				if (run.projectKey) this.setLock(clientId, run.projectKey, run.jobId, run.runId);
			}
		}
		for (const run of report.runs.filter((candidate) => candidate.status === "idle")) {
			if (await this.finishRun(run.jobId, run.runId)) acceptedRunIds.push(run.runId);
		}
		const reported = new Set(report.runs.map((run) => `${run.jobId}:${run.runId}`));
		for (const job of await this.listActiveSessionJobs(clientId)) {
			const runId = parsePayload(job.payload).runId;
			if (!runId || reported.has(`${job.id}:${runId}`)) continue;
			await this.failSession(job.id, runId, "PI_CLIENT_RESTARTED");
		}
		return { acceptedRunIds, closedRunIds, reportAgain: closedRunIds.length > 0 };
	}

	/** Task 5/6 迁移前的 legacy agent.run adapter。 */
	async reconcileState(clientId: string, report: PiStateReport): Promise<void> {
		for (const run of report.runs) {
			const job = await this.prisma.job.findUnique({ where: { id: run.jobId } });
			if (!job || job.clientId !== clientId || job.type !== "agent.run") continue;
			if (run.projectKey) this.setLock(clientId, run.projectKey, run.jobId, run.runId);
			if (run.status === "running" || run.status === "waiting_input") {
				await this.legacyTransition(run.jobId, ACTIVE_STATUSES, { status: run.status });
			} else if (run.status === "done" || run.status === "error") {
				await this.legacyTransition(run.jobId, ACTIVE_STATUSES, {
					status: run.status === "done" ? JobStatus.DONE : JobStatus.ERROR,
					finishedAt: new Date(),
				});
				this.releaseLock(run.jobId, run.runId);
			}
		}
	}

	async createRun(actor: ActorContext, input: CreateRunInput): Promise<{ jobId: string; runId: string }> {
		const key = this.lockKey(input.clientId, input.projectKey);
		if (this.locks.has(key)) throw piError("PI_PROJECT_BUSY", "Project has an active turn");
		const jobId = randomUUID();
		await this.prisma.job.create({
			data: {
				id: jobId,
				clientId: input.clientId,
				type: "agent.run",
				status: JobStatus.PENDING,
				payload: JSON.stringify({ mode: "interactive", operation: "prompt", sessionId: input.sessionId, hasImages: (input.imageCount ?? 0) > 0, imageCount: input.imageCount ?? 0 }),
				createdByIdentityId: actor.identityId,
				createdByName: actor.displayName,
				createdVia: actor.source,
			},
		});
		this.setLock(input.clientId, input.projectKey, jobId, jobId);
		return { jobId, runId: jobId };
	}

	async settle(jobId: string, state: PiAgentState): Promise<void> {
		this.cancelSettlement(jobId, jobId);
		const job = await this.prisma.job.findUnique({ where: { id: jobId } });
		if (!job) throw piError("PI_SESSION_NOT_FOUND", "Run not found");
		const payload = parsePayload(job.payload) as RunPayload & { sessionId?: string };
		await this.legacyTransition(jobId, [JobStatus.PENDING, JobStatus.RUNNING, JobStatus.WAITING_INPUT, JobStatus.DISCONNECTED], {
			status: JobStatus.DONE,
			result: JSON.stringify({ sessionId: payload.sessionId ?? "", runId: jobId, stopReason: "settled", ...(state.model ? { model: state.model } : {}) }),
			finishedAt: new Date(),
		});
		this.releaseLock(jobId, jobId);
	}

	async fail(jobId: string, code: string, _message: string): Promise<void> {
		const job = await this.prisma.job.findUnique({ where: { id: jobId } });
		if (!job) throw piError("PI_SESSION_NOT_FOUND", "Run not found");
		if (job.type === "agent.session") {
			const runId = parsePayload(job.payload).runId;
			if (runId) await this.failSession(jobId, runId, code as PiErrorCode);
			return;
		}
		await this.legacyTransition(jobId, ACTIVE_STATUSES, {
			status: JobStatus.ERROR,
			errorCode: code,
			errorMessage: safePiErrorMessage(code),
			finishedAt: new Date(),
		});
		this.releaseLock(jobId, jobId);
	}

	async cancel(jobId: string): Promise<void> {
		await this.legacyTransition(jobId, ACTIVE_STATUSES, { status: JobStatus.CANCELLED, finishedAt: new Date() });
		this.releaseLock(jobId, jobId);
	}

	async markDisconnected(clientId: string): Promise<void> {
		await this.prisma.job.updateMany({
			where: { clientId, type: "agent.run", status: { in: [JobStatus.RUNNING, JobStatus.WAITING_INPUT] } },
			data: { status: JobStatus.DISCONNECTED },
		});
	}

	async assertOwner(jobId: string, identityId: string): Promise<void> {
		const job = await this.prisma.job.findUnique({ where: { id: jobId } });
		if (!job) throw piError("PI_SESSION_NOT_FOUND", "Run not found");
		if (job.type === "agent.session") {
			const runId = parsePayload(job.payload).runId;
			if (!runId) throw piError("PI_CONTROL_FORBIDDEN", "Session has no active run");
			return this.assertCurrentRunOwner(jobId, runId, identityId);
		}
		if (job.createdByIdentityId !== identityId || !ACTIVE_STATUSES.includes(job.status as typeof ACTIVE_STATUSES[number])) {
			throw piError("PI_CONTROL_FORBIDDEN", "Only the run owner can control this turn");
		}
	}

	async assertIdleMutation(clientId: string, projectKey: string): Promise<void> {
		if (this.locks.has(this.lockKey(clientId, projectKey))) throw piError("PI_PROJECT_BUSY", "Project has an active turn");
	}

	async listAllRuns(): Promise<Array<Record<string, unknown>>> {
		return this.prisma.job.findMany({ where: { type: "agent.run" } });
	}

	async listActiveByClient(clientId: string): Promise<Array<{ jobId: string; runId: string; sessionId: string; status: string }>> {
		const jobs = await this.prisma.job.findMany({
			where: { clientId, type: "agent.session", status: { in: [...ACTIVE_STATUSES] } },
		});
		return (jobs as JobRecord[]).flatMap((job) => {
			const runId = parsePayload(job.payload).runId;
			return typeof runId === "string" ? [{ jobId: job.id, runId, sessionId: job.id, status: job.status }] : [];
		});
	}

	private async listActiveSessionJobs(clientId: string): Promise<JobRecord[]> {
		return this.prisma.job.findMany({
			where: { clientId, type: "agent.session", status: { in: [...ACTIVE_STATUSES] } },
		}) as Promise<JobRecord[]>;
	}

	private async runTransition(jobId: string, runId: string, statuses: readonly string[], data: Record<string, unknown>): Promise<boolean> {
		const updated = await this.prisma.job.updateMany({
			where: { id: jobId, type: "agent.session", status: { in: [...statuses] }, payload: runPayload(runId) },
			data,
		});
		return updated.count > 0;
	}

	private async legacyTransition(jobId: string, statuses: readonly string[], data: Record<string, unknown>): Promise<void> {
		// Task 6 删除：仅为旧 agent.run 调用保持原有非 CAS 行为，不供 agent.session 使用。
		const existing = await this.prisma.job.findUnique({ where: { id: jobId } });
		if (!existing) throw piError("PI_SESSION_NOT_FOUND", "Run not found");
		if (existing.type !== "agent.run" || !statuses.includes(existing.status)) return;
		await this.prisma.job.update({ where: { id: jobId }, data });
	}
}
