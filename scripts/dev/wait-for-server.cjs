#!/usr/bin/env node

const DEFAULT_SERVER = "http://localhost:3001";
const DEFAULT_POLL_MS = 300;
const DEFAULT_REQUEST_TIMEOUT_MS = 1000;
const DEFAULT_TIMEOUT_MS = 60_000;

function getHealthUrl(serverUrl) {
	return `${serverUrl.replace(/\/+$/, "")}/api/health`;
}

async function waitForServer(
	serverUrl = process.env.VCPDECK_SERVER || DEFAULT_SERVER,
	options = {},
) {
	const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
	const requestTimeoutMs =
		options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const healthUrl = getHealthUrl(serverUrl);
	const deadline = Date.now() + timeoutMs;
	let lastError = "未收到健康响应";

	while (Date.now() < deadline) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
		try {
			const response = await fetch(healthUrl, { signal: controller.signal });
			if (response.ok) return;
			lastError = `HTTP ${response.status}`;
			await response.body?.cancel();
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		} finally {
			clearTimeout(timer);
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}

	throw new Error(
		`等待 Server 就绪超时（${healthUrl}，最近错误：${lastError}）`,
	);
}

if (require.main === module) {
	const serverUrl = process.env.VCPDECK_SERVER || DEFAULT_SERVER;
	console.log(`[vcpdeck] 等待 Server 就绪: ${getHealthUrl(serverUrl)}`);
	waitForServer(serverUrl)
		.then(() => console.log("[vcpdeck] Server 已就绪，启动 Client"))
		.catch((error) => {
			console.error(`[vcpdeck] ${error.message}`);
			process.exitCode = 1;
		});
}

module.exports = { getHealthUrl, waitForServer };
