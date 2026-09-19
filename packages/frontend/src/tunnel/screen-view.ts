/**
 * 远程桌面的区域裁剪计算（纯函数，无 DOM 依赖）。
 *
 * 服务端送来的是整块虚拟桌面（实测 3960×1920 这类多屏拼接），RFB 没有"选择显示器"
 * 消息；noVNC 1.7 也未公开多屏几何，因此"按显示器查看"在本期退化为**按比例区域裁剪**：
 * 只改变可见区域，不重连、不丢会话。详见 ADR-0028 与设计文档。
 */

/** 画面内的百分比矩形（x/y/w/h 均为 0–1）。 */
export interface PercentRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** 预设区域。 */
export type DisplayPreset = "all" | "left" | "right";

/** 分割比例下限/上限，避免裁剪出零宽区域。 */
const MIN_W = 0.05;

function clampSplit(v: number): number {
	if (!Number.isFinite(v)) return 0.5;
	return Math.min(1 - MIN_W, Math.max(MIN_W, v));
}

/** 把预设 + 分割比例转成百分比矩形。 */
export function rectForPreset(preset: DisplayPreset, split = 0.5): PercentRect {
	if (preset === "all") return { x: 0, y: 0, w: 1, h: 1 };
	const s = clampSplit(split);
	return preset === "left"
		? { x: 0, y: 0, w: s, h: 1 }
		: { x: s, y: 0, w: 1 - s, h: 1 };
}

/** 是否为整块画面（此时不需要裁剪包裹层）。 */
export function isFullRect(r: PercentRect): boolean {
	return r.x === 0 && r.y === 0 && r.w === 1 && r.h === 1;
}

/** 归一化比例串（不依赖真实帧尺寸），供 UI 属性与测试使用。 */
export function normalizedAspect(rect: PercentRect): string {
	return `${rect.w * 100} / ${rect.h * 100}`;
}

/**
 * 计算裁剪所需的包裹层比例与 inner 定位。
 *
 * 包裹层只显示 rect 区域：inner 放大到 `100/w × 100/h`（相对包裹层），
 * 再反向平移 `-x/w`、`-y/h`（translate 百分比相对 inner 自身尺寸），
 * 从而把 rect 左上角对齐到包裹层左上角。
 *
 * @param rect 要显示的百分比矩形
 * @param frameWidth 帧像素宽度（用于还原被裁区域的真实宽高比，避免拉伸变形）
 * @param frameHeight 帧像素高度
 */
export function cropLayout(
	rect: PercentRect,
	frameWidth: number,
	frameHeight: number,
): {
	aspectRatio: string;
	inner: {
		position: "absolute";
		top: number;
		left: number;
		width: string;
		height: string;
		transform: string;
	};
} {
	// -0 在 CSS 中无意义，统一归一为 0；同时去掉尾零，保证字符串可复现。
	const pct = (n: number): string => {
		const v = n * 100;
		const normalized = v === 0 ? 0 : v;
		const text = normalized.toFixed(6).replace(/\.?0+$/, "");
		return `${text === "" ? "0" : text}%`;
	};
	return {
		aspectRatio: `${rect.w * frameWidth} / ${rect.h * frameHeight}`,
		inner: {
			position: "absolute",
			top: 0,
			left: 0,
			width: pct(1 / rect.w),
			height: pct(1 / rect.h),
			transform: `translate(${pct(-rect.x / rect.w)}, ${pct(-rect.y / rect.h)})`,
		},
	};
}
