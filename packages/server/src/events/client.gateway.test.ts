import { describe, expect, it, vi } from "vitest";
import { ClientGateway } from "./client.gateway.js";
import type { Socket } from "socket.io";

function makeSocket(id = "socket-1") {
	return {
		id,
		data: {} as { clientId?: string },
		join: vi.fn(),
		emit: vi.fn(),
	} as unknown as Socket;
}

function makeReconciliation(overrides: Record<string, unknown> = {}) {
	return {
		handleState: vi.fn(async (): Promise<{ connectionGeneration: string; accepted: boolean; action: string }> => ({
			connectionGeneration: "conn-1",
			accepted: true,
			action: "none",
		})),
		handleLocalResult: vi.fn(async () => {}),
		handleLocalFailure: vi.fn(async () => {}),
		disconnect: vi.fn(async () => {}),
		isBusy: vi.fn(() => false),
		assertWritable: vi.fn(),
		bindDispatcher: vi.fn(),
		recoverInterrupted: vi.fn(async () => {}),
		onModuleDestroy: vi.fn(),
		...overrides,
	};
}

function makeGateway(reconciliation = makeReconciliation()) {
	const clientService = {
		register: vi.fn(async () => {}),
		getClientIdBySocketId: vi.fn(async () => "c1"),
		markOfflineBySocketId: vi.fn(async () => {}),
		bindSocket: vi.fn(async () => {}),
		expireStaleClients: vi.fn(
			async (): Promise<Array<{ clientId: string; socketId: string | null }>> => [],
		),
	};
	const jobService = {
		markDone: vi.fn().mockResolvedValue(null),
		markDisconnected: vi.fn(async () => {}),
		// JOB_CANCEL_FAILED 的收尾路径（2026-10-10 生产事故）
		failOrphaned: vi.fn().mockResolvedValue(null),
		findById: vi.fn().mockResolvedValue(undefined),
	};
	const fileService = {
		confirmUpload: vi.fn().mockResolvedValue({
			key: "aliyun-file-id",
			size: 158601385,
		}),
	};
	const frpService = {
		settleClientOperation: vi.fn(),
		failClientOperation: vi.fn(),
		markInactiveByClientId: vi.fn(async () => {}),
	};
	const terminalService = {
		handleClientResponse: vi.fn(async () => {}),
		handleClientOutput: vi.fn(async () => {}),
		handleClientExit: vi.fn(async () => {}),
		handleClientState: vi.fn(
			async (): Promise<{
				acceptedSessionIds: string[];
				closeSessionIds: string[];
			}> => ({
				acceptedSessionIds: [],
				closeSessionIds: [],
			}),
		),
		handleClientDisconnect: vi.fn(async () => {}),
		handleClientRegistered: vi.fn(async () => {}),
	};
	const terminalBroker = {
		bindEmitter: vi.fn(),
		disconnect: vi.fn(),
		resolve: vi.fn(),
	};
	const orchestrator = {
		onClientRegistered: vi.fn(),
		onUpdateReady: vi.fn(),
		onUpdateFailed: vi.fn(),
	};
	const updateChannel = {
		bindEmitters: vi.fn(),
	};
	const tunnelSessions = {
		bindClientSender: vi.fn(),
		signalFromClient: vi.fn(async () => {}),
		clientState: vi.fn(async () => {}),
		closeFromClient: vi.fn(async () => {}),
		disconnectClient: vi.fn(),
	};
	const gitSsh = {
		bindSender: vi.fn(),
		onRegistered: vi.fn(async () => {}),
		onDisconnected: vi.fn(async () => {}),
		applyAck: vi.fn(async () => {}),
	};
	const gateway = new ClientGateway(
		clientService as never,
		jobService as never,
		fileService as never,
		frpService as never,
		terminalService as never,
		terminalBroker as never,
		orchestrator as never,
		updateChannel as never,
		reconciliation as never,
		tunnelSessions as never,
		gitSsh as never,
	);
	const emit = vi.fn();
	const to = vi.fn(() => ({ emit }));
	gateway.server = { emit: vi.fn(), to } as never;
	return {
		gateway,
		clientService,
		jobService,
		fileService,
		frpService,
		terminalService,
		terminalBroker,
		orchestrator,
		updateChannel,
		reconciliation,
		tunnelSessions,
		gitSsh,
		emit,
		to,
	};
}


describe("ClientGateway client liveness", () => {
	it("Gateway 初始化后每 5 秒扫描一次心跳超时", async () => {
		const { gateway, clientService } = makeGateway();
		vi.useFakeTimers();
		try {
			gateway.onModuleInit();
			await vi.advanceTimersByTimeAsync(5_000);
			expect(clientService.expireStaleClients).toHaveBeenCalledTimes(1);
		} finally {
			gateway.onModuleDestroy();
			vi.useRealTimers();
		}
	});

	it("未注册 Socket 断开时也释放 broker pending 请求", async () => {
		const { gateway, terminalBroker } = makeGateway();

		await gateway.handleDisconnect(makeSocket());

		expect(terminalBroker.disconnect).toHaveBeenCalledWith("socket-1");
	});

	it("心跳超时后按 socket lease 执行断线清理", async () => {
		const {
			gateway,
			clientService,
			jobService,
			frpService,
			terminalService,
		} = makeGateway();
		clientService.expireStaleClients.mockResolvedValue([
			{ clientId: "c1", socketId: "socket-1" },
		]);

		await gateway.sweepStaleClients();

		expect(jobService.markDisconnected).toHaveBeenCalledWith("c1");
		expect(frpService.markInactiveByClientId).toHaveBeenCalledWith("c1");
		expect(terminalService.handleClientDisconnect).toHaveBeenCalledWith(
			"c1",
			"socket-1",
		);
	});
});

describe("ClientGateway 连接与身份生命周期", () => {
	it("REGISTER 绑定身份并持久化，且先回 ack", async () => {
		const { gateway, clientService } = makeGateway();
		const socket = makeSocket();
		await gateway.handleRegister(socket, {
			clientId: "c1",
			hostname: "host",
			os: "win32",
			cpuModel: "cpu",
			totalMemMB: 1024,
			clientVersion: "1",
			capabilities: ["exec"],
			capabilityDetails: {},
		});
		expect(socket.data.clientId).toBe("c1");
		expect(clientService.register).toHaveBeenCalledWith(
			expect.objectContaining({ clientId: "c1" }),
			"socket-1",
		);
		expect(socket.emit).toHaveBeenCalledWith("ack", { event: "register" });
	});

	it("断线时标记 Job 为 disconnected 并收敛 FRP，不再由 Pi generation 门控", async () => {
		const { gateway, jobService, frpService, terminalBroker } = makeGateway();
		const socket = makeSocket();
		socket.data.clientId = "c1";
		await gateway.handleDisconnect(socket);
		expect(terminalBroker.disconnect).toHaveBeenCalledWith("socket-1");
		expect(jobService.markDisconnected).toHaveBeenCalledWith("c1");
		expect(frpService.markInactiveByClientId).toHaveBeenCalledWith("c1");
	});

	it("REGISTER 先回 ack 再下发 Git SSH，否则指令会被 Client 的未注册门禁丢弃", async () => {
		// 契约：Client 的 Git SSH 桥只处理 REGISTER ack 之后的指令（fail closed）。
		// Server 若先把 install 发出去再回 ack，这次 install 会静默丢失、永不产生回执，
		// 目标状态就会永久卡在 pending。命令收发顺序是可见行为，必须锁住。
		const { gateway, gitSsh } = makeGateway();
		const socket = makeSocket();
		const order: string[] = [];
		(socket.emit as unknown as { mockImplementation: (fn: (event: string) => void) => void })
			.mockImplementation((event: string) => {
				if (event === "ack") order.push("ack");
			});
		gitSsh.onRegistered.mockImplementation(async () => {
			order.push("gitSsh");
		});

		await gateway.handleRegister(socket, {
			clientId: "c1",
			hostname: "host",
			os: "win32",
			cpuModel: "cpu",
			totalMemMB: 1024,
			clientVersion: "1",
			capabilities: ["exec"],
			capabilityDetails: {},
		});

		expect(order).toEqual(["ack", "gitSsh"]);
	});

	it("REGISTER 含新字段（privileged + installation）时正常持久化", async () => {
		const { gateway, clientService } = makeGateway();
		const socket = makeSocket();
		await gateway.handleRegister(socket, {
			clientId: "c1",
			hostname: "host",
			os: "linux 6.11.0",
			cpuModel: "cpu",
			totalMemMB: 1024,
			clientVersion: "1",
			capabilities: ["exec"],
			capabilityDetails: {
				privileged: {
					available: true,
					mode: "sudo-all",
					nonInteractive: true,
					runAsUser: "vcpdeck",
				},
			},
			installation: { mode: "systemd-root-equivalent" },
		});
		expect(clientService.register).toHaveBeenCalledWith(
			expect.objectContaining({
				installation: { mode: "systemd-root-equivalent" },
			}),
			"socket-1",
		);
	});

	it("非法 REGISTER（缺 hostname / 非法 privileged mode）不持久化且不断开连接", async () => {
		const { gateway, clientService } = makeGateway();
		const socket = makeSocket();
		socket.disconnect = vi.fn();
		await gateway.handleRegister(socket, {
			clientId: "c1",
			os: "win32",
			cpuModel: "cpu",
			totalMemMB: 1024,
			clientVersion: "1",
			capabilities: ["exec"],
		});
		expect(clientService.register).not.toHaveBeenCalled();
		expect(socket.data.clientId).toBeUndefined();
		// 加固（2026-10-12 事故）：载荷非法不再断开连接，只回稳定错误码；
		// 断开会让旧客户端连上即被踢且 socket.io 不自动重连 → 永久静默。
		expect(socket.disconnect).not.toHaveBeenCalled();
		expect(socket.emit).toHaveBeenCalledWith("error", {
			code: "REGISTER_INVALID",
			message: "invalid register",
		});

		const socket2 = makeSocket("socket-2");
		socket2.disconnect = vi.fn();
		await gateway.handleRegister(socket2, {
			clientId: "c1",
			hostname: "host",
			os: "win32",
			cpuModel: "cpu",
			totalMemMB: 1024,
			clientVersion: "1",
			capabilities: ["exec"],
			capabilityDetails: { privileged: { available: true, mode: "root" } },
		});
		expect(socket2.disconnect).not.toHaveBeenCalled();
	});

	it("同一 Client 仍有存活连接时不置离线，只把 socket lease 切给存活连接", async () => {
		const { gateway, clientService } = makeGateway();
		const socket = makeSocket();
		socket.data.clientId = "c1";
		gateway["trackSocket"]("c1", "socket-9");

		await gateway.handleDisconnect(socket);

		expect(clientService.markOfflineBySocketId).not.toHaveBeenCalled();
		expect(clientService.bindSocket).toHaveBeenCalledWith("c1", "socket-9");
		expect(gateway["survivingSocketId"]("c1")).toBe("socket-9");
	});

	it("最后一个连接断开时置离线并清空连接记账", async () => {
		const { gateway, clientService } = makeGateway();
		const socket = makeSocket();
		socket.data.clientId = "c1";
		gateway["trackSocket"]("c1", socket.id);

		await gateway.handleDisconnect(socket);

		expect(clientService.markOfflineBySocketId).toHaveBeenCalledWith("socket-1");
		expect(clientService.bindSocket).not.toHaveBeenCalled();
		expect(gateway["survivingSocketId"]("c1")).toBeNull();
	});

	it("重复 socket 断线且仍有存活连接时，不收敛 Job/FRP 状态", async () => {
		const { gateway, jobService, frpService, clientService } = makeGateway();
		const socket = makeSocket();
		socket.data.clientId = "c1";
		gateway["trackSocket"]("c1", "socket-9");

		await gateway.handleDisconnect(socket);

		// 机器仍在线（lease 已切给存活连接）：不得把在跑的 Job 与 FRP 映射判死。
		expect(clientService.bindSocket).toHaveBeenCalledWith("c1", "socket-9");
		expect(jobService.markDisconnected).not.toHaveBeenCalled();
		expect(frpService.markInactiveByClientId).not.toHaveBeenCalled();
	});

	it("错误 PSK 仍然 fail closed 断开（加固不得削弱握手认证）", () => {
		vi.stubEnv("VCPDECK_PSK", "test-psk");
		const { gateway } = makeGateway();
		const socket = makeSocket();
		socket.disconnect = vi.fn();
		(socket as unknown as { handshake: { auth: { psk: string } } }).handshake = {
			auth: { psk: "wrong-psk" },
		};

		gateway.handleConnection(socket);

		expect(socket.emit).toHaveBeenCalledWith("error", "invalid PSK");
		expect(socket.disconnect).toHaveBeenCalled();
	});

	it("0.18.2 客户端带已退役 pi 摘要仍能注册（0.19.0 事故回归）", async () => {
		// 0.19.0 把 pi 当"未知字段"抛错，导致全集群旧客户端连上又被踢。
		const { gateway, clientService } = makeGateway();
		const socket = makeSocket();
		socket.disconnect = vi.fn();
		await gateway.handleRegister(socket, {
			clientId: "c1",
			hostname: "host",
			os: "win32",
			cpuModel: "cpu",
			totalMemMB: 1024,
			clientVersion: "0.18.2",
			capabilities: ["exec", "agent.pi"],
			capabilityDetails: {
				pi: {
					available: true,
					sdkVersion: "0.86.0",
					nodeVersion: "24.16.0",
					shellKind: "path",
				},
			} as never,
		});

		expect(socket.disconnect).not.toHaveBeenCalled();
		expect(socket.data.clientId).toBe("c1");
		expect(socket.emit).toHaveBeenCalledWith("ack", { event: "register" });
		expect(clientService.register).toHaveBeenCalled();
		const registerCalls = (
			clientService.register as unknown as { mock: { calls: unknown[][] } }
		).mock.calls;
		expect(registerCalls[0]?.[0]).not.toHaveProperty("capabilityDetails.pi");
	});
});

describe("ClientGateway terminal routing", () => {
	it("afterInit 绑定 terminal emitter 精确投递 socketId", () => {
		const { gateway, terminalBroker, emit } = makeGateway();
		gateway.afterInit();
		// 第二个 bindEmitter 调用属于 terminal broker
		const binder = terminalBroker.bindEmitter.mock.calls[0]?.[0];
		if (!binder) throw new Error("no binder");
		binder("socket-2", { requestId: "r1", action: "shells.list" });
		expect(emit).toHaveBeenCalledWith(
			"terminal:request",
			expect.objectContaining({ requestId: "r1" }),
		);
	});

	it("未 REGISTER 的 socket 上报 terminal 消息被忽略", async () => {
		const { gateway, terminalService } = makeGateway();
		const socket = makeSocket();
		await gateway.handleTerminalResponse(socket, {
			requestId: "r1",
			ok: true,
			action: "session.detach",
			sessionId: "s1",
		});
		await gateway.handleTerminalOutput(socket, {
			sessionId: "s1",
			seq: 1,
			data: "x",
		});
		await gateway.handleTerminalExit(socket, { sessionId: "s1", exitCode: 0 });
		expect(terminalService.handleClientResponse).not.toHaveBeenCalled();
		expect(terminalService.handleClientOutput).not.toHaveBeenCalled();
		expect(terminalService.handleClientExit).not.toHaveBeenCalled();
	});

	it("TERMINAL_RESPONSE 解析后按 socket 绑定 clientId 交给 service", async () => {
		const { gateway, terminalService } = makeGateway();
		const socket = makeSocket("socket-9");
		socket.data.clientId = "c1";
		await gateway.handleTerminalResponse(socket, {
			requestId: "r1",
			ok: true,
			action: "session.detach",
			sessionId: "s1",
		});
		expect(terminalService.handleClientResponse).toHaveBeenCalledWith(
			"c1",
			"socket-9",
			expect.objectContaining({ requestId: "r1" }),
		);
	});

	it("非法 TERMINAL_RESPONSE 被忽略", async () => {
		const { gateway, terminalService } = makeGateway();
		const socket = makeSocket();
		socket.data.clientId = "c1";
		await gateway.handleTerminalResponse(socket, {
			requestId: "r1",
			ok: true,
			action: "session.hack",
			sessionId: "s1",
		} as never);
		expect(terminalService.handleClientResponse).not.toHaveBeenCalled();
	});

	it("TERMINAL_OUTPUT 解析后交给 service（身份来自 socket 绑定）", async () => {
		const { gateway, terminalService } = makeGateway();
		const socket = makeSocket();
		socket.data.clientId = "c1";
		await gateway.handleTerminalOutput(socket, {
			sessionId: "s1",
			seq: 3,
			data: "ok",
		});
		expect(terminalService.handleClientOutput).toHaveBeenCalledWith("c1", {
			sessionId: "s1",
			seq: 3,
			data: "ok",
		});
	});

	it("TERMINAL_EXIT 解析后交给 service", async () => {
		const { gateway, terminalService } = makeGateway();
		const socket = makeSocket();
		socket.data.clientId = "c1";
		await gateway.handleTerminalExit(socket, { sessionId: "s1", exitCode: 0 });
		expect(terminalService.handleClientExit).toHaveBeenCalledWith("c1", {
			sessionId: "s1",
			exitCode: 0,
		});
	});

	it("TERMINAL_STATE 解析后交给 service 并原样 ack", async () => {
		const { gateway, terminalService } = makeGateway();
		const socket = makeSocket();
		socket.data.clientId = "c1";
		const report = { clientId: "c1", generationId: "g1", sessions: [] };
		terminalService.handleClientState.mockResolvedValue({
			acceptedSessionIds: ["s1"],
			closeSessionIds: ["s2"],
		});
		const result = await gateway.handleTerminalState(socket, report);
		expect(terminalService.handleClientState).toHaveBeenCalledWith(
			"c1",
			"socket-1",
			report,
		);
		expect(result).toEqual({
			acceptedSessionIds: ["s1"],
			closeSessionIds: ["s2"],
		});
	});

	it("非法 TERMINAL_STATE 不 ack", async () => {
		const { gateway, terminalService } = makeGateway();
		const socket = makeSocket();
		socket.data.clientId = "c1";
		const result = await gateway.handleTerminalState(socket, {
			clientId: 42,
			generationId: "g",
			sessions: [],
		} as never);
		expect(terminalService.handleClientState).not.toHaveBeenCalled();
		expect(result).toEqual({ acceptedSessionIds: [], closeSessionIds: [] });
	});


	it("断线通知 terminal service 但不终结会话", async () => {
		const { gateway, terminalService } = makeGateway();
		const socket = makeSocket();
		socket.data.clientId = "c1";
		await gateway.handleDisconnect(socket);
		expect(terminalService.handleClientDisconnect).toHaveBeenCalledWith(
			"c1",
			"socket-1",
		);
		expect(terminalService.handleClientOutput).not.toHaveBeenCalled();
	});

	it("REGISTER 成功后通知 terminal service", async () => {
		const { gateway, terminalService } = makeGateway();
		const socket = makeSocket();
		await gateway.handleRegister(socket, {
			clientId: "c1",
			hostname: "host",
			os: "win32",
			cpuModel: "cpu",
			totalMemMB: 1024,
			clientVersion: "1",
			capabilities: [],
		});
		expect(terminalService.handleClientRegistered).toHaveBeenCalledWith(
			"c1",
			"socket-1",
		);
	});
});

describe("ClientGateway.handleJobDone", () => {
	it("exec 基础设施错误保留输出并继续派发队列", async () => {
		const { gateway, jobService, emit } = makeGateway();
		jobService.markDone.mockResolvedValue({
			jobId: "next-job",
			clientId: "c1",
			type: "exec",
			payload: { mode: "command", command: "echo next" },
			timeout: null,
		});

		await gateway.handleJobDone({
			jobId: "job-1",
			type: "exec",
			error: { code: "EXEC_TIMEOUT", message: "Execution timed out" },
			stdout: "READY\n",
		} as never);

		expect(jobService.markDone).toHaveBeenCalledWith("job-1", "exec", {
			errorCode: "EXEC_TIMEOUT",
			errorMessage: "Execution timed out",
			stdout: "READY\n",
		});
		expect(emit).toHaveBeenCalledWith(
			"job:dispatch",
			expect.objectContaining({ jobId: "next-job" }),
		);
	});

	it("FRP Dashboard 收敛成功后才终结 Job", async () => {
		const { gateway, jobService, frpService } = makeGateway();
		frpService.settleClientOperation.mockResolvedValue({
			terminal: true,
			result: { mappingId: "fm_1", status: "active" },
		});

		await gateway.handleJobDone({
			jobId: "job-1",
			type: "frp.create",
			result: { mappingId: "fm_1", status: "active" },
		} as never);

		expect(frpService.settleClientOperation).toHaveBeenCalledWith(
			"job-1",
			"frp.create",
		);
		expect(jobService.markDone).toHaveBeenCalledWith("job-1", "frp.create", {
			mappingId: "fm_1",
			status: "active",
		});
	});

	it("创建超时派发回滚且不提前终结创建 Job", async () => {
		const { gateway, jobService, frpService, emit } = makeGateway();
		frpService.settleClientOperation.mockResolvedValue({
			terminal: false,
			dispatch: {
				jobId: "rollback-job",
				clientId: "c1",
				type: "frp.delete",
				payload: { mappingId: "fm_1", name: "tcp-1919" },
			},
		});

		await gateway.handleJobDone({
			jobId: "job-1",
			type: "frp.create",
			result: { mappingId: "fm_1", status: "active" },
		} as never);

		expect(jobService.markDone).not.toHaveBeenCalled();
		expect(emit).toHaveBeenCalledWith(
			"job:dispatch",
			expect.objectContaining({ jobId: "rollback-job", type: "frp.delete" }),
		);
	});

	it("回滚终态同时终结原创建 Job", async () => {
		const { gateway, jobService, frpService } = makeGateway();
		frpService.settleClientOperation.mockResolvedValue({
			terminal: true,
			result: { mappingId: "fm_1", deleted: true },
			relatedJob: {
				jobId: "create-job",
				errorCode: "FRP_PROXY_CONFIRM_TIMEOUT",
				errorMessage: "已自动回滚",
			},
		});

		await gateway.handleJobDone({
			jobId: "rollback-job",
			type: "frp.delete",
			result: { mappingId: "fm_1", deleted: true },
		} as never);

		expect(jobService.markDone).toHaveBeenCalledWith(
			"create-job",
			"frp.create",
			expect.objectContaining({
				errorCode: "FRP_PROXY_CONFIRM_TIMEOUT",
			}),
		);
	});

	it("FRP Client 失败进入服务收敛，不走通用立即终态", async () => {
		const { gateway, jobService, frpService } = makeGateway();
		frpService.failClientOperation.mockResolvedValue({
			terminal: false,
			dispatch: {
				jobId: "rollback-job",
				clientId: "c1",
				type: "frp.delete",
				payload: { mappingId: "fm_1", name: "tcp-1919" },
			},
		});

		await gateway.handleJobDone({
			jobId: "create-job",
			type: "frp.create",
			error: { code: "FRPC_START_FAILED", message: "frpc 启动失败" },
		} as never);

		expect(frpService.failClientOperation).toHaveBeenCalledWith(
			"create-job",
			"frp.create",
			"FRPC_START_FAILED",
			"frpc 启动失败",
		);
		expect(jobService.markDone).not.toHaveBeenCalled();
	});

	it("用数据库中的真实 key 覆盖 Client 回传的临时 key", async () => {
		const { gateway, jobService, fileService } = makeGateway();
		const result = {
			fileId: "file-1",
			key: "temporary-key/nginx-1.18.0.zip",
			sha256: "sha256-value",
			size: 158601385,
		};

		await gateway.handleJobDone({
			jobId: "job-1",
			type: "file.export",
			result,
		});

		expect(fileService.confirmUpload).toHaveBeenCalledWith(
			"file-1",
			"sha256-value",
		);
		expect(jobService.markDone).toHaveBeenCalledWith("job-1", "file.export", {
			...result,
			key: "aliyun-file-id",
		});
	});
});

describe("ClientGateway FRP reconciliation", () => {
	const validStateReport = {
		clientId: "c1",
		connectionGeneration: "conn-1",
		runtimeGeneration: 3,
		status: "running",
		processRunning: true,
		recoveryOwner: null,
		attempt: 0,
		frpsEndpoint: { serverAddr: "frps.example.com", serverPort: 7000 },
		mappings: [
			{
				mappingId: "fm_1",
				name: "tcp-1919",
				proxyType: "tcp",
				localIp: "127.0.0.1",
				localPort: 1919,
				remotePort: 20000,
				customDomain: null,
			},
		],
	};

	it("FRP_STATE 只把已注册 socket 与严格 report 交给 reconciliation service 并 ack", async () => {
		const { gateway, reconciliation, to } = makeGateway();
		const socket = makeSocket();
		socket.data.clientId = "c1";

		const ack = await gateway.handleFrpState(socket, validStateReport);

		expect(reconciliation.handleState).toHaveBeenCalledWith(
			"c1",
			"socket-1",
			validStateReport,
		);
		expect(ack).toMatchObject({ accepted: true });
		expect(to).not.toHaveBeenCalled();
	});

	it("未注册 socket 的 FRP_STATE 上报失败关闭，不调用 service", async () => {
		const { gateway, reconciliation } = makeGateway();
		const socket = makeSocket();

		const ack = await gateway.handleFrpState(socket, validStateReport);

		expect(reconciliation.handleState).not.toHaveBeenCalled();
		expect(ack).toMatchObject({ accepted: false, action: "stale" });
	});

	it("reconcile dispatch 精确发往 socketId，不使用 clientId room", () => {
		const { gateway, reconciliation } = makeGateway();
		gateway.afterInit();
		const dispatcher = reconciliation.bindDispatcher.mock.calls[0]?.[0];
		expect(typeof dispatcher).toBe("function");
		const emitJobDispatch = vi.fn();
		const emitJobUpdate = vi.fn();
		const toMock = vi.fn(() => ({
			emit: (event: string, payload?: unknown) => {
				if (event === "job:dispatch") emitJobDispatch(payload);
			},
		}));
		(gateway.server as { to: unknown }).to = toMock;
		const originalEmit = (gateway.server as { emit: (...args: unknown[]) => unknown }).emit;
		(gateway.server as { emit: unknown }).emit = (event: string, payload?: unknown) => {
			if (event === "job:update") emitJobUpdate(payload);
			return originalEmit?.(event, payload);
		};

		dispatcher!("socket-2", {
			jobId: "reconcile-1",
			clientId: "c1",
			type: "frp.reconcile",
			payload: { connectionGeneration: "conn-1" },
			timeout: 30,
		} as never);

		expect(toMock).toHaveBeenCalledWith("socket-2");
		expect(emitJobDispatch).toHaveBeenCalledWith(
			expect.objectContaining({ jobId: "reconcile-1", type: "frp.reconcile" }),
		);
		expect(emitJobUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ jobId: "reconcile-1", status: "running" }),
		);
	});

	it("frp.reconcile JOB_DONE 交给 reconciliation service，不走 create rollback", async () => {
		const { gateway, reconciliation, frpService, emit } = makeGateway();

		await gateway.handleJobDone({
			jobId: "reconcile-1",
			type: "frp.reconcile",
			result: {
				connectionGeneration: "conn-1",
				runtimeGeneration: 4,
				status: "running",
				loadedMappingIds: ["fm_1"],
			},
		} as never);

		expect(reconciliation.handleLocalResult).toHaveBeenCalledWith(
			"reconcile-1",
			expect.objectContaining({ runtimeGeneration: 4 }),
		);
		expect(frpService.settleClientOperation).not.toHaveBeenCalled();
		expect(frpService.failClientOperation).not.toHaveBeenCalled();
		expect(emit).not.toHaveBeenCalled();
	});

	it("frp.reconcile JOB_DONE error 交给 reconciliation service 安全错误码", async () => {
		const { gateway, reconciliation, frpService } = makeGateway();

		await gateway.handleJobDone({
			jobId: "reconcile-1",
			type: "frp.reconcile",
			error: { code: "FRPC_START_FAILED", message: "frpc 启动失败" },
		} as never);

		expect(reconciliation.handleLocalFailure).toHaveBeenCalledWith(
			"reconcile-1",
			"FRPC_START_FAILED",
		);
		expect(frpService.failClientOperation).not.toHaveBeenCalled();
	});

	it("断线总是通知 reconciliation service（匹配 socket 由其内部判断）", async () => {
		const { gateway, reconciliation, clientService } = makeGateway();
		const socket = makeSocket();
		socket.data.clientId = "c1";

		await gateway.handleDisconnect(socket);

		expect(reconciliation.disconnect).toHaveBeenCalledWith("c1", "socket-1");
		expect(clientService.markOfflineBySocketId).toHaveBeenCalledWith("socket-1");
	});

	it("心跳超时 sweep 也通知 reconciliation service", async () => {
		const { gateway, clientService, reconciliation } = makeGateway();
		clientService.expireStaleClients.mockResolvedValue([
			{ clientId: "c1", socketId: "socket-7" },
		]);

		await gateway.sweepStaleClients();

		expect(reconciliation.disconnect).toHaveBeenCalledWith("c1", "socket-7");
	});
});

describe("ClientGateway P2P tunnel routing", () => {
	function clientSocket() {
		const socket = makeSocket("client-socket");
		socket.data.clientId = "c1";
		return socket;
	}

	it("Client TUNNEL_STATE 按 socketId 转发到 session 服务", async () => {
		const { gateway, tunnelSessions } = makeGateway();
		await gateway.handleTunnelState(clientSocket(), { sessionId: "tn_1", state: "connected" });
		expect(tunnelSessions.clientState).toHaveBeenCalledWith("client-socket", {
			sessionId: "tn_1",
			state: "connected",
		});
	});

	it("Client TUNNEL_CLOSE 校验 lease 后释放 session", async () => {
		const { gateway, tunnelSessions } = makeGateway();
		await gateway.handleTunnelClose(clientSocket(), { sessionId: "tn_1" });
		expect(tunnelSessions.closeFromClient).toHaveBeenCalledWith("c1", "client-socket", "tn_1");
	});

	it("Client 断线回收匹配 clientId+socket 的 session", async () => {
		const { gateway, tunnelSessions } = makeGateway();
		await gateway.handleDisconnect(clientSocket());
		expect(tunnelSessions.disconnectClient).toHaveBeenCalledWith("c1", "client-socket");
	});
});

describe("ClientGateway Git SSH 分发（ADR-0037/0038）", () => {
	const registerPayload = (gitSsh?: unknown) => ({
		clientId: "c1",
		hostname: "host",
		os: "linux 6.11.0",
		cpuModel: "cpu",
		totalMemMB: 1024,
		clientVersion: "1",
		capabilities: ["exec"],
		capabilityDetails: gitSsh === undefined ? {} : { gitSsh },
	});

	it("afterInit 绑定发送通道：按 socketId 精准发送 GIT_SSH_COMMAND", () => {
		const { gateway, gitSsh, to, emit } = makeGateway();
		gateway.afterInit();

		const sender = gitSsh.bindSender.mock.calls[0]?.[0] as (
			socketId: string,
			command: unknown,
		) => void;
		sender("socket-9", { action: "clear" });

		expect(to).toHaveBeenCalledWith("socket-9");
		expect(emit).toHaveBeenCalledWith("git-ssh:command", { action: "clear" });
	});

	it("REGISTER 后把 gitSsh 能力交给分发服务对账", async () => {
		const { gateway, gitSsh } = makeGateway();
		const socket = makeSocket();

		await gateway.handleRegister(
			socket,
			registerPayload({ available: true, protocolVersion: 1 }),
		);

		expect(gitSsh.onRegistered).toHaveBeenCalledWith("c1", "socket-1", {
			available: true,
			protocolVersion: 1,
		});
	});

	it("旧 Client 未上报 gitSsh 时按未上报转交（能力由服务判定）", async () => {
		const { gateway, gitSsh } = makeGateway();
		await gateway.handleRegister(makeSocket(), registerPayload());
		expect(gitSsh.onRegistered).toHaveBeenCalledWith("c1", "socket-1", undefined);
	});

	it("GIT_SSH_ACK 严格解析后交给分发服务；非法载荷与未注册 socket 忽略", async () => {
		const { gateway, gitSsh } = makeGateway();
		const socket = makeSocket();
		socket.data.clientId = "c1";

		await gateway.handleGitSshAck(socket, {
			protocolVersion: 1,
			operationId: "op-1",
			version: 1,
			state: "installed",
		});
		expect(gitSsh.applyAck).toHaveBeenCalledWith("c1", "socket-1", {
			protocolVersion: 1,
			operationId: "op-1",
			version: 1,
			state: "installed",
		});

		await gateway.handleGitSshAck(socket, { state: "installed" });
		await gateway.handleGitSshAck(socket, {
			protocolVersion: 1,
			operationId: "op-1",
			version: 1,
			state: "bogus",
		});
		expect(gitSsh.applyAck).toHaveBeenCalledTimes(1);

		const unregistered = makeSocket("socket-plain");
		await gateway.handleGitSshAck(unregistered, {
			protocolVersion: 1,
			operationId: "op-1",
			version: 1,
			state: "installed",
		});
		expect(gitSsh.applyAck).toHaveBeenCalledTimes(1);
	});

	it("断线与心跳超时都按实际 socket 回收分发租约", async () => {
		const { gateway, gitSsh, clientService } = makeGateway();
		const socket = makeSocket();
		socket.data.clientId = "c1";

		await gateway.handleDisconnect(socket);
		expect(gitSsh.onDisconnected).toHaveBeenCalledWith("c1", "socket-1");

		clientService.expireStaleClients.mockResolvedValue([
			{ clientId: "c1", socketId: "socket-7" },
		]);
		await gateway.sweepStaleClients();
		expect(gitSsh.onDisconnected).toHaveBeenCalledWith("c1", "socket-7");
	});
});

describe("ClientGateway.handleJobCancelFailed", () => {
	it("客户端确认不再持有该 Job 时收尾为 error 并推进该 Client 队列", async () => {
		const { gateway, jobService, emit } = makeGateway();
		// harness 的 emit 间谍只覆盖 server.to().emit；job:update 走 server.emit，需按既有套路打点。
		const updates: unknown[] = [];
		const serverEmit = (gateway.server as { emit: (...a: unknown[]) => unknown })
			.emit;
		(gateway.server as { emit: unknown }).emit = (
			event: string,
			payload?: unknown,
		) => {
			if (event === "job:update") updates.push(payload);
			return serverEmit?.(event, payload);
		};
		jobService.failOrphaned.mockResolvedValue({
			jobId: "next-job",
			clientId: "c1",
			type: "exec",
			payload: { mode: "command", command: "echo next" },
			timeout: null,
		});
		jobService.findById.mockResolvedValue({ id: "job-1", type: "exec" });

		await gateway.handleJobCancelFailed({
			jobId: "job-1",
			reason: "Job not found",
		} as never);

		expect(jobService.failOrphaned).toHaveBeenCalledWith("job-1", "Job not found");
		expect(updates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ jobId: "job-1", status: "error" }),
			]),
		);
		expect(emit).toHaveBeenCalledWith(
			"job:dispatch",
			expect.objectContaining({ jobId: "next-job" }),
		);
	});

	it("收尾失败（Job 已是终态）时不覆盖结果、也不派发", async () => {
		const { gateway, jobService, emit } = makeGateway();
		jobService.failOrphaned.mockResolvedValue(null);
		jobService.findById.mockResolvedValue({ id: "job-9", type: "exec" });

		await gateway.handleJobCancelFailed({
			jobId: "job-9",
			reason: "Job not found",
		} as never);

		expect(emit).not.toHaveBeenCalledWith(
			"job:dispatch",
			expect.anything(),
		);
	});
});
