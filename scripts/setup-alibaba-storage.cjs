#!/usr/bin/env node
/**
 * VCPDeck 阿里云盘 Storage 配置引导（ADR-0016 真环境验收前置）
 *
 * 用法：
 *   node scripts/setup-alibaba-storage.cjs
 *
 * 流程：
 *   1. 检查 Server 连接 + 管理员登录
 *   2. 检查阿里云盘 OAuth 状态
 *   3. 如未授权：写入 clientId → 服务端生成 PKCE 与授权 URL →
 *      用户在浏览器完成授权 → 把 code 粘回 → 服务端用 PKCE 换 access_token
 *   4. 验证授权状态（driveId 已就绪）
 *   5. 切换 Storage 后端为 alibaba（触发热切换）
 *   6. 小型上传/下载冒烟，确认 SDK 工作
 *
 * 前置：
 *   - Server 已启动（如 pnpm --filter @vcpdeck/server start）
 *   - VCPDECK_ADMIN_PASSWORD 已注入或使用默认 test123
 *   - 已在 https://www.aliyundrive.com/ 创建应用，redirect_uri 设为 oob
 *
 * 该脚本只承担人工授权与切后端；真正的发布构件自更新验收见
 * scripts/test-release-alibaba.cjs。
 */

const readline = require("node:readline");

const BASE = process.env.VCPDECK_BASE || "http://localhost:3001";
const ADMIN_USERNAME = process.env.VCPDECK_ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD =
	process.env.VCPDECK_ADMIN_PASSWORD ||
	process.env.VCPDECK_PASSWORD ||
	"test123";
const DEFAULT_OPENAPI_BASE = "https://openapi.alipan.com";

let cookie = "";
const results = [];

function pass(name, detail) {
	results.push({ status: "PASS", name, detail: detail || "" });
	console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `: ${detail}` : ""}`);
}
function fail(name, detail) {
	results.push({ status: "FAIL", name, detail: detail || "" });
	console.log(`  \x1b[31m✗\x1b[0m ${name}: ${detail}`);
}
function step(label) {
	console.log(`\n── ${label} ──`);
}

async function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function api(method, path, opts = {}) {
	const headers = { ...(opts.headers || {}) };
	if (opts.json) headers["Content-Type"] = "application/json";
	if (!opts.noCookie && cookie) headers["Cookie"] = cookie;
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers,
		body: opts.json ? JSON.stringify(opts.json) : undefined,
		redirect: "manual",
	});
	const setCookie = res.headers.get("set-cookie");
	if (setCookie) {
		const m = setCookie.match(/vcpdeck_session=([^;]+)/);
		if (m) cookie = `vcpdeck_session=${m[1]}`;
	}
	return res;
}
async function apiJson(method, path, opts = {}) {
	const res = await api(method, path, opts);
	const text = await res.text();
	let body = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = text;
	}
	return { status: res.status, body };
}

function ask(question, hidden = false) {
	return new Promise((resolve) => {
		if (!hidden) {
			const rl = readline.createInterface({
				input: process.stdin,
				output: process.stdout,
			});
			rl.question(question, (a) => {
				rl.close();
				resolve(a.trim());
			});
			return;
		}
		const stdin = process.stdin;
		const stdout = process.stdout;
		if (stdin.isTTY) stdout.write(question);
		let buf = "";
		const onData = (c) => {
			const ch = c.toString();
			if (ch === "\n" || ch === "\r") {
				stdin.removeListener("data", onData);
				stdin.setRawMode?.(false);
				stdout.write("\n");
				resolve(buf);
				return;
			}
			if (ch === "\u0003") process.exit(0);
			if (ch === "\u007f" || ch === "\b") {
				if (buf.length > 0) buf = buf.slice(0, -1);
			} else {
				buf += ch;
			}
		};
		stdin.setRawMode?.(true);
		stdin.on("data", onData);
	});
}

function fmtTime(ms) {
	return new Date(ms).toLocaleString();
}

async function main() {
	console.log("\n╔══════════════════════════════════════════╗");
	console.log("║  VCPDeck 阿里云盘 Storage 授权引导      ║");
	console.log("╚══════════════════════════════════════════╝\n");
	console.log(`📡 Server: ${BASE}`);

	step("0. Server 健康检查");
	{
		const { status, body } = await apiJson("GET", "/api/health");
		if (status === 200 && body && body.ok) {
			pass("Server 在线");
		} else {
			fail("Server 不可达", "请先启动 Server 或检查 VCPDECK_BASE");
			return printReport();
		}
	}

	step("1. 管理员登录");
	{
		const { status, body } = await apiJson("POST", "/api/auth/login", {
			json: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
			noCookie: true,
		});
		if (
			(status === 200 || status === 201) &&
			body &&
			body.identity &&
			body.identity.isAdmin
		) {
			pass("管理员登录成功", `username=${body.identity.username}`);
		} else {
			fail("管理员登录失败", `status=${status}`);
			return printReport();
		}
	}

	step("2. 阿里云盘授权状态");
	const status0 = await apiJson("GET", "/api/aliyundrive/status");
	const sBody = status0.body || {};
	console.log(`  configured=${sBody.configured} authorized=${sBody.authorized}`);
	console.log(`  clientId=${sBody.clientId || "(未设置)"}`);
	console.log(`  driveId=${sBody.driveId || "(未知)"}`);
	if (sBody.expiresAt) {
		console.log(`  expiresAt=${fmtTime(sBody.expiresAt)}`);
	}

	if (!sBody.configured || !sBody.authorized) {
		step("3. 配置 clientId");
		const envClientId = process.env.ALIBABA_CLIENT_ID;
		const clientId =
			envClientId ||
			(await ask("  阿里云盘 App clientId（回车用环境变量）: "));
		if (!clientId) {
			fail("未提供 clientId", "已取消");
			return printReport();
		}
		const openapiBase =
			process.env.ALIBABA_OPENAPI_BASE ||
			(await ask(`  OpenAPI 地址 [${DEFAULT_OPENAPI_BASE}]: `)) ||
			DEFAULT_OPENAPI_BASE;
		const cfg = await apiJson("PUT", "/api/aliyundrive/config", {
			json: { clientId, openapiBase },
		});
		if (cfg.status === 200 || cfg.status === 201) {
			pass("clientId 已保存");
		} else {
			fail("保存 clientId 失败", JSON.stringify(cfg.body));
			return printReport();
		}

		step("4. OAuth PKCE 授权");
		const start = await apiJson("POST", "/api/aliyundrive/oauth/start");
		if (start.status !== 200 && start.status !== 201) {
			fail("生成授权 URL 失败", JSON.stringify(start.body));
			return printReport();
		}
		const { authorizationUrl, state } = start.body;
		console.log("");
		console.log("🔗 请在浏览器中打开以下 URL 并完成授权：\n");
		console.log(`   \x1b[36m${authorizationUrl}\x1b[0m\n`);
		console.log("   授权完成后，复制浏览器地址栏中的 code 参数值");
		console.log("   （或粘贴整个包含 code= 的 URL）。\n");

		const codeInput = await ask("   code (或完整 callback URL): ");
		let code = codeInput.trim();
		const codeMatch = code.match(/[?&]code=([^&]+)/);
		if (codeMatch) code = decodeURIComponent(codeMatch[1]);
		if (!code) {
			fail("未输入 code", "已取消");
			return printReport();
		}
		const complete = await apiJson("POST", "/api/aliyundrive/oauth/complete", {
			json: { state, code },
		});
		if (complete.status === 200 || complete.status === 201) {
			pass("OAuth 授权成功", `expiresAt=${fmtTime(complete.body.expiresAt)}`);
		} else {
			fail("OAuth 授权失败", JSON.stringify(complete.body));
			return printReport();
		}
	} else {
		pass("阿里云盘已授权", "跳过 OAuth 步骤");
	}

	step("5. 验证授权（拉 driveId）");
	let attempt = 0;
	let verified = false;
	while (attempt < 5 && !verified) {
		attempt++;
		const check = await apiJson("POST", "/api/aliyundrive/verify");
		if (check.body && check.body.valid && check.body.driveId) {
			verified = true;
			pass("授权有效 + driveId 已就绪", `driveId=${check.body.driveId}`);
			break;
		}
		await sleep(1500);
	}
	if (!verified) {
		fail("授权未生效", "请检查网络与 token 是否过期；可重跑本脚本");
		return printReport();
	}

	step("6. 切换 Storage 后端为 alibaba");
	const cfgBefore = await apiJson("GET", "/api/storage/config");
	if (cfgBefore.body && cfgBefore.body.kind === "alibaba") {
		pass("已是 alibaba 后端", "无需切换");
	} else {
		const sw = await apiJson("PUT", "/api/storage/config", {
			json: { kind: "alibaba" },
		});
		if (sw.status === 200 || sw.status === 201) {
			pass("Storage 后端切换为 alibaba");
		} else {
			fail("切换失败", JSON.stringify(sw.body));
			return printReport();
		}
	}

	step("7. 小型上传/下载冒烟（确认 SDK 工作）");
	{
		const sample = `vcpdeck-alibaba-ready-${Date.now()}\n`;
		const tok = await apiJson("POST", "/api/storage/upload-token", {
			json: {
				clientId: "setup-smoke",
				filename: "setup-smoke.txt",
				size: sample.length,
			},
		});
		if (tok.status !== 200 && tok.status !== 201) {
			fail("上传令牌获取失败", `status=${tok.status}`);
			return printReport();
		}
		const put = await fetch(`${BASE}${tok.body.url}`, {
			method: "PUT",
			headers: { "Content-Type": "text/plain" },
			body: sample,
		});
		const putBody = await put.json().catch(() => null);
		if (put.status !== 200 || !putBody || !putBody.key) {
			fail("上传失败", `status=${put.status}`);
			return printReport();
		}
		pass("上传成功", `fileId=${String(putBody.key).slice(0, 16)}...`);

		const dl = await apiJson("POST", "/api/storage/download-token", {
			json: { key: putBody.key },
		});
		if (dl.status !== 200 && dl.status !== 201) {
			fail("下载令牌失败", `status=${dl.status}`);
			return printReport();
		}
		// alibaba 后端：download-token 返回真实阿里云临时 URL（外部直链）
		const fetchDl = await fetch(
			dl.body.url.startsWith("http") ? dl.body.url : `${BASE}${dl.body.url}`,
		);
		const got = await fetchDl.text();
		if (fetchDl.status === 200 && got === sample) {
			pass("下载内容匹配", `${got.length} bytes`);
		} else {
			fail("下载内容不匹配", `status=${fetchDl.status}`);
			return printReport();
		}

		await apiJson("DELETE", `/api/storage/${encodeURIComponent(putBody.key)}`);
	}

	printReport();
}

function printReport() {
	console.log("\n=== 授权引导报告 ===\n");
	const passed = results.filter((r) => r.status === "PASS").length;
	const failed = results.filter((r) => r.status === "FAIL").length;
	console.log(`  ${passed}/${results.length} passed, ${failed} failed\n`);
	if (failed === 0) {
		console.log(
			"✅ 授权与后端切换完成。",
		);
		console.log("   下一步：node scripts/test-release-alibaba.cjs");
		console.log("   （真实环境发布构件直连自更新验收）");
	}
	process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
	console.error(`\n\x1b[31mFatal:\x1b[0m ${e.message}`);
	process.exit(1);
});