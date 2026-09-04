import fs from "node:fs";
import path from "node:path";
import type { PluginConfig } from "./types.js";

/**
 * 解析 config.env 文件
 */
export function parseEnvFile(content: string): Record<string, string> {
	const result: Record<string, string> = {};
	const lines = content.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIndex = trimmed.indexOf("=");
		if (eqIndex === -1) continue;
		const key = trimmed.slice(0, eqIndex).trim();
		let val = trimmed.slice(eqIndex + 1).trim();
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1);
		}
		result[key] = val;
	}
	return result;
}

/**
 * 加载插件配置
 */
export function loadConfig(searchDir?: string): PluginConfig {
	const dir = searchDir ?? process.cwd();
	const envPath = path.join(dir, "config.env");

	let envFromFile: Record<string, string> = {};
	if (fs.existsSync(envPath)) {
		try {
			const content = fs.readFileSync(envPath, "utf-8");
			envFromFile = parseEnvFile(content);
		} catch (err) {
			process.stderr.write(`[VCPDeck] Failed to read config.env: ${err}\n`);
		}
	}

	const serverUrl =
		envFromFile.SERVER_URL ||
		process.env.VCPDECK_SERVER_URL ||
		process.env.SERVER_URL ||
		"";

	const apiToken =
		envFromFile.API_TOKEN ||
		process.env.VCPDECK_API_TOKEN ||
		process.env.API_TOKEN ||
		"";

	const timeoutStr =
		envFromFile.REQUEST_TIMEOUT_MS ||
		process.env.REQUEST_TIMEOUT_MS ||
		"300000";

	if (!serverUrl) {
		throw new Error(
			"Missing SERVER_URL in config.env or environment variables",
		);
	}
	if (!apiToken) {
		throw new Error(
			"Missing API_TOKEN in config.env or environment variables",
		);
	}

	const normalizedServerUrl = serverUrl.replace(/\/+$/, "");
	const publicShareBaseUrl = (
		envFromFile.PUBLIC_SHARE_BASE_URL ||
		process.env.PUBLIC_SHARE_BASE_URL ||
		normalizedServerUrl
	).replace(/\/+$/, "");
	try {
		const parsed = new URL(publicShareBaseUrl);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
	} catch {
		throw new Error("PUBLIC_SHARE_BASE_URL must be a valid HTTP(S) URL");
	}

	return {
		serverUrl: normalizedServerUrl,
		apiToken,
		publicShareBaseUrl,
		requestTimeoutMs: Number.parseInt(timeoutStr, 10) || 300000,
	};
}
