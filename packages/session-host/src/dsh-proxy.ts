import http from "node:http";
import type { Duplex } from "node:stream";

/**
 * DSH 原生 Web 的宿主内反向代理（ADR-0047）。
 *
 * 这个组件的唯一职责是**透明搬运**，不是安全策略中心：
 * - 不改 `Host`/`Origin`/`Cookie`/`sec-fetch-site`，让 DSH 自己在原 authority 下判定；
 * - 不注入任何 `X-Forwarded-*`（禁止用转发头伪造 authority），也不透传入站的伪造值；
 * - 不缓冲、不截断请求体，超限由 DSH 自己按 `maxRequestBodyBytes` 拒绝；
 * - 上游状态码（含 4xx/5xx）原样透传，绝不改判为成功；
 * - 不打印任何日志（正文、Cookie、令牌都不得进日志）。
 *
 * 两层认证的归属：VCPDeck 身份层在 Server/通道侧，DSH 会话层由 DSH 自己执行。
 * 代理不承担 VCPDeck 认证层（浏览器导航与 WebSocket 握手无法携带自定义头），
 * 因此 `token` 在这里只作边界守卫与「绝不转发」的保证。
 */

/** DSH 的 loopback 监听目标。 */
export interface DshProxyTarget {
	host: string;
	port: number;
}

export interface DshProxyOptions {
	target: DshProxyTarget;
	/** 宿主本机令牌：绝不向上游转发，也绝不进入日志或响应。 */
	token: string;
}

/** 逐跳头：不参与端到端语义，按 spec 必须由代理消化。 */
const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

/** 凭据与可能被用来伪造 authority 的头：任何情况下都不向上游转发。 */
const NEVER_FORWARD = new Set(["authorization", "proxy-authorization", "expect"]);

function isNeverForwarded(lowerName: string): boolean {
	return NEVER_FORWARD.has(lowerName) || lowerName.startsWith("x-forwarded-");
}

/** 组装上游请求头：upgrade 需要保留 `connection`/`upgrade`，普通请求则按逐跳头剔除。 */
function requestHeaders(inbound: http.IncomingHttpHeaders, upgrade: boolean): http.OutgoingHttpHeaders {
	const headers: http.OutgoingHttpHeaders = {};
	for (const [name, value] of Object.entries(inbound)) {
		if (value === undefined) continue;
		const lower = name.toLowerCase();
		if (isNeverForwarded(lower)) continue;
		if (HOP_BY_HOP.has(lower) && !(upgrade && (lower === "connection" || lower === "upgrade"))) continue;
		headers[name] = value;
	}
	return headers;
}

/** 回程头：剔逐跳头，保留 `Set-Cookie` 等端到端头。 */
function responseHeaders(inbound: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
	const headers: http.OutgoingHttpHeaders = {};
	for (const [name, value] of Object.entries(inbound)) {
		if (value === undefined) continue;
		if (HOP_BY_HOP.has(name.toLowerCase())) continue;
		headers[name] = value;
	}
	return headers;
}

/** 把上游响应行与原始头逐字节写回已切换协议的 socket。 */
function writeRawResponseHead(socket: Duplex, response: http.IncomingMessage): void {
	const statusLine = `HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? ""}`.trimEnd();
	const lines: string[] = [];
	for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
		lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
	}
	socket.write(`${statusLine}\r\n${lines.join("\r\n")}\r\n\r\n`);
}

function unavailable(res: http.ServerResponse): void {
	const body = JSON.stringify({ error: { message: "上游不可达" } });
	res.writeHead(502, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
	res.end(body);
}

/**
 * 创建 DSH 反向代理。
 *
 * 由宿主监听 loopback（随机端口），DSH 继续只监听本机回环；
 * 对外 TLS 由部署提供，本组件不实现证书生命周期。
 */
export function createDshProxy(options: DshProxyOptions): http.Server {
	if (typeof options.token !== "string" || options.token.length === 0) {
		throw new Error("DSH 代理必须以宿主令牌构造：本机凭据的边界不得缺省");
	}

	function openUpstream(req: http.IncomingMessage, upgrade: boolean): http.ClientRequest {
		return http.request({
			host: options.target.host,
			port: options.target.port,
			method: req.method,
			path: req.url ?? "/",
			headers: requestHeaders(req.headers, upgrade),
		});
	}

	const server = http.createServer((req, res) => {
		const upstream = openUpstream(req, false);
		upstream.on("response", (upstreamRes) => {
			res.writeHead(
				upstreamRes.statusCode ?? 502,
				upstreamRes.statusMessage ?? "",
				responseHeaders(upstreamRes.headers),
			);
			// 流式回传：不缓冲、不按大小截断。
			upstreamRes.pipe(res);
		});
		upstream.on("error", () => {
			if (res.headersSent) res.destroy();
			else unavailable(res);
		});
		// 客户端中途离开时不得把上游请求挂在那里。
		res.on("close", () => upstream.destroy());
		// 请求体流式转发：DSH 自己按 maxRequestBodyBytes 决定接受或拒绝。
		req.pipe(upstream);
	});

	server.on("upgrade", (req, socket, head) => {
		const upstream = openUpstream(req, true);
		upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
			writeRawResponseHead(socket, upstreamRes);
			if (upstreamHead.length > 0) socket.write(upstreamHead);
			else if (head.length > 0) upstreamSocket.write(head);
			socket.pipe(upstreamSocket);
			upstreamSocket.pipe(socket);
			// 升级后的管道没有合法的半开状态：任一端 end/close/error 都必须回收两端，
			// 否则客户端断开后上游连接会在没有任何 'close' 事件的情况下悬挂。
			let torndown = false;
			const teardown = (): void => {
				if (torndown) return;
				torndown = true;
				socket.destroy();
				upstreamSocket.destroy();
			};
			socket.on("end", teardown);
			upstreamSocket.on("end", teardown);
			socket.on("close", teardown);
			upstreamSocket.on("close", teardown);
			socket.on("error", teardown);
			upstreamSocket.on("error", teardown);
			void upstreamRes;
		});
		upstream.on("response", (upstreamRes) => {
			// 上游明确拒绝 upgrade（401/403/404 等）：原样把状态码与正文交回，不伪装成 101。
			writeRawResponseHead(socket, upstreamRes);
			upstreamRes.pipe(socket);
			socket.on("close", () => upstreamRes.destroy());
		});
		upstream.on("error", () => socket.destroy());
		socket.on("error", () => upstream.destroy());
		upstream.end();
	});

	return server;
}
