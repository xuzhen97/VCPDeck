/** CLI 运行时依赖，测试可注入输出。 */
export interface CliContext {
    log?: (message: string) => void;
    error?: (message: string) => void;
}
/** 执行 CLI 命令并返回进程退出码。 */
export declare function run(argv: string[], context?: CliContext): Promise<number>;
/** CLI 总帮助。 */
export declare function helpText(): string;
