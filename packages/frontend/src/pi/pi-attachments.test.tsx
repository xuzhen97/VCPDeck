import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PiMessageView } from "./pi-message-view.js";
import type { PiImagePlaceholder, PiMessage } from "@vcpdeck/shared";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("PiMessageView 图片附件", () => {
	it("历史图片占位点击后触发加载回调", async () => {
		const onLoad = vi.fn();
		const block: PiImagePlaceholder = {
			type: "image",
			deferred: true,
			mimeType: "image/png",
			entryId: "e1",
			blockIndex: 2,
		};
		const message: PiMessage = {
			id: "m1",
			role: "assistant",
			content: [block, { type: "text", text: "ok" }],
		};
		render(<PiMessageView message={message} onImageLoad={onLoad} />);
		await screen.getByTestId("image-placeholder").click();
		expect(onLoad).toHaveBeenCalledWith(block);
	});

	it("已加载图片显示 <img> 而非占位按钮", () => {
		const message: PiMessage = {
			id: "m1",
			role: "assistant",
			content: [
				{
					type: "image",
					deferred: true,
					mimeType: "image/png",
					entryId: "e1",
					blockIndex: 0,
				} as PiImagePlaceholder,
			],
		};
		const { container } = render(
			<PiMessageView message={message} imageUrls={{ "e1:0": "data:image/png;base64,AAAA" }} />,
		);
		expect(screen.queryByTestId("image-placeholder")).toBeNull();
		expect(container.querySelector("img")).toBeTruthy();
	});
});
