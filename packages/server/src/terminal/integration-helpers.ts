import { vi } from "vitest";

/** 内存 Prisma（client + terminalSession + terminalAuditEvent）。 */
export function makeMemoryPrisma() {
	const clients = new Map<string, Record<string, unknown>>();
	const sessions = new Map<string, Record<string, unknown>>();
	const audits: Array<Record<string, unknown>> = [];
	const now = () => new Date("2026-08-12T00:00:00.000Z");
	const withDefaults = (data: Record<string, unknown>): Record<string, unknown> => ({
		createdAt: now(),
		updatedAt: now(),
		status: "starting",
		...data,
	});
	return {
		clients,
		sessions,
		audits,
		prisma: {
			client: {
				findUnique: vi.fn(async ({ where }: { where: { id: string } }) => clients.get(where.id) ?? null),
			},
			terminalSession: {
				findUnique: vi.fn(async ({ where }: { where: { id: string } }) => sessions.get(where.id) ?? null),
				findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
					if (!where) return [...sessions.values()];
					return [...sessions.values()].filter((s) =>
						Object.entries(where).every(([k, v]) => {
							if (k === "status" && typeof v === "object" && v !== null) {
								const notIn = (v as { notIn?: string[] }).notIn;
								if (notIn) return !notIn.includes(s.status as string);
							}
							return s[k] === v;
						}),
					);
				}),
				count: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
					if (!where) return sessions.size;
					let total = 0;
					for (const s of sessions.values()) {
						let ok = true;
						for (const [k, v] of Object.entries(where)) {
							if (k === "status" && typeof v === "object" && v !== null) {
								const notIn = (v as { notIn?: string[] }).notIn;
								if (notIn && notIn.includes(s.status as string)) ok = false;
								continue;
							}
							if (s[k] !== v) ok = false;
						}
						if (ok) total += 1;
					}
					return total;
				}),
				create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
					const row = withDefaults(data);
					sessions.set(row.id as string, row);
					return row;
				}),
				update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
					const row = { ...(sessions.get(where.id) ?? {}), ...data, updatedAt: now() };
					sessions.set(where.id, row);
					return row;
				}),
			},
			terminalAuditEvent: {
				create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
					audits.push({ ...data, createdAt: now() });
					return data;
				}),
				findMany: vi.fn(async () => []),
				count: vi.fn(async () => 0),
			},
		} as never,
		audit: {
			record: vi.fn(async () => undefined),
		} as never,
	};
}

/** fake Client：模拟 Client 桥（shells/create/attach/input/resize/close + 输出）。 */
export function makeFakeClient() {
	const ptys = new Map<string, { seq: number; cols: number; rows: number }>();
	const receivedInput: Array<{ sessionId: string; data: string }> = [];
	let onOutput: ((sessionId: string, data: string) => void) | null = null;
	let onClientResponse: ((socketId: string, response: unknown) => void) | null = null;
	const broker = new (class {
		emitter: ((socketId: string, request: unknown) => void) | null = null;
		pending = new Map<string, { socketId: string; resolve: (r: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
		bindEmitter(fn: (socketId: string, request: unknown) => void): void {
			this.emitter = fn;
		}
		request(lease: { clientId: string; socketId: string }, request: { requestId: string }): Promise<unknown> {
			return new Promise((resolve) => {
				const timer = setTimeout(() => {
					this.pending.delete(request.requestId);
					resolve({ requestId: request.requestId, ok: false, error: { code: "TERMINAL_REQUEST_TIMEOUT", message: "timeout" } });
				}, 3000);
				this.pending.set(request.requestId, { socketId: lease.socketId, resolve, timer });
				this.emitter?.(lease.socketId, request);
			});
		}
		resolve(socketId: string, response: { requestId: string }): void {
			const p = this.pending.get(response.requestId);
			if (!p || p.socketId !== socketId) return;
			clearTimeout(p.timer);
			this.pending.delete(response.requestId);
			p.resolve(response);
		}
	})();
	const routes = new Map<string, (request: any) => Promise<any>>();
	broker.bindEmitter((socketId, request) => {
		void routes.get(socketId)?.(request).then((response) => {
			broker.resolve(socketId, response);
			onClientResponse?.(socketId, response);
		});
	});
	return {
		broker,
		ptys,
		receivedInput,
		bindClientSocket: (socketId: string) => {
			routes.set(socketId, async (request: any) => {
				switch (request.action) {
					case "shells.list":
						return { requestId: request.requestId, ok: true, action: "shells.list", shells: [{ id: "bash", label: "bash", kind: "bash", isDefault: true }] };
					case "session.create": {
						ptys.set(request.sessionId, { seq: 0, cols: request.cols, rows: request.rows });
						return { requestId: request.requestId, ok: true, action: "session.create", sessionId: request.sessionId, status: "detached" };
					}
					case "session.attach": {
						const pty = ptys.get(request.sessionId);
						return {
							requestId: request.requestId,
							ok: true,
							action: "session.attach",
							sessionId: request.sessionId,
							snapshot: `SNAP:${request.sessionId}`,
							snapshotSeq: pty?.seq ?? 0,
							cols: pty?.cols ?? 80,
							rows: pty?.rows ?? 24,
							historyTruncated: false,
						};
					}
					case "session.input": {
						receivedInput.push({ sessionId: request.sessionId, data: request.data });
						onOutput?.(request.sessionId, `echo:${request.data}`);
						return { requestId: request.requestId, ok: true, action: "session.input", sessionId: request.sessionId };
					}
					case "session.resize": {
						const pty = ptys.get(request.sessionId);
						if (pty) {
							pty.cols = request.cols;
							pty.rows = request.rows;
						}
						return { requestId: request.requestId, ok: true, action: "session.resize", sessionId: request.sessionId, cols: request.cols, rows: request.rows };
					}
					case "session.detach":
						return { requestId: request.requestId, ok: true, action: "session.detach", sessionId: request.sessionId };
					case "session.snapshot": {
						const pty = ptys.get(request.sessionId);
						return {
							requestId: request.requestId,
							ok: true,
							action: "session.snapshot",
							sessionId: request.sessionId,
							snapshot: "SNAP",
							snapshotSeq: pty?.seq ?? 0,
							cols: pty?.cols ?? 80,
							rows: pty?.rows ?? 24,
							historyTruncated: false,
						};
					}
					case "session.close": {
						ptys.delete(request.sessionId);
						return { requestId: request.requestId, ok: true, action: "session.close", sessionId: request.sessionId, status: "closed" };
					}
				}
			});
		},
		setOnOutput: (fn: (sessionId: string, data: string) => void) => {
			onOutput = fn;
		},
		setOnClientResponse: (fn: (socketId: string, response: unknown) => void) => {
			onClientResponse = fn;
		},
	};
}
