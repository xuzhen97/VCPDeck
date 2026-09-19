import { describe, expect, it } from "vitest";
import { cropLayout, isFullRect, normalizedAspect, rectForPreset } from "./screen-view.js";

describe("rectForPreset", () => {
	it("全部 / 左半 / 右半（默认平分）", () => {
		expect(rectForPreset("all")).toEqual({ x: 0, y: 0, w: 1, h: 1 });
		expect(rectForPreset("left")).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
		expect(rectForPreset("right")).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
	});

	it("自定义分割比例，并被夹到 (0,1) 内", () => {
		expect(rectForPreset("left", 0.3)).toEqual({ x: 0, y: 0, w: 0.3, h: 1 });
		expect(rectForPreset("right", 0.3)).toEqual({ x: 0.3, y: 0, w: 0.7, h: 1 });
		expect(rectForPreset("left", 0).w).toBeGreaterThan(0);
		expect(rectForPreset("left", 1).w).toBeLessThan(1);
		expect(rectForPreset("left", Number.NaN).w).toBe(0.5);
		// 右半宽度恒等于 1 - 分割点
		const s = rectForPreset("left", 0.25).w;
		expect(rectForPreset("right", 0.25)).toEqual({ x: s, y: 0, w: 1 - s, h: 1 });
	});
});

describe("isFullRect", () => {
	it("只对整块画面为真", () => {
		expect(isFullRect({ x: 0, y: 0, w: 1, h: 1 })).toBe(true);
		expect(isFullRect({ x: 0, y: 0, w: 0.5, h: 1 })).toBe(false);
		expect(isFullRect({ x: 0.1, y: 0, w: 1, h: 1 })).toBe(false);
	});
});

describe("normalizedAspect", () => {
	it("给出不依赖真实帧尺寸的归一化比例串", () => {
		expect(normalizedAspect({ x: 0, y: 0, w: 1, h: 1 })).toBe("100 / 100");
		expect(normalizedAspect({ x: 0, y: 0, w: 0.5, h: 1 })).toBe("50 / 100");
	});
});

describe("cropLayout", () => {
	it("按真实帧尺寸给出被裁区域的宽高比，并放大 + 反向平移 inner", () => {
		// 3960x1920 虚拟桌面取右半 → 1980x1920
		const layout = cropLayout({ x: 0.5, y: 0, w: 0.5, h: 1 }, 3960, 1920);
		expect(layout.aspectRatio).toBe("1980 / 1920");
		expect(layout.inner.position).toBe("absolute");
		expect(layout.inner.top).toBe(0);
		expect(layout.inner.left).toBe(0);
		expect(layout.inner.width).toBe("200%"); // 100 / 0.5
		expect(layout.inner.height).toBe("100%"); // 100 / 1
		expect(layout.inner.transform).toBe("translate(-100%, 0%)"); // -x/w, -y/h
	});

	it("整块画面退化为无缩放无平移", () => {
		const layout = cropLayout({ x: 0, y: 0, w: 1, h: 1 }, 1920, 1080);
		expect(layout.aspectRatio).toBe("1920 / 1080");
		expect(layout.inner.width).toBe("100%");
		expect(layout.inner.height).toBe("100%");
		expect(layout.inner.transform).toBe("translate(0%, 0%)");
	});

	it("非平分裁剪的百分比可复现", () => {
		const layout = cropLayout({ x: 0.25, y: 0.5, w: 0.25, h: 0.5 }, 1600, 1200);
		expect(layout.aspectRatio).toBe("400 / 600");
		expect(layout.inner.width).toBe("400%");
		expect(layout.inner.height).toBe("200%");
		expect(layout.inner.transform).toBe("translate(-100%, -100%)");
	});
});
