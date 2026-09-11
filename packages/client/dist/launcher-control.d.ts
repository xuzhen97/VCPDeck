export interface LauncherControl {
    port: number;
    token: string;
}
export interface ClientLauncherOptions {
    /** control.json 路径（默认 ~/.vcpdeck/launcher/control.json） */
    controlFile?: string;
    /** fetch 实现（测试注入） */
    fetchImpl?: typeof fetch;
}
export declare class ClientLauncher {
    private readonly controlFile;
    private readonly fetchImpl;
    constructor(options?: ClientLauncherOptions);
    private readControl;
    private post;
    /** 第一阶段：让 launcher 准备新版本（下载/校验/解压） */
    prepareUpdate(input: {
        version: string;
        url: string;
        sha256: string;
    }): Promise<void>;
    /** 第二阶段：让 launcher 停掉本进程并切换版本（连接被掐断=成功） */
    applyUpdate(): Promise<void>;
}
