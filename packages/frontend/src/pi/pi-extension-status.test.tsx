import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PiExtensionUiSnapshot } from "@vcpdeck/shared";
import { PiExtensionStatus, stripExtensionText } from "./pi-extension-status.js";

function snapshot(
	overrides: Partial<PiExtensionUiSnapshot> = {},
): PiExtensionUiSnapshot {
	return {
		runtimeInstanceId: "spec-1",
		runtimeRevision: "rev-1",
		sequence: 1,
		title: null,
		statuses: [],
		widgets: [],
		...overrides,
	};
}

describe("stripExtensionText", () => {
	it("剔除 ANSI 控制序列与终端控制字符", () => {
		expect(stripExtensionText("\u001b[31m红色\u001b[0m")).toBe("红色");
		expect(stripExtensionText("\u001b[1;32m粗体\u001b[39m\u001b[0m")).toBe("粗体");
		// 空白是正文，不归 ANSI 剔除范围：不得默默裁剪用户的真实空格。
		expect(stripExtensionText("\u001b[1m粗体\u001b[0m 尾随空格")).toBe("粗体 尾随空格");
		// 光标/擦除类序列不应留下可见残留。
		expect(stripExtensionText("\u001b[2J\u001b[Hclean")).toBe("clean");
		expect(stripExtensionText("a\u0000b\u0007c")).toBe("abc");
	});

	it("保留普通文本与不可见但无害的字符", () => {
		expect(stripExtensionText("正常文本")).toBe("正常文本");
		expect(stripExtensionText("行一\n行二")).toBe("行一\n行二");
		expect(stripExtensionText("<script>alert(1)</script>")).toBe(
			"<script>alert(1)</script>",
		);
	});
});

describe("PiExtensionStatus", () => {
	it("无快照时什么都不渲染", () => {
		const { container } = render(<PiExtensionStatus snapshot={null} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("空快照（有身份但无内容）不渲染任何区块", () => {
		const { container } = render(<PiExtensionStatus snapshot={snapshot()} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("扩展标题是独立小标题，不改浏览器全局标题", () => {
		render(
			<PiExtensionStatus snapshot={snapshot({ title: "构建进度" })} />,
		);
		const heading = screen.getByRole("heading", { name: "构建进度" });
		expect(heading).toBeInTheDocument();
		expect(document.title).toBe("");
	});

	it("status 单独成区并带 key 标签", () => {
		render(
			<PiExtensionStatus
				snapshot={snapshot({
					statuses: [
						{ key: "build", text: "正在编译" },
						{ key: "test", text: "通过" },
					],
				})}
			/>,
		);
		const region = screen.getByRole("region", { name: "扩展状态" });
		expect(region).toBeInTheDocument();
		expect(screen.getByText("正在编译")).toBeInTheDocument();
		expect(screen.getByText("build")).toBeInTheDocument();
		expect(screen.getByText("通过")).toBeInTheDocument();
	});

	it("Widget 按 placement 分区输出并保持行结构", () => {
		render(
			<PiExtensionStatus
				snapshot={snapshot({
					widgets: [
						{ key: "w1", lines: ["第一行", "第二行"], placement: "aboveEditor" },
						{ key: "w2", lines: ["尾行"], placement: "belowEditor" },
					],
				})}
			/>,
		);
		const above = screen.getByRole("region", { name: "扩展内容（编辑区上方）" });
		const below = screen.getByRole("region", { name: "扩展内容（编辑区下方）" });
		expect(above).toBeInTheDocument();
		expect(below).toBeInTheDocument();
		// 行必须保留为多行文本，而不是被 join 压成一行。
		expect(above.textContent).toContain("第一行");
		expect(above.textContent).toContain("第二行");
		expect(screen.getByText("尾行")).toBeInTheDocument();
	});

	it("扩展文本按纯文本展示，不解析 HTML 也不执行脚本", () => {
		const { container } = render(
			<PiExtensionStatus
				snapshot={snapshot({
					statuses: [{ key: "k", text: "<img src=x onerror=alert(1)>" }],
				})}
			/>,
		);
		// 必须是文本节点，绝不成为真实元素。
		expect(container.querySelector("img")).toBeNull();
		expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
	});

	it("扩展文本中的 ANSI 序列被剔除后再展示", () => {
		render(
			<PiExtensionStatus
				snapshot={snapshot({ statuses: [{ key: "k", text: "\u001b[31m错误\u001b[0m" }] })}
			/>,
		);
		expect(screen.getByText("错误")).toBeInTheDocument();
		expect(screen.queryByText(`[31m错误[0m`)).not.toBeInTheDocument();
	});
});