import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SdkProvider } from "@/api/context";
import { TerminalPanel } from "./terminal-panel.js";

function sessionInfo(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		sessionId: "s1",
		clientId: "c1",
		shellId: "bash",
		shellLabel: "bash",
		status: "detached",
		cols: 80,
		rows: 24,
		createdByIdentityId: null,
		createdByName: null,
		createdAt: "2026-08-12T00:00:00.000Z",
		lastAttachedAt: null,
		detachedAt: null,
		expiresAt: null,
		endedAt: null,
		endReason: null,
		errorCode: null,
		...overrides,
	} as never;
}

function makeSdk(overrides: Record<string, unknown> = {}) {
	const list = vi.fn(async () => ({ data: [sessionInfo()], total: 1, page: 1, pageSize: 50, totalPages: 1 }));
	const shells = vi.fn(async () => [{ id: "bash", label: "bash", kind: "bash", isDefault: true }]);
	const create = vi.fn(async (clientId: string, body: { shellId: string; cols: number; rows: number }) =>
		sessionInfo({ shellId: body.shellId }),
	);
	const remove = vi.fn(async () => sessionInfo({ status: "closed" }));
	const audit = vi.fn(async () => ({ data: [], total: 0, page: 1, pageSize: 20, totalPages: 0 }));
	const sdk = {
		terminals: { list, shells, create, remove, audit, ...overrides },
	} as never;
	return { sdk, list, shells, create, remove, audit };
}

/** 自动 ack 的 fake socket。 */
function makeSocketFactory() {
	const socket = {
		on: vi.fn(() => socket),
		off: vi.fn(() => socket),
		emit: vi.fn((event: string, _payload: unknown, ack?: (r: unknown) => void) => {
			if (typeof ack === "function") {
				ack({
					ok: true,
					data:
						event === "terminal:attach"
							? { sessionId: "s1", attachmentId: "ta1", reconnectToken: "tok", mode: "operator", controlProtectedUntil: null }
							: undefined,
				});
			}
			return socket;
		}),
	} as never;
	return () => socket;
}

/** fake xterm adapter（避免 jsdom canvas 限制）。 */
function makeAdapterFactory() {
	return () => ({
		open: vi.fn(),
		write: vi.fn(),
		reset: vi.fn(),
		dispose: vi.fn(),
		onData: vi.fn(),
		fit: () => ({ cols: 100, rows: 40 }),
	});
}

function renderPanel(sdk: ReturnType<typeof makeSdk>["sdk"]) {
	return render(
		<SdkProvider client={sdk as never}>
			<TerminalPanel
				clientId="c1"
				socketFactory={makeSocketFactory()}
				viewAdapterFactory={makeAdapterFactory()}
			/>
		</SdkProvider>,
	);
}

describe("TerminalPanel", () => {
	it("加载会话与 Shell，渲染子标签和控制条", async () => {
		const { sdk } = makeSdk();
		renderPanel(sdk);
		await waitFor(() => expect(screen.getByTestId("terminal-tabs")).toBeTruthy());
		expect(await screen.findByText(/bash 1/)).toBeTruthy();
		expect(screen.getByTestId("terminal-control")).toBeTruthy();
		
	});

	it("新建终端：菜单选择 Shell 并调用 create（默认尺寸）", async () => {
		const user = userEvent.setup();
		const { sdk, create } = makeSdk();
		renderPanel(sdk);
		await screen.findByTestId("terminal-tabs");
		await user.click(screen.getByRole("button", { name: /新建/ }));
		await user.click(within(await screen.findByTestId("terminal-new-menu")).getByText("bash"));
		await waitFor(() =>
			expect(create).toHaveBeenCalledWith("c1", { shellId: "bash", cols: 120, rows: 30 }),
		);
	});

	it("5 个活跃会话时禁用新建按钮", async () => {
		const { sdk } = makeSdk({
			list: vi.fn(async () => ({
				data: Array.from({ length: 5 }, (_, i) => sessionInfo({ sessionId: `s${i}`, status: "active" })),
				total: 5,
				page: 1,
				pageSize: 50,
				totalPages: 1,
			})),
		});
		renderPanel(sdk);
		await screen.findByTestId("terminal-tabs");
		const btn = screen.getByRole("button", { name: /新建/ });
		expect((btn as HTMLButtonElement).disabled).toBe(true);
	});

	it("关闭终端需二次确认并调用 remove", async () => {
		const user = userEvent.setup();
		const { sdk, remove } = makeSdk();
		renderPanel(sdk);
		await screen.findByTestId("terminal-tabs");
		await user.click(screen.getByRole("button", { name: "关闭终端" }));
		expect(await screen.findByText("关闭终端？")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: /确认关闭/ }));
		await waitFor(() => expect(remove).toHaveBeenCalledWith("c1", "s1"));
	});

	it("列表加载失败展示稳定错误并支持重试", async () => {
		const user = userEvent.setup();
		const listMock = vi.fn(async () => {
			throw Object.assign(new Error("offline"), { code: "TERMINAL_CLIENT_OFFLINE" });
		});
		const { sdk } = makeSdk({ list: listMock });
		renderPanel(sdk);
		await waitFor(() => expect(screen.getByText(/终端不可用：TERMINAL_CLIENT_OFFLINE/)).toBeTruthy());
		listMock.mockResolvedValue({ data: [sessionInfo()], total: 1, page: 1, pageSize: 50, totalPages: 1 } as never);
		const retry = await screen.findByRole("button", { name: /重试/ });
		await user.click(retry);
		await waitFor(() => expect(screen.getByTestId("terminal-tabs")).toBeTruthy());
	});

	it("空列表显示引导文案", async () => {
		const { sdk } = makeSdk({
			list: vi.fn(async () => ({ data: [], total: 0, page: 1, pageSize: 50, totalPages: 0 })),
		});
		renderPanel(sdk);
		expect(await screen.findByText(/还没有终端会话/)).toBeTruthy();
	});

	it("审计对话框分页展示记录", async () => {
		const user = userEvent.setup();
		const auditMock = vi.fn(async () => ({
			data: [
				{ id: "a1", sessionId: "s1", clientId: "c1", event: "created", identityId: null, actorName: "admin", source: "web", result: "ok", reason: null, createdAt: "2026-08-12T00:00:00.000Z" },
			],
			total: 1,
			page: 1,
			pageSize: 20,
			totalPages: 1,
		}));
		const { sdk } = makeSdk({ audit: auditMock });
		renderPanel(sdk);
		await screen.findByTestId("terminal-tabs");
		const auditBtn = await screen.findByRole("button", { name: /操作记录/ });
		await user.click(auditBtn);
		await waitFor(() => expect(auditMock).toHaveBeenCalled());
		const list = await screen.findByTestId("terminal-audit-list");
		expect(within(list).getByText("创建")).toBeTruthy();
	});
});
