/**
 * VCPDeck 阿里云盘 Storage 集成测试
 *
 * 用法：
 *   node scripts/test-aliyundrive.cjs
 *
 * 前提：
 *   1. Server 已启动（如 pnpm --filter @vcpdeck/server dev）
 *   2. 管理员已创建（或使用 VCPDECK_ADMIN_PASSWORD 环境变量）
 *
 * 流程：
 *   1. 输入阿里云盘 App 信息（clientId）
 *   2. 完成 OAuth PKCE 授权
 *   3. 切换到 alibaba 存储后端
 *   4. 运行 upload → download → delete 集成测试
 *   5. 可选：切回 local 后端
 */

const readline = require("node:readline");
const path = require("node:path");
const os = require("node:os");

// ── 配置 ──
const BASE = process.env.VCPDECK_BASE || "http://localhost:3001";
const ADMIN_PASSWORD = process.env.VCPDECK_ADMIN_PASSWORD || "test123";
const DEFAULT_OPENAPI_BASE = "https://openapi.alipan.com";
const DEFAULT_TRANSFER_FOLDER = "VCPDeckTransfers";

// ── 状态 ──
let cookie = "";
const results = [];

function pass(name, detail) {
	results.push({ name, status: "PASS", detail: detail ?? "" });
	console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}

function fail(name, detail) {
	results.push({ name, status: "FAIL", detail: detail ?? "" });
	console.log(`  \x1b[31m✗\x1b[0m ${name}: ${detail}`);
}

function warn(name, detail) {
	results.push({ name, status: "WARN", detail: detail ?? "" });
	console.log(`  \x1b[33m⚠\x1b[0m ${name}: ${detail}`);
}

async function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function api(method, path, opts = {}) {
	const headers = { ...(opts.headers || {}) };
	if (opts.json) {
		headers["Content-Type"] = "application/json";
	}
	if (opts.bearer) {
		headers["Authorization"] = `Bearer ${opts.bearer}`;
	}
	if (!opts.noCookie && cookie) {
		headers["Cookie"] = cookie;
	}

	const res = await fetch(`${BASE}${path}`, {
		method,
		headers,
		body: opts.json ? JSON.stringify(opts.json) : (opts.body ?? undefined),
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
	const body = await res.json().catch(() => null);
	return { status: res.status, body };
}

/** 交互式输入（隐藏敏感字段） */
function ask(question, hidden = false) {
	return new Promise((resolve) => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});

		if (hidden) {
			// 简化版密码输入（不依赖 readline/promises）
			const stdin = process.stdin;
			const stdout = process.stdout;
			if (stdin.isTTY) stdout.write(question);

			let buf = "";
			const onData = (c) => {
				const char = c.toString();
				if (char === "\n" || char === "\r") {
					stdin.removeListener("data", onData);
					stdin.setRawMode?.(false);
					stdout.write("\n");
					rl.close();
					resolve(buf);
					return;
				}
				if (char === "\u0003") {
					// Ctrl+C
					process.exit(0);
				}
				if (char === "\u007f" || char === "\b") {
					// backspace
					if (buf.length > 0) buf = buf.slice(0, -1);
				} else {
					buf += char;
				}
			};
			stdin.setRawMode?.(true);
			stdin.on("data", onData);
		} else {
			rl.question(question, (answer) => {
				rl.close();
				resolve(answer.trim());
			});
		}
	});
}

// ── 主流程 ──

async function main() {
	console.log("\n╔══════════════════════════════════════════╗");
	console.log("║  VCPDeck 阿里云盘 Storage 集成测试      ║");
	console.log("╚══════════════════════════════════════════╝\n");

	console.log(`📡 Server: ${BASE}`);

	// ───────────────────────────
	// Step 0: 检查 Server 是否在线
	// ───────────────────────────
	console.log("\n── Step 0: 检查 Server 连接 ──");
	try {
		const res = await fetch(`${BASE}/api/health`);
		const body = await res.json();
		if (body.ok) {
			pass("Server 在线", `${BASE}`);
		} else {
			fail("Server 响应异常", JSON.stringify(body));
			return printReport();
		}
	} catch (e) {
		fail("无法连接 Server", `${BASE} — 请先启动 Server`);
		return printReport();
	}

	// ───────────────────────────
	// Step 1: 管理员登录
	// ───────────────────────────
	console.log("\n── Step 1: 管理员登录 ──");
	{
		const { status, body } = await apiJson("POST", "/api/auth/login", {
			json: { username: "admin", password: ADMIN_PASSWORD },
			noCookie: true,
		});
		if ((status === 200 || status === 201) && body.identity?.isAdmin) {
			pass("管理员登录成功", `username=${body.identity.username}`);
		} else {
			fail(
				"管理员登录失败",
				`status=${status}。尝试设置 VCPDECK_ADMIN_PASSWORD 环境变量`,
			);
			return printReport();
		}
	}

	// ───────────────────────────
	// Step 2: 检查当前存储后端状态
	// ───────────────────────────
	console.log("\n── Step 2: 当前存储状态 ──");
	const currentConfig = await apiJson("GET", "/api/storage/config");
	let wasAlibaba = false;
	if (currentConfig.body?.kind === "alibaba") {
		wasAlibaba = true;
		warn("存储后端已是 alibaba", "将直接进行测试");
	} else {
		console.log(`  当前后端: ${currentConfig.body?.kind || "local"}`);
		console.log("  需要配置阿里云盘信息并完成 OAuth 授权。");
	}

	// ───────────────────────────
	// Step 3: 收集阿里云盘配置
	// ───────────────────────────
	console.log("\n── Step 3: 配置阿里云盘 ──");

	// 先检查已有的 aliyundrive 状态
	const existingStatus = await apiJson("GET", "/api/aliyundrive/status");

	let clientId = "";
	let needOAuth = true;

	if (existingStatus.body?.authorized) {
		console.log(`  已有授权: ${existingStatus.body.configured ? "✓" : "✗"}`);
		console.log(`  clientId: ${existingStatus.body.clientId || "(未设置)"}`);
		console.log(`  driveId: ${existingStatus.body.driveId || "(未知)"}`);
		console.log(
			`  expiresAt: ${existingStatus.body.expiresAt ? new Date(existingStatus.body.expiresAt).toLocaleString() : "N/A"}`,
		);

		const reuse = await ask("\n  使用现有授权继续测试？[Y/n]: ");
		if (reuse.toLowerCase() !== "n") {
			needOAuth = false;
		}
	}

	if (needOAuth || !existingStatus.body?.configured) {
		console.log(
			"\n📋 请前往 https://www.aliyundrive.com/ 创建应用获取 clientId",
		);
		console.log("   回调地址设为: oob\n");

		clientId = await ask("  阿里云盘 App clientId: ");
		if (!clientId) {
			fail("未输入 clientId", "取消测试");
			return printReport();
		}

		const openapiBaseInput = await ask(
			`  OpenAPI 地址 [${DEFAULT_OPENAPI_BASE}]: `,
		);
		const openapiBase = openapiBaseInput || DEFAULT_OPENAPI_BASE;

		// 保存配置
		console.log("\n  保存配置...");
		const { status: configStatus, body: configBody } = await apiJson(
			"PUT",
			"/api/aliyundrive/config",
			{
				json: {
					clientId,
					openapiBase,
				},
			},
		);
		if (configStatus === 200 || configStatus === 201) {
			pass(
				"配置已保存",
				`clientId=${(configBody.clientId || "").slice(0, 8)}...`,
			);
		} else {
			fail("配置保存失败", JSON.stringify(configBody));
			return printReport();
		}

		// OAuth 授权
		console.log("\n── OAuth PKCE 授权 ──");
		const { status: oauthStartStatus, body: oauthBody } = await apiJson(
			"POST",
			"/api/aliyundrive/oauth/start",
		);
		if (oauthStartStatus !== 200 && oauthStartStatus !== 201) {
			fail("OAuth 启动失败", JSON.stringify(oauthBody));
			return printReport();
		}

		console.log(`\n🔗 请在浏览器中打开以下 URL 并完成授权：\n`);
		console.log(`   \x1b[36m${oauthBody.authorizationUrl}\x1b[0m\n`);
		console.log(
			"   授权完成后，复制浏览器地址栏中的 code 参数值（或整个 URL）。\n",
		);

		const codeInput = await ask("   请输入 code (或完整 callback URL): ");
		let code = codeInput;
		// 从完整 URL 中提取 code
		const codeMatch = codeInput.match(/[?&]code=([^&]+)/);
		if (codeMatch) code = decodeURIComponent(codeMatch[1]);

		if (!code) {
			fail("未输入 code", "取消测试");
			return printReport();
		}

		console.log("\n  换取 access_token...");
		const { status: completeStatus, body: completeBody } = await apiJson(
			"POST",
			"/api/aliyundrive/oauth/complete",
			{
				json: { state: oauthBody.state, code },
			},
		);
		if (completeStatus === 200 || completeStatus === 201) {
			pass(
				"OAuth 授权成功",
				`expiresAt=${new Date(completeBody.expiresAt).toLocaleString()}`,
			);
		} else {
			fail("OAuth 授权失败", JSON.stringify(completeBody));
			return printReport();
		}
	}

	// ───────────────────────────
	// Step 4: 检查授权状态
	// ───────────────────────────
	console.log("\n── Step 4: 验证授权 ──");
	const { body: statusBody } = await apiJson("GET", "/api/aliyundrive/status");
	if (statusBody?.authorized) {
		pass("授权有效", `driveId=${statusBody.driveId || "(获取中...)"}`);
	} else {
		fail("授权无效", `state=${statusBody?.authorizationState || "unknown"}`);
		return printReport();
	}

	// ───────────────────────────
	// Step 5: 切换到 alibaba 后端
	// ───────────────────────────
	console.log("\n── Step 5: 切换存储后端 ──");

	if (!wasAlibaba) {
		const { status: switchStatus } = await apiJson(
			"PUT",
			"/api/storage/config",
			{
				json: { kind: "alibaba" },
			},
		);
		if (switchStatus === 200 || switchStatus === 201) {
			pass("存储后端切换为 alibaba", "");
		} else {
			fail("切换失败", `status=${switchStatus}`);
			return printReport();
		}
	} else {
		console.log("  已是 alibaba 后端，跳过切换。");
	}

	// ───────────────────────────
	// Step 6: 上传测试
	// ───────────────────────────
	console.log("\n── Step 6: 上传测试 ──");
	const testContent = `VCPDeck Aliyun Drive Integration Test\n${new Date().toISOString()}\n`;
	const testFilename = `test-${Date.now()}.txt`;

	let uploadKey = null;

	{
		const { status: tokStatus, body: tokBody } = await apiJson(
			"POST",
			"/api/storage/upload-token",
			{
				json: {
					jobId: "aliyun-test",
					clientId: "test",
					filename: testFilename,
					size: testContent.length,
				},
			},
		);
		if (tokStatus !== 200 && tokStatus !== 201) {
			fail("获取上传令牌失败", `status=${tokStatus}`);
			return printReport();
		}
		const uploadUrl = tokBody.url;
		const keyMatch = uploadUrl.match(/\/api\/storage\/upload\/([^?]+)/);
		uploadKey = keyMatch ? keyMatch[1] : null;
		pass("获取上传令牌", `key=${(uploadKey || "").slice(0, 30)}...`);

		// PUT 上传
		console.log("  上传文件中...");
		const putRes = await api("PUT", uploadUrl, {
			headers: { "Content-Type": "text/plain" },
			body: testContent,
		});
		const putBody = await putRes.json().catch(() => null);
		if (putRes.status === 200 && putBody?.key) {
			// 阿里云盘返回的 key 是 fileId
			uploadKey = putBody.key;
			pass(
				"文件上传到阿里云盘",
				`key=${(uploadKey || "").slice(0, 16)}..., size=${putBody.size}`,
			);
		} else {
			fail(
				"上传失败",
				`status=${putRes.status} body=${JSON.stringify(putBody)?.slice(0, 200)}`,
			);
			return printReport();
		}
	}

	// ───────────────────────────
	// Step 7: 下载测试
	// ───────────────────────────
	console.log("\n── Step 7: 下载测试 ──");

	{
		const { status: dlTokStatus, body: dlTokBody } = await apiJson(
			"POST",
			"/api/storage/download-token",
			{
				json: { key: uploadKey },
			},
		);
		if (dlTokStatus !== 200 && dlTokStatus !== 201) {
			fail("获取下载令牌失败", `status=${dlTokStatus}`);
			return printReport();
		}
		pass("获取下载令牌", "");

		const getRes = await fetch(`${BASE}${dlTokBody.url}`, {
			redirect: "manual",
		});
		const content = await getRes.text();
		if (getRes.status === 200 && content === testContent) {
			pass("下载内容完全匹配", `${content.length} bytes`);
		} else if (getRes.status === 200) {
			fail(
				"下载内容不匹配",
				`expected ${testContent.length}B, got ${content.length}B`,
			);
		} else {
			fail("下载失败", `status=${getRes.status}`);
		}
	}

	// 测试签名过期
	console.log("  测试过期签名...");
	{
		const { status: tokStatus, body: tokBody } = await apiJson(
			"POST",
			"/api/storage/download-token",
			{
				json: { key: uploadKey, ttlSeconds: 1 },
			},
		);
		if (tokStatus === 200 || tokStatus === 201) {
			await sleep(2000);
			const expiredRes = await fetch(`${BASE}${tokBody.url}`, {
				redirect: "manual",
			});
			if (expiredRes.status === 403) {
				pass("过期签名被拒绝", "403");
			} else {
				fail("过期签名未被拒绝", `status=${expiredRes.status}`);
			}
		}
	}

	// 测试篡改签名
	console.log("  测试篡改签名...");
	{
		const { status: tokStatus, body: tokBody } = await apiJson(
			"POST",
			"/api/storage/download-token",
			{
				json: { key: uploadKey },
			},
		);
		if (tokStatus === 200 || tokStatus === 201) {
			const tamperedUrl = tokBody.url.replace(
				/sig=([^&]+)/,
				"sig=deadbeefbadc0ffee",
			);
			const badRes = await fetch(`${BASE}${tamperedUrl}`, {
				redirect: "manual",
			});
			if (badRes.status === 403) {
				pass("篡改签名被拒绝", "403");
			} else {
				fail("篡改签名未被拒绝", `status=${badRes.status}`);
			}
		}
	}

	// ───────────────────────────
	// Step 8: 删除测试
	// ───────────────────────────
	console.log("\n── Step 8: 删除测试 ──");

	{
		const { status: delStatus } = await apiJson(
			"DELETE",
			`/api/storage/${encodeURIComponent(uploadKey)}`,
		);
		if (delStatus === 200) {
			pass("文件已删除", "200");

			// 确认无法再下载
			const { status: dlTokStatus, body: dlTokBody } = await apiJson(
				"POST",
				"/api/storage/download-token",
				{
					json: { key: uploadKey },
				},
			);
			if (dlTokStatus === 200 || dlTokStatus === 201) {
				const goneRes = await fetch(`${BASE}${dlTokBody.url}`, {
					redirect: "manual",
				});
				if (goneRes.status >= 400) {
					pass("已删除文件不可下载", `status=${goneRes.status}`);
				} else {
					warn("已删除文件仍可下载", "阿里云盘可能有延迟");
				}
			}
		} else {
			fail("删除失败", `status=${delStatus}`);
		}
	}

	// ───────────────────────────
	// Step 9: 大文件上传测试（可选）
	// ───────────────────────────
	console.log("\n── Step 9: 大文件测试（可选） ──");
	const runLargeTest = await ask(
		"  是否测试大文件上传（约 10MB 随机数据）？[y/N]: ",
	);
	if (runLargeTest.toLowerCase() === "y") {
		// 生成 10MB 随机数据（使用 Buffer.alloc 快速生成，非 crypto 随机）
		console.log("  生成 10MB 测试数据...");
		const largeSize = 10 * 1024 * 1024;
		const largeBuf = Buffer.alloc(largeSize);
		// 填充伪随机数据（比 crypto.randomBytes 快很多）
		for (let i = 0; i < largeBuf.length; i += 4096) {
			const end = Math.min(i + 4096, largeBuf.length);
			const chunk = largeBuf.subarray(i, end);
			// 用时间戳+偏移混合保证一定随机性
			for (let j = 0; j < chunk.length; j++) {
				chunk[j] = (Date.now() + i + j) & 0xff;
			}
		}

		const largeFilename = `large-test-${Date.now()}.bin`;
		console.log(
			`  文件: ${largeFilename} (${(largeSize / 1024 / 1024).toFixed(1)}MB)`,
		);

		const { status: tokStatus, body: tokBody } = await apiJson(
			"POST",
			"/api/storage/upload-token",
			{
				json: {
					jobId: "aliyun-large-test",
					clientId: "test",
					filename: largeFilename,
					size: largeSize,
				},
			},
		);
		if (tokStatus !== 200 && tokStatus !== 201) {
			fail("大文件上传令牌获取失败", `status=${tokStatus}`);
		} else {
			const startMs = Date.now();
			const putRes = await api("PUT", tokBody.url, {
				headers: { "Content-Type": "application/octet-stream" },
				body: largeBuf,
			});
			const elapsed = Date.now() - startMs;
			const putBody = await putRes.json().catch(() => null);
			if (putRes.status === 200 && putBody?.key) {
				const speed = (largeSize / 1024 / 1024 / (elapsed / 1000)).toFixed(1);
				pass(
					"大文件上传成功",
					`${(largeSize / 1024 / 1024).toFixed(1)}MB in ${(elapsed / 1000).toFixed(1)}s (${speed} MB/s)`,
				);

				// 下载验证
				const { status: dlTokStatus2, body: dlTokBody2 } = await apiJson(
					"POST",
					"/api/storage/download-token",
					{ json: { key: putBody.key } },
				);
				if (dlTokStatus2 === 200 || dlTokStatus2 === 201) {
					const dlStart = Date.now();
					const getRes = await fetch(`${BASE}${dlTokBody2.url}`);
					const dlBuf = Buffer.from(await getRes.arrayBuffer());
					const dlElapsed = Date.now() - dlStart;
					const dlSpeed = (
						largeSize /
						1024 /
						1024 /
						(dlElapsed / 1000)
					).toFixed(1);

					if (dlBuf.length === largeBuf.length) {
						// 简单校验（抽样检查首尾）
						const headOk = dlBuf
							.subarray(0, 1024)
							.equals(largeBuf.subarray(0, 1024));
						const tailOk = dlBuf
							.subarray(-1024)
							.equals(largeBuf.subarray(-1024));
						if (headOk && tailOk) {
							pass(
								"大文件下载校验通过",
								`${(dlBuf.length / 1024 / 1024).toFixed(1)}MB in ${(dlElapsed / 1000).toFixed(1)}s (${dlSpeed} MB/s)`,
							);
						} else {
							fail("大文件内容不匹配", "首尾抽样不一致");
						}
					} else {
						fail(
							"大文件下载大小不匹配",
							`expected ${largeSize}, got ${dlBuf.length}`,
						);
					}
				}

				// 清理
				await apiJson(
					"DELETE",
					`/api/storage/${encodeURIComponent(putBody.key)}`,
				);
			} else {
				fail(
					"大文件上传失败",
					`status=${putRes.status} ${JSON.stringify(putBody)?.slice(0, 200)}`,
				);
			}
		}
	}

	// ───────────────────────────
	// Step 10: 可选切回 local
	// ───────────────────────────
	console.log("\n── Step 10: 是否切回 local ──");
	const revert = await ask("  切回 local 存储后端？[y/N]: ");
	if (revert.toLowerCase() === "y") {
		const { status: revStatus } = await apiJson("PUT", "/api/storage/config", {
			json: { kind: "local" },
		});
		if (revStatus === 200 || revStatus === 201) {
			pass("已切回 local 后端", "");
		} else {
			warn("切换失败", `status=${revStatus}`);
		}
	}

	// ───────────────────────────
	// 报告
	// ───────────────────────────
	printReport();
}

function printReport() {
	console.log("\n╔══════════════════════════════════════════╗");
	console.log("║              测试报告                    ║");
	console.log("╚══════════════════════════════════════════╝\n");

	const passed = results.filter((r) => r.status === "PASS").length;
	const failed = results.filter((r) => r.status === "FAIL").length;
	const warned = results.filter((r) => r.status === "WARN").length;
	const total = results.length;

	for (const r of results) {
		const icon =
			r.status === "PASS"
				? "\x1b[32m✓\x1b[0m"
				: r.status === "FAIL"
					? "\x1b[31m✗\x1b[0m"
					: "\x1b[33m⚠\x1b[0m";
		console.log(`  ${icon} ${r.name}`);
		if (r.detail) console.log(`       ${r.detail}`);
	}

	console.log(
		`\n  \x1b[1m${passed}/${total}\x1b[0m passed, \x1b[31m${failed} failed\x1b[0m, \x1b[33m${warned} warnings\x1b[0m\n`,
	);

	process.exit(failed > 0 ? 1 : 0);
}

// ── Run ──
main().catch((err) => {
	console.error("\n\x1b[31mFatal:\x1b[0m", err.message);
	process.exit(1);
});
