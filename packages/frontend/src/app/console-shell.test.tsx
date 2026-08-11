import type { IdentityInfo } from "@vcpdeck/shared";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ConfirmTargetDialog } from "@/components/confirm-target-dialog";
import { ConsoleShell } from "./console-shell";

const admin: IdentityInfo = {
	id: "identity-1",
	username: "admin",
	displayName: "管理员",
	isAdmin: true,
	disabledAt: null,
	createdAt: "2026-07-26T00:00:00.000Z",
};

describe("ConsoleShell", () => {
	it("renders operation-first navigation", () => {
		render(
			<MemoryRouter>
				<ConsoleShell identity={admin} onLogout={vi.fn()}>
					<p>content</p>
				</ConsoleShell>
			</MemoryRouter>,
		);

		const navigation = within(
			screen.getByRole("navigation", { name: "主导航" }),
		);
		for (const label of ["概览", "机器", "任务", "映射", "存储", "设置"]) {
			expect(navigation.getByRole("link", { name: label })).toBeVisible();
		}
		expect(navigation.queryByRole("link", { name: "FRP" })).not.toBeInTheDocument();
	});

	it("puts the sidebar toggle outside the sidebar at the main header edge", () => {
		render(
			<MemoryRouter>
				<ConsoleShell identity={admin} onLogout={vi.fn()}>
					<p>content</p>
				</ConsoleShell>
			</MemoryRouter>,
		);

		const brand = screen.getByTestId("sidebar-brand");
		expect(within(brand).queryByRole("button", { name: "收起侧栏" })).not.toBeInTheDocument();
		const mainHeader = screen.getByRole("banner");
		const toggle = within(mainHeader).getByRole("button", { name: "收起侧栏" });
		expect(toggle).toHaveClass("vcpdeck-sidebar-toggle", "lg:inline-flex");
		expect(screen.getByRole("button", { name: "打开侧栏" })).toHaveClass("lg:hidden");
		expect(screen.getByTestId("sidebar-footer")).not.toHaveTextContent("收起侧栏");

		fireEvent.click(toggle);
		expect(within(mainHeader).getByRole("button", { name: "展开侧栏" })).toBeVisible();
	});

	it("uses matching icon button sizing for notification/theme/logout actions", () => {
		render(
			<MemoryRouter>
				<ConsoleShell identity={admin} onLogout={vi.fn()}>
					<p>content</p>
				</ConsoleShell>
			</MemoryRouter>,
		);

		for (const name of ["任务通知", "切换主题", "退出登录"]) {
			expect(screen.getByRole("button", { name })).toHaveClass("size-10", "rounded-lg");
		}
	});

	it("keeps the notification layer above the scrolling main content", () => {
		render(
			<MemoryRouter>
				<ConsoleShell identity={admin} onLogout={vi.fn()}>
					<p>content</p>
				</ConsoleShell>
			</MemoryRouter>,
		);

		expect(screen.getByRole("banner")).toHaveClass("relative", "z-40");
	});

	it("requires exact target before destructive confirmation", async () => {
		const onConfirm = vi.fn();
		render(
			<ConfirmTargetDialog
				open
				target="D:/work/data"
				title="删除目录"
				onConfirm={onConfirm}
				onOpenChange={vi.fn()}
			/>,
		);

		const confirm = screen.getByRole("button", { name: "确认删除" });
		expect(confirm).toBeDisabled();
		await userEvent.type(
			screen.getByLabelText("输入目标以确认"),
			"D:/work/data",
		);
		await userEvent.click(confirm);

		expect(onConfirm).toHaveBeenCalledOnce();
	});
});
