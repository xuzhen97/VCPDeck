import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiRenderBoundary } from "./pi-render-boundary";

describe("PiRenderBoundary（渲染降级护栏）", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("子树渲染抛错时回落 fallback，不向上冒泡", () => {
		const Bomb = (): never => {
			throw new Error("render boom");
		};
		render(
			<PiRenderBoundary fallback={<span>降级文本</span>}>
				<Bomb />
			</PiRenderBoundary>,
		);
		expect(screen.getByText("降级文本")).toBeDefined();
	});

	it("子树正常渲染时不动内容", () => {
		render(
			<PiRenderBoundary fallback={<span>降级文本</span>}>
				<span>正常内容</span>
			</PiRenderBoundary>,
		);
		expect(screen.getByText("正常内容")).toBeDefined();
	});
});
