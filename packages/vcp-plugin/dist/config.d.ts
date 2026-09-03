import type { PluginConfig } from "./types.js";
/**
 * 解析 config.env 文件
 */
export declare function parseEnvFile(content: string): Record<string, string>;
/**
 * 加载插件配置
 */
export declare function loadConfig(searchDir?: string): PluginConfig;
