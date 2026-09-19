import { describe, expect, it } from "vitest";
import { BLACK_STREAK_LIMIT, createBlackStreak, isNearlyBlack } from "./black-screen.js";

/** 由灰度值数组构造 rgba 像素缓冲（每值 4 字节）。 */
function px(values: number[]): Uint8ClampedArray {
	return new Uint8ClampedArray(values.flatMap((v) => [v, v, v, 255]));
}

describe("isNearlyBlack", () => {
	it("全黑与近黑判为 true", () => {
		expect(isNearlyBlack(px([0, 0, 0, 0, 5, 3]))).toBe(true);
	});

	it("有明亮像素判为 false", () => {
		expect(isNearlyBlack(px([200, 200, 200, 255]))).toBe(false);
	});

	it("按亮像素占比阈值判定（默认 1%）", () => {
		const dim = new Array<number>(100).fill(0);
		dim[0] = 200; // 1/100 = 1% → 不算超过阈值
		expect(isNearlyBlack(px(dim))).toBe(true);
		dim[1] = 200; // 2/100 = 2% → 明确非黑
		expect(isNearlyBlack(px(dim))).toBe(false);
	});

	it("阈值可覆盖", () => {
		expect(isNearlyBlack(px([20]), 12)).toBe(false);
		expect(isNearlyBlack(px([20]), 30)).toBe(true);
	});

	it("空缓冲不判为黑（本轮不可判定）", () => {
		expect(isNearlyBlack(new Uint8ClampedArray(0))).toBe(false);
	});
});

describe("createBlackStreak", () => {
	it("默认上限为 5", () => {
		expect(BLACK_STREAK_LIMIT).toBe(5);
	});

	it("连续达到上限才触发，中断即清零", () => {
		const s = createBlackStreak(3);
		expect([s.push(true), s.push(true)]).toEqual([false, false]);
		expect(s.push(false)).toBe(false);
		expect(s.count()).toBe(0);
		expect([s.push(true), s.push(true), s.push(true)]).toEqual([false, false, true]);
	});

	it("reset 清零计数", () => {
		const s = createBlackStreak(3);
		s.push(true);
		s.reset();
		expect(s.count()).toBe(0);
		expect(s.push(true)).toBe(false);
	});
});
