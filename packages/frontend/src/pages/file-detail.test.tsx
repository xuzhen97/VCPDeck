import type { VcpDeckClient } from "@vcpdeck/sdk";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { FileDetail } from "./file-detail";

describe("FileDetail", () => {
	it("导出使用稳定下载地址", async () => {
		const click = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(() => {});
		const downloadUrl = vi
			.fn()
			.mockReturnValue("/api/storage/download-redirect/aliyun-file");
		const client = {
			files: {
				readText: vi.fn().mockResolvedValue({ content: "hello", size: 5 }),
				export: vi.fn().mockResolvedValue({ key: "aliyun-file" }),
				writeText: vi.fn(),
			},
			storage: { downloadUrl },
		} as unknown as VcpDeckClient;

		render(
			<SdkProvider client={client}>
				<FileDetail
					clientId="c1"
					rootDir="D:\\"
					path="."
					entry={{
						name: "a.txt",
						kind: "file",
						size: 5,
						mtime: "2026-08-05T00:00:00.000Z",
					}}
					onDelete={vi.fn()}
					onMove={vi.fn()}
					onChanged={vi.fn()}
				/>
			</SdkProvider>,
		);

		await userEvent.click(await screen.findByRole("button", { name: "导出下载" }));
		await waitFor(() => expect(click).toHaveBeenCalledOnce());
		expect(downloadUrl).toHaveBeenCalledWith("aliyun-file");
	});
});
