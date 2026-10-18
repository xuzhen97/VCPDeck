import type { VcpDeckClient } from "@vcpdeck/sdk";
import { VcpDeckApiError } from "@vcpdeck/sdk";
import type { ClientInfo } from "@vcpdeck/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { MachineAnnotationsPanel } from "./machine-annotations-panel";

const baseClient: ClientInfo = {
	clientId: "c1",
	name: "workstation",
	hostname: "workstation",
	os: "linux",
	cpuModel: "CPU",
	totalMemMB: 1024,
	clientVersion: "0.20.1",
	capabilities: [],
	capabilityDetails: {},
	online: true,
	cpuPercent: null,
	memPercent: null,
	disks: [],
	lastHeartbeatAt: null,
};

function renderPanel(
	client: ClientInfo,
	updateAnnotations = vi.fn(async () => client),
) {
	const sdk = {
		clients: { updateAnnotations },
	} as unknown as VcpDeckClient;
	render(
		<SdkProvider client={sdk}>
			<MachineAnnotationsPanel client={client} />
		</SdkProvider>,
	);
	return { updateAnnotations };
}

describe("MachineAnnotationsPanel", () => {
	it("未补充时显示未补充", () => {
		renderPanel(baseClient);
		expect(screen.getByText("公网与注解")).toBeVisible();
		expect(screen.getByText("未补充")).toBeVisible();
	});

	it("展示公网地址、域名与备注", () => {
		renderPanel({
			...baseClient,
			annotations: {
				publicAddress: {
					v4: ["1.2.3.4"],
					v6: [],
					host: "nas.example.com",
				},
				notes: "动态 IP",
				updatedAt: "2026-10-18T02:00:00.000Z",
			},
		});
		expect(screen.getByTestId("machine-public-address")).toHaveTextContent(
			"1.2.3.4 · nas.example.com",
		);
		expect(screen.getByText("动态 IP")).toBeVisible();
	});

	it("区分未声明与明确无公网", () => {
		renderPanel({
			...baseClient,
			annotations: {
				publicAddress: null,
				notes: "待确认",
				updatedAt: "2026-10-18T02:00:00.000Z",
			},
		});
		expect(screen.getByTestId("machine-public-address")).toHaveTextContent(
			"未声明",
		);
	});

	it("明确无公网地址", () => {
		renderPanel({
			...baseClient,
			annotations: {
				publicAddress: { v4: [], v6: [], host: null },
				notes: null,
				updatedAt: "2026-10-18T02:00:00.000Z",
			},
		});
		expect(screen.getByTestId("machine-public-address")).toHaveTextContent(
			"无公网地址",
		);
	});

	it("编辑并保存完整注解", async () => {
		const updated = {
			...baseClient,
			annotations: {
				publicAddress: { v4: ["5.6.7.8"], v6: [], host: null },
				notes: "新备注",
				updatedAt: "2026-10-18T03:00:00.000Z",
			},
		};
		const { updateAnnotations } = renderPanel(
			baseClient,
			vi.fn(async () => updated),
		);

		fireEvent.click(screen.getByRole("button", { name: "编辑" }));
		fireEvent.change(screen.getByLabelText("公网地址类型"), {
			target: { value: "yes" },
		});
		fireEvent.change(screen.getByLabelText("公网 IPv4"), {
			target: { value: "5.6.7.8" },
		});
		fireEvent.change(screen.getByLabelText("备注"), {
			target: { value: "新备注" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存" }));

		expect(
			await screen.findByTestId("machine-public-address"),
		).toHaveTextContent("5.6.7.8");
		expect(updateAnnotations).toHaveBeenCalledWith("c1", {
			publicAddress: { v4: ["5.6.7.8"], v6: [], host: null },
			notes: "新备注",
		});
	});

	it("未声明保存为 publicAddress null", async () => {
		const { updateAnnotations } = renderPanel(
			baseClient,
			vi.fn(async () => baseClient),
		);

		fireEvent.click(screen.getByRole("button", { name: "编辑" }));
		fireEvent.click(screen.getByRole("button", { name: "保存" }));

		await waitFor(() =>
			expect(updateAnnotations).toHaveBeenCalledWith("c1", {
				publicAddress: null,
				notes: null,
			}),
		);
	});

	it("明确无公网保存为空地址对象", async () => {
		const { updateAnnotations } = renderPanel(
			baseClient,
			vi.fn(async () => baseClient),
		);

		fireEvent.click(screen.getByRole("button", { name: "编辑" }));
		fireEvent.change(screen.getByLabelText("公网地址类型"), {
			target: { value: "none" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存" }));

		await waitFor(() =>
			expect(updateAnnotations).toHaveBeenCalledWith("c1", {
				publicAddress: { v4: [], v6: [], host: null },
				notes: null,
			}),
		);
	});

	it("服务端 400 时保留弹窗并提示", async () => {
		renderPanel(
			baseClient,
			vi.fn().mockRejectedValue(
				new VcpDeckApiError(
					"bad",
					400,
					"INVALID_CLIENT_ANNOTATIONS",
				),
			),
		);

		fireEvent.click(screen.getByRole("button", { name: "编辑" }));
		fireEvent.click(screen.getByRole("button", { name: "保存" }));

		expect(await screen.findByText(/注解格式不合法/)).toBeVisible();
		expect(screen.getByRole("button", { name: "保存" })).toBeVisible();
	});
});
