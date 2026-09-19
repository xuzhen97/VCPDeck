/**
 * 「无活动显示输出」的判定（纯逻辑，不含 DOM）。
 *
 * 目标机真·没有任何活动显示输出时（未接显示器且无虚拟显示器驱动），
 * 任何桌面抓取都只能得到全黑画面 —— 这是 Windows 显示模型的限制，与抓取技术无关。
 * 这里只做**低成本判定**：把画布缩采样到极小尺寸后统计亮像素占比。
 */

/** 连续判定为全黑的帧数上限（2 秒/帧 × 5 ≈ 10 秒）。 */
export const BLACK_STREAK_LIMIT = 5;

/**
 * 亮像素占比低于 `minBrightRatio` 视为"近全黑"。
 *
 * @param rgba 4 字节/像素的 RGBA 缓冲
 * @param blackThreshold 单通道超过该值即视为亮像素
 * @param minBrightRatio 亮像素占比阈值（默认 1%）；**不超过**该比例视为近全黑
 */
export function isNearlyBlack(
	rgba: Uint8ClampedArray,
	blackThreshold = 12,
	minBrightRatio = 0.01,
): boolean {
	const total = Math.floor(rgba.length / 4);
	if (total === 0) return false; // 无可判定数据 → 不作为全黑
	let bright = 0;
	for (let i = 0; i < total; i += 1) {
		const o = i * 4;
		if (
			rgba[o] > blackThreshold ||
			rgba[o + 1] > blackThreshold ||
			rgba[o + 2] > blackThreshold
		) {
			bright += 1;
		}
	}
	return bright / total <= minBrightRatio;
}

/** 连续计数：达到 `limit` 次连续全黑即返回 true；非全黑立即清零。 */
export function createBlackStreak(limit: number = BLACK_STREAK_LIMIT) {
	let count = 0;
	return {
		push(black: boolean): boolean {
			count = black ? count + 1 : 0;
			return count >= limit;
		},
		count: (): number => count,
		reset: (): void => {
			count = 0;
		},
	};
}

/** 采样画布：缩到 32×32 后取像素（离屏 canvas 在调用方复用；willReadFrequently 避免反复读回警告）。 */
export function sampleCanvasPixels(
	canvas: HTMLCanvasElement,
	scratch: HTMLCanvasElement,
): Uint8ClampedArray | null {
	const ctx = scratch.getContext("2d", { willReadFrequently: true });
	if (!ctx) return null;
	ctx.drawImage(canvas, 0, 0, scratch.width, scratch.height);
	return ctx.getImageData(0, 0, scratch.width, scratch.height).data;
}
