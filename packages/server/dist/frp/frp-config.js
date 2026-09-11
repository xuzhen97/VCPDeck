"use strict";
/**
 * @file FRP 模块配置 — 从环境变量读取
 * @deprecated 自 2026-07-29 起，FRP 配置已迁移到 DB 表 FrpsInstance。
 * 仅保留 FrpDashboardConfig 类型导出供 PortAllocator 使用。
 * 后续版本将移除此文件。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFrpConfig = getFrpConfig;
function envInt(key, fallback) {
    const v = process.env[key];
    if (v === undefined)
        return fallback;
    const n = parseInt(v, 10);
    if (Number.isNaN(n))
        return fallback;
    return n;
}
/** @deprecated 使用 FrpsInstancesService.getDefault() 替代。 */
function getFrpConfig() {
    const dashboard = process.env.FRP_DASHBOARD_HOST
        ? {
            scheme: process.env.FRP_DASHBOARD_SCHEME || "http",
            host: process.env.FRP_DASHBOARD_HOST,
            port: envInt("FRP_DASHBOARD_PORT", 7500),
            user: process.env.FRP_DASHBOARD_USER || "admin",
            password: process.env.FRP_DASHBOARD_PASSWORD || "admin",
        }
        : null;
    return {
        portRangeStart: envInt("FRP_PORT_RANGE_START", 20000),
        portRangeEnd: envInt("FRP_PORT_RANGE_END", 21000),
        frpsPublicHost: process.env.FRP_PUBLIC_HOST || "127.0.0.1",
        dashboard,
    };
}
