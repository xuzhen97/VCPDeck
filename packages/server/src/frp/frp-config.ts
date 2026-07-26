/** @file FRP 模块配置 — 从环境变量读取 */

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

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return n;
}

export function getFrpConfig(): FrpConfig {
  const dashboard = process.env.FRP_DASHBOARD_HOST
    ? {
        scheme: (process.env.FRP_DASHBOARD_SCHEME as "http" | "https") || "http",
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
