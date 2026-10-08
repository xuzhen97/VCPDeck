import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PiChatInput, type PiChatAttachmentDraft } from "./pi-chat-input.js";

function renderInput(
	overrides: Partial<Parameters<typeof PiChatInput>[0]> = {},
) {
	return render(
		<PiChatInput
			status="idle"
			disabled={false}
			onSend={vi.fn()}
			onSteer={vi.fn()}
			onFollowUp={vi.fn()}
			onAbort={vi.fn()}
			onCompact={vi.fn()}
			onAbortCompact={vi.fn()}
			onPickFiles={vi.fn()}
			{...overrides}
		/>,
	);
}

const png = (name = "shot.png") =>
	new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });

/** 构造 dataTransfer 风格的剪贴板载荷（jsdom 不提供 ClipboardEvent 的 dataTransfer）。 */
function clipboardWith(files: File[], text = "") {
	return {
		items: files.map((file) => ({
			kind: "file",
			type: file.type,
			getAsFile: () => file,
		})),
		files,
		getData: () => text,
	};
}

const draft = (
	overrides: Partial<PiChatAttachmentDraft> = {},
): PiChatAttachmentDraft => ({
	id: "d1",
	name: "shot.png",
	status: "ready",
	...overrides,
});

describe("PiChatInput", () => {
	it("Observer 禁用正文并隐藏所有运行和附件 mutation", () => {
		const onAbort = vi.fn();
		renderInput({ status: "running", disabled: true, onAbort });
		expect(screen.getByRole("textbox", { name: "Pi 输入" })).toBeDisabled();
		expect(screen.queryByRole("button", { name: "Steer" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Follow-up" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Compact" })).toBeNull();
		expect(screen.queryByRole("button", { name: "中止" })).toBeNull();
		expect(screen.queryByTitle("添加图片")).toBeNull();

		fireEvent.keyDown(window, { key: "Escape" });
		expect(onAbort).not.toHaveBeenCalled();
	});
	it.each([
		"error",
		"running",
		"waiting_input",
	] as const)("%s 禁止普通 Prompt", (status) => {
		renderInput({ status });
		expect(screen.getByRole("textbox", { name: "Pi 输入" })).toBeDisabled();
	});
	it.each(["idle", "done"] as const)("%s 允许普通 Prompt", (status) => {
		renderInput({ status });
		expect(screen.getByRole("textbox", { name: "Pi 输入" })).toBeEnabled();
	});

	it("一体化 composer：正文与操作行同属一块容器，图标按钮保留可访问名称", () => {
		renderInput();

		expect(screen.getByTestId("pi-chat-composer")).toHaveClass("pt-2");
		const attach = screen.getByTitle("添加图片");
		expect(attach).toHaveClass("h-9", "w-9");
		expect(screen.getByRole("textbox", { name: "Pi 输入" })).toHaveAttribute(
			"rows",
			"1",
		);
		const send = screen.getByRole("button", { name: "发送" });
		expect(send).toHaveClass("h-9", "w-9", "rounded-full");
	});

	it("参数控件经操作行注入，不再占用输入框上方独立设置栏", () => {
		renderInput({
			settingsSlot: <select aria-label="会话模型" defaultValue="m1"><option value="m1">m1</option></select>,
		});
		expect(screen.getByLabelText("会话模型")).toBeTruthy();
	});

	it("粘贴图片走与选图相同的上传入口，并阻止默认粘贴", () => {
		const onPickFiles = vi.fn();
		renderInput({ onPickFiles });
		const textarea = screen.getByRole("textbox", { name: "Pi 输入" });
		const image = png();

		const event = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "clipboardData", {
			value: clipboardWith([image]),
		});
		textarea.dispatchEvent(event);

		expect(onPickFiles).toHaveBeenCalledTimes(1);
		expect(onPickFiles.mock.calls[0]?.[0]).toEqual([image]);
		expect(event.defaultPrevented).toBe(true);
	});

	it("粘贴纯文本不抢事件，也不触发上传", () => {
		const onPickFiles = vi.fn();
		renderInput({ onPickFiles });
		const textarea = screen.getByRole("textbox", { name: "Pi 输入" });

		const event = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "clipboardData", {
			value: clipboardWith([], "hello"),
		});
		textarea.dispatchEvent(event);

		expect(onPickFiles).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	it("非图片文件不被当作粘贴图片处理", () => {
		const onPickFiles = vi.fn();
		renderInput({ onPickFiles });
		const textarea = screen.getByRole("textbox", { name: "Pi 输入" });
		const txt = new File(["x"], "note.txt", { type: "text/plain" });

		const event = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "clipboardData", {
			value: clipboardWith([txt]),
		});
		textarea.dispatchEvent(event);

		expect(onPickFiles).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	it.each([
		["Observer", { disabled: true }],
		["运行中", { status: "running" as const }],
	])("%s 时不处理粘贴图片", (_name, overrides) => {
		const onPickFiles = vi.fn();
		renderInput({ onPickFiles, ...overrides });
		const textarea = screen.getByRole("textbox", { name: "Pi 输入" });

		const event = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "clipboardData", {
			value: clipboardWith([png()]),
		});
		textarea.dispatchEvent(event);

		expect(onPickFiles).not.toHaveBeenCalled();
	});

	it("纯图片（无文字）可以发送空提示词", () => {
		const onSend = vi.fn();
		renderInput({ onSend, attachments: [draft()] });

		const send = screen.getByRole("button", { name: "发送" });
		expect(send).toBeEnabled();
		fireEvent.click(send);

		expect(onSend).toHaveBeenCalledWith("");
	});

	it("无文字且无有效图片时不能发送", () => {
		const onSend = vi.fn();
		renderInput({ onSend });
		expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();

		renderInput({ onSend, attachments: [draft({ status: "error" })] });
		expect(screen.getAllByRole("button", { name: "发送" })[1]).toBeDisabled();
		expect(onSend).not.toHaveBeenCalled();
	});

	it("上传中或失败的图片阻止发送并给出提示", () => {
		renderInput({ attachments: [draft({ status: "uploading" })] });
		expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
		expect(screen.getByRole("status")).toHaveTextContent("上传中");

		renderInput({ attachments: [draft({ status: "error" })] });
		expect(screen.getAllByRole("button", { name: "发送" })[1]).toBeDisabled();
		expect(screen.getAllByRole("status")[1]).toHaveTextContent("上传失败");
	});

	it("请求未完成时不重复提交", () => {
		renderInput({ attachments: [draft()], sendPending: true });
		expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
	});

	it("移除附件按稳定 id 定位，同名文件不串位", () => {
		const onRemoveAttachment = vi.fn();
		renderInput({
			onRemoveAttachment,
			attachments: [
				draft({ id: "a", name: "same.png" }),
				draft({ id: "b", name: "same.png" }),
			],
		});

		const removeButtons = screen.getAllByRole("button", { name: /移除附件/ });
		expect(removeButtons).toHaveLength(2);
		fireEvent.click(removeButtons[1]!);

		expect(onRemoveAttachment).toHaveBeenCalledWith("b");
	});

	it("发送被拒绝时保留草稿，被接受后才清空", async () => {
		const rejected = vi.fn(async () => false);
		renderInput({ onSend: rejected });
		const textarea = screen.getByRole("textbox", { name: "Pi 输入" });
		fireEvent.change(textarea, { target: { value: "retry me" } });
		fireEvent.click(screen.getByRole("button", { name: "发送" }));

		await vi.waitFor(() => expect(rejected).toHaveBeenCalledWith("retry me"));
		expect(textarea).toHaveValue("retry me");
	});

	it("发送被接受后清空草稿文本", async () => {
		const accepted = vi.fn(async () => true);
		renderInput({ onSend: accepted });
		const textarea = screen.getByRole("textbox", { name: "Pi 输入" });
		fireEvent.change(textarea, { target: { value: "send me" } });
		fireEvent.click(screen.getByRole("button", { name: "发送" }));

		await vi.waitFor(() => expect(accepted).toHaveBeenCalledWith("send me"));
		await vi.waitFor(() => expect(textarea).toHaveValue(""));
	});

	it("已完成的图片显示预览缩略图", () => {
		renderInput({
			attachments: [draft({ previewUrl: "blob:preview-1" })],
		});
		expect(
			screen.getByRole("img", { name: "附件预览 shot.png" }),
		).toHaveAttribute("src", "blob:preview-1");
	});

	describe("扩展斜杠命令", () => {
		const commands = [
			{ name: "review", description: "审查当前改动" },
			{ name: "test", description: "运行测试" },
		];

		it("输入 / 列出已注册命令及描述", async () => {
			const user = userEvent.setup();
			renderInput({ commands, onCommand: vi.fn() });

			await user.type(screen.getByRole("textbox", { name: "Pi 输入" }), "/");

			expect(screen.getByRole("option", { name: /review/ })).toBeInTheDocument();
			expect(screen.getByText("审查当前改动")).toBeInTheDocument();
		});

		it("选择命令后填入 /name 且不发送", async () => {
			const user = userEvent.setup();
			const onCommand = vi.fn();
			const onSend = vi.fn();
			renderInput({ commands, onCommand, onSend });

			const box = screen.getByRole("textbox", { name: "Pi 输入" });
			await user.type(box, "/");
			await user.click(screen.getByRole("option", { name: /review/ }));

			expect(box).toHaveValue("/review ");
			expect(onCommand).not.toHaveBeenCalled();
			expect(onSend).not.toHaveBeenCalled();
		});

		it("提交已注册命令走 command，绝不当作 Prompt 发出", async () => {
			const user = userEvent.setup();
			const onCommand = vi.fn(async () => true);
			const onSend = vi.fn();
			renderInput({ commands, onCommand, onSend });

			const box = screen.getByRole("textbox", { name: "Pi 输入" });
			await user.type(box, "/review src/pi");
			await user.click(screen.getByRole("button", { name: "发送" }));

			expect(onCommand).toHaveBeenCalledWith("review", "src/pi");
			expect(onSend).not.toHaveBeenCalled();
			expect(box).toHaveValue("");
		});

		it("无可用命令时敲 / 给出提示，而不是静默无反应", async () => {
			// 唯一的受信扩展可以只做工具门控而不注册任何命令，
			// 此时打 `/` 必须有可见反馈，否则用户以为界面坏了。
			const user = userEvent.setup();
			renderInput({ commands: [], onCommand: vi.fn() });

			await user.type(screen.getByRole("textbox", { name: "Pi 输入" }), "/");

			expect(
				await screen.findByText(/没有可用的扩展命令/),
			).toBeInTheDocument();
		});

		it("未知 slash 保留草稿并提示，不调用 Prompt", async () => {
			const user = userEvent.setup();
			const onCommand = vi.fn();
			const onSend = vi.fn();
			renderInput({ commands, onCommand, onSend });

			const box = screen.getByRole("textbox", { name: "Pi 输入" });
			await user.type(box, "/unknown");
			await user.click(screen.getByRole("button", { name: "发送" }));

			expect(onCommand).not.toHaveBeenCalled();
			expect(onSend).not.toHaveBeenCalled();
			// 草稿必须保留：用户不该丢输入。
			expect(box).toHaveValue("/unknown");
			expect(await screen.findByText(/未知扩展命令/)).toBeInTheDocument();
		});

		it("命令被拒绝时保留草稿", async () => {
			const user = userEvent.setup();
			const onCommand = vi.fn(async () => false);
			renderInput({ commands, onCommand });

			const box = screen.getByRole("textbox", { name: "Pi 输入" });
			await user.type(box, "/review");
			await user.click(screen.getByRole("button", { name: "发送" }));

			expect(box).toHaveValue("/review");
		});

		it("运行中（steer/followUp）不提供命令选择", async () => {
			const user = userEvent.setup();
			const onCommand = vi.fn();
			renderInput({ status: "running", commands, onCommand });

			await user.click(screen.getByRole("button", { name: "Steer" }));
			const box = screen.getByRole("textbox", { name: "Pi 输入" });
			await user.type(box, "/review");

			expect(screen.queryByRole("option", { name: /review/ })).toBeNull();
		});

		it("命令不允许带附件：阻止发送且附件不丢失", async () => {
			const user = userEvent.setup();
			const onCommand = vi.fn();
			const onSend = vi.fn();
			renderInput({
				commands,
				onCommand,
				onSend,
				attachments: [draft()],
			});

			const box = screen.getByRole("textbox", { name: "Pi 输入" });
			await user.type(box, "/review");
			await user.click(screen.getByRole("button", { name: "发送" }));

			expect(await screen.findByText(/命令不支持附件/)).toBeInTheDocument();
			expect(onCommand).not.toHaveBeenCalled();
			expect(onSend).not.toHaveBeenCalled();
			// 附件仍在，未被静默丢弃（渲染 chip 本体即可证明）。
			expect(screen.getByTestId("pi-attachment-chip")).toBeInTheDocument();
			expect(screen.getByText("shot.png")).toBeInTheDocument();
		});

		it("非斜杠文本不受影响，仍走 Prompt", async () => {
			const user = userEvent.setup();
			const onCommand = vi.fn();
			const onSend = vi.fn(async () => true);
			renderInput({ commands, onCommand, onSend });

			const box = screen.getByRole("textbox", { name: "Pi 输入" });
			await user.type(box, "普通消息");
			await user.click(screen.getByRole("button", { name: "发送" }));

			expect(onSend).toHaveBeenCalledWith("普通消息");
			expect(onCommand).not.toHaveBeenCalled();
		});
	});

	describe("扩展编辑填充", () => {
		it("非空草稿收到填充时不自动覆写，等待用户应用", async () => {
			const user = userEvent.setup();
			const onApplyEditorRequest = vi.fn();
			renderInput({
				editorRequest: { requestId: "r1", text: "扩展建议" },
				onApplyEditorRequest,
				onDismissEditorRequest: vi.fn(),
			});

			const box = screen.getByRole("textbox", { name: "Pi 输入" });
			await user.type(box, "用户草稿");

			// 提示已出现，且草稿未被覆写。
			expect(await screen.findByText(/扩展建议/)).toBeInTheDocument();
			expect(box).toHaveValue("用户草稿");
			expect(onApplyEditorRequest).not.toHaveBeenCalled();
		});

		it("用户可显式应用填充", async () => {
			const user = userEvent.setup();
			const onApplyEditorRequest = vi.fn();
			renderInput({
				editorRequest: { requestId: "r1", text: "扩展建议" },
				onApplyEditorRequest,
				onDismissEditorRequest: vi.fn(),
			});

			await user.click(screen.getByRole("button", { name: "应用扩展填充" }));

			expect(onApplyEditorRequest).toHaveBeenCalledWith("r1", "扩展建议");
		});

		it("用户可忽略填充，草稿与请求都不变", async () => {
			const user = userEvent.setup();
			const onApplyEditorRequest = vi.fn();
			const onDismissEditorRequest = vi.fn();
			renderInput({
				editorRequest: { requestId: "r1", text: "扩展建议" },
				onApplyEditorRequest,
				onDismissEditorRequest,
			});

			await user.click(screen.getByRole("button", { name: "忽略扩展填充" }));

			expect(onDismissEditorRequest).toHaveBeenCalledWith("r1");
			expect(onApplyEditorRequest).not.toHaveBeenCalled();
		});

		it("填充内容作为纯文本展示，不解析 HTML", async () => {
			renderInput({
				editorRequest: {
					requestId: "r1",
					text: "<img src=x onerror=alert(1)>",
				},
				onApplyEditorRequest: vi.fn(),
				onDismissEditorRequest: vi.fn(),
			});
			expect(
				screen.getByText("<img src=x onerror=alert(1)>"),
			).toBeInTheDocument();
			expect(document.querySelector("img")).toBeNull();
		});
	});

	describe("运行错误态", () => {
		it("属主在输入框上方直接看到「标记完成」，不必去开右栏抽屉", () => {
			renderInput({ status: "error", onComplete: vi.fn() });
			expect(screen.getByRole("alert").textContent).toContain(
				"标记完成后可继续提问",
			);
			expect(screen.getByRole("button", { name: "标记完成" })).toBeTruthy();
		});

		it("点击「标记完成」触发收尾回调", async () => {
			const onComplete = vi.fn();
			renderInput({ status: "error", onComplete });
			await userEvent.click(screen.getByRole("button", { name: "标记完成" }));
			expect(onComplete).toHaveBeenCalledTimes(1);
		});

		it("非属主（未提供回调）不渲染入口", () => {
			renderInput({ status: "error" });
			expect(screen.queryByRole("button", { name: "标记完成" })).toBeNull();
		});

		it("错误态下输入框仍禁用，占位文案指向该入口", () => {
			renderInput({ status: "error", onComplete: vi.fn() });
			const box = screen.getByLabelText("Pi 输入") as HTMLTextAreaElement;
			expect(box.disabled).toBe(true);
			expect(box.placeholder).toBe("运行错误，请先点上方「标记完成」");
		});

		it("非错误态不渲染该入口", () => {
			renderInput({ status: "idle", onComplete: vi.fn() });
			expect(screen.queryByRole("button", { name: "标记完成" })).toBeNull();
		});
	});
});
