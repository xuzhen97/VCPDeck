import type { PiAgentState, PiSessionContextPage, PiSessionDetail, PiSessionInfo } from "@vcpdeck/shared";
/** 单页消息条数（最新窗口） */
export declare const PI_CONTEXT_PAGE_SIZE = 60;
/** Tool Result 文本超过该长度时延迟加载 */
export declare const MAX_TOOL_RESULT_BYTES: number;
export interface PiSessionReader {
    list(): Promise<PiSessionInfo[]>;
    newSession(): Promise<{
        sessionId: string;
    }>;
    get(sessionId: string): Promise<PiSessionDetail>;
    state(sessionId: string): Promise<PiAgentState>;
    context(sessionId: string, leafId?: string | null, cursor?: string | null): Promise<PiSessionContextPage>;
    entryContent(sessionId: string, entryId: string, blockIndex: number): Promise<{
        mimeType: string;
        data: string;
    }>;
    rename(sessionId: string, name: string): Promise<void>;
    delete(sessionId: string): Promise<void>;
    fork(sessionId: string, upToMessageId: string): Promise<{
        sessionId: string;
    }>;
    clone(sessionId: string): Promise<{
        sessionId: string;
    }>;
    navigate(sessionId: string, leafId: string): Promise<PiSessionContextPage>;
}
/** 按 canonical cwd 创建 Session 读取器（不创建 AgentSession、不加载 extensions） */
export declare function createPiSessionReader(cwd: string, sessionDir?: string): PiSessionReader;
