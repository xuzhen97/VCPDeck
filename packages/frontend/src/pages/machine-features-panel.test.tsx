import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { FeatureInfo } from "@vcpdeck/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { MachineFeaturesPanel } from "./machine-features-panel";

const feature: FeatureInfo = {
	id: "ft_1",
	slug: "comfyui-t2i",
	name: "ComfyUI 文生图",
	summary: "按工作流出图",
	clientId: "c1",
	clientName: "silvermoon-box",
	scope: "generic",
	invoke: {
		kind: "http",
		method: "POST",
		url: "http://10.0.0.1:8188/prompt",
		timeoutSeconds: 60,
	},
	verify: {
		kind: "http",
		method: "GET",
		url: "http://10.0.0.1:8188/system_stats",
		timeoutSeconds: 60,
	},
	inputs: [],
	output: "PNG",
	notes: "",
	status: "active",
	freshness: "stale",
	lastVerifiedAt: "2026-10-01T00:00:00.000Z",
	lastVerifiedOk: true,
	lastVerifyEvidence: "HTTP 200",
	verifiedVia: "cli",
	sourceJobId: null,
	createdByName: "Admin",
	createdVia: "cli",
	createdAt: "2026-10-01T00:00:00.000Z",
	updatedAt: "2026-10-01T00:00:00.000Z",
};

function renderPanel(data: FeatureInfo[]) {
	const page = {
		data,
		total: data.length,
		page: 1,
		pageSize: 20,
		totalPages: 1,
	};
	const sdk = {
		features: {
			list: vi.fn(async () => page),
			listByClient: vi.fn(async () => page),
			update: vi.fn(async () => data[0]),
		},
	} as unknown as VcpDeckClient;
	render(
		<SdkProvider client={sdk}>
			<MachineFeaturesPanel clientId="c1" />
		</SdkProvider>,
	);
	return { sdk };
}

describe("MachineFeaturesPanel", () => {
	it("stale 条目显示未验证天数提示", async () => {
		renderPanel([feature]);
		const freshness = await screen.findByTestId("feature-freshness");
		expect(freshness.textContent).toMatch(/已 \d+ 天未验证/);
	});

	it("常驻提示 active 只代表声明", async () => {
		renderPanel([feature]);
		const warning = await screen.findByTestId("feature-warning");
		expect(warning.textContent).toContain("active 只代表声明");
	});

	it("空列表提示如何登记", async () => {
		renderPanel([]);
		expect(await screen.findByText(/还没有登记任何功能/)).toBeVisible();
	});

	it("最近验证失败时展示失败文案而非“通过”", async () => {
		renderPanel([
			{
				...feature,
				status: "draft",
				lastVerifiedOk: false,
				lastVerifyEvidence: "exitCode=1",
			},
		]);
		const freshness = await screen.findByTestId("feature-freshness");
		expect(freshness.textContent).toContain("最新验证失败");
		expect(freshness.textContent).not.toContain("通过");
	});

	it("默认隐藏已退役条目，勾选后才显示且带已退役前缀", async () => {
		renderPanel([
			feature,
			{
				...feature,
				id: "ft_old",
				slug: "old-feature",
				name: "旧条目",
				status: "retired",
			},
		]);
		await screen.findByTestId("feature-row");
		expect(screen.queryByText("旧条目")).toBeNull();

		fireEvent.click(screen.getByLabelText("显示已退役"));
		expect(await screen.findByText("旧条目")).toBeVisible();
		const cells = screen.getAllByTestId("feature-freshness");
		const retiredCell = cells.find((cell) =>
			cell.textContent?.includes("已退役"),
		);
		expect(retiredCell?.textContent).toMatch(/^已退役（.+）$/);
	});

	it("全部退役时给出提示而不是空表", async () => {
		renderPanel([{ ...feature, status: "retired" }]);
		expect(
			await screen.findByText(/这台机器的功能条目都已退役/),
		).toBeVisible();
	});

	it("列表展示作用域与提供机器", async () => {
		renderPanel([feature]);
		const row = await screen.findByTestId("feature-row");
		expect(row.textContent).toContain("通用");
		expect(row.textContent).toContain("silvermoon-box");
	});
});
