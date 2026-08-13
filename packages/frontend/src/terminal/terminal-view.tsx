import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

/** xterm 适配器（测试可注入 fake）。 */
export interface XtermAdapter {
	open(container: HTMLElement): void;
	write(data: string): void;
	reset(): void;
	dispose(): void;
	onData(cb: (data: string) => void): void;
	/** 返回适配后尺寸；容器不可见时返回 null。 */
	fit(): { cols: number; rows: number } | null;
}

/** 真实 xterm 适配器。 */
export function createXtermAdapter(): XtermAdapter {
	let terminal: Terminal | null = null;
	let fitAddon: FitAddon | null = null;
	return {
		open(container) {
			if (terminal) return;
			terminal = new Terminal({
				fontFamily:
					'"Cascadia Code", "JetBrains Mono", "Sarasa Mono SC", Consolas, "Courier New", monospace',
				fontSize: 14,
				cursorBlink: true,
				scrollback: 2000,
			});
			fitAddon = new FitAddon();
			terminal.loadAddon(fitAddon);
			terminal.open(container);
			try {
				fitAddon.fit();
			} catch {
				/* 容器不可见时忽略 */
			}
		},
		write(data) {
			terminal?.write(data);
		},
		reset() {
			terminal?.reset();
		},
		dispose() {
			terminal?.dispose();
			terminal = null;
			fitAddon = null;
		},
		onData(cb) {
			terminal?.onData(cb);
		},
		fit() {
			if (!terminal || !fitAddon) return null;
			try {
				fitAddon.fit();
				return { cols: terminal.cols, rows: terminal.rows };
			} catch {
				return null;
			}
		},
	};
}

/** 容器尺寸观察器（测试注入）。 */
export interface ResizeObserverLike {
	observe(el: HTMLElement, cb: () => void): void;
	disconnect(): void;
}

/** 终端视图组件：xterm + 自动 fit + 合并 resize。 */
export interface TerminalViewHandle {
	write(data: string): void;
	reset(): void;
}

export interface TerminalViewProps {
	onData: (data: string) => void;
	onResize: (cols: number, rows: number) => void;
	readOnly?: boolean;
	/** 视图就绪（可写入）回调。 */
	onReady?: () => void;
	adapterFactory?: () => XtermAdapter;
	resizeObserverFactory?: () => ResizeObserverLike;
}

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(function TerminalView(
	{ onData, onResize, readOnly = false, onReady, adapterFactory = createXtermAdapter, resizeObserverFactory },
	ref,
) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const adapterRef = useRef<XtermAdapter | null>(null);
	const onDataRef = useRef(onData);
	const onResizeRef = useRef(onResize);
	onDataRef.current = onData;
	onResizeRef.current = onResize;

	useImperativeHandle(
		ref,
		() => ({
			write: (data: string) => adapterRef.current?.write(data),
			reset: () => adapterRef.current?.reset(),
		}),
		[],
	);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const adapter = adapterFactory();
		adapterRef.current = adapter;
		adapter.open(container);
		onReady?.();
		if (!readOnly) {
			adapter.onData((data) => onDataRef.current(data));
		}
		// 50ms 合并 resize
		let debounce: ReturnType<typeof setTimeout> | null = null;
		let observer: ResizeObserverLike | null = null;
		const doFit = () => {
			debounce = null;
			const size = adapter.fit();
			if (size) onResizeRef.current(size.cols, size.rows);
		};
		if (resizeObserverFactory) {
			observer = resizeObserverFactory();
			observer.observe(container, () => {
				if (debounce) clearTimeout(debounce);
				debounce = setTimeout(doFit, 50);
			});
		} else if (typeof ResizeObserver !== "undefined") {
			let realObserver: ResizeObserver | null = null;
			observer = {
				observe: (el, cb) => {
					realObserver = new ResizeObserver(() => cb());
					realObserver.observe(el);
				},
				disconnect: () => realObserver?.disconnect(),
			};
			observer.observe(container, () => {
				if (debounce) clearTimeout(debounce);
				debounce = setTimeout(doFit, 50);
			});
		}
		return () => {
			if (debounce) clearTimeout(debounce);
			observer?.disconnect();
			adapter.dispose();
			adapterRef.current = null;
		};
	}, [adapterFactory, readOnly, resizeObserverFactory]);

	return (
		<div
			data-testid="terminal-view"
			ref={containerRef}
			className="h-full w-full overflow-hidden bg-black p-2"
		/>
	);
});
