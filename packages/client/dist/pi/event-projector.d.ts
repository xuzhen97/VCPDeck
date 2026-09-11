import type { PiClientEvent } from "@vcpdeck/shared";
/** 单个投影事件 JSON 上限 */
export declare const MAX_EVENT_BYTES: number;
/**
 * 把 Pi SDK 原生事件投影为可出站的裁剪事件。
 * - 去掉 turn_start/turn_end/tool_execution_update；
 * - thinking 只保留受限阶段、正文增量和耗时；
 * - message_update 不携带完整 partial；
 * - 超大事件兜底为 history_changed。
 */
export declare function projectPiEvent(event: unknown, sessionId: string): PiClientEvent | null;
