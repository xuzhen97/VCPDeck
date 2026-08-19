#!/usr/bin/env node
/**
 * VCPDeck 阿里云盘 Storage 配置引导（ADR-0016 真环境验收前置，自动化版）
 *
 * 用法：
 *   node scripts/setup-alibaba-storage.cjs
 *
 * 自动化部分：
 *   - 检查 Server 健康、登录管理员、写 clientId、生成 PKCE 授权 URL、
 *     验证 driveId、切 storage 后端为 alibaba、小型上传/下载冒烟
 *
 * 需要你介入的两个瞬间（脚本会自动暂停等你）：
 *   1. 第一次需要输入 clientId 时
 *   2. 浏览器完成 OAuth 后，需要你把回调 code（或完整 callback URL）粘回
 *
 * 敏感字段从环境变量读取（更省事）：
 *   VCPDECK_BASE、VCPDECK_ADMIN_USERNAME、VCPDECK_ADMIN_PASSWORD、
 *   ALIBABA_CLIENT_ID、ALIBABA_OPENAPI_BASE
 *
 * 前置：
 *   - Server 已运行（pnpm --filter @vcpdeck/server dev 或生产部署）
 *   - 已在 https://www.aliyundrive.com/ 开发者中心创建应用，
 *     redirect_uri 必须填 oob
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

function ask(question) {
	return new Promise((resolve) => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(question, (a) => {
			rl.close();
			resolve(a.trim());
		});
	});
}

function fmtTime(ms) {
	return new Date(ms).toLocaleString();
}

async function waitForServer(timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const r = await fetch(`${BASE}/api/health`);
			if (r.ok) {
				const j = await r.json();
				if (j && j.ok) return true;
			}
		} catch {
			// 端口还没开
		}
		await sleep(1000);
	}
	return false;
}

async function main() {
	console.log("\n╔══════════════════════════════════════════╗");
	console.log("║  VCPDeck 阿里云盘 Storage 授权引导      ║");
	console.log("║  （自动化 + 两个介入点）                ║");
	console.log("╚══════════════════════════════════════════╝\n");
	console.log(`📡 Server: ${BASE}`);

 step("Server 在线待");
 if (process.env.VCPDECK_ADMIN_PASSWORD) {
 console.log(`  使用环境变量中的管理员凭据（用户名=${ADMIN_USERNAME}）`);
 }

 if (!(await waitForServer())) {
 fail("Server 不可达", `请先起 Server（pnpm --filter @vcpdeck/server dev）`);
 return printReport();
 }
 pass("Server 在线");

	{
 const r = await apiJson("POST", "/api/auth/login", {
 json: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
 noCookie: true,
 });
 if (
 (r.status === 200 || r.status === 201) &&
 r.body &&
 r.body.identity &&
 r.body.identity.isAdmin
 ) {
 pass("管理员登录成功", `username=${r.body.identity.username}`);
 } else {
 fail("管理员登录失败", `status=${r.status}`);
 return printReport();
 }
	}

 step("阿里云盘授权状态");
 const status0 = await apiJson("GET", "/api/aliyundrive/status");
 const sBody = status0.body || {};
 console.log(`  configured=${sBody.configured} authorized=${sBody.authorized}`);
 if (sBody.expiresAt) console.log(`  expiresAt=${fmtTime(sBody.expiresAt)}`);

 if (!sBody.configured || !sBody.authorized) {
 // 介入点 1：clientId
 step("需要你输入 clientId");
 let clientId = process.env.ALIBABA_CLIENT_ID;
 if (clientId) {
 console.log(`  使用环境变量 ALIBABA_CLIENT_ID（${clientId.slice(0, 8)}...）`);
 } else {
 console.log("");
 console.log("📋 请前往 https://www.aliyundrive.com/ 开发者中心创建应用：");
 console.log("   - 应用名称：自填（如 VCPDeck E2E）");
 console.log("   - 应用类型：自填");
 console.log("   - **redirect_uri 必须填 oob**");
 console.log("   - 权限：勾选 user:base / file:all:read / file:all:write");
 console.log("");
 console.log("   创建完成后，把 clientId 复制到这里：");
 console.log("");
 clientId = await ask("  clientId（也可 export ALIBABA_CLIENT_ID=... 后跳过）: ");
 if (!clientId) {
 fail("未提供 clientId", "已取消");
 return printReport();
 }
 }

 const openapiBase =
 process.env.ALIBABA_OPENAPI_BASE || DEFAULT_OPENAPI_BASE;

 const cfg = await apiJson("PUT", "/api/aliyundrive/config", {
 json: { clientId, openapiBase },
 });
 if (cfg.status === 200 || cfg.status === 201) {
 pass("clientId 已保存");
 } else {
 fail("保存 clientId 失败", JSON.stringify(cfg.body));
 return printReport();
 }

 step("生成授权 URL");
 const start = await apiJson("POST", "/api/aliyundrive/oauth/start");
 if (start.status !== 200 && start.status !== 201) {
 fail("生成授权 URL 失败", JSON.stringify(start.body));
 return printReport();
 }
 const { authorizationUrl, state } = start.body;

 // 介入点 2：浏览器授权 + 粘贴 code
 step("需要你在浏览器授权后把 code 粘回来");
 console.log("");
 console.log("🔗 请按以下步骤操作：");
 console.log("");
 console.log("  1. 在浏览器打开下面的 URL 并完成登录/授权：");
 console.log("");
 console.log(`     \x1b[36m${authorizationUrl}\x1b[0m`);
 console.log("");
 console.log("  2. 授权完成后，浏览器会跳转到：");
 console.log("     https://www.aliyundrive.com/oob/?code=XXXXX&state=YYYYY");
 console.log("");
 console.log("  3. 复制整个地址栏的 URL（或只复制 code= 后面的那段）");
 console.log("     粘到下面：");
 console.log("");
 console.log("     （脚本会等 5 分钟内你的输入；超时自动退出）");
 console.log("");

 const codeInput = await Promise.race([
 ask("  code (或完整 callback URL): "),
 sleep(300_000).then(() => null),
 ]);
 if (!codeInput) {
 fail("超时未输入 code", "已取消");
 return printReport();
 }
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

 step("验证授权（拉 driveId）");
let attempt = 0;
 let driveId = null;
 while (attempt < 5 && !driveId) {
 attempt++;
 const check = await apiJson("POST", "/api/aliyundrive/verify");
 if (check.body && check.body.valid && check.body.driveId) {
 driveId = check.body.driveId;
 pass("授权有效 + driveId 已就绪", `driveId=${driveId}`);
 break;
 }
 await sleep(1500);
 }
 if (!driveId) {
 fail("授权未生效", "请检查网络与 token 是否过期；可重跑本脚本");
 return printReport();
 }

 step("切换 Storage 后端为 alibaba");
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

 step("小型上传/下载冒烟（确认 SDK 工作）");
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
		console.log("✅ 授权与后端切换完成。");
		console.log("   下一步：node scripts/test-release-alibaba.cjs");
		console.log("   （真实环境发布构件直连自更新验收）");
	}
	process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
	console.error(`\n\x1b[31mFatal:\x1b[0m ${e.message}`);
	process.exit(1);
});