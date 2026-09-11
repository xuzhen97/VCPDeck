import type { Server, Socket } from "socket.io";
import { ClientService } from "../client/client.service.js";
import { JobService } from "../job/job.service.js";
import type { MachineRegister, Heartbeat, JobOutput, JobDone, JobCancelled, JobCancelFailed, StatusReport, DispatchPayload } from "@vcpdeck/shared";
export declare class EventsGateway {
    private readonly clientService;
    private readonly jobService;
    server: Server;
    constructor(clientService: ClientService, jobService: JobService);
    handleConnection(client: Socket): void;
    handleDisconnect(client: Socket): Promise<void>;
    handleRegister(client: Socket, data: MachineRegister): Promise<void>;
    handleHeartbeat(data: Heartbeat): Promise<void>;
    handleStatusReport(client: Socket, data: StatusReport): Promise<void>;
    handleJobStdout(data: JobOutput): Promise<void>;
    handleJobStderr(data: JobOutput): Promise<void>;
    handleJobDone(data: JobDone): Promise<void>;
    handleJobCancelled(data: JobCancelled): Promise<void>;
    handleJobCancelFailed(data: JobCancelFailed): void;
    sendDispatch(d: DispatchPayload): void;
    sendCancel(clientId: string, jobId: string): void;
}
