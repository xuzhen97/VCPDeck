/**
 * VCPDeck 面板的 Host 半。
 *
 * 浏览器半不能直接调 VCPDeck Server：DSH 页面与 VCPDeck 不同源，Cookie 与 CORS
 * 都会拦下来。因此由 Host 半在本机服务端进程里代发请求（Token 也不进浏览器），
 * 浏览器只访问同源的 `/api/vcpdeck/clients`。
 *
 * 配置来源（按优先级）：插件行 `config` → 环境变量。
 * - config.serverUrl / VCPDECK_API_URL（默认 http://127.0.0.1:3001）
 * - config.token     / VCPDECK_API_TOKEN
 *
 * 不记录任何含 token 的日志；返回给浏览器的字段做白名单裁剪。
 */

const PREFIX = "/api/vcpdeck";

/** Cordis 依赖声明：不声明就无法访问 ctx.webServer。 */
export const inject = ["webServer"];

/** 允许透传给浏览器的 Client 字段（白名单，避免把 Server 的全量字段带到 DSH 页面）。 */
function project(client) {
	return {
		clientId: client.clientId,
		name: client.name,
		hostname: client.hostname,
		online: Boolean(client.online),
		lastHeartbeatAt: client.lastHeartbeatAt ?? null,
		...(client.dshWebUrl ? { dshWebUrl: client.dshWebUrl } : {}),
	};
}

function json(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

/**
 * Host 插件入口。
 *
 * 所有资源都在 `ctx.effect` 里注册并返回清理函数，卸载插件即撤销路由。
 */
export function apply(ctx, config) {
	const serverUrl = (
		config?.serverUrl ??
		process.env.VCPDECK_API_URL ??
		"http://127.0.0.1:3001"
	).replace(/\/+$/, "");
	const token = config?.token ?? process.env.VCPDECK_API_TOKEN ?? "";

	ctx.effect(() =>
		ctx.webServer.register({
			kind: "prefix",
			path: PREFIX,
			handler: async (req, res) => {
				const url = new URL(req.url ?? "/", "http://localhost");
				if (url.pathname !== `${PREFIX}/clients`) {
					json(res, 404, { error: "not_found" });
					return;
				}
				if (req.method !== "GET") {
					json(res, 405, { error: "method_not_allowed" });
					return;
				}
				if (!token) {
					json(res, 500, {
						error: "missing_token",
						message: "在插件配置或 VCPDECK_API_TOKEN 中提供 VCPDeck API token",
					});
					return;
				}
				try {
					const upstream = await fetch(`${serverUrl}/api/clients`, {
						headers: { authorization: `Bearer ${token}` },
					});
					if (!upstream.ok) {
						json(res, 502, { error: "upstream_failed", status: upstream.status });
						return;
					}
					const clients = await upstream.json();
					json(res, 200, {
						serverUrl,
						clients: Array.isArray(clients) ? clients.map(project) : [],
					});
				} catch {
					json(res, 502, { error: "upstream_unreachable" });
				}
			},
		}),
	);
}
