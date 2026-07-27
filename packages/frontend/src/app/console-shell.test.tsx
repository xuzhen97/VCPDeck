import type { IdentityInfo } from "@vcpdeck/shared";
import { render, screen, within } from "@testing-library/react";
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

		const navigation = within(screen.getByRole("navigation", { name: "主导航" }));
		for (const label of ["概览", "机器", "任务", "FRP", "存储", "设置"]) {
			expect(navigation.getByRole("link", { name: label })).toBeVisible();
		}
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
		await userEvent.type(screen.getByLabelText("输入目标以确认"), "D:/work/data");
		await userEvent.click(confirm);

		expect(onConfirm).toHaveBeenCalledOnce();
	});
});
