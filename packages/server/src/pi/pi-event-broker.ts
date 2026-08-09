import { Inject, Injectable } from "@nestjs/common";
import { interval, merge, Observable, Subject } from "rxjs";
import { map } from "rxjs/operators";
import type {
	MessageEvent,
} from "@nestjs/common";
import { parsePiAgentState, isPiAgentIdle } from "@vcpdeck/shared";
import type { PiEvent } from "@vcpdeck/shared";
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

		const interactiveExtension =
			event.event.type === "extension_request" &&
			isDialogKind(event.event.ui.kind);
		// 只有交互式 Extension UI 才进入 waiting_input；notify 等状态通知不阻塞回合。
		if (interactiveExtension) {
			await this.runs.waitForInput(jobId, runId).catch(() => {});
		}
		if (event.event.type === "extension_resolved" && !event.event.hasPending) {
			await this.runs.resume(jobId, runId).catch(() => {});
		}
		// grace 内新 activity 取消 settlement；普通 notify 不算 activity。
		if (
			ACTIVITY_EVENTS.has(event.event.type) &&
			(event.event.type !== "extension_request" || interactiveExtension)
		) {
			this.runs.cancelSettlement(jobId, runId);
		}
		if (event.event.type === "prompt_error") {
			this.runs.cancelSettlement(jobId, runId);
			await this.runs.finishRun(jobId, runId).catch(() => {});
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

	/** 触发 settlement：30 秒 grace 后再查一次 state，仍 idle 才 settle */
	private async scheduleSettlementCheck(
		clientId: string,
		sessionId: string,
		jobId: string,
		runId: string,
	): Promise<void> {
		await this.runs.scheduleSettlement(jobId, runId, async () => {
			try {
				await this.runs.withReconciledClient(clientId, async (lease) => {
					const response = await this.requests.request(lease, {
						requestId: `settle-${jobId}-${Date.now()}`,
						action: "agent.state",
						sessionId,
						jobId,
						runId,
					});
					if (!response.ok) return;
					const state = parsePiAgentState(response.data);
					if (isPiAgentIdle(state)) {
						await this.runs.finishRun(jobId, runId);
					}
				});
			} catch {
				// Client 断线、generation 切换或畸形响应：留给重连 reconcile。
			}
		});
	}
}

function isDialogKind(kind: unknown): boolean {
	return (
		kind === "select" ||
		kind === "confirm" ||
		kind === "input" ||
		kind === "editor"
	);
}
