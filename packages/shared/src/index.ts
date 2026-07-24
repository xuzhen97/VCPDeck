export const VERSION = "0.0.0";

// ── Event names ──
export const Events = {
	REGISTER: "register",
	HEARTBEAT: "heartbeat",
	JOB_DISPATCH: "job:dispatch",
	JOB_STDOUT: "job:stdout",
	JOB_STDERR: "job:stderr",
	JOB_DONE: "job:done",
	JOB_CANCEL: "job:cancel",
	JOB_CANCELLED: "job:cancelled",
	JOB_CANCEL_FAILED: "job:cancel-failed",
	JOB_UPDATE: "job:update",
	STATUS_REPORT: "status:report",
} as const;

// ── Job type ──
export enum JobType {
	EXEC = "exec",
	FILE_LIST = "file.list",
	FILE_STAT = "file.stat",
	FILE_READ_TEXT = "file.readText",
	FILE_WRITE_TEXT = "file.writeText",
	FILE_MKDIR = "file.mkdir",
	FILE_DELETE = "file.delete",
	FILE_MOVE = "file.move",
	FILE_DOWNLOAD = "file.download",
	FILE_UPLOAD = "file.upload",
	AGENT_RUN = "agent.run",
}

// ── Job status ──
export enum JobStatus {
	PENDING = "pending",
	RUNNING = "running",
	WAITING_INPUT = "waiting_input",
	DONE = "done",
	ERROR = "error",
	DISCONNECTED = "disconnected",
	CANCELLED = "cancelled",
}

// ── Register / Heartbeat ──
export interface MachineRegister {
	clientId: string;
	hostname: string;
	os: string;
	cpuModel: string;
	totalMemMB: number;
	totalDiskMB: number;
	clientVersion: string;
	capabilities: string[];
}

export interface Heartbeat {
	clientId: string;
	cpuPercent: number;
	memPercent: number;
	diskPercent: number;
	runningJobs: string[];
	uptime: number;
}

// ── Job payloads ──
// ── Job dispatch（Server → Client，判别联合） ──
export type JobDispatch =
  | {
      jobId: string;
      type: "exec";
      command: string;
      timeout?: number;
    }
  | {
      jobId: string;
      type: string;
      payload: Record<string, unknown>;
      timeout?: number;
    };

export interface JobOutput {
	jobId: string;
	text: string;
}

// ── Job done（Client → Server，判别联合） ──
export type JobDone =
  | { jobId: string; type: "exec"; exitCode: number }
  | { jobId: string; type: string; result: Record<string, unknown> };

export interface JobUpdate {
	jobId: string;
	type: string;
	status: JobStatus;
	result?: Record<string, unknown>;
	errorCode?: string;
	errorMessage?: string;
}

export interface JobCancel {
	jobId: string;
}

export interface JobCancelled {
	jobId: string;
}

export interface JobCancelFailed {
	jobId: string;
	reason: string;
}

export interface JobCreate {
	clientId: string;
	type: string;
	payload: Record<string, unknown>;
	timeout?: number;
}

export interface JobCreateResult {
	jobId: string;
	status: JobStatus;
	type: string;
}

// ── Dispatch result (internal, returned by scheduler) ──
export interface DispatchPayload {
	jobId: string;
	clientId: string;
	type: string;
	payload: Record<string, unknown>;
	timeout?: number;
}

// ── Status report (reconnect) ──
export interface JobStatusReport {
	jobId: string;
	status: "running" | "waiting_input" | "done" | "error";
	exitCode: number | null;
}

export interface StatusReport {
	clientId: string;
	jobs: JobStatusReport[];
}

// ── Client info (REST response) ──
export interface ClientInfo {
	clientId: string;
	hostname: string;
	os: string;
	capabilities: string[];
	online: boolean;
	lastHeartbeatAt: string | null;
}

// ── Job info (REST response) ──
export interface JobInfo {
	jobId: string;
	clientId: string;
	type: string;
	status: JobStatus;
	payload: Record<string, unknown>;
	result: Record<string, unknown> | null;
	errorCode: string | null;
	errorMessage: string | null;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
}

// ── Job error ──
export interface JobError {
	code: string;
	message: string;
}

// ── FileRef (reserved, not implemented) ──
export interface FileRef {
	id: string;
	url: string;
	method: "GET" | "PUT";
	expiresAt: number;
	headers?: Record<string, string>;
}
