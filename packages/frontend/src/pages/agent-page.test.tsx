import type { VcpDeckClient } from "@vcpdeck/sdk";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { AuthProvider } from "@/auth-context";
import { AgentPage } from "./agent-page";

// AgentPage 的职责是「二级路由接线 + 当前面板唯一挂载」；对话面板由
// agent-chat-panel.test.tsx 覆盖，这里替身以切断 PiPanel → pi-web 的依赖链。
vi.mock("@/pages/agent-chat-panel", () => ({
	AgentChatPanel: () => <div data-testid="chat-panel-mock" />,
}));

const identity = {
	id: "i1",
	username: "operator",
	displayName: "操作员",
	isAdmin: true,
	disabledAt: null,
	createdAt: "2026-07-26T00:00:00.000Z",
};

function paginated<T>(data: T[]) {
	return {
		data,
		total: data.length,
		page: 1,
		pageSize: 20,
		totalPages: data.length > 0 ? 1 : 0,
	};
}

function LocationProbe() {
	return <output aria-label="当前位置">{useLocation().pathname}</output>;
}

function renderAgent(path: string) {
	const sdk = {
		auth: { me: async () => identity },
		clients: { list: vi.fn().mockResolvedValue([]) },
		pi: {
			profiles: { list: vi.fn().mockResolvedValue(paginated([])) },
			providers: { list: vi.fn().mockResolvedValue(paginated([])) },
			credentials: { list: vi.fn().mockResolvedValue(paginated([])) },
			bindings: { list: vi.fn().mockResolvedValue([]) },
			runtime: vi.fn().mockResolvedValue([]),
		},
	} as unknown as VcpDeckClient;
	render(
		<MemoryRouter initialEntries={[path]}>
			<SdkProvider client={sdk}>
				<AuthProvider>
					<Routes>
						<Route path="/agent/*" element={<AgentPage />} />
					</Routes>
					<LocationProbe />
				</AuthProvider>
			</SdkProvider>
		</MemoryRouter>,
	);
}

describe("AgentPage", () => {
	it("renders the Agent heading and only the current configuration panel", async () => {
		renderAgent("/agent/profile");

		expect(
			await screen.findByRole("heading", { name: "Agent" }),
		).toBeInTheDocument();
		expect(
			await screen.findByRole("heading", { name: "Pi · Profile" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: "Pi · Provider" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: "Pi · Client 运行时" }),
		).not.toBeInTheDocument();
		expect(screen.queryByTestId("chat-panel-mock")).not.toBeInTheDocument();
	});

	it("mounts the provider panel on its own sub-route", async () => {
		renderAgent("/agent/provider");

		expect(
			await screen.findByRole("heading", { name: "Pi · Provider" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: "Pi · Profile" }),
		).not.toBeInTheDocument();
	});

	it("keeps the historical credentials alias on the provider panel", async () => {
		renderAgent("/agent/credentials");

		expect(
			await screen.findByRole("heading", { name: "Pi · Provider" }),
		).toBeInTheDocument();
	});

	it("renders the chat view full-bleed without the page heading", async () => {
		renderAgent("/agent/chat");

		expect(await screen.findByTestId("chat-panel-mock")).toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: "Agent" }),
		).not.toBeInTheDocument();
	});

	it("redirects the module root to the chat view", async () => {
		renderAgent("/agent");

		await waitFor(() =>
			expect(screen.getByLabelText("当前位置")).toHaveTextContent("/agent/chat"),
		);
		expect(await screen.findByTestId("chat-panel-mock")).toBeInTheDocument();
	});
});
