export declare class DirectUrlCache {
    private readonly safetyMarginMs;
    private readonly entries;
    constructor(safetyMarginMs?: number);
    /** 命中且未到安全余量内返回 URL；否则淘汰并返回 null */
    get(key: string, now?: number): string | null;
    set(key: string, url: string, expiresAt: number): void;
    delete(key: string): void;
}
