import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { TerminalView, type ResizeObserverLike, type XtermAdapter } from "./terminal-view.js";
import { createRef } from "react";

function makeAdapter() {
	const writes: string[] = [];
	const resets: number[] = [];
	const dataCbs: Array<(d: string) => void> = [];
	const adapter: XtermAdapter = {
		open: vi.fn(),
		write: (d) => writes.push(d),
		reset: () => resets.push(1),
		dispose: vi.fn(),
		onData: (cb) => dataCbs.push(cb),
		fit: vi.fn(() => ({ cols: 100, rows: 40 })),
	};
	return { adapter, writes, resets, dataCbs };
}

function makeObserver() {
	const cbs: Array<() => void> = [];
	const observer: ResizeObserverLike = {
		observe: (_el, cb) => cbs.push(cb),
		disconnect: vi.fn(),
	};
	return { observer, cbs };
}

describe("TerminalView", () => {
	it("挂载时创建 adapter 并 open；卸载时 dispose", () => {
		const { adapter } = makeAdapter();
		const { unmount } = render(
			<TerminalView
				onData={() => undefined}
				onResize={() => undefined}
				adapterFactory={() => adapter}
				resizeObserverFactory={() => makeObserver().observer}
			/>,
		);
		expect(screen.getByTestId("terminal-view")).toBeTruthy();
		expect(adapter.open).toHaveBeenCalledTimes(1);
		unmount();
		expect(adapter.dispose).toHaveBeenCalledTimes(1);
	});

	it("operator 模式绑定 onData；readOnly 模式不绑定", () => {
		const { adapter, dataCbs } = makeAdapter();
		const onData = vi.fn();
		render(
			<TerminalView
				onData={onData}
				onResize={() => undefined}
				adapterFactory={() => adapter}
				resizeObserverFactory={() => makeObserver().observer}
			/>,
		);
		act(() => {
			dataCbs[0]?.("ls\r");
		});
		expect(onData).toHaveBeenCalledWith("ls\r");
		const { adapter: adapter2, dataCbs: cbs2 } = makeAdapter();
		render(
			<TerminalView
				onData={() => undefined}
				onResize={() => undefined}
				readOnly
				adapterFactory={() => adapter2}
				resizeObserverFactory={() => makeObserver().observer}
			/>,
		);
		expect(cbs2).toHaveLength(0);
	});

	it("resize 观察器 50ms 合并：连续触发只回调一次 fit 尺寸", async () => {
		const { adapter } = makeAdapter();
		const { cbs } = makeObserver();
		const onResize = vi.fn();
		render(
			<TerminalView
				onData={() => undefined}
				onResize={onResize}
				adapterFactory={() => adapter}
				resizeObserverFactory={() => ({ observe: (_el, cb) => cbs.push(cb), disconnect: vi.fn() })}
			/>,
		);
		act(() => {
			cbs[0]?.();
			cbs[0]?.();
			cbs[0]?.();
		});
		expect(onResize).not.toHaveBeenCalled();
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(onResize).toHaveBeenCalledTimes(1);
		expect(onResize).toHaveBeenCalledWith(100, 40);
	});

	it("forwardRef 暴露 write/reset", () => {
		const { adapter, writes, resets } = makeAdapter();
		const ref = createRef<{ write: (d: string) => void; reset: () => void; fit: () => { cols: number; rows: number } | null }>();
		render(
			<TerminalView
				ref={ref}
				onData={() => undefined}
				onResize={() => undefined}
				adapterFactory={() => adapter}
				resizeObserverFactory={() => makeObserver().observer}
			/>,
		);
		act(() => {
			ref.current?.write("hello");
			ref.current?.reset();
		});
		expect(writes).toEqual(["hello"]);
		expect(resets).toHaveLength(1);
	});
});
