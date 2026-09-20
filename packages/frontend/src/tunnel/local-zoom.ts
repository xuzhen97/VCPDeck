/**
 * 本地缩放：只改变浏览器显示大小，绝不改动远端分辨率。
 *
 * 关键约束（已对 noVNC 1.7 源码核验）：
 *   `absX(x) { return x / this._scale + this._viewportLoc.x }`
 * 其中 `x` 来自 canvas 的**渲染后** bounding rect，而 `this._scale` 由 noVNC 依据
 * **挂载容器**的尺寸算出（`autoscale` → `_rescale` 只设置 canvas 的 style 宽高）。
 * 因此：
 *   - 倍率缩放必须通过**放大容器**实现（容器变大 ⇒ autoscale 变大 ⇒ 画面变大）；
 *   - 绝不能在 canvas 或其祖先上使用 CSS `transform` / `zoom` —— noVNC 感知不到，
 *     指针坐标会被放大，误差随离原点距离线性增长（正是本模块要根治的缺陷）。
 */

/** 缩放档位：适应窗口 / 1:1 / 百分比倍率（仅本地显示）。 */
export type ZoomLevel = "fit" | "actual" | 125 | 150 | 175 | 200;

/** 百分比阶梯；fit/actual 由 noVNC 自身控制尺寸，不在阶梯内。 */
const PERCENT_LEVELS = [125, 150, 175, 200] as const;
type PercentLevel = (typeof PERCENT_LEVELS)[number];

/** 百分比档位（供 UI 渲染按钮）；顺序与 nextZoom 的阶梯一致。 */
export const PERCENT_ZOOMS: readonly ZoomLevel[] = PERCENT_LEVELS;

/**
 * 返回放大 noVNC 容器的内联样式；fit/actual 返回 null（交给 noVNC）。
 * 只返回宽高百分比，绝不返回 transform。
 */
export function zoomContainerStyle(
	level: ZoomLevel,
): { width: string; height: string } | null {
	if (level === "fit" || level === "actual") return null;
	return { width: `${level}%`, height: `${level}%` };
}

/**
 * 沿倍率阶梯移动一档。
 * fit/actual 向上进入 125%；低于最低档回到 fit；两端夹紧，不循环。
 */
export function nextZoom(level: ZoomLevel, direction: 1 | -1): ZoomLevel {
	if (level === "fit" || level === "actual") {
		return direction === 1 ? PERCENT_LEVELS[0] : "fit";
	}
	const index = PERCENT_LEVELS.indexOf(level as PercentLevel);
	const target = index + direction;
	if (target < 0) return "fit";
	// 夹紧到阶梯两端（不循环）；用 min 而不是直接取末元素，边界更清晰
	return PERCENT_LEVELS[Math.min(target, PERCENT_LEVELS.length - 1)];
}
