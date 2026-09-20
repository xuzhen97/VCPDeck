/**
 * UltraVNC `SetSW` 显示器切换。
 *
 * 协议：RFB 客户端消息类型 10（`rfbSetSW`），6 字节
 * `[type, status, x_hi, x_lo, y_hi, y_lo]`。
 * 真机实测（UltraVNC 1.8.3.0，双 1920×1080）：`[10,0,0,0,0,0]` 即被接受并生效，
 * 无需构造坐标；效果是切换 winvnc **服务端共享**的捕获源 ——
 * 在一条连接上切换会推送给所有已连客户端，新建连接也直接看到切换后的状态。
 *
 * 因此：
 * - 同一目标机的并发会话共享所选显示源，UI 必须明示（见 ADR-0028 决策 7）；
 * - 同尺寸多屏无法用尺寸区分是哪一块，故只提供「切换到下一屏」的循环式操作，
 *   不给屏幕编号（见 ADR-0028 决策 6 的降级）。
 *
 * 本模块只使用公开的 `RTCDataChannel.send`，不触碰 noVNC 私有字段；
 * 消息与 noVNC 写入的是同一条有序通道，RFB 无包边界依赖，交错插入一条完整消息是安全的。
 */

/** `SetSW` 消息类型（rfbSetSW）。 */
export const SET_SW_MESSAGE_TYPE = 10;

/** 编码一条 `SetSW` 请求（`status`/`x`/`y` 置 0，实测有效）。 */
export function encodeSetSw(): Uint8Array {
	return new Uint8Array([SET_SW_MESSAGE_TYPE, 0, 0, 0, 0, 0]);
}

/** 发送所需的最小通道面（便于测试注入）。 */
export interface SwChannel {
	readyState: RTCDataChannelState | string;
	send: (data: Uint8Array) => void;
}

export interface UltraVncDisplayControl {
	/** 切换到下一显示源（服务端全局）。通道未打开时静默忽略。 */
	cycle: () => void;
}

/**
 * 创建 `SetSW` 控制器。
 * 只依赖通道的 `readyState` 与 `send`，不做任何状态推断（服务端不回传当前源）。
 */
export function createUltraVncDisplayControl(
	channel: SwChannel,
): UltraVncDisplayControl {
	return {
		cycle() {
			if (channel.readyState !== "open") return;
			channel.send(encodeSetSw());
		},
	};
}
