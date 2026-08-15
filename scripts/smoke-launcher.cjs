#!/usr/bin/env node
/**
 * launcher 冒烟测试（E2E-lite，F1 雏形）：
 * 1. 构造 apps/1.0.0 fake client 构件（Windows 用 state.json 指针）
 * 2. 启动 launcher → 验证 v1 被拉起、control.json 就绪
 * 3. POST /prepare（本地静态服务 zip + sha256）→ POST /apply
 * 4. 验证切换成功：current=1.1.0 且 v2 进程已启动（标记文件）
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

function makeClientScript(version) {
	return `
const fs = require("node:fs");
const path = require("node:path");
const markDir = process.env.SMOKE_MARK_DIR;
fs.writeFileSync(path.join(markDir, "started-" + ${JSON.stringify(version)}), "ok");
fs.writeFileSync(path.join(markDir, "pid-" + ${JSON.stringify(version)}), String(process.pid));
console.log("[artifact] running " + ${JSON.stringify(version)});
setInterval(() => {}, 1000);
`;
}

async function main() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-smoke-"));
	const appDir = path.join(root, "launcher");
	const appsDir = path.join(appDir, "apps");
	const pkgDir = path.join(root, "pkg");
	const zipPath = path.join(root, "update.zip");
	const markDir = path.join(root, "marks");
	fs.mkdirSync(markDir, { recursive: true });

	const makeManifest = (version) => ({
		version,
		nodeVersion: ">=18",
		launcherMinVersion: "0.0.0",
		sha256: "",
		artifacts: { client: { dir: "client", entry: "index.js" } },
	});

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
		fs.symlinkSync(path.join(appsDir, "1.0.0"), path.join(appsDir, "current"), "dir");
	}

	// 1.1.0 更新包
	fs.mkdirSync(path.join(pkgDir, "client"), { recursive: true });
	fs.writeFileSync(
		path.join(pkgDir, "manifest.json"),
		JSON.stringify(makeManifest("1.1.0")),
	);
	fs.writeFileSync(
		path.join(pkgDir, "client", "index.js"),
		makeClientScript("1.1.0"),
	);
	try {
		execSync(
			`powershell -Command "Compress-Archive -Path '${path.join(pkgDir, "*")}' -DestinationPath '${zipPath}' -Force"`,
		);
	} catch (e) {
		throw new Error(`构造更新包 zip 失败: ${e.message}`);
	}
	const sha256 = crypto
		.createHash("sha256")
		.update(fs.readFileSync(zipPath))
		.digest("hex");

	// 静态服务 zip
	const fileServer = http.createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/zip" });
		fs.createReadStream(zipPath).pipe(res);
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
	launcher.stderr.on("data", (d) => process.stderr.write(`[launcher-err] ${d}`));

	try {
		await waitFor(
			() => fs.existsSync(path.join(appDir, "control.json")),
			15_000,
			"control.json 就绪",
		);
		await waitFor(
			() => fs.existsSync(path.join(markDir, "started-1.0.0")),
			20_000,
			"v1.0.0 进程启动",
		);
		console.log("✓ v1.0.0 已被守护启动");

		const control = JSON.parse(
			fs.readFileSync(path.join(appDir, "control.json"), "utf-8"),
		);

		const prepRes = await fetch(`http://127.0.0.1:${control.port}/prepare`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-launcher-token": control.token,
			},
			body: JSON.stringify({
				version: "1.1.0",
				url: "http://127.0.0.1:3999/update.zip",
				sha256,
			}),
		});
		assert(prepRes.status === 200, `prepare 失败: ${prepRes.status} ${await prepRes.text()}`);
		console.log("✓ prepare 完成（下载/校验/解压）");

		const applyRes = await fetch(`http://127.0.0.1:${control.port}/apply`, {
			method: "POST",
			headers: { "x-launcher-token": control.token },
		});
		assert(applyRes.status === 200, `apply 失败: ${applyRes.status} ${await applyRes.text()}`);

		await waitFor(
			() => fs.existsSync(path.join(markDir, "started-1.1.0")),
			30_000,
			"v1.1.0 进程启动",
		);
		console.log("✓ 已切换到 1.1.0 并启动新进程");

		// 版本指针确认
		const stateFile = path.join(appsDir, "state.json");
		const current = process.platform === "win32"
			? JSON.parse(fs.readFileSync(stateFile, "utf-8")).current
			: path.basename(fs.readlinkSync(path.join(appsDir, "current")));
		assert(current === "1.1.0", `current 应为 1.1.0，实际 ${current}`);
		console.log("✓ current 指针 = 1.1.0");

		console.log("== launcher 冒烟通过 ==");
	} finally {
		launcher.kill();
		fileServer.close();
		// 清理孤儿 artifact 进程（Windows 上运行中进程的目录不可删除）
		for (const name of fs.readdirSync(markDir)) {
			if (!name.startsWith("pid-")) continue;
			try {
				process.kill(Number(fs.readFileSync(path.join(markDir, name), "utf-8")));
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
