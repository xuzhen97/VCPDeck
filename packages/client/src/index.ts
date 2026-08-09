import { io, type Socket } from "socket.io-client";
import { Events } from "@vcpdeck/shared";
import type {
	MachineRegister,
	PiCapabilityStatus,
	PiEvent,
	StatusReport,
} from "@vcpdeck/shared";
import { parsePiRequest } from "@vcpdeck/shared";
import { CLIENT_ID, getRegisterInfo } from "./register.js";
import { getHeartbeat } from "./heartbeat.js";
import { killJob, getRunningJobIds, getStatusReport } from "./executor.js";
import { dispatch } from "./dispatcher.js";
import {
	createPiSupervisor,
	type PiSupervisor,
	type PiWorkerHandle,
} from "./pi/supervisor.js";
import type { PiWorkerRequestMessage } from "./pi/worker-protocol.js";
import { probePiCapability } from "./pi/capability.js";
import { fork } from "node:child_process";
import { join } from "node:path";

const SERVER_URL =
	(process.env.VCPDECK_SERVER || "http://localhost:3001") + "/client";
const PSK = process.env.VCPDECK_PSK || "vcpdeck-dev-psk";

function main() {
	connect();
}

// Auto-run when executed directly: node dist/index.js
if (require.main === module) {
	main();
}

/** 真实 fork 项目 Worker（cwd 通过 argv 传入） */
function forkProjectWorker(cwd: string): PiWorkerHandle {
	const child = fork(join(__dirname, "pi", "worker.js"), [cwd], {
		stdio: ["ignore", "ignore", "ignore", "ipc"],
	});
	return {
		send: (msg: PiWorkerRequestMessage) => child.send(msg),
		onMessage: (listener) => {
			child.on("message", listener);
			return () => child.removeListener("message", listener);
		},
		onExit: (listener) => {
			child.on("exit", (code) => listener(code ?? 0));
			return () => child.removeListener("exit", listener);
		},
		kill: () => child.kill(),
	};
}

export interface PiBridgeDeps {
	clientId: string;
	supervisor: PiSupervisor;
	getPiStatus: () => Promise<PiCapabilityStatus>;
	getRegister: (piStatus: PiCapabilityStatus | undefined) => MachineRegister;
	getStatusReport: () => StatusReport;
}

export interface PiBridge {
	/** connect handler 中调用：探测 → REGISTER(ack) → STATUS_REPORT + PI_STATE */
	onConnected: () => Promise<void>;
}

/**
 * 绑定 Pi Socket 桥：PI_REQUEST 响应、PI_EVENT 转发、注册后状态上报。
 * Server 完成 register 后通过 ack callback 或现有 "ack" event 通知。
 */
export function attachPiBridge(socket: Socket, deps: PiBridgeDeps): PiBridge {
	// 请求响应（信任边界：先 parse 再交给 supervisor）
	socket.on(Events.PI_REQUEST, (raw: unknown) => {
		try {
			const request = parsePiRequest(raw);
			void deps.supervisor.request(request).then((response) => {
				if (socket.connected) socket.emit(Events.PI_RESPONSE, response);
			});
		} catch {
			const requestId =
				typeof raw === "object" &&
				raw !== null &&
				"requestId" in raw &&
				typeof (raw as { requestId: unknown }).requestId === "string"
					? (raw as { requestId: string }).requestId
					: "";
			if (socket.connected) {
				socket.emit(Events.PI_RESPONSE, {
					requestId,
					ok: false,
					error: { code: "PI_PROTOCOL_INVALID", message: "Invalid request" },
				});
			}
		}
	});

	// supervisor 事件转发（断线期间不发送；Worker 继续运行）
	deps.supervisor.onEvent((event: PiEvent) => {
		if (socket.connected) socket.emit(Events.PI_EVENT, event);
	});

	let registered = false;
	const onRegistered = () => {
		if (registered) return;
		registered = true;
		socket.emit(Events.STATUS_REPORT, deps.getStatusReport());
		socket.emit(
			Events.PI_STATE,
			deps.supervisor.getStateReport(),
			(ack?: { acceptedRunIds?: string[] }) => {
				deps.supervisor.ackTerminalRuns(ack?.acceptedRunIds ?? []);
			},
		);
	};
	// 兼容旧 Server：现有 "ack" event
	socket.on("ack", (data: { event?: string }) => {
		if (data?.event === Events.REGISTER) onRegistered();
	});

	return {
		async onConnected() {
			// probe 最多等待 3 秒：超时降级为无 Pi 能力，不阻塞注册
			const piStatus = await Promise.race([
				deps.getPiStatus(),
				new Promise<undefined>((resolve) =>
					setTimeout(() => resolve(undefined), 3000),
				),
			]).catch(() => undefined);
			socket.emit(Events.REGISTER, deps.getRegister(piStatus), onRegistered);
		},
	};
}

export function connect(): Socket {
	const socket: Socket = io(SERVER_URL, {
		auth: { psk: PSK },
		reconnection: true,
		reconnectionDelay: 1_000,
		reconnectionDelayMax: 10_000,
	});

	const supervisor = createPiSupervisor({
		clientId: CLIENT_ID,
		forkWorker: forkProjectWorker,
	});

	const bridge = attachPiBridge(socket, {
		clientId: CLIENT_ID,
		supervisor,
		getPiStatus: () => probePiCapability(),
		getRegister: (piStatus) => getRegisterInfo(piStatus),
		getStatusReport: () => ({
			clientId: CLIENT_ID,
			jobs: getStatusReport(),
		}),
	});

	socket.on("connect", () => {
		console.log(`[vcpdeck] connected as ${CLIENT_ID}`);
		void bridge.onConnected();
	});

	setInterval(() => {
		if (socket.connected) {
			socket.emit(Events.HEARTBEAT, getHeartbeat(getRunningJobIds()));
		}
	}, 5_000);

	socket.on(Events.JOB_DISPATCH, (data: any) => {
		console.log(`[vcpdeck] job dispatch: ${data.jobId} — ${data.type}`);
		dispatch(data, socket);
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
