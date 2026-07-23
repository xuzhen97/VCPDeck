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

// ── Job status ──
export enum JobStatus {
  PENDING = "pending",
  RUNNING = "running",
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
export interface JobDispatch {
  jobId: string;
  command: string;
  timeout?: number;
}

export interface JobOutput {
  jobId: string;
  text: string;
}

export interface JobDone {
  jobId: string;
  exitCode: number;
}

export interface JobUpdate {
  jobId: string;
  status: JobStatus;
  exitCode?: number;
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
  command: string;
  timeout?: number;
}

export interface JobCreateResult {
  jobId: string;
  status: JobStatus;
}

// ── Dispatch result (internal, returned by scheduler) ──
export interface DispatchPayload {
  jobId: string;
  clientId: string;
  command: string;
  timeout?: number;
}

// ── Status report (reconnect) ──
export interface JobStatusReport {
  jobId: string;
  status: "running" | "done" | "error";
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
  command: string;
  status: JobStatus;
  exitCode: number | null;
  output: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

// ── FileRef (reserved, not implemented) ──
export interface FileRef {
  id: string;
  url: string;
  method: "GET" | "PUT";
  expiresAt: number;
  headers?: Record<string, string>;
}
