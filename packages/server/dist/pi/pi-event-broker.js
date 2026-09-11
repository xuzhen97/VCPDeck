"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PiEventBroker = exports.SSE_HEARTBEAT_MS = void 0;
const common_1 = require("@nestjs/common");
const rxjs_1 = require("rxjs");
const operators_1 = require("rxjs/operators");
const shared_1 = require("@vcpdeck/shared");
const pi_request_broker_js_1 = require("./pi-request-broker.js");
const pi_run_service_js_1 = require("./pi-run.service.js");
/** SSE 心跳间隔 */
exports.SSE_HEARTBEAT_MS = 30_000;
/** 触发 settlement 检查的事件 */
const SETTLEMENT_TRIGGERS = new Set(["prompt_done", "agent_settled"]);
/** 会取消 settlement grace 的活动事件 */
const ACTIVITY_EVENTS = new Set([
    "agent_start",
    "extension_request",
    "message_update",
    "usage_update",
]);
/**
 * Pi 事件代理：把 Client PiEvent 按 clientId+sessionId 扇出给浏览器 SSE，
 * 并在 prompt_done/agent_settled 后执行 settlement 检查（30 秒可取消 grace）。
 */
let PiEventBroker = class PiEventBroker {
    requests;
    runs;
    streams = new Map();
    constructor(requests, runs) {
        this.requests = requests;
        this.runs = runs;
    }
    key(clientId, sessionId) {
        return `${clientId}:${sessionId}`;
    }
    /** Client 上报事件：投影扇出 + 状态机更新 */
    async publish(event) {
        const { clientId, sessionId, jobId, runId } = event;
        const key = this.key(clientId, sessionId);
        const stream = this.streams.get(key);
        const interactiveExtension = event.event.type === "extension_request" &&
            isDialogKind(event.event.ui.kind);
        // 只有交互式 Extension UI 才进入 waiting_input；notify 等状态通知不阻塞回合。
        if (interactiveExtension) {
            await this.runs.waitForInput(jobId, runId).catch(() => { });
        }
        if (event.event.type === "extension_resolved" && !event.event.hasPending) {
            await this.runs.resume(jobId, runId).catch(() => { });
        }
        // grace 内新 activity 取消 settlement；普通 notify 不算 activity。
        if (ACTIVITY_EVENTS.has(event.event.type) &&
            (event.event.type !== "extension_request" || interactiveExtension)) {
            this.runs.cancelSettlement(jobId, runId);
        }
        if (event.event.type === "prompt_error") {
            this.runs.cancelSettlement(jobId, runId);
            await this.runs.finishRun(jobId, runId).catch(() => { });
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
    stream(clientId, sessionId) {
        const key = this.key(clientId, sessionId);
        let stream = this.streams.get(key);
        if (!stream) {
            stream = { subject: new rxjs_1.Subject(), subscribers: 0 };
            this.streams.set(key, stream);
        }
        stream.subscribers += 1;
        const heartbeat = (0, rxjs_1.interval)(exports.SSE_HEARTBEAT_MS).pipe((0, operators_1.map)(() => ({ data: ":hb" })));
        return new rxjs_1.Observable((subscriber) => {
            const merged = (0, rxjs_1.merge)(stream.subject, heartbeat);
            const subscription = merged.subscribe(subscriber);
            return () => {
                subscription.unsubscribe();
                stream.subscribers -= 1;
                if (stream.subscribers <= 0) {
                    this.streams.delete(key);
                }
            };
        });
    }
    /** 触发 settlement：30 秒 grace 后再查一次 state，仍 idle 才 settle */
    async scheduleSettlementCheck(clientId, sessionId, jobId, runId) {
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
                    if (!response.ok)
                        return;
                    const state = (0, shared_1.parsePiAgentState)(response.data);
                    if ((0, shared_1.isPiAgentIdle)(state)) {
                        await this.runs.finishRun(jobId, runId);
                    }
                });
            }
            catch {
                // Client 断线、generation 切换或畸形响应：留给重连 reconcile。
            }
        });
    }
};
exports.PiEventBroker = PiEventBroker;
exports.PiEventBroker = PiEventBroker = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(pi_request_broker_js_1.PiRequestBroker)),
    __param(1, (0, common_1.Inject)(pi_run_service_js_1.PiRunService)),
    __metadata("design:paramtypes", [pi_request_broker_js_1.PiRequestBroker, pi_run_service_js_1.PiRunService])
], PiEventBroker);
function isDialogKind(kind) {
    return (kind === "select" ||
        kind === "confirm" ||
        kind === "input" ||
        kind === "editor");
}
