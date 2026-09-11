import type { Socket } from "socket.io-client";
import { type JobDispatch } from "@vcpdeck/shared";
export declare function dispatch(job: JobDispatch, socket: Socket): void | Promise<void>;
