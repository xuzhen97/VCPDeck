import { VcpDeckClient } from "@vcpdeck/sdk";
import { loadConfig } from "./config.js";
import { dispatchCommand } from "./dispatcher.js";
import type { VcpRequest, VcpResponse } from "./types.js";

/**
 * 安全输出 JSON 到 stdout
 */
function sendResponse(response: VcpResponse) {
	// 对齐 VCP 标准 synchronous stdio 协议：{ status: "success", result: { content: [...] }, messageForAI }
	const payload = {
		status: response.status,
		result: {
			content: response.content || response.result?.content || [],
		},
		messageForAI: response.messageForAI,
		content: response.content || response.result?.content || [],
	};
	process.stdout.write(JSON.stringify(payload));
}

/**
 * 格式化错误并输出
 */
function sendError(err: unknown) {
	const message = err instanceof Error ? err.message : String(err);
	const response = {
		status: "error",
		error: message,
		result: {
			content: [
				{
					type: "text" as const,
					text: message,
				},
			],
		},
		messageForAI: `执行失败: ${message}`,
	};
	process.stdout.write(JSON.stringify(response));
}

/**
 * 读取 stdin 输入
 */
async function readStdin(): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		process.stdin.setEncoding("utf-8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolve(data);
		});
		process.stdin.on("error", (err) => {
			reject(err);
		});
	});
}

/**
 * 主入口
 */
async function main() {
	let rawInput = "";
	try {
		rawInput = await readStdin();
		if (!rawInput.trim()) {
			throw new Error("No input received on stdin");
		}

		let req: VcpRequest;
		try {
			req = JSON.parse(rawInput);
		} catch {
			throw new Error(`Invalid JSON input: ${rawInput}`);
		}

		const config = loadConfig();
		const client = new VcpDeckClient({
			baseUrl: config.serverUrl,
			auth: {
				type: "bearer",
				token: config.apiToken,
			},
		});

		const res = await dispatchCommand(client, req);
		sendResponse(res);
	} catch (err) {
		process.stderr.write(`[VCPDeck] Error: ${err}\n`);
		sendError(err);
	}
}

main().catch((err) => {
	process.stderr.write(`[VCPDeck] Fatal: ${err}\n`);
	process.exit(1);
});
