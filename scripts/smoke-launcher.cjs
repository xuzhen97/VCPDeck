#!/usr/bin/env node
/**
 * launcher 冒烟测试（E2E-lite，F1 雏形）：
 * 场景 1 正常更新：1.0.0 → prepare/apply → 1.1.0 启动、指针切换
 * 场景 2 失败回退：1.2.0（启动即崩溃）→ apply 报错 → 自动回退 1.1.0 并重启
 */
const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const crypto = require("node:crypto");

function assert(cond, msg) {
	if (!cond) {
		console.error(`✗ ${msg}`);
		process.exit(1);
	}
}

async function waitFor(cond, timeoutMs, what) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 300));
	}
	throw new Error(`等待超时: ${what}`);
}

/** 构件脚本：写启动标记（append 计数，回退重启可辨）；bad=true 时启动即崩溃 */
function makeClientScript(version, bad = false) {
	return `
const fs = require("node:fs");
const path = require("node:path");
const markDir = process.env.SMOKE_MARK_DIR;
fs.appendFileSync(path.join(markDir, "started-" + ${JSON.stringify(version)}), "ok\\n");
console.log("[artifact] running " + ${JSON.stringify(version)});
${bad ? "process.exit(3);" : "setInterval(() => {}, 1000);"}
`;
}

function makeManifest(version) {
	return {
		version,
		nodeVersion: ">=18",
		launcherMinVersion: "0.0.0",
		sha256: "",
		artifacts: { client: { dir: "client", entry: "index.js" } },
	};
}

function buildZip(pkgDir, zipPath, version, bad) {
	fs.mkdirSync(path.join(pkgDir, "client"), { recursive: true });
	fs.writeFileSync(
		path.join(pkgDir, "client", "index.js"),
		makeClientScript(version, bad),
	);
	fs.writeFileSync(
		path.join(pkgDir, "manifest.json"),
		JSON.stringify(makeManifest(version)),
	);
	try {
		execSync(
			`powershell -Command "Compress-Archive -Path '${path.join(pkgDir, "*")}' -DestinationPath '${zipPath}' -Force"`,
		);
	} catch (e) {
		throw new Error(`构造更新包 zip 失败: ${e.message}`);
	}
	return crypto
		.createHash("sha256")
		.update(fs.readFileSync(zipPath))
		.digest("hex");
}

function markCount(markDir, version) {
	try {
		return fs
			.readFileSync(path.join(markDir, `started-${version}`), "utf-8")
			.split("\n")
			.filter(Boolean).length;
	} catch {
		return 0;
	}
}

async function main() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-smoke-"));
	const appDir = path.join(root, "launcher");
	const appsDir = path.join(appDir, "apps");
	const markDir = path.join(root, "marks");
	fs.mkdirSync(markDir, { recursive: true });

	// v1.0.0 初始部署
	fs.mkdirSync(path.join(appsDir, "1.0.0", "client"), { recursive: true });
	fs.writeFileSync(
		path.join(appsDir, "1.0.0", "manifest.json"),
		JSON.stringify(makeManifest("1.0.0")),
	);
	fs.writeFileSync(
		path.join(appsDir, "1.0.0", "client", "index.js"),
		makeClientScript("1.0.0"),
	);
	if (process.platform === "win32") {
		fs.writeFileSync(
			path.join(appsDir, "state.json"),
			JSON.stringify({ current: "1.0.0" }),
		);
	} else {
		fs.symlinkSync(
			path.join(appsDir, "1.0.0"),
			path.join(appsDir, "current"),
			"dir",
		);
	}

	// 更新包：1.1.0（正常）与 1.2.0（启动即崩溃）
	const goodZip = path.join(root, "good.zip");
	const badZip = path.join(root, "bad.zip");
	const goodSha = buildZip(
		path.join(root, "pkg-good"),
		goodZip,
		"1.1.0",
		false,
	);
	const badSha = buildZip(path.join(root, "pkg-bad12"), badZip, "1.2.0", true);

	// 静态服务（按路径路由两个 zip）
	const fileServer = http.createServer((req, res) => {
		const file = req.url === "/bad.zip" ? badZip : goodZip;
		res.writeHead(200, { "content-type": "application/zip" });
		fs.createReadStream(file).pipe(res);
	});
	await new Promise((r) => fileServer.listen(3999, "127.0.0.1", r));

	// 启动 launcher
	const launcher = spawn(
		process.execPath,
		[path.join(__dirname, "../packages/launcher/dist/main.js")],
		{
			cwd: path.join(__dirname, ".."),
			env: {
				...process.env,
				VCPDECK_APP_DIR: appDir,
				VCPDECK_ARTIFACT: "client",
				SMOKE_MARK_DIR: markDir,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	launcher.stdout.on("data", (d) => process.stdout.write(`[launcher] ${d}`));
	launcher.stderr.on("data", (d) =>
		process.stderr.write(`[launcher-err] ${d}`),
	);

	const currentVersion = () => {
		const stateFile = path.join(appsDir, "state.json");
		if (process.platform === "win32") {
			try {
				return JSON.parse(fs.readFileSync(stateFile, "utf-8")).current;
			} catch (e) {
				throw new Error(`读 state.json 失败: ${e.message}`);
			}
		}
		return path.basename(fs.readlinkSync(path.join(appsDir, "current")));
	};

	const postControl = async (pathName, token, body) =>
		fetch(`http://127.0.0.1:${control.port}${pathName}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-launcher-token": token,
			},
			body: body ? JSON.stringify(body) : undefined,
		});

	let control;
	try {
		await waitFor(
			() => fs.existsSync(path.join(appDir, "control.json")),
			15_000,
			"control.json 就绪",
		);
		await waitFor(
			() => markCount(markDir, "1.0.0") >= 1,
			20_000,
			"v1.0.0 进程启动",
		);
		console.log("✓ 场景 1：v1.0.0 已被守护启动");
		control = JSON.parse(
			fs.readFileSync(path.join(appDir, "control.json"), "utf-8"),
		);

		// ── 正常更新 1.0.0 → 1.1.0 ──
		const prep1 = await postControl("/prepare", control.token, {
			version: "1.1.0",
			url: "http://127.0.0.1:3999/good.zip",
			sha256: goodSha,
		});
		assert(
			prep1.status === 200,
			`prepare 失败: ${prep1.status} ${await prep1.text()}`,
		);
		console.log("✓ prepare 1.1.0 完成");

		const apply1 = await postControl("/apply", control.token);
		assert(
			apply1.status === 200,
			`apply 失败: ${apply1.status} ${await apply1.text()}`,
		);
		await waitFor(
			() => markCount(markDir, "1.1.0") >= 1,
			30_000,
			"v1.1.0 启动",
		);
		assert(
			currentVersion() === "1.1.0",
			`current 应为 1.1.0，实际 ${currentVersion()}`,
		);
		console.log("✓ 正常更新完成：current = 1.1.0");

		// ── 坏更新 1.2.0（启动即崩）→ 自动回退 ──
		const prep2 = await postControl("/prepare", control.token, {
			version: "1.2.0",
			url: "http://127.0.0.1:3999/bad.zip",
			sha256: badSha,
		});
		assert(prep2.status === 200, `prepare 1.2.0 失败: ${prep2.status}`);
		console.log("✓ prepare 1.2.0（坏版本）完成");

		const apply2 = await postControl("/apply", control.token);
		assert(
			apply2.status === 500,
			`坏版本 apply 应返回 500，实际 ${apply2.status}`,
		);
		assert(
			(await apply2.text()).includes("已回退"),
			"apply 响应应包含「已回退」",
		);
		await waitFor(
			() => markCount(markDir, "1.1.0") >= 2,
			30_000,
			"回退后 1.1.0 重启",
		);
		assert(
			currentVersion() === "1.1.0",
			`回退后 current 应为 1.1.0，实际 ${currentVersion()}`,
		);
		console.log("✓ 坏版本自动回退：current = 1.1.0，旧版本已重启");

		console.log("== launcher 冒烟全部通过（正常更新 + 失败回退） ==");
	} finally {
		launcher.kill();
		fileServer.close();
		for (const name of fs.readdirSync(markDir)) {
			if (!name.startsWith("pid-") && !name.startsWith("started-")) continue;
			if (!name.startsWith("pid-")) continue;
			try {
				process.kill(
					Number(fs.readFileSync(path.join(markDir, name), "utf-8")),
				);
			} catch {
				// 进程可能已退出
			}
		}
		await new Promise((r) => setTimeout(r, 800));
		for (let i = 0; i < 5; i++) {
			try {
				fs.rmSync(root, { recursive: true, force: true });
				break;
			} catch {
				await new Promise((r) => setTimeout(r, 500));
			}
		}
	}
}

main().catch((e) => {
	console.error(`✗ 冒烟失败: ${e.message}`);
	process.exit(1);
});
