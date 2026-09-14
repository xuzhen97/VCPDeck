import { Injectable, Optional } from "@nestjs/common";
import {
	RemoteDesktopLimits,
	type RemoteDesktopSignal,
} from "@vcpdeck/shared";

interface SignalBudget {
	windowStartedAt: number;
	messageCount: number;
	bytes: number;
	candidateCount: number;
	browserOfferSeen: boolean;
	hostAnswerSeen: boolean;
}

function signalBytes(signal: RemoteDesktopSignal): number {
	return new TextEncoder().encode(JSON.stringify(signal)).byteLength;
}

function signalError(message: string): Error {
	return Object.assign(new Error(message), { code: "REMOTE_DESKTOP_SIGNAL_LIMIT" });
}

/**
 * Remote Desktop 信令预算与方向校验。
 *
 * SDP/ICE 正文只在内存中经过这里，不写日志、不持久化，也不承担媒体转发。
 */
@Injectable()
export class RemoteDesktopSignalingService {
	private readonly budgets = new Map<string, SignalBudget>();
	private readonly now: () => number;

	// `@Optional()` 不可省略：Nest 无法为 `() => number` 解析依赖（元数据类型是
	// `Function`），构造参数的默认值在依赖解析**之后**才生效，救不了它。
	// 加 `@Optional()` 后 Nest 注入 `undefined`，默认值随即生效；
	// 测试仍可直接传入确定性时钟。
	constructor(@Optional() now: () => number = Date.now) {
		this.now = now;
	}

	private budget(attachmentId: string): SignalBudget {
		const current = this.budgets.get(attachmentId);
		if (current) return current;
		const created: SignalBudget = {
			windowStartedAt: this.now(),
			messageCount: 0,
			bytes: 0,
			candidateCount: 0,
			browserOfferSeen: false,
			hostAnswerSeen: false,
		};
		this.budgets.set(attachmentId, created);
		return created;
	}

	private consume(attachmentId: string, signal: RemoteDesktopSignal): SignalBudget {
		const now = this.now();
		const current = this.budget(attachmentId);
		if (now - current.windowStartedAt >= 1_000) {
			current.windowStartedAt = now;
			current.messageCount = 0;
		}
		if (current.messageCount >= RemoteDesktopLimits.maxSignalMessagesPerSecond) {
			throw signalError("Remote Desktop signal rate limit exceeded");
		}
		const bytes = signalBytes(signal);
		if (bytes > RemoteDesktopLimits.maxSignalBytes) {
			throw signalError("Remote Desktop signal exceeds the message limit");
		}
		if (current.bytes + bytes > RemoteDesktopLimits.maxSignalBytesPerAttachment) {
			throw signalError("Remote Desktop signal budget exceeded");
		}
		if (signal.kind === "ice" && current.candidateCount >= RemoteDesktopLimits.maxIceCandidates) {
			throw signalError("Remote Desktop ICE candidate limit exceeded");
		}
		current.messageCount += 1;
		current.bytes += bytes;
		if (signal.kind === "ice") current.candidateCount += 1;
		return current;
	}

	/** 接受 Browser→Host 的 offer/ICE；answer 只能从 Host 返回。 */
	acceptBrowserSignal(attachmentId: string, signal: RemoteDesktopSignal): RemoteDesktopSignal {
		const budget = this.consume(attachmentId, signal);
		if (signal.kind === "answer") {
			throw signalError("Invalid signal direction: Browser cannot send answer");
		}
		if (signal.kind === "offer") {
			if (budget.browserOfferSeen) throw signalError("Duplicate browser offer");
			budget.browserOfferSeen = true;
		}
		return signal;
	}

	/** 接受 Host→Browser 的 answer/ICE。 */
	acceptHostSignal(attachmentId: string, signal: RemoteDesktopSignal): RemoteDesktopSignal {
		const budget = this.consume(attachmentId, signal);
		if (signal.kind === "offer") {
			throw signalError("Invalid signal direction: Host cannot send offer");
		}
		if (signal.kind === "answer") {
			if (budget.hostAnswerSeen) throw signalError("Duplicate host answer");
			budget.hostAnswerSeen = true;
		}
		return signal;
	}

	/** Attachment 关闭或重新协商时释放所有临时信令预算。 */
	reset(attachmentId: string): void {
		this.budgets.delete(attachmentId);
	}
}
