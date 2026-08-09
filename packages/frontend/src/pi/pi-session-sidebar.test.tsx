import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PiSessionSidebar } from "./pi-session-sidebar.js";

const sessions = [
	{ id: "s1", name: "owned", firstMessage: null, messageCount: 1, modified: "2026-08-08T00:00:00.000Z", running: false },
	{ id: "s2", name: "observed", firstMessage: null, messageCount: 1, modified: "2026-08-08T00:00:00.000Z", running: false },
];

describe("PiSessionSidebar", () => {
	it("只有 mutableSessionId 对应卡片显示管理操作", async () => {
		const pi = {
			sessions: { list: vi.fn(async () => sessions), get: vi.fn(async () => ({ tree: [] })), rename: vi.fn(), delete: vi.fn(), fork: vi.fn(), clone: vi.fn() },
			agent: { newSession: vi.fn() },
		} as never;
		const files = { roots: vi.fn(), list: vi.fn() } as never;
		render(<PiSessionSidebar pi={pi} files={files} clientId="c1" cwdRef={{ rootDir: "D:\\", relativePath: "repo" }} onCwdChange={vi.fn()} activeSessionId="s1" mutableSessionId="s1" onSelectSession={vi.fn()} onCreated={vi.fn()} />);
		expect(await screen.findByText("owned")).toBeVisible();
		expect(screen.getByText("observed")).toBeVisible();
		expect(screen.getAllByRole("button", { name: "重命名" })).toHaveLength(1);
		expect(screen.getAllByRole("button", { name: "克隆" })).toHaveLength(1);
		expect(screen.getAllByRole("button", { name: "Fork" })).toHaveLength(1);
		expect(screen.getAllByRole("button", { name: "删除" })).toHaveLength(1);
	});
});
