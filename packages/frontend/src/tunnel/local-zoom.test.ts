import { describe, expect, it } from "vitest";
import { nextZoom, zoomContainerStyle, type ZoomLevel } from "./local-zoom.js";

describe("zoomContainerStyle", () => {
	it("fit / actual 由 noVNC 自己控制尺寸，不放大容器", () => {
		expect(zoomContainerStyle("fit")).toBeNull();
		expect(zoomContainerStyle("actual")).toBeNull();
	});

	it("倍率档位按百分比放大容器（绝不返回 transform）", () => {
		expect(zoomContainerStyle(125)).toEqual({ width: "125%", height: "125%" });
		expect(zoomContainerStyle(150)).toEqual({ width: "150%", height: "150%" });
		expect(zoomContainerStyle(200)).toEqual({ width: "200%", height: "200%" });
		for (const level of [125, 150, 175, 200] as ZoomLevel[]) {
			const style = zoomContainerStyle(level);
			expect(style).not.toBeNull();
			expect(Object.keys(style ?? {})).toEqual(["width", "height"]);
		}
	});
});

describe("nextZoom", () => {
	it("从 fit/actual 向上进入倍率阶梯", () => {
		expect(nextZoom("fit", 1)).toBe(125);
		expect(nextZoom("actual", 1)).toBe(125);
	});

	it("在阶梯内上下移动", () => {
		expect(nextZoom(125, 1)).toBe(150);
		expect(nextZoom(150, 1)).toBe(175);
		expect(nextZoom(175, 1)).toBe(200);
	});

	it("在边界处夹紧（不越界、不循环）", () => {
		expect(nextZoom(200, 1)).toBe(200);
		expect(nextZoom(125, -1)).toBe("fit");
		expect(nextZoom("fit", -1)).toBe("fit");
	});
});
