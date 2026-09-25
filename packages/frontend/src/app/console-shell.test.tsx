import type { IdentityInfo } from "@vcpdeck/shared";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
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

function LocationProbe() {
	return <output aria-label="当前位置">{useLocation().pathname}</output>;
}

/** 渲染外壳 + 占位内容；外壳的层级由 initialPath 决定。 */
function renderShell(initialPath = "/dashboard") {
	return render(
		<MemoryRouter initialEntries={[initialPath]}>
			<ConsoleShell identity={admin} onLogout={vi.fn()}>
				<Routes>
					<Route path="*" element={<p>content</p>} />
				</Routes>
			</ConsoleShell>
			<LocationProbe />
		</MemoryRouter>,
	);
}

describe("ConsoleShell", () => {
	it("renders operation-first navigation", () => {
		renderShell("/dashboard");

		const navigation = within(
			screen.getByRole("navigation", { name: "主导航" }),
		);
		for (const label of [
			"概览",
			"Agent",
			"机器",
			"任务",
			"映射",
			"发版",
			"设置",
		]) {
			expect(navigation.getByRole("link", { name: label })).toBeVisible();
		}
		for (const gone of ["存储", "FRP"]) {
			expect(
				navigation.queryByRole("link", { name: gone }),
			).not.toBeInTheDocument();
		}
		// 一级状态不渲染 Back Action
		expect(screen.queryByTestId("sidebar-back")).not.toBeInTheDocument();
		expect(screen.queryByTestId("mobile-nav-back")).not.toBeInTheDocument();
	});

	it("replaces level-one navigation with module sub-navigation and offers Back", async () => {
		renderShell("/machines");

		await userEvent.click(
			within(screen.getByRole("navigation", { name: "主导航" })).getByRole(
				"link",
				{ name: "设置" },
			),
		);

		// 一级导航整体消失，二级导航出现——两者永不并排
		expect(
			screen.queryByRole("navigation", { name: "主导航" }),
		).not.toBeInTheDocument();
		const subnav = within(screen.getByRole("navigation", { name: "模块导航" }));
		for (const label of ["个人资料", "Token", "网络", "存储", "身份管理"]) {
			expect(subnav.getByRole("link", { name: label })).toBeVisible();
		}
		expect(screen.getByLabelText("当前位置")).toHaveTextContent("/settings");

		// 窄屏横向导航在二级状态把「返回」放在首项，否则抽屉关着时无法回到一级
		const mobileNav = within(
			screen.getByRole("navigation", { name: "移动导航" }),
		);
		const mobileBack = mobileNav.getByTestId("mobile-nav-back");
		expect(mobileNav.getAllByRole("button")[0]).toBe(mobileBack);
		expect(mobileBack).toHaveAccessibleName("返回全局导航");

		// Back 可用，且回到进入模块前的一级页面。
		// 侧栏与横向导航各有一个 Back，必须按容器/testid 定位。
		const back = screen.getByTestId("sidebar-back");
		await userEvent.click(back);
		await waitFor(() =>
			expect(screen.getByLabelText("当前位置")).toHaveTextContent("/machines"),
		);
		expect(
			screen.queryByRole("button", { name: "返回全局导航" }),
		).not.toBeInTheDocument();
	});

	it("keeps level-one navigation on routes whose module has no sub-navigation", () => {
		renderShell("/machines/client-1/files");

		const navigation = within(
			screen.getByRole("navigation", { name: "主导航" }),
		);
		expect(navigation.getByRole("link", { name: "机器" })).toHaveClass("active");
		expect(
			screen.queryByRole("navigation", { name: "模块导航" }),
		).not.toBeInTheDocument();
		expect(screen.queryByTestId("sidebar-back")).not.toBeInTheDocument();
	});

	it("drops main paddings and scrolling for the full-bleed chat view", () => {
		renderShell("/agent/chat");

		const main = screen.getByRole("main");
		expect(main).toHaveClass("overflow-hidden");
		expect(main).not.toHaveClass("p-4");
		expect(main).not.toHaveClass("overflow-y-auto");
	});

	it("keeps the Back label span so collapsing hides it together with nav labels", () => {
		renderShell("/settings/profile");

		const back = screen.getByTestId("sidebar-back");
		expect(back).toHaveAccessibleName("返回全局导航");
		expect(back).toHaveClass("vcpdeck-nav-link");
		expect(back.querySelector(".vcpdeck-sidebar-label")).not.toBeNull();
	});

	it("puts the sidebar toggle outside the sidebar at the main header edge", () => {
		renderShell("/dashboard");

		const brand = screen.getByTestId("sidebar-brand");
		expect(
			within(brand).queryByRole("button", { name: "收起侧栏" }),
		).not.toBeInTheDocument();
		const mainHeader = screen.getByRole("banner");
		const toggle = within(mainHeader).getByRole("button", { name: "收起侧栏" });
		expect(toggle).toHaveClass("vcpdeck-sidebar-toggle", "lg:inline-flex");
		expect(screen.getByRole("button", { name: "打开侧栏" })).toHaveClass(
			"lg:hidden",
		);
		expect(screen.getByTestId("sidebar-footer")).not.toHaveTextContent(
			"收起侧栏",
		);

		fireEvent.click(toggle);
		expect(
			within(mainHeader).getByRole("button", { name: "展开侧栏" }),
		).toBeVisible();
	});

	it("uses matching icon button sizing for notification/theme/logout actions", () => {
		renderShell("/dashboard");

		for (const name of ["任务通知", "切换主题", "退出登录"]) {
			expect(screen.getByRole("button", { name })).toHaveClass(
				"size-10",
				"rounded-lg",
			);
		}
	});

	it("keeps the notification layer above the scrolling main content", () => {
		renderShell("/dashboard");

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
