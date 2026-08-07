import { Inject, Injectable } from "@nestjs/common";
import { interval, merge, Observable, Subject } from "rxjs";
import { map } from "rxjs/operators";
import type {
	MessageEvent,
} from "@nestjs/common";
import type {
	PiAgentState,
	PiEvent,
	PiStateReport,
} from "@vcpdeck/shared";
import { PiRequestBroker } from "./pi-request-broker.js";
import { PiRunService } from "./pi-run.service.js";

/** SSE 心跳间隔 */
export const SSE_HEARTBEAT_MS = 30_000;

/** 触发 settlement 检查的事件 */
const SETTLEMENT_TRIGGERS = new Set(["prompt_done", "agent_settled"]);

/** 会取消 settlement grace 的活动事件 */
const ACTIVITY_EVENTS = new Set([
	"agent_start",
	"extension_request",
	"message_update",
	"usage_update",
]);

interface SessionStream {
	subject: Subject<MessageEvent>;
	subscribers: number;
}

function isIdleState(state: unknown): boolean {
	if (typeof state !== "object" || state === null) return false;
	const s = state as PiAgentState;
	return (
		s.status === "idle" &&
		s.streaming === false &&
		s.prompting === false &&
		s.compacting === false &&
		s.waitingForExtensionInput !== true
	);
}

/**
 * Pi 事件代理：把 Client PiEvent 按 clientId+sessionId 扇出给浏览器 SSE，
 * 并在 prompt_done/agent_settled 后执行 settlement 检查（30 秒可取消 grace）。
 */
@Injectable()
export class PiEventBroker {
	private readonly streams = new Map<string, SessionStream>();

	constructor(
		@Inject(PiRequestBroker) private readonly requests: PiRequestBroker,
		@Inject(PiRunService) private readonly runs: PiRunService,
	) {}

	private key(clientId: string, sessionId: string): string {
		return `${clientId}:${sessionId}`;
	}

	/** Client 上报事件：投影扇出 + 状态机更新 */
	async publish(event: PiEvent): Promise<void> {
		const { clientId, sessionId, jobId, runId } = event;
		const key = this.key(clientId, sessionId);
		const stream = this.streams.get(key);

		// Extension dialog → waiting_input；Owner 响应后回 running（controller 调 resume）
		if (event.event.type === "extension_request") {
			await this.runs.waitForInput(jobId).catch(() => {});
		}
		// grace 内新 activity 取消 settlement
		if (ACTIVITY_EVENTS.has(event.event.type)) {
			this.runs.cancelSettlement(jobId);
		}
		// 终态触发 settlement 检查
		if (SETTLEMENT_TRIGGERS.has(event.event.type)) {
			await this.scheduleSettlementCheck(clientId, sessionId, jobId, runId);
		}

		if (stream) {
			stream.subject.next({ data: JSON.stringify(event) });
		}
	}

	/** 订阅浏览器 SSE 流（session 级；断开只取消订阅） */
	stream(clientId: string, sessionId: string): Observable<MessageEvent> {
		const key = this.key(clientId, sessionId);
		let stream = this.streams.get(key);
		if (!stream) {
			stream = { subject: new Subject<MessageEvent>(), subscribers: 0 };
			this.streams.set(key, stream);
		}
		stream.subscribers += 1;
		const heartbeat = interval(SSE_HEARTBEAT_MS).pipe(
			map((): MessageEvent => ({ data: ":hb" })),
		);
		return new Observable<MessageEvent>((subscriber) => {
			const merged = merge(stream!.subject, heartbeat);
			const subscription = merged.subscribe(subscriber);
			return () => {
				subscription.unsubscribe();
				stream!.subscribers -= 1;
				if (stream!.subscribers <= 0) {
					this.streams.delete(key);
				}
			};
		});
	}

	/** Client 重连状态报告：恢复 Job 状态并返回 accepted run ids */
	async handleState(clientId: string, report: PiStateReport): Promise<string[]> {
		await this.runs.reconcileState(clientId, report);
		return report.runs
			.filter((r) => r.status === "done" || r.status === "error")
			.map((r) => r.jobId);
	}

	/** 触发 settlement：30 秒 grace 后再查一次 state，仍 idle 才 settle */
	private async scheduleSettlementCheck(
		clientId: string,
		sessionId: string,
		jobId: string,
		runId: string,
	): Promise<void> {
		await this.runs.scheduleSettlement(jobId, async () => {
			let state: PiAgentState;
			try {
				const response = await this.requests.request(clientId, {
					requestId: `settle-${jobId}-${Date.now()}`,
					action: "agent.state",
					sessionId,
					jobId,
					runId,
				});
				if (!response.ok) return;
				state = response.data as PiAgentState;
			} catch {
				return; // Client 断线等：留给重连 reconcile
			}
			if (
				isIdleState(state) &&
				state.queuedMessages.steering.length === 0 &&
				state.queuedMessages.followUp.length === 0
			) {
				await this.runs.settle(jobId, state);
			}
		});
	}
}
