import { io, type Socket } from "socket.io-client";
import { Events } from "@vcpdeck/shared";
import type { JobDispatch, StatusReport } from "@vcpdeck/shared";
import { CLIENT_ID, getRegisterInfo } from "./register.js";
import { getHeartbeat } from "./heartbeat.js";
import {
  executeJob,
  killJob,
  getRunningJobIds,
  getStatusReport,
} from "./executor.js";

const SERVER_URL = process.env.VCPDECK_SERVER || "http://localhost:3001";
const PSK = process.env.VCPDECK_PSK || "vcpdeck-dev-psk";

function main() {
  connect();
}

// Auto-run when executed directly: node dist/index.js
if (require.main === module) {
  main();
}

export function connect(): Socket {
  const socket: Socket = io(SERVER_URL, {
    auth: { psk: PSK },
    reconnection: true,
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 10_000,
  });

  socket.on("connect", () => {
    console.log(`[vcpdeck] connected as ${CLIENT_ID}`);
    socket.emit(Events.REGISTER, getRegisterInfo());

    // Send status report for any running jobs (reconnect case)
    const report: StatusReport = {
      clientId: CLIENT_ID,
      jobs: getStatusReport(),
    };
    socket.emit(Events.STATUS_REPORT, report);
  });

  setInterval(() => {
    if (socket.connected) {
      socket.emit(Events.HEARTBEAT, getHeartbeat(getRunningJobIds()));
    }
  }, 30_000);

  socket.on(Events.JOB_DISPATCH, (data: JobDispatch) => {
    console.log(`[vcpdeck] job dispatch: ${data.jobId} — ${data.command}`);
    executeJob(data, socket);
  });

  socket.on(Events.JOB_CANCEL, (data: { jobId: string }) => {
    console.log(`[vcpdeck] job cancel: ${data.jobId}`);
    killJob(data.jobId, socket);
  });

  socket.on("disconnect", (reason) => {
    console.log(`[vcpdeck] disconnected: ${reason}`);
  });

  socket.on("connect_error", (err) => {
    console.error(`[vcpdeck] connection error: ${err.message}`);
  });

  return socket;
}
