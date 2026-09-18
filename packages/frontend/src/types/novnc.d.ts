/**
 * @novnc/novnc 缺少官方类型声明。
 * 这里只声明本仓库用到的最小面（默认导出 RFB 构造器及其被调用的成员），
 * 避免为整个库维护一份会漂移的 .d.ts。
 */
declare module "@novnc/novnc" {
	export default class RFB {
		constructor(
			target: Element,
			urlOrChannel: string | RTCDataChannel,
			options?: Record<string, unknown>,
		);
		viewOnly: boolean;
		scaleViewport: boolean;
		resizeSession: boolean;
		disconnect(): void;
		sendCredentials(creds: {
			username?: string;
			password?: string;
			target?: string;
		}): void;
		addEventListener(type: string, listener: EventListener): void;
		removeEventListener(type: string, listener: EventListener): void;
	}
}
