export interface LauncherControl {
    port: number;
    token: string;
}
export interface LauncherHttpClientOptions {
    /** control.json 路径（默认 ~/.vcpdeck/launcher/control.json） */
    controlFile?: string;
    /** fetch 实现（测试注入） */
    fetchImpl?: typeof fetch;
}
export declare class LauncherHttpClient {
    private readonly controlFile;
    private readonly fetchImpl;
    constructor(options?: LauncherHttpClientOptions);
    private readControl;
    private post;
    /** 第一阶段：让 launcher 准备新版本（下载/校验/解压） */
    prepareUpdate(input: {
        version: string;
        url: string;
        sha256: string;
    }): Promise<void>;
    /**
     * 第二阶段：让 launcher 停掉本进程并切换版本。
     * 2xx 或连接被 launcher 掐断（本进程被停）都视为成功。
     */
    applyUpdate(): Promise<void>;
}
