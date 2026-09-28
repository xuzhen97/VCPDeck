import { fireEvent, render, screen } from "@testing-library/react";
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
});
