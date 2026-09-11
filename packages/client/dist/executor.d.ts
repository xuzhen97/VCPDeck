import type { Socket } from "socket.io-client";
import type { JobStatusReport } from "@vcpdeck/shared";
type ExecJob = {
    jobId: string;
    mode: "command";
    command: string;
    cwd?: string;
    timeout?: number;
} | {
    jobId: string;
    mode: "script";
    executable: string;
    args: string[];
    script: string;
    cwd?: string;
    timeout?: number;
};
export declare function executeExec(job: ExecJob, socket: Socket): void;
export declare function killJob(jobId: string, socket: Socket): void;
export declare function getRunningJobIds(): string[];
export declare function getStatusReport(): JobStatusReport[];
export {};
