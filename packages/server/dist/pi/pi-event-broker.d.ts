import { Observable } from "rxjs";
import type { MessageEvent } from "@nestjs/common";
import type { PiEvent } from "@vcpdeck/shared";
import { PiRequestBroker } from "./pi-request-broker.js";
import { PiRunService } from "./pi-run.service.js";
/** SSE 心跳间隔 */
export declare const SSE_HEARTBEAT_MS = 30000;
/**
 * Pi 事件代理：把 Client PiEvent 按 clientId+sessionId 扇出给浏览器 SSE，
 * 并在 prompt_done/agent_settled 后执行 settlement 检查（30 秒可取消 grace）。
 */
export declare class PiEventBroker {
    private readonly requests;
    private readonly runs;
    private readonly streams;
    constructor(requests: PiRequestBroker, runs: PiRunService);
    private key;
    /** Client 上报事件：投影扇出 + 状态机更新 */
    publish(event: PiEvent): Promise<void>;
    /** 订阅浏览器 SSE 流（session 级；断开只取消订阅） */
    stream(clientId: string, sessionId: string): Observable<MessageEvent>;
    /** 触发 settlement：30 秒 grace 后再查一次 state，仍 idle 才 settle */
    private scheduleSettlementCheck;
}
