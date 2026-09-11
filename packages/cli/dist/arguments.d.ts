/** CLI 长选项解析结果。 */
export interface ParsedCommandArgs {
    positionals: string[];
    options: Record<string, string | true>;
}
/**
 * 解析 `--name=value`、`--name value` 与布尔长选项。
 * 未声明、重复或缺值选项会明确失败，避免静默拼写错误。
 * 裸 `--` 为分隔符：其后所有参数原样作为位置参数，不再解析选项。
 */
export declare function parseCommandArgs(argv: string[], schema?: {
    value?: readonly string[];
    boolean?: readonly string[];
}): ParsedCommandArgs;
/** 读取字符串选项。 */
export declare function stringOption(options: Record<string, string | true>, name: string): string | undefined;
