#!/usr/bin/env node
/**
 * VCPDeck 发布构件经阿里云盘直连自更新集成测试（ADR-0016 真环境验收）
 *
 * 用法：
 *   node scripts/test-release-alibaba.cjs
 *
 * 前置：
 *   1. 已运行 scripts/setup-alibaba-storage.cjs 完成 OAuth 授权 + storage=alibaba
 *   2. 全量构建（pnpm build）
 *   3. Server 不在外部运行（脚本自己启停）
 *
 * 流程：
 *   1. 构建新版本 0.1.18（pnpm release）
 *   2. install.cjs 安装 server 0.1.17 作为基线
 *   3. 启动 server Launcher
 *   4. install.cjs 安装 client 0.1.17 作为基线
 *   5. 启动 client Launcher（守护真 client 进程）
 *   6. 确认 Server/Client 都连上
 *   7. CLI 上传两个平台 0.1.18 → 自动转存 alibaba + 记录 storage
 *   8. 轮询 /api/releases 直到 done
 *   9. 验证：serverVersion=0.1.18、client.clientVersion=0.1.18
 *  10. 验证：VCPDECK_RELEASES_DIR 下没有 0.1.18 zip（ADR-0016 标志）
 *  11. 清理（uninstall）
 *
 * 关键 ADR-0016 验收点：
 *   - Release.archives[plat].storage 字段为 { provider: 'alibaba', key, mode: 'direct' }
 *   - 目标机通过 GET /api/releases/:version/file 收到 302 直链
 *   - 字节流不经过 Server 监听端口
 */

const { spawn, execFileSync } = require("node:child_process");
const { existsSync, readFileSync, rmSync, mkdirSync, statSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir, homedir, hostname, platform: nodePlatform } = require("node:os");

const ROOT = resolve(__dirname, "..");
const BASE = process.env.VCPDECK_BASE || "http://localhost:3001";
const ADMIN_USERNAME = process.env.VCPDECK_ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD =
	process.env.VCPDECK_ADMIN_PASSWORD || "test123";
const NEW_VERSION = "0.1.18";
const BASE_VERSION = "0.1.17";
const TEST_CLIENT_ID =
	process.env.VCPDECK_TEST_CLIENT_ID ||
	`alibaba-e2e-${nodePlatform()}-${Date.now()}`;

let cookie = "";
const results = [];
let serverLauncher = null;
let clientLauncher = null;

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

/** 等待 Server /api/status 返回 listening */
async function waitForServer(timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const r = await fetch(`${BASE}/api/health`);
			if (r.ok) {
				const j = await r.json();
				if (j && j.ok) return;
			}
		} catch {
			// 端口还没开
		}
		await sleep(1000);
	}
	throw new Error("Server 在超时时间内未就绪");
}

/** 等待 Server Launcher 完成 prepare 后，/api/status.serverVersion 等于目标 */
async function waitForServerVersion(version, timeoutMs = 600_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const r = await apiJson("GET", "/api/status");
			if (r.status === 200 && r.body && r.body.serverVersion === version) {
				return r.body;
			}
		} catch {
			// 忽略瞬时
		}
		await sleep(2000);
	}
	throw new Error(`Server 未在 ${timeoutMs / 1000}s 内切到 ${version}`);
}

/** 轮询 Release 状态直到终态 */
async function waitForReleaseDone(timeoutMs = 600_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const r = await apiJson("GET", "/api/releases");
		if (r.status === 200 && r.body && Array.isArray(r.body.data)) {
			const target = r.body.data.find((x) => x.version === NEW_VERSION);
			if (target) {
				if (target.status === "done") return target;
				if (target.status === "failed") {
					throw new Error(
						`Release failed: ${target.errorMessage || "(无原因)"}`,
					);
				}
			}
		}
		await sleep(2000);
	}
	throw new Error(`Release 未在 ${timeoutMs / 1000}s 内进入 done`);
}

/** 等待指定 client 上线、版本对齐 */
async function waitForClient(clientId, version, timeoutMs = 600_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const r = await apiJson("GET", "/api/clients");
		if (r.status === 200 && Array.isArray(r.body)) {
			const c = r.body.find((x) => x.clientId === clientId);
			if (
				c &&
				c.online === true &&
				(!version || c.clientVersion === version)
			) {
				return c;
			}
		}
		await sleep(2000);
	}
	throw new Error(`Client ${clientId} 在 ${timeoutMs / 1000}s 内未满足要求`);
}

/** 执行 install.cjs；返回 Promise<{ code, stdout, stderr }> */
function runInstall(args) {
	return new Promise((resolveP) => {
		const p = spawn(
			process.execPath,
			[join(ROOT, "scripts", "install.cjs"), ...args],
			{
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env },
			},
		);
		let stdout = "";
		let stderr = "";
		p.stdout.on("data", (c) => {
			stdout += c.toString();
		});
		p.stderr.on("data", (c) => {
			stderr += c.toString();
		});
		p.on("close", (code) => resolveP({ code, stdout, stderr }));
	});
}

/** 启动 Launcher（使用真 launcher 包，环境变量指定 app-dir + artifact） */
function startLauncher({ appDir, artifact, env, logTag }) {
	mkdirSync(appDir, { recursive: true });
	const child = spawn(
		process.execPath,
		[join(ROOT, "packages", "launcher", "dist", "main.js")],
		{
			cwd: appDir,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...env },
		},
	);
	const prefix = `[launcher:${logTag}]`;
	child.stdout.on("data", (c) => {
		const t = c.toString();
		process.stdout.write(`${prefix} ${t}`);
	});
	child.stderr.on("data", (c) => {
		process.stderr.write(`${prefix}-err ${c.toString()}`);
	});
	return child;
}

/** 杀进程树：SIGTERM → 等 5s → SIGKILL；Windows 走 taskkill */
function killTree(child) {
	if (!child || child.killed || child.exitCode !== null) return;
	try {
		if (nodePlatform() === "win32") {
			try {
				execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
					stdio: "ignore",
					timeout: 5_000,
				});
				return;
			} catch {
				// taskkill 可能因权限失败，回退到 child.kill
			}
		}
		try {
			child.kill("SIGTERM");
		} catch {
			// 进程可能已退出
		}
		setTimeout(() => {
			try {
				if (!child.killed && child.exitCode === null) {
					child.kill("SIGKILL");
				}
			} catch {
				// 进程已退出
			}
		}, 5_000);
	} catch {
		// 兜底
		try {
			child.kill("SIGKILL");
		} catch {
			// 忽略
		}
	}
}

async function main() {
	console.log("\n╔══════════════════════════════════════════╗");
	console.log("║  VCPDeck 阿里云盘自更新集成测试        ║");
	console.log("║  （ADR-0016 真环境验收）               ║");
	console.log("╚══════════════════════════════════════════╝\n");
	console.log(`📡 Server: ${BASE}`);
	console.log(`🎯 目标: Server ${BASE_VERSION} → ${NEW_VERSION}, Client ${BASE_VERSION} → ${NEW_VERSION}`);

	const serverAppDir = join(tmpdir(), `vcpdeck-aliyun-e2e-server-${process.pid}`);
	const clientAppDir = join(tmpdir(), `vcpdeck-aliyun-e2e-client-${process.pid}`);
	const serverReleasesDir = join(serverAppDir, "releases");
	const serverDbPath = join(serverAppDir, "server.db");
	const zipBase = join(ROOT, "dist-release", `vcpdeck-${NEW_VERSION}`);

	try {
		step("0. 检查前置条件（storage=alibaba / 全量构建）");
		{
			const cfg = await apiJson("GET", "/api/storage/config");
			if (cfg.status === 200 && cfg.body && cfg.body.kind === "alibaba") {
				pass("Storage 后端为 alibaba");
			} else {
				fail(
					"Storage 后端不是 alibaba",
					"请先跑 scripts/setup-alibaba-storage.cjs",
				);
				return;
			}
			for (const p of [
				"packages/cli/dist/index.js",
				"packages/launcher/dist/main.js",
				"packages/server/dist/main.js",
				"packages/client/dist/index.js",
			]) {
				if (!existsSync(join(ROOT, p))) {
					fail("缺构件", `请先 pnpm build（缺 ${p}）`);
					return;
				}
			}
			pass("CLI / Launcher / Server / Client 构件齐全");
		}

		step(`1. 构建新版本 ${NEW_VERSION}`);
		{
			const bothZipExist = ["win-x64", "linux-x64"].every((p) =>
				existsSync(`${zipBase}-${p}.zip`),
			);
			if (bothZipExist) {
				pass(
					"两份 zip 已存在",
					`dist-release/vcpdeck-${NEW_VERSION}-{win,linux}-x64.zip`,
				);
			} else {
				console.log("  正在打包（首次需要数分钟）...");
				try {
					execFileSync(
						"pnpm",
						["release", `--version=${NEW_VERSION}`],
						{
							cwd: ROOT,
							stdio: "inherit",
							env: { ...process.env },
						},
					);
				} catch (e) {
					fail("打包失败", e.message);
					return;
				}
				pass("打包完成", `${zipBase}-{win,linux}-x64.zip`);
			}
		}

		step("2. 安装 Server 基线版本");
		{
			// 选定本机平台 zip
			const isWin = nodePlatform() === "win32";
			const zipName = isWin
				? `vcpdeck-${BASE_VERSION}-win-x64.zip`
				: `vcpdeck-${BASE_VERSION}-linux-x64.zip`;
			// 同样需要这个 zip；如果没有，重新跑 release 用 BASE_VERSION
			const zipPath = join(ROOT, "dist-release", zipName);
			if (!existsSync(zipPath)) {
				console.log(`  缺少基线 zip，重新打包 ${BASE_VERSION}...`);
				try {
					execFileSync(
						"pnpm",
						["release", `--version=${BASE_VERSION}`],
						{
							cwd: ROOT,
							stdio: "inherit",
							env: { ...process.env },
						},
					);
				} catch (e) {
					fail("基线打包失败", e.message);
					return;
				}
			}
			mkdirSync(serverAppDir, { recursive: true });
			const envArgs = [
				`--artifact=server`,
				`--zip=${zipPath}`,
				`--app-dir=${serverAppDir}`,
				`--db-url=file:${serverDbPath.replace(/\\/g, "/")}`,
				`--releases-dir=${serverReleasesDir}`,
				`--psk=${ADMIN_PASSWORD}`,
				`--admin-password=${ADMIN_PASSWORD}`,
				`--no-env`,
				"--force",
			];
			// 写 launcher.env 给 launcher 用
			mkdirSync(serverAppDir, { recursive: true });
			const envContent = [
				"# auto-generated by test-release-alibaba.cjs",
				`VCPDECK_APP_DIR=${serverAppDir}`,
				"VCPDECK_ARTIFACT=server",
				`VCPDECK_PSK=${ADMIN_PASSWORD}`,
				`VCPDECK_ADMIN_PASSWORD=${ADMIN_PASSWORD}`,
				"VCPDECK_COOKIE_SECURE=false",
				`DATABASE_URL=file:${serverDbPath.replace(/\\/g, "/")}`,
				`VCPDECK_RELEASES_DIR=${serverReleasesDir}`,
				"VCPDECK_PROBE_URL=http://127.0.0.1:3001/api/status",
				"",
			].join("\n");
			// install.cjs --no-env 不写 env 文件；手动写一份给 launcher
			require("node:fs").writeFileSync(
				join(serverAppDir, "launcher.env"),
				envContent,
			);
			const r = await runInstall(envArgs);
			if (r.code !== 0) {
				fail("install server 失败", r.stderr || r.stdout.slice(-500));
				return;
			}
			pass(`Server ${BASE_VERSION} 已安装`, serverAppDir);
		}

		step("3. 启动 Server Launcher");
			serverLauncher = startLauncher({
				appDir: serverAppDir,
				artifact: "server",
				env: {
					VCPDECK_APP_DIR: serverAppDir,
					VCPDECK_ARTIFACT: "server",
					VCPDECK_PSK: ADMIN_PASSWORD,
					VCPDECK_ADMIN_PASSWORD: ADMIN_PASSWORD,
					VCPDECK_COOKIE_SECURE: "false",
					DATABASE_URL: `file:${serverDbPath.replace(/\\/g, "/")}`,
					VCPDECK_RELEASES_DIR: serverReleasesDir,
					VCPDECK_PROBE_URL: `${BASE}/api/status`,
				},
				logTag: "server",
			});
			try {
				await waitForServer();
				pass("Server Launcher 拉起 Server + 健康检查通过");
			} catch (e) {
				fail("Server 启动失败", e.message);
				return;
			}

		step("4. 管理员登录 + 验证 storage=alibaba");
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
				pass("管理员登录成功");
			} else {
				fail("管理员登录失败", `status=${r.status}`);
				return;
			}
			const cfg = await apiJson("GET", "/api/storage/config");
			if (cfg.status === 200 && cfg.body && cfg.body.kind === "alibaba") {
				pass("Storage 仍为 alibaba（重启后热加载）");
			} else {
				fail("重启后 storage 不是 alibaba", JSON.stringify(cfg.body));
				return;
			}
		}

		step(`5. 安装 Client 基线版本 ${BASE_VERSION}`);
		{
			const isWin = nodePlatform() === "win32";
			const zipName = isWin
				? `vcpdeck-${BASE_VERSION}-win-x64.zip`
				: `vcpdeck-${BASE_VERSION}-linux-x64.zip`;
			const zipPath = join(ROOT, "dist-release", zipName);
			mkdirSync(clientAppDir, { recursive: true });
			require("node:fs").writeFileSync(
				join(clientAppDir, "launcher.env"),
				[
					`VCPDECK_APP_DIR=${clientAppDir}`,
					"VCPDECK_ARTIFACT=client",
					`VCPDECK_SERVER=${BASE}`,
					`VCPDECK_PSK=${ADMIN_PASSWORD}`,
					`VCPDECK_CLIENT_ID=${TEST_CLIENT_ID}`,
					"",
				].join("\n"),
			);
			const r = await runInstall([
				"--artifact=client",
				`--zip=${zipPath}`,
				`--app-dir=${clientAppDir}`,
				`--server-url=${BASE}`,
				`--psk=${ADMIN_PASSWORD}`,
				`--client-id=${TEST_CLIENT_ID}`,
				`--no-env`,
				"--force",
			]);
			if (r.code !== 0) {
				fail("install client 失败", r.stderr || r.stdout.slice(-500));
				return;
			}
			pass(`Client ${BASE_VERSION} 已安装`, clientAppDir);
		}

		step("6. 启动 Client Launcher");
			clientLauncher = startLauncher({
				appDir: clientAppDir,
				artifact: "client",
				env: {
					VCPDECK_APP_DIR: clientAppDir,
					VCPDECK_ARTIFACT: "client",
					VCPDECK_SERVER: BASE,
					VCPDECK_PSK: ADMIN_PASSWORD,
					VCPDECK_CLIENT_ID: TEST_CLIENT_ID,
				},
				logTag: "client",
			});
			try {
				const c = await waitForClient(TEST_CLIENT_ID, BASE_VERSION);
				pass(
					`Client 已连接`,
					`version=${c.clientVersion} os=${c.os || "?"}`,
				);
			} catch (e) {
				fail("Client 未在预期时间内连接", e.message);
				return;
			}

		step(`7. CLI 上传 ${NEW_VERSION} 两个平台（自动转存 alibaba）`);
			try {
				execFileSync(
					process.execPath,
					[
						join(ROOT, "packages", "cli", "dist", "index.js"),
						"release",
						"upload",
						`${zipBase}-win-x64.zip`,
						`${zipBase}-linux-x64.zip`,
						`--server=${BASE}`,
						`--username=${ADMIN_USERNAME}`,
						`--password=${ADMIN_PASSWORD}`,
					],
					{
						cwd: ROOT,
						stdio: "inherit",
						env: {
							...process.env,
							VCPDECK_ADMIN_USERNAME: ADMIN_USERNAME,
							VCPDECK_ADMIN_PASSWORD: ADMIN_PASSWORD,
						},
					},
				);
			} catch (e) {
				fail("CLI 上传失败", e.message);
				return;
			}
			pass("两个平台 zip 已上传（自动转存 alibaba）");

		step("8. 验证 Release 元数据记录 storage 字段（ADR-0016 关键标志）");
		{
			const r = await apiJson("GET", "/api/releases");
			const target =
				r.body && Array.isArray(r.body.data)
					? r.body.data.find((x) => x.version === NEW_VERSION)
					: null;
			if (!target) {
				fail("未找到刚上传的 Release");
				return;
			}
			console.log("  archives:");
			for (const [plat, info] of Object.entries(target.archives)) {
				console.log(
					`    ${plat}: sha256=${String(info.sha256).slice(0, 12)}... size=${info.size}`,
				);
				if (info.storage) {
					console.log(
						`      storage=${JSON.stringify(info.storage)}`,
					);
				}
			}
			const allDirect = ["win-x64", "linux-x64"].every(
				(p) =>
					target.archives[p] &&
					target.archives[p].storage &&
					target.archives[p].storage.mode === "direct",
			);
			if (allDirect) {
				pass("两个平台 archive 都记录了 storage.mode=direct");
			} else {
				fail(
					"archive 未记录 storage 字段",
					"ADR-0016 关键标志未命中",
				);
				return;
			}
			// 不应落本地
			const localPath = join(
				serverReleasesDir,
				`vcpdeck-${NEW_VERSION}-win-x64.zip`,
			);
			if (existsSync(localPath)) {
				fail(
					"VCPDECK_RELEASES_DIR 下仍有 zip",
					"ADR-0016：应仅在 alibaba",
				);
				return;
			} else {
				pass(
					"VCPDECK_RELEASES_DIR 下无 zip",
					"ADR-0016：构件仅在 alibaba，Server 不再承载字节",
				);
			}
		}

		step("9. 验证下载端点返回 302 直链（ADR-0016 关键标志）");
		{
			const r = await fetch(
				`${BASE}/api/releases/${NEW_VERSION}/file?platform=win-x64`,
				{ redirect: "manual" },
			);
			if (r.status === 302) {
				const loc = r.headers.get("location") || "";
				const startsAliyun =
					loc.startsWith("https://") &&
					(loc.includes("alipan") ||
						loc.includes("aliyundrive") ||
						loc.includes("alibaba"));
				if (startsAliyun) {
					pass(
						"download 302 到 aliyun 直链",
						loc.slice(0, 60) + "...",
					);
				} else {
					fail(
						"302 但 Location 不是 aliyun 直链",
						`status=${r.status} location=${loc.slice(0, 80)}`,
					);
					return;
				}
			} else {
				fail(
					"download 未返回 302",
					`status=${r.status}（ADR-0016 期望 302 直链）`,
				);
				return;
			}
		}

		step(`10. 等待 Server 自更新到 ${NEW_VERSION}`);
			try {
				const s = await waitForServerVersion(NEW_VERSION);
				pass(
					`Server 已更新到 ${NEW_VERSION}`,
					`serverVersion=${s.serverVersion}`,
				);
			} catch (e) {
				fail("Server 自更新未完成", e.message);
				return;
			}

		step(`11. 等待 Client 自更新到 ${NEW_VERSION}`);
			try {
				// 重新登录（Server 重启后 session 可能失效）
				cookie = "";
				await apiJson("POST", "/api/auth/login", {
					json: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
					noCookie: true,
				});
				const c = await waitForClient(TEST_CLIENT_ID, NEW_VERSION);
				pass(
					`Client 已更新到 ${NEW_VERSION}`,
					`clientVersion=${c.clientVersion}`,
				);
			} catch (e) {
				fail("Client 自更新未完成", e.message);
				return;
			}

		step("12. 等待 Release 进入 done");
			try {
				const target = await waitForReleaseDone();
				const failedClients = Object.entries(target.clientStates || {})
					.filter(([, v]) => v.state === "failed")
					.map(([k]) => k);
				if (failedClients.length === 0) {
					pass(
						"Release done，无 client 失败",
						`clients=${Object.keys(target.clientStates || {}).length}`,
					);
				} else {
					fail("Release done 但有 client 失败", failedClients.join(", "));
				}
			} catch (e) {
				fail("Release 未进入 done", e.message);
				return;
			}

		printReport();
	} finally {
		step("清理：杀掉 Launcher 与测试目录");
		if (serverLauncher) killTree(serverLauncher);
		if (clientLauncher) killTree(clientLauncher);
		try {
			rmSync(serverAppDir, { recursive: true, force: true });
		} catch (e) {
			console.error("清理 serverAppDir 失败: " + e.message);
		}
		try {
			rmSync(clientAppDir, { recursive: true, force: true });
		} catch (e) {
			console.error("清理 clientAppDir 失败: " + e.message);
		}
	}
}

function printReport() {
	console.log("\n=== 集成测试报告 ===\n");
	const passed = results.filter((r) => r.status === "PASS").length;
	const failed = results.filter((r) => r.status === "FAIL").length;
	for (const r of results) {
		const icon = r.status === "PASS" ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
		console.log(`  ${icon} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
	}
	console.log(
		`\n  ${passed}/${results.length} passed, ${failed} failed\n`,
	);
	if (failed === 0) {
		console.log(
			"✅ ADR-0016 阿里云盘直连分发自更新链路验证通过",
		);
	}
	process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
	console.error("\n\u001b[31mFatal:\u001b[0m " + e.message);
	console.error(e.stack);
	process.exit(1);
});