/**
 * @file FRP 模块配置 — 从环境变量读取
 * @deprecated 自 2026-07-29 起，FRP 配置已迁移到 DB 表 FrpsInstance。
 * 仅保留 FrpDashboardConfig 类型导出供 PortAllocator 使用。
 * 后续版本将移除此文件。
 */
export interface FrpDashboardConfig {
    scheme: "http" | "https";
    host: string;
    port: number;
    user: string;
    password: string;
}
export interface FrpConfig {
    portRangeStart: number;
    portRangeEnd: number;
    frpsPublicHost: string;
    dashboard: FrpDashboardConfig | null;
}
/** @deprecated 使用 FrpsInstancesService.getDefault() 替代。 */
export declare function getFrpConfig(): FrpConfig;
