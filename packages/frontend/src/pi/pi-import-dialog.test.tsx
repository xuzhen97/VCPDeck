import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PiApi } from "@vcpdeck/sdk";
import { PiImportDialog } from "./pi-import-dialog.js";

const okSession = {
	sourceName: "ok_a.jsonl",
	sourceLabel: "dir/ok_a.jsonl",
	startedAt: "2026-09-01T00:00:01.000Z",
	entryCount: 2,
	cwd: "/proj/a",
	imported: false,
	cwdNotAllowed: false,
	unreadable: false,
};
const importedSession = {
	...okSession,
	sourceName: "imported_b.jsonl",
	sourceLabel: "imported_b.jsonl",
	imported: true,
};
const foreignSession = {
	...okSession,
	sourceName: "foreign_c.jsonl",
	sourceLabel: "foreign_c.jsonl",
	cwdNotAllowed: true,
	cwd: "/elsewhere/secret",
};
const brokenSession = {
	...okSession,
	sourceName: "broken_d.jsonl",
	sourceLabel: "broken_d.jsonl",
	entryCount: 0,
	cwd: null,
	cwdNotAllowed: true,
	unreadable: true,
};

function makePi(sessions: Array<Record<string, unknown>> = [okSession, importedSession, foreignSession, brokenSession]) {
	return {
		sessions: {
			importable: vi.fn(async () => ({
				sourceRoot: "/home/u/.pi/agent/sessions",
				sessions,
			})),
			previewImportable: vi.fn(async () => ({
				sourceName: "ok_a.jsonl",
				previewText: "用户原生 Pi 的历史问题",
				truncated: false,
			})),
			import: vi.fn(async () => ({
				results: [
					{ sourceName: "ok_a.jsonl", status: "imported" },
					{ sourceName: "imported_b.jsonl", status: "alreadyImported" },
					{
						sourceName: "foreign_c.jsonl",
						status: "rejected",
						reasonCode: "PI_PROJECT_NOT_ALLOWED",
					},
				],
			})),
		},
	} as unknown as Pick<PiApi, "sessions">;
}

function renderDialog(pi: Pick<PiApi, "sessions">) {
	return render(
		<PiImportDialog pi={pi} clientId="c1" open onOpenChange={vi.fn()} />,
	);
}

describe("PiImportDialog（旧会话显式导入抽屉）", () => {
	it("预览前必须显示隐私提示；确认后才发预览请求", async () => {
		const user = userEvent.setup();
		const pi = makePi();
		renderDialog(pi);

		const previewButtons = await screen.findAllByRole("button", { name: "预览" });
		await user.click(previewButtons[0]!);

		expect(screen.getByText("预览会读取该会话正文")).toBeInTheDocument();
		expect(pi.sessions.previewImportable).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "确认预览" }));

		expect(pi.sessions.previewImportable).toHaveBeenCalledTimes(1);
		expect(pi.sessions.previewImportable).toHaveBeenCalledWith(
			"c1",
			"ok_a.jsonl",
		);
		expect(
			await screen.findByText(/用户原生 Pi 的历史问题/),
		).toBeInTheDocument();
	});

	it("cwd 越根与无法读取的条目禁用勾选并显示原因；已导入仍可勾选", async () => {
		renderDialog(makePi());
		const boxes = (await screen.findAllByRole("checkbox")) as HTMLInputElement[];
		expect(boxes).toHaveLength(4);
		expect(boxes.filter((box) => box.disabled)).toHaveLength(2); // 仅后两类禁用
		expect(screen.getAllByText("cwd 不在允许根")).toHaveLength(1);
		expect(screen.getByText("无法读取")).toBeInTheDocument();
		expect(screen.getByText("已导入")).toBeInTheDocument();
	});

	it("导入前二次确认列出文件名与目标项目", async () => {
		const user = userEvent.setup();
		const pi = makePi();
		renderDialog(pi);

		await user.click(await screen.findByRole("checkbox", { name: "dir/ok_a.jsonl" }));
		await user.click(screen.getByRole("button", { name: /^导入（1）$/ }));

		expect(screen.getByTestId("pi-import-confirm")).toHaveTextContent(
			"将导入 1 个会话到项目 /proj/a",
		);
		expect(screen.getByTestId("pi-import-confirm")).toHaveTextContent("ok_a.jsonl");
		expect(pi.sessions.import).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "确认导入" }));

		expect(pi.sessions.import).toHaveBeenCalledWith("c1", ["ok_a.jsonl"]);
	});

	it("逐条结果展示三种状态与拒绝原因", async () => {
		const user = userEvent.setup();
		const three = [okSession, importedSession, foreignSession];
		const pi = makePi(three);
		renderDialog(pi);

		for (const box of (await screen.findAllByRole("checkbox")) as HTMLInputElement[]) {
			if (!box.disabled) await user.click(box);
		}
		await user.click(screen.getByRole("button", { name: /^导入（2）$/ }));
		await user.click(screen.getByRole("button", { name: "确认导入" }));

		const results = await screen.findByTestId("pi-import-results");
		expect(results).toHaveTextContent("已导入到副本");
		expect(results).toHaveTextContent("此前已导入");
		expect(results).toHaveTextContent("拒绝：cwd 不在允许根");
	});

	it("服务端错误直显（不被吞成通用文案）", async () => {
		const user = userEvent.setup();
		const pi = makePi();
		(
			pi.sessions.importable as ReturnType<typeof vi.fn>
		).mockRejectedValueOnce(
			Object.assign(new Error("Pi 配置不可用或尚未就绪"), {
				code: "PI_CONFIG_UNAVAILABLE",
			}),
		);
		renderDialog(pi);

		expect(await screen.findByTestId("pi-import-error")).toHaveTextContent(
			"Pi 配置不可用或尚未就绪",
		);
		void user;
	});
});
