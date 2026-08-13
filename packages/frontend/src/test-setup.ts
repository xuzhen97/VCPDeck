import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom 缺省 API 补丁（xterm/部分组件依赖）
if (typeof window !== "undefined" && !window.matchMedia) {
	window.matchMedia = ((query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: () => undefined,
		removeListener: () => undefined,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		dispatchEvent: () => false,
	})) as unknown as typeof window.matchMedia;
}

if (typeof window !== "undefined" && !window.ResizeObserver) {
	window.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof window.ResizeObserver;
}

// xterm 颜色探测需要 canvas 2d context（jsdom 未实现）
if (typeof HTMLCanvasElement !== "undefined") {
	const stub = () =>
		({
			measureText: () => ({ width: 0 }),
			fillRect: () => undefined,
			clearRect: () => undefined,
			getImageData: () => ({ data: new Uint8ClampedArray(4) }),
			putImageData: () => undefined,
			createLinearGradient: () => ({ addColorStop: () => undefined }),
			createRadialGradient: () => ({ addColorStop: () => undefined }),
			createPattern: () => null,
			save: () => undefined,
			restore: () => undefined,
			beginPath: () => undefined,
			fill: () => undefined,
			stroke: () => undefined,
			arc: () => undefined,
			moveTo: () => undefined,
			lineTo: () => undefined,
			fillText: () => undefined,
			strokeText: () => undefined,
			drawImage: () => undefined,
			setTransform: () => undefined,
			translate: () => undefined,
			scale: () => undefined,
			rotate: () => undefined,
			clip: () => undefined,
			closePath: () => undefined,
			rect: () => undefined,
			quadraticCurveTo: () => undefined,
			bezierCurveTo: () => undefined,
			canvas: null,
		}) as unknown as CanvasRenderingContext2D;
	// jsdom 的 getContext 存在但抛 Not implemented，无条件覆盖
	(HTMLCanvasElement.prototype as { getContext?: unknown }).getContext = stub as never;
}

afterEach(cleanup);
