import type { PiMessage } from "@vcpdeck/shared";
/** 把 Pi 原生 assistant 消息中的 toolCall block 字段名规范化 */
export declare function normalizeToolCalls(msg: PiMessage): PiMessage;
/** 提取 text block 的纯文本（历史列表 firstMessage 预览用） */
export declare function textOf(content: unknown): string;
/** 安全截断预览文本 */
export declare function truncatePreview(text: string, max?: number): string;
